'use strict';
/**
 * lib/voices.js: the Voices URL, the connection check and its status mapping,
 * the voice parser and labels, and which voice gets selected. checkVoices runs
 * for real against a faked fetch and fake timers.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const TTSVoices = require('../lib/voices.js');
const { settle, createFakeTimers, createFakeFetch, jsonResponse, textResponse, hangUntilAbort } = require('./helpers/fake-chrome.js');

const { CONN, REASONS } = TTSVoices;
const SPEECH = 'http://localhost:8090/v1/audio/speech';
const VOICES = 'http://localhost:8090/v1/audio/voices?model=tts-1';

// --- Voices URL -----------------------------------------------------------------------------------

test('deriveVoicesUrl: keeps the origin, swaps /audio/speech for /audio/voices, drops query and fragment, adds ?model=tts-1', () => {
  const cases = [
    [SPEECH, VOICES],
    [`${SPEECH}/`, VOICES],
    [`${SPEECH}///`, VOICES],
    [`${SPEECH}?model=other&x=1`, VOICES],
    [`${SPEECH}#frag`, VOICES],
    [`${SPEECH}/?a=b#frag`, VOICES],
    ['  http://localhost:8090/v1/audio/speech  ', VOICES],
    ['https://tts.example.com/audio/speech', 'https://tts.example.com/audio/voices?model=tts-1'],
    ['http://user:pw@10.0.0.5:9000/openai/v1/audio/speech', 'http://user:pw@10.0.0.5:9000/openai/v1/audio/voices?model=tts-1'],
    ['http://localhost:8000/v1/audio/speech', 'http://localhost:8000/v1/audio/voices?model=tts-1']
  ];
  for (const [input, expected] of cases) assert.equal(TTSVoices.deriveVoicesUrl(input), expected, input);
});

test('deriveVoicesUrl: null when the path does not end in /audio/speech, or it is not an http(s) URL', () => {
  const cases = [
    'http://localhost:8090/', 'http://localhost:8090/v1/audio/voices', 'http://localhost:8090/v1/audio/speech/extra',
    'http://localhost:8090/v1/audio/speech.json', 'http://localhost:8090/audio/speechx', 'localhost:8090/v1/audio/speech',
    'ftp://localhost/v1/audio/speech', 'not a url', '', '   ', undefined, null, 42
  ];
  for (const input of cases) assert.equal(TTSVoices.deriveVoicesUrl(input), null, String(input));
});

test('checkVoices: a Server URL with no /audio/speech is connNoList with no fetch', async () => {
  const fetch = createFakeFetch(() => jsonResponse({ voices: ['A'] }));
  const result = await TTSVoices.checkVoices({ serverUrl: 'http://localhost:8090/v1/models', fetch });
  assert.deepEqual(result, { state: CONN.NO_LIST, reason: "Can't derive a voices address", voices: [] });
  assert.equal(fetch.calls.length, 0);
});

// --- Parser ---------------------------------------------------------------------------------------

test('parseVoices: strings, {voices:[...]}, a bare array, objects by id then name then voice', () => {
  const cases = [
    [{ status: 'ok', voices: ['Olivia.wav', 'Abigail.wav'] }, ['Olivia.wav', 'Abigail.wav']],
    [['af_bella', 'am_adam'], ['af_bella', 'am_adam']],
    [{ voices: [{ id: 'a', name: 'Ignored' }, { name: 'b', voice: 'Ignored' }, { voice: 'c' }] }, ['a', 'b', 'c']],
    [[{ id: 'x' }, 'y', { name: 'z' }], ['x', 'y', 'z']],
    [{ voices: [] }, []],
    [[], []]
  ];
  for (const [data, expected] of cases) assert.deepEqual(TTSVoices.parseVoices(data), expected, JSON.stringify(data));
});

test('parseVoices: empties and duplicates are dropped, server order is kept (no sorting)', () => {
  const data = { voices: ['b', '', '  ', 'a', 'b', null, 42, {}, { id: '' }, { id: 5 }, { name: 'a' }, 'c', 'a'] };
  assert.deepEqual(TTSVoices.parseVoices(data), ['b', 'a', 'c']);
  assert.deepEqual(TTSVoices.parseVoices(['z', 'y', 'x']), ['z', 'y', 'x']);
});

test('parseVoices: null when there is no voices array', () => {
  for (const data of [null, undefined, 'ok', 42, {}, { status: 'ok' }, { voices: 'Olivia.wav' }, { voices: { a: 1 } }, { data: [] }]) {
    assert.equal(TTSVoices.parseVoices(data), null, JSON.stringify(data));
  }
});

// --- Labels ---------------------------------------------------------------------------------------

test('labelVoices: strips a trailing .wav, .mp3, .flac or .ogg in any case; the id stays raw', () => {
  const ids = ['Olivia.wav', 'Adrian.MP3', 'Cora.Flac', 'Dee.OGG', 'plain', 'af_bella', 'dotted.name.wav', 'a.wav.txt', 'x.wavy'];
  assert.deepEqual(TTSVoices.labelVoices(ids).map((v) => v.label), ['Olivia', 'Adrian', 'Cora', 'Dee', 'plain', 'af_bella', 'dotted.name', 'a.wav.txt', 'x.wavy']);
  assert.deepEqual(TTSVoices.labelVoices(ids).map((v) => v.id), ids);
});

test('labelVoices: ids that differ only by extension show their raw ids; the others keep their labels', () => {
  const labelled = TTSVoices.labelVoices(['Olivia.wav', 'Thomas.wav', 'Olivia.mp3']);
  assert.deepEqual(labelled, [
    { id: 'Olivia.wav', label: 'Olivia.wav' },
    { id: 'Thomas.wav', label: 'Thomas' },
    { id: 'Olivia.mp3', label: 'Olivia.mp3' }
  ]);
  // A bare id that equals another's label collides too.
  assert.deepEqual(TTSVoices.labelVoices(['Olivia', 'Olivia.WAV']).map((v) => v.label), ['Olivia', 'Olivia.WAV']);
});

test('labelVoices: an id that is only an extension keeps its raw id; order is kept', () => {
  assert.deepEqual(TTSVoices.labelVoices(['.wav', 'B.wav', 'A.wav']).map((v) => v.label), ['.wav', 'B', 'A']);
});

// --- Reconcile ------------------------------------------------------------------------------------

const LIST = TTSVoices.labelVoices(['Abigail.wav', 'Olivia.wav', 'Thomas.wav']);
const KOKORO = TTSVoices.labelVoices(['af_bella', 'am_adam']);

test('reconcileVoice: a saved voice on the list is kept, without a note', () => {
  assert.deepEqual(TTSVoices.reconcileVoice('Olivia.wav', LIST), { voice: 'Olivia.wav', note: '' });
});

test('reconcileVoice: a saved voice that is not on the list gives the first voice and a note', () => {
  assert.deepEqual(TTSVoices.reconcileVoice('Zed.wav', LIST), {
    voice: 'Abigail.wav',
    note: 'Voice Zed.wav is not on this server; using Abigail'
  });
});

test('reconcileVoice: an empty or missing saved voice is unset: first voice, no note', () => {
  for (const saved of ['', '   ', undefined, null, 5]) {
    assert.deepEqual(TTSVoices.reconcileVoice(saved, LIST), { voice: 'Abigail.wav', note: '' }, String(saved));
  }
});

test('reconcileVoice: af_bella is unset when the server does not offer it, and kept when it does', () => {
  assert.deepEqual(TTSVoices.reconcileVoice('af_bella', LIST), { voice: 'Abigail.wav', note: '' });
  assert.deepEqual(TTSVoices.reconcileVoice('af_bella', KOKORO), { voice: 'af_bella', note: '' });
  assert.deepEqual(TTSVoices.reconcileVoice('am_adam', KOKORO), { voice: 'am_adam', note: '' });
});

// --- Defaults -------------------------------------------------------------------------------------

test('normalizeServerUrl: missing, empty and the old port-8000 default count as unset; anything else is kept', () => {
  const dflt = 'http://localhost:8090/v1/audio/speech';
  for (const stored of [undefined, null, '', '   ', 5, 'http://localhost:8000/v1/audio/speech', ' http://localhost:8000/v1/audio/speech ']) {
    assert.equal(TTSVoices.normalizeServerUrl(stored, dflt), dflt, String(stored));
  }
  for (const stored of ['http://localhost:9999/v1/audio/speech', 'http://localhost:8000/v1/audio/speech2', 'http://other:8000/v1/audio/speech']) {
    assert.equal(TTSVoices.normalizeServerUrl(stored, dflt), stored);
  }
});

// --- Status mapping (checkVoices against a faked fetch) -------------------------------------------

async function check(respond, options = {}) {
  const fetch = createFakeFetch(respond);
  const timers = createFakeTimers();
  const result = await TTSVoices.checkVoices({ serverUrl: SPEECH, fetch, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout, ...options });
  return { result, fetch, timers };
}

test('status mapping: 200 with voices is connOk with labelled voices, in server order', async () => {
  const { result, fetch } = await check(() => jsonResponse({ status: 'ok', voices: ['Olivia.wav', 'Abigail.wav'] }));
  assert.deepEqual(result, {
    state: CONN.OK,
    reason: '',
    voices: [{ id: 'Olivia.wav', label: 'Olivia' }, { id: 'Abigail.wav', label: 'Abigail' }]
  });
  assert.equal(fetch.calls.length, 1);
});

test('status mapping: the request is a plain GET of the derived Voices URL - no headers, no auth, no method override, no body', async () => {
  const { fetch } = await check(() => jsonResponse({ voices: ['A'] }), { serverUrl: `${SPEECH}?x=1#y` });
  assert.equal(fetch.calls[0].url, VOICES);
  assert.deepEqual(Object.keys(fetch.calls[0].init), ['signal']);
  assert.equal(fetch.calls[0].init.headers, undefined);
  assert.equal(fetch.calls[0].body, null);
});

test('status mapping: 200 with a bare array works (Kokoro-FastAPI)', async () => {
  const { result } = await check(() => jsonResponse(['af_bella', 'am_adam']));
  assert.equal(result.state, CONN.OK);
  assert.deepEqual(result.voices.map((v) => v.id), ['af_bella', 'am_adam']);
});

test('status mapping: 200 with an empty list is connNoVoices', async () => {
  const { result } = await check(() => jsonResponse({ status: 'ok', voices: [] }));
  assert.deepEqual(result, { state: CONN.NO_VOICES, reason: 'Server has no voices', voices: [] });
  // Entries that are all empty or duplicates leave nothing, which is also an empty list.
  const { result: junk } = await check(() => jsonResponse({ voices: ['', null] }));
  assert.equal(junk.state, CONN.NO_VOICES);
});

test('status mapping: 404 and 405 are connNoList (connected, no voice list)', async () => {
  for (const status of [404, 405]) {
    const { result } = await check(() => jsonResponse({}, status));
    assert.deepEqual(result, { state: CONN.NO_LIST, reason: 'Connected, no voice list', voices: [] }, String(status));
  }
});

test('status mapping: 401 and 403 are reported as Not authorised, not handled (one request, no retry)', async () => {
  for (const status of [401, 403]) {
    const { result, fetch } = await check(() => jsonResponse({ error: 'nope' }, status));
    assert.deepEqual(result, { state: CONN.FAILED, reason: `Not authorised (${status})`, voices: [] });
    assert.equal(fetch.calls.length, 1);
  }
});

test('status mapping: any other non-200 is Server error N', async () => {
  for (const status of [500, 502, 503, 400, 418, 204, 301]) {
    const { result } = await check(() => jsonResponse({ voices: ['A'] }, status));
    assert.deepEqual(result, { state: CONN.FAILED, reason: `Server error ${status}`, voices: [] }, String(status));
  }
});

test('status mapping: a 200 that is not JSON, or JSON with no voices array, is Unexpected response', async () => {
  const responders = [
    () => textResponse('<html>hello</html>'),
    () => jsonResponse({ status: 'ok' }),
    () => jsonResponse({ voices: 'Olivia.wav' }),
    () => jsonResponse(null),
    () => jsonResponse('ok'),
    () => jsonResponse(42)
  ];
  for (const respond of responders) {
    const { result } = await check(respond);
    assert.deepEqual(result, { state: CONN.FAILED, reason: 'Unexpected response', voices: [] });
  }
});

test('status mapping: a non-JSON body is never quoted in the result', async () => {
  const { result } = await check(() => textResponse('secret-token-123'));
  assert.ok(!JSON.stringify(result).includes('secret-token-123'));
});

test("status mapping: whatever fetch throws is \"Can't reach server - is it running?\", whatever its message", async () => {
  const messages = ['Failed to fetch', 'net::ERR_CONNECTION_REFUSED', 'NetworkError when attempting to fetch resource', 'getaddrinfo ENOTFOUND', 'CORS blocked', 'Mixed Content', '', 'The operation was aborted.'];
  for (const message of messages) {
    const { result } = await check(() => { throw new TypeError(message); });
    assert.deepEqual(result, { state: CONN.FAILED, reason: "Can't reach server - is it running?", voices: [] }, message);
  }
  // Even a thrown AbortError: only our own timeout or the caller's signal count as those.
  const { result } = await check(() => { const e = new Error('x'); e.name = 'AbortError'; throw e; });
  assert.equal(result.reason, REASONS.UNREACHABLE);
  // A rejected promise, not just a throw.
  const { result: rejected } = await check(() => Promise.reject(new TypeError('Failed to fetch')));
  assert.equal(rejected.reason, REASONS.UNREACHABLE);
});

test('status mapping: a caller abort is { aborted: true } and silent, whether before, during or after the request', async () => {
  const early = new AbortController();
  early.abort();
  const { result: before, fetch } = await check(() => jsonResponse({ voices: ['A'] }), { signal: early.signal });
  assert.deepEqual(before, { aborted: true });
  assert.equal(fetch.calls.length, 0);

  const controller = new AbortController();
  const fetchFn = createFakeFetch(({ signal }) => hangUntilAbort(signal));
  const timers = createFakeTimers();
  const pending = TTSVoices.checkVoices({ serverUrl: SPEECH, fetch: fetchFn, signal: controller.signal, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout });
  await settle();
  controller.abort();
  assert.deepEqual(await pending, { aborted: true });
  assert.equal(timers.pending, 0, 'the timeout is cleared');
});

test('status mapping: an answer that arrives after the caller aborted is { aborted: true }, not a result', async () => {
  const controller = new AbortController();
  let answer;
  const fetchFn = createFakeFetch(() => new Promise((resolve) => { answer = () => resolve(jsonResponse({ voices: ['A.wav'] })); }));
  const pending = TTSVoices.checkVoices({ serverUrl: SPEECH, fetch: fetchFn, signal: controller.signal });
  await settle();
  controller.abort();
  answer();
  assert.deepEqual(await pending, { aborted: true });
});

test('status mapping: still waiting at 89.999 s is not a result; at 90 s it is "Timed out - click the light to retry"', async () => {
  const fetchFn = createFakeFetch(({ signal }) => hangUntilAbort(signal));
  const timers = createFakeTimers();
  let result = null;
  const pending = TTSVoices.checkVoices({ serverUrl: SPEECH, fetch: fetchFn, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout })
    .then((r) => { result = r; });
  await timers.tick(89999);
  assert.equal(result, null, 'a cold start is never red before the timeout');
  await timers.tick(1);
  await pending;
  assert.deepEqual(result, { state: CONN.FAILED, reason: 'Timed out - click the light to retry', voices: [] });
  assert.equal(fetchFn.calls[0].init.signal.aborted, true, 'the request is abandoned');
});

test('status mapping: the 90 s timeout also covers reading the body', async () => {
  const fetchFn = createFakeFetch(({ signal }) => ({
    status: 200,
    ok: true,
    json: () => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))))
  }));
  const timers = createFakeTimers();
  let result = null;
  const pending = TTSVoices.checkVoices({ serverUrl: SPEECH, fetch: fetchFn, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout })
    .then((r) => { result = r; });
  await timers.tick(90000);
  await pending;
  assert.equal(result.reason, REASONS.TIMED_OUT);
});

test('status mapping: a quick answer clears the timeout timer', async () => {
  const { timers } = await check(() => jsonResponse({ voices: ['A'] }));
  assert.equal(timers.pending, 0);
});

test('status mapping: with no injected fetch the global fetch is used', async () => {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => { calls.push({ url, init }); return jsonResponse({ voices: ['A.wav'] }); };
  try {
    const result = await TTSVoices.checkVoices({ serverUrl: SPEECH });
    assert.equal(result.state, CONN.OK);
    assert.equal(calls[0].url, VOICES);
  } finally {
    globalThis.fetch = original;
  }
});

// --- Play gate ------------------------------------------------------------------------------------

test('connectionAllowsPlay: open for connOk, and for connNoList only with a voice name', () => {
  assert.equal(TTSVoices.connectionAllowsPlay(CONN.OK, ''), true);
  assert.equal(TTSVoices.connectionAllowsPlay(CONN.NO_LIST, 'Olivia.wav'), true);
  assert.equal(TTSVoices.connectionAllowsPlay(CONN.NO_LIST, ''), false);
  assert.equal(TTSVoices.connectionAllowsPlay(CONN.NO_LIST, '  '), false);
  for (const state of [CONN.IDLE, CONN.CHECKING, CONN.STARTING, CONN.NO_VOICES, CONN.FAILED]) {
    assert.equal(TTSVoices.connectionAllowsPlay(state, 'Olivia.wav'), false, state);
  }
});
