import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { FEED_URL } from '../src/nhc.js';
import { run } from '../src/run.js';

const empty = await readFile(new URL('./fixtures/current-storms-empty.json', import.meta.url), 'utf8');
const sample = await readFile(new URL('./fixtures/current-storms-sample.json', import.meta.url), 'utf8');
const forecast = await readFile(new URL('./fixtures/al112017_5day_042.zip', import.meta.url));
const trackUrl = 'https://www.nhc.noaa.gov/gis/forecast/archive/al112017_5day_042.zip';
const firstKey = 'seen-default-AL112017';
const secondKey = 'seen-default-AL122017';

async function simulate({ input, responses = [sample], charges = [], seen = new Map() } = {}) {
    const requests = [];
    const pauses = [];
    const rows = [];
    const messages = { info: [], warning: [], error: [] };
    const events = [];
    const values = {};
    let failure;
    let exited = false;
    const actor = {
        async init() {},
        async getInput() { return input; },
        async openKeyValueStore(name) {
            assert.equal(name, 'nhc-tropical-cyclones-state');
            return {
                async getValue(key) { return seen.get(key); },
                async setValue(key, value) { events.push(`state:${key}`); seen.set(key, value); },
            };
        },
        async pushData(row) {
            events.push(`push:${row.id}`);
            const result = charges.shift() ?? { eventChargeLimitReached: false, chargedCount: 0 };
            if (result instanceof Error) throw result;
            if (!result.eventChargeLimitReached || result.chargedCount > 0) rows.push(row);
            return result;
        },
        async setValue(key, value) { values[key] = value; },
        async exit() { exited = true; },
        async fail(message) { failure = message; },
    };
    await run({
        actor,
        async fetch(url, options) {
            requests.push(url);
            assert.equal(options.redirect, 'manual');
            const response = responses.shift();
            if (response === undefined) throw new Error('Unexpected request');
            if (response instanceof Error) throw response;
            return response instanceof Response ? response : new Response(response);
        },
        log: {
            info: (message) => messages.info.push(message),
            warning: (message) => messages.warning.push(message),
            error: (message) => messages.error.push(message),
        },
        async sleep(ms) { pauses.push(ms); },
    });
    return { requests, pauses, rows, messages, events, values, failure, exited };
}

test('default off-season run succeeds with zero rows and a summary', async () => {
    const result = await simulate({ responses: [empty] });
    assert.deepEqual(result.requests, [FEED_URL]);
    assert.deepEqual(result.pauses, []);
    assert.deepEqual(result.rows, []);
    assert.deepEqual(result.values.RUN_SUMMARY, { activeStorms: 0, forecastTrackErrors: 0 });
    assert.equal(result.exited, true);
    assert.match(result.messages.info[0], /no active storms/);
});

test('fetches only matching forecast products sequentially and includes their points by default', async () => {
    const { activeStorms: [irma, jose] } = JSON.parse(sample);
    Object.assign(jose, { id: 'cp122017', binNumber: 'CP2', classification: 'TS', forecastTrack: null });
    const feed = JSON.stringify({ activeStorms: [irma, jose] });
    const result = await simulate({
        input: { basins: ['AL', 'CP'], minIntensity: 'HU' }, responses: [feed, forecast],
    });
    assert.equal(result.exited, true, result.failure);
    assert.deepEqual(result.requests, [FEED_URL, trackUrl]);
    assert.deepEqual(result.pauses, [2350]);
    assert.deepEqual(result.rows.map(({ id }) => id), ['AL112017']);
    assert.equal(result.rows[0].forecastTrack.length, 7);
    assert.equal(result.values.RUN_SUMMARY.activeStorms, 2);

    const central = await simulate({ input: { basins: ['CP'], minIntensity: 'TS' }, responses: [feed] });
    assert.equal(central.exited, true, central.failure);
    assert.equal(central.rows[0].id, 'CP122017');
    assert.equal(central.rows[0].forecastTrack, null);
    assert.equal(Object.hasOwn(central.rows[0], 'forecastTrackError'), false);
    assert.equal(central.values.RUN_SUMMARY.forecastTrackErrors, 0);
    assert.deepEqual(central.requests, [FEED_URL]);
});

