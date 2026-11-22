const NHC_HOST = 'www.nhc.noaa.gov';
export const FEED_URL = 'https://www.nhc.noaa.gov/CurrentStorms.json';
export const SOURCE = 'NOAA National Hurricane Center';
const BASINS = ['AL', 'EP', 'CP'];
const MIN_INTENSITIES = ['TD', 'TS', 'HU'];
const INTENSITY_RANK = { TD: 0, STD: 0, TS: 1, STS: 1, HU: 2, MH: 2 };
const NHC_HOSTS = new Set([NHC_HOST, 'www.hurricanes.gov']);

function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function parseInput(input) {
    const invalid = (message) => new Error(`Invalid input: ${message}`);
    if (!isObject(input)) throw invalid('expected an object.');
    const {
        basins = BASINS, includeForecastTrack = true, minIntensity,
        onlyNew = false, stateKey = 'default',
    } = input;
    if (!Array.isArray(basins) || !basins.length || new Set(basins).size !== basins.length
        || !basins.every((basin) => BASINS.includes(basin))) {
        throw invalid('basins must contain one or more distinct values from AL, EP, CP.');
    }
    if (typeof includeForecastTrack !== 'boolean' || typeof onlyNew !== 'boolean') {
        throw invalid('includeForecastTrack and onlyNew must be booleans.');
    }
    if (minIntensity !== undefined && !MIN_INTENSITIES.includes(minIntensity)) {
        throw invalid('minIntensity must be TD, TS, or HU.');
    }
    if (typeof stateKey !== 'string' || !/^[a-zA-Z0-9_-]{1,50}$/.test(stateKey)) {
        throw invalid('stateKey must contain 1 to 50 letters, digits, underscores, or hyphens.');
    }
    return { basins, includeForecastTrack, minIntensity, onlyNew, stateKey };
}

export function meetsMinIntensity(classification, minimum) {
    return minimum === undefined || INTENSITY_RANK[classification] >= INTENSITY_RANK[minimum];
}

function requiredString(value, pattern, field) {
    if (typeof value !== 'string' || !pattern.test(value)) throw new Error(`invalid ${field}`);
    return value;
}

export function numberField(value, field, min, max) {
    if (value == null || value === '') return null;
    if (typeof value === 'string' && /^-?\d+(?:\.\d+)?$/.test(value)) value = Number(value);
    if (!Number.isFinite(value) || value < min || value > max) throw new Error(`invalid ${field}`);
    return value;
}

