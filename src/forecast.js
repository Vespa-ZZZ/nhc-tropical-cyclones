import { unzipSync } from 'fflate';
import { openDbf } from 'shapefile';
import { advisoryNumber, numberField } from './nhc.js';

const HOUR = 3_600_000;
const MAX_DBF_BYTES = 256 * 1024;
const MAX_POINTS = 32;
const DBF_FIELDS = ['ADVISNUM', 'BASIN', 'STORMNUM', 'TAU', 'VALIDTIME', 'LAT', 'LON', 'MAXWIND', 'STORMTYPE'];

function utcLabel(time) {
    const iso = new Date(time).toISOString();
    return `${iso.slice(8, 10)}/${iso.slice(11, 13)}${iso.slice(14, 16)}`;
}

function baseTime(label, issuance) {
    const match = /^(\d{2})\/(\d{2})(\d{2})$/.exec(label);
    if (!match) throw new Error('invalid initial VALIDTIME');
    const [, day, hour, minute] = match.map(Number);
    const issued = new Date(issuance);
    const candidates = [-1, 0, 1].map((offset) => Date.UTC(
        issued.getUTCFullYear(), issued.getUTCMonth() + offset, day, hour, minute,
    ));
    // The analysis cycle can fall on the other side of a month boundary from the issuance.
    const time = candidates.find((candidate) => utcLabel(candidate) === label
        && Math.abs(candidate - issued.getTime()) <= 24 * HOUR);
    if (time === undefined) throw new Error('initial VALIDTIME does not match forecast issuance');
    return time;
}

async function readPoints(archive, id, number) {
    const pointFile = `${id}-${number}_5day_pts.dbf`.toLowerCase();
    const files = unzipSync(archive, {
        filter: ({ name, originalSize }) => name.toLowerCase() === pointFile && originalSize <= MAX_DBF_BYTES,
    });
    const [dbf] = Object.values(files);
    if (!dbf || dbf.length < 32) throw new Error('missing or undersized forecast point table');
    const expectedCount = new DataView(dbf.buffer, dbf.byteOffset, dbf.byteLength).getUint32(4, true);
    if (expectedCount < 1 || expectedCount > MAX_POINTS) throw new Error('invalid forecast point count');
    const reader = await openDbf(dbf);
    const points = [];
    try {
        for (let i = 0; i < expectedCount; i++) {
            const { done, value } = await reader.read();
            if (done) throw new Error('truncated forecast point table');
            points.push(value);
        }
        if (!(await reader.read()).done) throw new Error('unexpected additional forecast points');
    } finally {
        await reader.cancel();
    }
    return points;
}

export async function parseForecastTrack(archive, id, track) {
    try {
        const points = await readPoints(archive, id, track.number);
        const byHour = new Map();
        for (const point of points) {
            if (!DBF_FIELDS.every((field) => Object.hasOwn(point, field))) {
                throw new Error('missing required forecast DBF columns');
            }
            if (point.BASIN !== id.slice(0, 2) || Number(point.STORMNUM) !== Number(id.slice(2, 4))
                || advisoryNumber(point.ADVISNUM, 'ADVISNUM') !== track.number) {
                throw new Error('forecast points belong to a different storm or advisory');
            }
            const hour = numberField(point.TAU, 'TAU', 0, 240);
            if (!Number.isInteger(hour) || byHour.has(hour)) throw new Error('missing or duplicate forecast hour');
            byHour.set(hour, point);
        }
        if (!byHour.has(0)) throw new Error('missing initial forecast point');
        const start = baseTime(byHour.get(0).VALIDTIME, track.issuance);
        byHour.delete(0);
        return [...byHour].sort(([a], [b]) => a - b).map(([hour, point]) => {
            const time = start + hour * HOUR;
            if (utcLabel(time) !== point.VALIDTIME) throw new Error('VALIDTIME does not match forecast hour');
            const classification = point.STORMTYPE || null;
            if (classification !== null && (typeof classification !== 'string' || !/^[A-Z]{1,3}$/.test(classification))) {
                throw new Error('invalid forecast classification');
            }
            return {
                time: new Date(time).toISOString(),
                lat: numberField(point.LAT, 'forecast LAT', -90, 90),
                lon: numberField(point.LON, 'forecast LON', -180, 180),
                maxWindKt: numberField(point.MAXWIND, 'forecast MAXWIND', 0, 300),
                classification,
            };
        });
    } catch (error) {
        throw new Error(`Unrecognized NHC forecast track for ${id} advisory ${track.number}: ${error.message}.`);
    }
}