for (const [step, zipResponse] of [
    ['fetch', new Response(null, { status: 404 })],
    ['parse', forecast],
]) {
    test(`a forecast ZIP ${step} failure still saves other storms and the run succeeds`, async () => {
        const { activeStorms: [irma, jose] } = JSON.parse(sample);
        const feed = JSON.stringify({ activeStorms: [jose, irma] });
        // The parse case serves a valid ZIP that contains Irma's points instead of Jose's.
        const result = await simulate({ responses: [feed, zipResponse, forecast] });

        assert.equal(result.exited, true, result.failure);
        assert.deepEqual(result.messages.error, []);
        assert.deepEqual(result.requests, [
            FEED_URL, 'https://www.nhc.noaa.gov/gis/forecast/archive/al122017_5day_017.zip', trackUrl,
        ]);
        assert.deepEqual(result.rows.map(({ id }) => id), ['AL122017', 'AL112017']);
        const [failed, healthy] = result.rows;
        const message = `Could not ${step} the NHC forecast ZIP.`;
        assert.equal(failed.forecastTrack, null);
        assert.equal(failed.forecastTrackError, message);
        assert.equal(healthy.forecastTrack.length, 7);
        assert.equal(Object.hasOwn(healthy, 'forecastTrackError'), false);
        assert.deepEqual(result.messages.warning, [`AL122017: ${message}`]);
        assert.equal(result.values.RUN_SUMMARY.forecastTrackErrors, 1);
        assert.equal(result.values.RUN_SUMMARY.pushed, 2);
    });
}

test('a notrack fingerprint retries the same advisory and emits again when the ZIP is ready', async () => {
    const advisory = '042/2017-09-09T15:00:00.000Z';
    const seen = new Map([[firstKey, advisory]]);
    const input = { onlyNew: true };
    const { activeStorms: [irma] } = JSON.parse(sample);
    const feed = JSON.stringify({ activeStorms: [irma] });
    const runWithZip = (zip) => simulate({ input, seen, responses: [feed, zip] });

    const first = await runWithZip(new Response(null, { status: 404 }));
    assert.equal(first.exited, true, first.failure);
    assert.equal(first.rows.length, 1);
    assert.equal(first.rows[0].forecastTrack, null);
    assert.equal(seen.get(firstKey), `${advisory}/notrack`);

    const stillMissing = await runWithZip(new Response(null, { status: 404 }));
    assert.equal(stillMissing.exited, true, stillMissing.failure);
    assert.deepEqual(stillMissing.requests, [FEED_URL, trackUrl]);
    assert.deepEqual(stillMissing.rows, []);
    assert.equal(stillMissing.values.RUN_SUMMARY.forecastTrackErrors, 1);
    assert.equal(stillMissing.values.RUN_SUMMARY.unchanged, 1);

    const recovered = await runWithZip(forecast);
    assert.equal(recovered.exited, true, recovered.failure);
    assert.equal(recovered.rows.length, 1);
    assert.equal(recovered.rows[0].forecastTrack.length, 7);
    assert.equal(Object.hasOwn(recovered.rows[0], 'forecastTrackError'), false);
    assert.equal(recovered.values.RUN_SUMMARY.forecastTrackErrors, 0);
    assert.equal(seen.get(firstKey), `${advisory}/track`);

    const unchanged = await simulate({ input, seen, responses: [feed] });
    assert.equal(unchanged.exited, true, unchanged.failure);
    assert.deepEqual(unchanged.requests, [FEED_URL]);
    assert.deepEqual(unchanged.rows, []);
    assert.equal(unchanged.values.RUN_SUMMARY.unchanged, 1);
});

