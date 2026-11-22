import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { parseForecastTrack } from '../src/forecast.js';
import { meetsMinIntensity, parseFeed, parseInput } from '../src/nhc.js';

const sample = await readFile(new URL('./fixtures/current-storms-sample.json', import.meta.url), 'utf8');
const forecast = await readFile(new URL('./fixtures/al112017_5day_042.zip', import.meta.url));

test('normalizes the published active-storm sample and retains advisory links', () => {
    const [{ row }] = parseFeed(sample);
    assert.deepEqual(row, {
        id: 'AL112017',
        binNumber: 'AT1',
        name: 'Irma',
        classification: 'HU',
        basin: 'AL',
        advisoryNumber: '042',
        issuanceTime: '2017-09-09T15:00:00.000Z',
        lat: 22.9,
        lon: -79.9,
        intensityKt: 125,
        intensityKmh: 231.5,
        pressureMb: 941,
        movementDirDeg: 280,
        movementSpeedMph: 9,
        publicAdvisoryUrl: 'https://www.nhc.noaa.gov/archive/2017/al11/al112017.public.042.shtml',
        forecastAdvisoryUrl: 'https://www.nhc.noaa.gov/archive/2017/al11/al112017.fstadv.042.shtml',
        forecastTrackUrl: 'https://www.nhc.noaa.gov/gis/forecast/archive/al112017_5day_042.zip',
        source: 'NOAA National Hurricane Center',
    });
});

test('preserves zero measurements, nulls and intermediate advisories, and redacts contacts', () => {
    const { activeStorms: [storm] } = JSON.parse(sample);
    Object.assign(storm, {
        name: 'Irma alerts@example.test +1 (305) 555-0101',
        latitude_numeric: 0,
        longitude_numeric: null,
        pressure: null,
        movementSpeed: 0,
        intensity: '35',
        forecastAdvisory: null,
        forecastTrack: null,
    });
    storm.publicAdvisory.advNum = '042A';
    const [{ row, track }] = parseFeed(JSON.stringify({ activeStorms: [storm] }));
    assert.equal(row.name, 'Irma [redacted] [redacted]');
    assert.equal(row.lat, 0);
    assert.equal(row.lon, null);
    assert.equal(row.pressureMb, null);
    assert.equal(row.movementSpeedMph, 0);
    assert.equal(row.intensityKmh, 64.82);
    assert.equal(row.advisoryNumber, '042A');
    assert.equal(row.forecastAdvisoryUrl, null);
    assert.equal(track, null);
});

test('rejects malformed or changed source schemas and unexpected product URLs', () => {
    assert.throws(() => parseFeed('<html>'), /expected valid JSON/);
    assert.throws(() => parseFeed('{"storms":[]}'), /expected an activeStorms array/);
    assert.throws(() => parseFeed('{"activeStorms":[{}]}'), /activeStorms\[0\]: invalid id/);
    const { activeStorms: [storm] } = JSON.parse(sample);
    assert.throws(() => parseFeed(JSON.stringify({ activeStorms: [storm, storm] })), /duplicate storm id/);
    const otherHost = structuredClone(storm);
    otherHost.forecastTrack.zipFile = otherHost.forecastTrack.zipFile.replace('www.hurricanes.gov', 'example.test');
    assert.throws(() => parseFeed(JSON.stringify({ activeStorms: [otherHost] })), /invalid forecast track ZIP URL/);
    storm.publicAdvisory.issuance = '2017-09-31T15:00:00Z';
    assert.throws(() => parseFeed(JSON.stringify({ activeStorms: [storm] })), /invalid publicAdvisory.issuance/);
});

test('validates inputs and applies the requested classification threshold', () => {
    assert.deepEqual(parseInput({}).basins, ['AL', 'EP', 'CP']);
    assert.deepEqual(parseInput({ basins: ['CP'] }).basins, ['CP']);
    assert.throws(() => parseInput({ basins: [] }), /Invalid input: basins/);
    assert.throws(() => parseInput({ basins: ['EP', 'EP'] }), /Invalid input: basins/);
    assert.throws(() => parseInput({ onlyNew: 'true' }), /must be booleans/);
    assert.throws(() => parseInput({ minIntensity: 'PTC' }), /minIntensity/);
    assert.throws(() => parseInput({ stateKey: '../state' }), /stateKey/);
    assert.equal(meetsMinIntensity('STD', 'TD'), true);
    assert.equal(meetsMinIntensity('STD', 'TS'), false);
    assert.equal(meetsMinIntensity('STS', 'TS'), true);
    assert.equal(meetsMinIntensity('TS', 'HU'), false);
    assert.equal(meetsMinIntensity('MH', 'HU'), true);
    assert.equal(meetsMinIntensity('PTC', 'TD'), false);
    assert.equal(meetsMinIntensity('PTC', undefined), true);
});

test('extracts UTC track points and classifications from the archived Irma forecast DBF', async () => {
    const [{ row, track }] = parseFeed(sample);
    const points = await parseForecastTrack(forecast, row.id, track);
    assert.equal(points.length, 7);
    assert.deepEqual(points[0], {
        time: '2017-09-10T00:00:00.000Z', lat: 23.4, lon: -80.7, maxWindKt: 115, classification: 'MH',
    });
    assert.deepEqual(points.at(-1), {
        time: '2017-09-14T12:00:00.000Z', lat: 37, lon: -88.5, maxWindKt: 20, classification: 'STD',
    });
    await assert.rejects(parseForecastTrack(forecast, row.id, { ...track, number: '043' }), /missing.* forecast point table/);
    await assert.rejects(parseForecastTrack(Buffer.from('<html>'), row.id, track), /Unrecognized NHC forecast track/);
});