function redactContacts(value) {
    if (value == null) return null;
    if (typeof value !== 'string') throw new Error('invalid name');
    return value
        .replace(/[\w.%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi, '[redacted]')
        .replace(/(?<!\w)(?:\+\d{1,3}[ .-]?)?(?:\(\d{2,4}\)|\d{2,4})[ .-]?\d{3,4}[ .-]?\d{4}(?:\s*(?:ext\.?|x|#)\s*\d+)?(?!\w)/gi, '[redacted]')
        .trim() || null;
}

function productUrl(value, pathPattern, field) {
    const url = typeof value === 'string' ? URL.parse(value) : null;
    if (!url || url.protocol !== 'https:' || !NHC_HOSTS.has(url.hostname) || url.port
        || url.username || url.password || url.search || url.hash || !pathPattern.test(url.pathname)) {
        throw new Error(`invalid ${field} URL`);
    }
    // NHC's reference uses its alternate Hurricanes.gov domain. Fetch from the verified NHC host.
    url.hostname = NHC_HOST;
    return url.href;
}

export function advisoryNumber(value, field) {
    const number = requiredString(value, /^\d{1,3}[A-Z]?$/, field);
    return number.replace(/^\d+/, (digits) => digits.padStart(3, '0'));
}

function issuanceTime(value, field) {
    const time = requiredString(value, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/, field);
    const timestamp = Date.parse(time);
    if (Number.isFinite(timestamp)) {
        const iso = new Date(timestamp).toISOString();
        if (iso.slice(0, 19) === time.slice(0, 19)) return iso;
    }
    throw new Error(`invalid ${field}`);
}

function parseAdvisory(advisory, field) {
    if (!isObject(advisory)) throw new Error(`missing ${field} object`);
    return {
        number: advisoryNumber(advisory.advNum, `${field}.advNum`),
        issuance: issuanceTime(advisory.issuance, `${field}.issuance`),
    };
}

const ADVISORY_PATH = /^\/(?:text|archive)\/[\w/+.-]+\.shtml$/i;

function parseStorm(storm) {
    if (!isObject(storm)) throw new Error('expected a storm object');
    const id = requiredString(storm.id, /^(?:AL|EP|CP)\d{6}$/i, 'id').toUpperCase();
    const binNumber = requiredString(storm.binNumber, /^(?:AT|EP|CP)[1-9]$/, 'binNumber');
    const classification = requiredString(storm.classification, /^[A-Z]{2,3}$/, 'classification');
    const publicAdvisory = parseAdvisory(storm.publicAdvisory, 'publicAdvisory');
    const publicAdvisoryUrl = productUrl(storm.publicAdvisory.url, ADVISORY_PATH, 'public advisory');
    const forecastAdvisoryUrl = storm.forecastAdvisory?.url == null ? null
        : productUrl(storm.forecastAdvisory.url, ADVISORY_PATH, 'forecast advisory');

    let track = null;
    if (storm.forecastTrack != null) {
        const metadata = parseAdvisory(storm.forecastTrack, 'forecastTrack');
        const zipPath = new RegExp(`^/gis/forecast/archive/${id}_5day_${metadata.number}\\.zip$`, 'i');
        const url = productUrl(storm.forecastTrack.zipFile, zipPath, 'forecast track ZIP');
        track = { ...metadata, url };
    }

    const intensityKt = numberField(storm.intensity, 'intensity', 0, 300);
    const row = {
        id,
        binNumber,
        name: redactContacts(storm.name),
        classification,
        basin: id.slice(0, 2),
        advisoryNumber: publicAdvisory.number,
        issuanceTime: publicAdvisory.issuance,
        lat: numberField(storm.latitude_numeric, 'latitude_numeric', -90, 90),
        lon: numberField(storm.longitude_numeric, 'longitude_numeric', -180, 180),
        intensityKt,
        intensityKmh: intensityKt === null ? null : Math.round(intensityKt * 1852) / 1000,
        pressureMb: numberField(storm.pressure, 'pressure', 0, 1100),
        movementDirDeg: numberField(storm.movementDir, 'movementDir', 0, 360),
        movementSpeedMph: numberField(storm.movementSpeed, 'movementSpeed', 0, 300),
        publicAdvisoryUrl,
        forecastAdvisoryUrl,
        forecastTrackUrl: track?.url ?? null,
        source: SOURCE,
    };
    return { row, track };
}

export function parseFeed(text) {
    let data;
    try {
        data = JSON.parse(text);
    } catch {
        throw new Error('Unrecognized CurrentStorms.json format: expected valid JSON.');
    }
    if (!isObject(data) || !Array.isArray(data.activeStorms)) {
        throw new Error('Unrecognized CurrentStorms.json format: expected an activeStorms array.');
    }
    const stormIds = new Set();
    return data.activeStorms.map((storm, index) => {
        try {
            const result = parseStorm(storm);
            if (stormIds.has(result.row.id)) throw new Error('duplicate storm id');
            stormIds.add(result.row.id);
            return result;
        } catch (error) {
            throw new Error(`Unrecognized CurrentStorms.json format at activeStorms[${index}]: ${error.message}.`);
        }
    });
}

export function sanitize(message) {
    return String(message)
        .replace(/(?<![A-Za-z0-9])[A-Za-z]:[\\/][^\s'"\x60)]*/g, '<path>')
        .replace(/\/(?:home|Users|root|tmp|var|usr)\/[^\s'"\x60)]*/g, '<path>');
}