test('stores only PPE rows that were saved and resumes with an uncharged storm next run', async () => {
    const seen = new Map();
    const input = { onlyNew: true, includeForecastTrack: false };
    const first = await simulate({
        input, seen, charges: [
            { eventChargeLimitReached: false, chargedCount: 0 },
            { eventChargeLimitReached: true, chargedCount: 0 },
        ],
    });
    assert.equal(first.exited, true, first.failure);
    assert.deepEqual(first.rows.map(({ id }) => id), ['AL112017']);
    assert.equal(Object.hasOwn(first.rows[0], 'forecastTrack'), false);
    assert.deepEqual(first.events, ['push:AL112017', `state:${firstKey}`, 'push:AL122017']);
    assert.equal(first.values.RUN_SUMMARY.pushed, 1);
    assert.equal(first.values.RUN_SUMMARY.chargeLimitReached, true);
    assert.equal(seen.has(secondKey), false);

    const second = await simulate({
        input, seen, charges: [{ eventChargeLimitReached: true, chargedCount: 1 }],
    });
    assert.deepEqual(second.rows.map(({ id }) => id), ['AL122017']);
    assert.deepEqual(second.events, ['push:AL122017', `state:${secondKey}`]);
    assert.equal(second.values.RUN_SUMMARY.unchanged, 1);
    assert.equal(second.values.RUN_SUMMARY.pushed, 1);
    assert.equal(seen.has(secondKey), true);

    const third = await simulate({ input, seen });
    assert.deepEqual(third.rows, []);
    assert.equal(third.values.RUN_SUMMARY.unchanged, 2);
});

test('a change to either public advisory fingerprint component makes a storm eligible', async () => {
    const seen = new Map([[firstKey, '042/2017-09-09T15:00:00.000Z']]);
    const input = { onlyNew: true, includeForecastTrack: false };
    const { activeStorms: [storm] } = JSON.parse(sample);
    const feed = () => JSON.stringify({ activeStorms: [storm] });
    storm.publicAdvisory.advNum = '042A';
    assert.equal((await simulate({ input, seen, responses: [feed()] })).rows.length, 1);
    storm.publicAdvisory.issuance = '2017-09-09T16:00:00Z';
    assert.equal((await simulate({ input, seen, responses: [feed()] })).rows.length, 1);
    storm.lastUpdate = '2017-09-09T17:00:00Z';
    assert.equal((await simulate({ input, seen, responses: [feed()] })).rows.length, 0);
    assert.equal((await simulate({ input: { ...input, stateKey: 'other' }, seen, responses: [feed()] })).rows.length, 1);
});

test('previous state survives when a later write fails, with local paths masked', async () => {
    const seen = new Map();
    const result = await simulate({
        input: { onlyNew: true, includeForecastTrack: false },
        charges: [null, new Error('Cannot write /tmp/local/storage.')],
        seen,
    });
    assert.equal(result.exited, false);
    assert.equal(result.failure, 'Cannot write <path>');
    assert.deepEqual(result.messages.error, ['Cannot write <path>']);
    assert.deepEqual([...seen.keys()], [firstKey]);
});

test('backs off for 429, 5xx and network errors and honors Retry-After', async () => {
    const result = await simulate({
        responses: [
            new Response(null, { status: 429, headers: { 'Retry-After': '95' } }),
            new Error('Network unavailable'),
            new Response(null, { status: 503 }),
            empty,
        ],
    });
    assert.equal(result.exited, true, result.failure);
    assert.deepEqual(result.pauses, [95_000, 120_000, 240_000]);
    assert.equal(result.requests.length, 4);
});

test('uses an HTTP date for Retry-After and stops after three retries', async (t) => {
    t.mock.method(Date, 'now', () => Date.parse('2026-01-01T00:00:00Z'));
    const response = (headers) => new Response(null, { status: 503, headers });
    const result = await simulate({
        responses: [response({ 'Retry-After': 'Thu, 01 Jan 2026 00:01:15 GMT' }), response(), response(), response()],
    });
    assert.deepEqual(result.pauses, [75_000, 120_000, 240_000]);
    assert.equal(result.requests.length, 4);
    assert.match(result.failure, /failed after 4 attempts: HTTP 503/);
});

test('fails without retries on a 403 or on a changed feed format', async () => {
    const blocked = await simulate({ responses: [new Response(null, { status: 403 })] });
    assert.deepEqual(blocked.requests, [FEED_URL]);
    assert.match(blocked.failure, /HTTP 403/);
    const changed = await simulate({ responses: ['{"stormList":[]}'] });
    assert.deepEqual(changed.requests, [FEED_URL]);
    assert.match(changed.failure, /Unrecognized CurrentStorms.json format/);
    assert.equal(changed.values.RUN_SUMMARY, undefined);
});
