import { parseForecastTrack } from './forecast.js';
import { FEED_URL, meetsMinIntensity, parseFeed, parseInput, sanitize } from './nhc.js';

const USER_AGENT = 'nhc-tropical-cyclones-actor/1.0';
const REQUEST_INTERVAL_MS = 2350;
const RETRY_INTERVAL_MS = 60_000;
const MAX_RETRIES = 3;
const TIMEOUT_MS = 20_000;
const MAX_FEED_BYTES = 1024 * 1024;
const MAX_TRACK_BYTES = 2 * 1024 * 1024;
const MAX_TIMER_MS = 2 ** 31 - 1;
const STATE_STORE = 'nhc-tropical-cyclones-state';

class RequestError extends Error {}

function retryAfterMs(value) {
    if (!value) return 0;
    if (/^\d+$/.test(value)) {
        const milliseconds = Number(value) * 1000;
        if (!Number.isSafeInteger(milliseconds)) throw new RequestError('NHC Retry-After exceeds the supported wait time.');
        return milliseconds;
    }
    const time = Date.parse(value);
    return Number.isNaN(time) ? 0 : Math.max(0, time - Date.now());
}

async function readBody(response, maxBytes) {
    if (!response.body) return Buffer.alloc(0);
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) return Buffer.concat(chunks, size);
            size += value.byteLength;
            if (size > maxBytes) {
                await reader.cancel().catch(() => {});
                throw new RequestError(`response exceeded ${maxBytes} bytes`);
            }
            chunks.push(value);
        }
    } finally {
        reader.releaseLock();
    }
}

function createRequester({ fetch, log, sleep }) {
    let requested = false;
    return async function get(url, label, maxBytes) {
        if (requested) await sleep(REQUEST_INTERVAL_MS);
        requested = true;
        for (let attempt = 0; ; attempt++) {
            let failure;
            let retryAfter = 0;
            try {
                const response = await fetch(url, {
                    headers: { 'User-Agent': USER_AGENT },
                    redirect: 'manual',
                    signal: AbortSignal.timeout(TIMEOUT_MS),
                });
                if (response.status === 200) return await readBody(response, maxBytes);
                await response.body?.cancel().catch(() => {});
                failure = `HTTP ${response.status}`;
                if (response.status !== 429 && (response.status < 500 || response.status > 599)) {
                    throw new RequestError(failure);
                }
                retryAfter = retryAfterMs(response.headers.get('Retry-After'));
            } catch (error) {
                failure = sanitize(error?.message ?? error);
                if (error instanceof RequestError) throw new Error(`NHC ${label} request failed: ${failure}.`);
            }
            if (attempt >= MAX_RETRIES) throw new Error(`NHC ${label} request failed after ${attempt + 1} attempts: ${failure}.`);
            let wait = Math.max(RETRY_INTERVAL_MS * 2 ** attempt, retryAfter);
            log.warning(`NHC ${label} request failed (${failure}). Retrying in ${Math.ceil(wait / 1000)} seconds.`);
            while (wait > MAX_TIMER_MS) {
                await sleep(MAX_TIMER_MS);
                wait -= MAX_TIMER_MS;
            }
            await sleep(wait);
        }
    };
}

export async function run({
    actor, fetch = globalThis.fetch, log, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
    try {
        await actor.init();
        const input = parseInput((await actor.getInput()) ?? {});
        const get = createRequester({ fetch, log, sleep });
        const storms = parseFeed((await get(FEED_URL, 'CurrentStorms.json', MAX_FEED_BYTES)).toString('utf8'));
        if (!storms.length) {
            await actor.setValue('RUN_SUMMARY', { activeStorms: 0, forecastTrackErrors: 0 });
            log.info('NHC reports no active storms.');
            await actor.exit();
            return;
        }

        const candidates = storms.filter(({ row }) => input.basins.includes(row.basin)
            && meetsMinIntensity(row.classification, input.minIntensity));
        const state = input.onlyNew && candidates.length ? await actor.openKeyValueStore(STATE_STORE) : null;
        const summary = {
            activeStorms: storms.length,
            matchedStorms: candidates.length,
            unchanged: 0,
            pushed: 0,
            forecastTrackErrors: 0,
            chargeLimitReached: false,
        };
        for (const { row, track } of candidates) {
            const key = `seen-${input.stateKey}-${row.id}`;
            const advisory = `${row.advisoryNumber}/${row.issuanceTime}`;
            const noTrackFingerprint = input.includeForecastTrack ? `${advisory}/notrack` : advisory;
            const linkedTrack = input.includeForecastTrack ? track : null;
            let fingerprint = linkedTrack ? `${advisory}/track` : noTrackFingerprint;
            const previousFingerprint = state ? await state.getValue(key) : null;

            if (input.includeForecastTrack) row.forecastTrack = null;
            // A previously saved row without a track remains eligible for a fresh ZIP attempt.
            if (linkedTrack && previousFingerprint !== fingerprint) {
                let errorMessage = 'Could not fetch the NHC forecast ZIP.';
                try {
                    const archive = await get(linkedTrack.url, `forecast track for ${row.id}`, MAX_TRACK_BYTES);
                    errorMessage = 'Could not parse the NHC forecast ZIP.';
                    row.forecastTrack = await parseForecastTrack(archive, row.id, linkedTrack);
                } catch {
                    row.forecastTrackError = errorMessage;
                    fingerprint = noTrackFingerprint;
                    summary.forecastTrackErrors++;
                    log.warning(`${row.id}: ${errorMessage}`);
                }
            }
            if (previousFingerprint === fingerprint) {
                summary.unchanged++;
                continue;
            }

            const charge = await actor.pushData(row);
            summary.chargeLimitReached = charge?.eventChargeLimitReached === true;
            // A zero charge without a limit hit is also a successful push outside PPE.
            if (!summary.chargeLimitReached || charge.chargedCount > 0) {
                summary.pushed++;
                if (state) await state.setValue(key, fingerprint);
            }
            if (summary.chargeLimitReached) {
                log.warning('Pay-per-event charge limit reached. Stopping dataset output.');
                break;
            }
        }
        await actor.setValue('RUN_SUMMARY', summary);
        log.info(`NHC reports ${summary.activeStorms} active storms. Saved ${summary.pushed} dataset rows.`);
        await actor.exit();
    } catch (error) {
        const message = sanitize(error?.message ?? error);
        log.error(message);
        await actor.fail(message);
    }
}
