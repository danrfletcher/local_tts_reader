'use strict';
/**
 * G9: the voice check at the start of a right-click Read Aloud, through the
 * real background.js (loadBackground). The fake fetch serves the voices route
 * (GET .../audio/voices) from `fetch.voices` and the speech route as usual;
 * voices requests are kept in `fetch.voiceCalls`, speech requests in
 * `fetch.calls`, and `fetch.log` has both in arrival order.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { settle, loadBackground, createFakeFetch } = require('./helpers/fake-chrome.js');
const { playChunks } = require('./helpers/session.js');
const {
  SENTENCES, RAW_SETTINGS, createGatedFetch, pressPlayNoWait, control, chunkReady, endChunk, liveSession
} = require('./helpers/pause.js');

const SPEECH_URL = 'http://localhost:8090/v1/audio/speech';
const VOICES_URL = 'http://localhost:8090/v1/audio/voices?model=tts-1';
const NO_VOICE = 'No voice selected - open the popup';
const ONE = ['Hello there friend.'];

function rightClick(bg) {
  bg.listeners.menuClicked[0]({ menuItemId: 'readAloud', frameId: 0 }, { id: 7 });
}

const playerStates = (bg) => bg.sentOfType('playerStateUpdate').map((m) => m.state);
const errors = (bg) => bg.sentOfType('streamError').map((m) => m.error);

// What the player shows for a read that goes ahead when nothing was reading
// before (a stop of an earlier session adds a leading 'stopped'): "starting"
// at once (the voices check), then the session's own loading and starting.
const READ_STATES = ['starting', 'loading', 'starting'];
// ... and for a start that is refused after the check.
const REFUSED_STATES = ['starting', 'stopped'];

/** A background whose fetch serves `voices` (a fetch.voices spec) and whose storage holds `stored`. */
function setup({ stored = {}, voices = {}, sentences = ONE } = {}) {
  const fetch = createFakeFetch(undefined, { voices });
  const bg = loadBackground({ sentences, localStorage: stored, fetch });
  return { bg, fetch };
}

/** Everything the check may have written to chrome.storage.local, minus the always-on debug log. */
function storageWrites(bg) {
  return bg.chrome.storage.local.setCalls.flatMap((call) => Object.keys(call)).filter((key) => key !== 'ttsDebugLog');
}

// --- Every outcome of the check ------------------------------------------------------------

const LISTED = ['Abigail.wav', 'Olivia.wav', 'Thomas.wav'];

// `expect`: the voice in the first speech request body, or { error } for a refused start.
const OUTCOMES = [
  { name: 'the list offers the saved voice: it is sent', voices: { voices: LISTED }, stored: 'Olivia.wav', expect: 'Olivia.wav' },
  { name: 'the list does not offer the saved voice: the first voice is sent, with no note', voices: { voices: LISTED }, stored: 'Gone.wav', expect: 'Abigail.wav' },
  { name: 'saved voice empty: the first voice', voices: { voices: LISTED }, stored: '', expect: 'Abigail.wav' },
  { name: 'nothing stored for the voice: the first voice', voices: { voices: LISTED }, stored: undefined, expect: 'Abigail.wav' },
  { name: 'af_bella and the server lists it (a Kokoro server): af_bella is sent', voices: { bare: ['af_sky', 'af_bella'] }, stored: 'af_bella', expect: 'af_bella' },
  { name: 'af_bella and the server does not list it: it counts as unset, the first voice is sent', voices: { voices: LISTED }, stored: 'af_bella', expect: 'Abigail.wav' },
  { name: 'a bare-array list (Kokoro shape) is read', voices: { bare: ['Olivia.wav', 'Thomas.wav'] }, stored: 'Thomas.wav', expect: 'Thomas.wav' },
  { name: 'a list of {id} objects is read', voices: { voices: [{ id: 'Olivia.wav' }, { id: 'Thomas.wav' }] }, stored: '', expect: 'Olivia.wav' },
  { name: '404 (no voices endpoint): the saved voice is sent as is', voices: { status: 404 }, stored: 'Typed.wav', expect: 'Typed.wav' },
  { name: '405 (no voices endpoint): the saved voice is sent as is', voices: { status: 405 }, stored: 'Typed.wav', expect: 'Typed.wav' },
  { name: '404 and the saved voice empty: no read starts', voices: { status: 404 }, stored: '', expect: { error: NO_VOICE } },
  { name: '405 and the saved voice empty: no read starts', voices: { status: 405 }, stored: '', expect: { error: NO_VOICE } },
  { name: '404 and the saved voice blank: no read starts', voices: { status: 404 }, stored: '   ', expect: { error: NO_VOICE } },
  { name: '401: the check failed, the saved voice is sent', voices: { status: 401 }, stored: 'Olivia.wav', expect: 'Olivia.wav' },
  { name: '403: the check failed, the saved voice is sent', voices: { status: 403 }, stored: 'Olivia.wav', expect: 'Olivia.wav' },
  { name: '500: the check failed, the saved voice is sent', voices: { status: 500 }, stored: 'Olivia.wav', expect: 'Olivia.wav' },
  { name: '500 and the saved voice empty: no read starts', voices: { status: 500 }, stored: '', expect: { error: NO_VOICE } },
  { name: 'a body that is not JSON: the saved voice is sent', voices: { text: '<html>hello</html>' }, stored: 'Olivia.wav', expect: 'Olivia.wav' },
  { name: 'JSON with no voices array: the saved voice is sent', voices: { bare: undefined, voices: 'nope' }, stored: 'Olivia.wav', expect: 'Olivia.wav' },
  { name: 'a network error: the saved voice is sent', voices: { networkError: true }, stored: 'Olivia.wav', expect: 'Olivia.wav' },
  { name: 'a network error and the saved voice empty: no read starts', voices: { networkError: true }, stored: '', expect: { error: NO_VOICE } },
  { name: 'a non-JSON body and the saved voice empty: no read starts', voices: { text: 'oops' }, stored: '', expect: { error: NO_VOICE } },
  { name: 'a list with no voices (200, empty): no read starts and the reason is the light\'s', voices: { voices: [] }, stored: 'Olivia.wav', expect: { error: 'Server has no voices' } }
];

for (const row of OUTCOMES) {
  test(`G9: ${row.name}`, async () => {
    const stored = row.stored === undefined ? {} : { voice: row.stored };
    const { bg, fetch } = setup({ stored, voices: row.voices });
    rightClick(bg);
    await settle();

    // Exactly one voices GET, to the derived address, before any speech request.
    assert.equal(fetch.voiceCalls.length, 1);
    assert.equal(fetch.voiceCalls[0].url, VOICES_URL);
    assert.equal(fetch.voiceCalls[0].method, 'GET');
    assert.deepEqual(Object.keys(fetch.voiceCalls[0].init), ['signal'], 'a plain GET: no headers, no body');
    assert.equal(fetch.log[0].url, VOICES_URL);

    if (typeof row.expect === 'string') {
      assert.equal(fetch.calls.length, 1);
      assert.equal(fetch.log[1].url, SPEECH_URL);
      assert.equal(fetch.calls[0].body.voice, row.expect);
      assert.deepEqual(Object.keys(fetch.calls[0].body).sort(), ['input', 'model', 'speed', 'voice']);
      assert.equal(fetch.calls[0].body.model, 'tts-1');
      assert.equal(playChunks(bg).length, 1);
      assert.deepEqual(playerStates(bg), READ_STATES);
      assert.deepEqual(errors(bg), []);
    } else {
      assert.equal(fetch.calls.length, 0, 'no speech request');
      assert.equal(playChunks(bg).length, 0);
      assert.deepEqual(errors(bg), [row.expect.error]);
      assert.deepEqual(playerStates(bg), REFUSED_STATES);
      assert.ok(!liveSession(bg) || liveSession(bg).stopped, 'no live session');
    }
    assert.deepEqual(storageWrites(bg), [], 'the check writes nothing to chrome.storage.local');
  });
}

test('G9: the 90 s timeout: nothing starts at 89.999 s, the saved voice is sent at 90 s', async () => {
  const { bg, fetch } = setup({ stored: { voice: 'Olivia.wav' }, voices: { hang: true } });
  rightClick(bg);
  await bg.timers.tick(89999);
  assert.equal(fetch.voiceCalls.length, 1);
  assert.equal(fetch.voiceCalls[0].signal.aborted, false);
  assert.equal(fetch.calls.length, 0, 'still waiting for the voices');
  assert.deepEqual(playerStates(bg), ['starting']);

  await bg.timers.tick(1);
  assert.equal(fetch.voiceCalls.length, 1, 'one voices request, not retried');
  assert.equal(fetch.voiceCalls[0].signal.aborted, true);
  assert.equal(fetch.calls.length, 1);
  assert.equal(fetch.calls[0].body.voice, 'Olivia.wav');
  assert.deepEqual(playerStates(bg), READ_STATES);
});

test('G9: the 90 s timeout with an empty saved voice: no read starts', async () => {
  const { bg, fetch } = setup({ stored: {}, voices: { hang: true } });
  rightClick(bg);
  await bg.timers.tick(90000);
  assert.equal(fetch.calls.length, 0);
  assert.deepEqual(errors(bg), [NO_VOICE]);
  assert.deepEqual(playerStates(bg), REFUSED_STATES);
});

test('G9: a server URL that does not end in /audio/speech makes no voices fetch; the saved voice is sent as is, to that URL', async () => {
  const { bg, fetch } = setup({ stored: { serverUrl: 'http://tts.example.invalid:9000/synthesize', voice: 'Typed.wav' } });
  rightClick(bg);
  await settle();
  assert.equal(fetch.voiceCalls.length, 0);
  assert.equal(fetch.calls.length, 1);
  assert.equal(fetch.calls[0].url, 'http://tts.example.invalid:9000/synthesize');
  assert.equal(fetch.calls[0].body.voice, 'Typed.wav');
  assert.deepEqual(playerStates(bg), READ_STATES);
});

test('G9: a server URL that does not end in /audio/speech and an empty saved voice: no read starts, still no fetch', async () => {
  const { bg, fetch } = setup({ stored: { serverUrl: 'http://tts.example.invalid:9000/synthesize' } });
  rightClick(bg);
  await settle();
  assert.equal(fetch.voiceCalls.length, 0);
  assert.equal(fetch.log.length, 0);
  assert.deepEqual(errors(bg), [NO_VOICE]);
});

test('G9: a stored custom Server URL is used for both the voices GET and the speech request', async () => {
  const { bg, fetch } = setup({ stored: { serverUrl: 'https://tts.example.invalid:9443/proxy/v1/audio/speech?x=1', voice: 'Olivia.wav' } });
  rightClick(bg);
  await settle();
  assert.equal(fetch.voiceCalls[0].url, 'https://tts.example.invalid:9443/proxy/v1/audio/voices?model=tts-1');
  assert.equal(fetch.calls[0].url, 'https://tts.example.invalid:9443/proxy/v1/audio/speech?x=1');
});

test('G9: a stored server URL equal to the old 8000 default is replaced by the 8090 default for both requests, and nothing is written back', async () => {
  const { bg, fetch } = setup({ stored: { serverUrl: 'http://localhost:8000/v1/audio/speech', voice: 'Olivia.wav' } });
  rightClick(bg);
  await settle();
  assert.equal(fetch.voiceCalls[0].url, VOICES_URL);
  assert.equal(fetch.calls[0].url, SPEECH_URL);
  assert.deepEqual(storageWrites(bg), []);
  assert.equal((await bg.chrome.storage.local.get('serverUrl')).serverUrl, 'http://localhost:8000/v1/audio/speech', 'storage still holds what the user had');
});

test('G9: a read never writes voice or any other key to chrome.storage.local (the always-on debug log aside), whatever the check found', async () => {
  for (const voices of [{ voices: LISTED }, { status: 404 }, { networkError: true }, { text: 'x' }, { voices: [] }]) {
    const { bg } = setup({ stored: { voice: 'Gone.wav', speed: 1.5 }, voices });
    rightClick(bg);
    await settle();
    assert.deepEqual(storageWrites(bg), [], JSON.stringify(voices));
    const after = await bg.chrome.storage.local.get(['voice', 'speed']);
    assert.deepEqual(after, { voice: 'Gone.wav', speed: 1.5 });
  }
});

// --- E12: the server is down --------------------------------------------------------------------

function downFetch() {
  return createFakeFetch(() => { throw new TypeError('Failed to fetch'); });
}

test('E12: server down, saved voice set: the voices check fails, the read starts with the saved voice and the speech fetch error surfaces as before', async () => {
  const fetch = downFetch();
  const bg = loadBackground({ sentences: ONE, localStorage: { voice: 'Olivia.wav' }, fetch });
  rightClick(bg);
  await settle();

  assert.deepEqual(fetch.calls.map((c) => [c.init.method || 'GET', c.url]), [
    ['GET', VOICES_URL],
    ['POST', SPEECH_URL]
  ], 'one voices GET, then one speech attempt (no retry on a network error)');
  assert.equal(fetch.calls[1].body.voice, 'Olivia.wav');
  assert.deepEqual(errors(bg), ['Failed to fetch'], 'the same message the per-sentence fetch gives');
  assert.equal(playChunks(bg).length, 0);
  assert.equal(playerStates(bg).at(-1), 'stopped');
});

test('E12: server down, saved voice empty: no read starts, no speech fetch is made, "No voice selected - open the popup" is shown', async () => {
  const fetch = downFetch();
  const bg = loadBackground({ sentences: ONE, fetch });
  rightClick(bg);
  await settle();

  assert.deepEqual(fetch.calls.map((c) => [c.init.method || 'GET', c.url]), [['GET', VOICES_URL]]);
  assert.deepEqual(errors(bg), [NO_VOICE]);
  assert.deepEqual(playerStates(bg), REFUSED_STATES);
  assert.equal(playChunks(bg).length, 0);
});

// --- Stopping and showing "starting" before the voices answer --------------------------------------

test('G9: the old reading is stopped and "starting" is broadcast before the voices fetch resolves; the read begins after it', async () => {
  const fetch = createGatedFetch(SENTENCES, { auto: true });
  fetch.voices = { gated: true };
  const bg = loadBackground({ sentences: SENTENCES, localStorage: { voice: 'Olivia.wav' }, fetch });
  await pressPlayNoWait(bg);
  await settle();
  const old = playChunks(bg)[0];
  assert.ok(old, 'a session is reading');
  const requestsBefore = fetch.calls.length;
  const sentBefore = bg.sent.length;

  rightClick(bg);
  await settle();

  // The voices fetch is still pending...
  assert.equal(fetch.voiceCalls.length, 1);
  assert.equal(fetch.voiceCalls[0].settled, false);
  // ...and yet the old session is stopped (naming its id), and the player says starting.
  const sinceClick = bg.sent.slice(sentBefore);
  assert.deepEqual(sinceClick.filter((m) => m.type === 'stop'), [{ type: 'stop', sessionId: old.sessionId }]);
  const states = sinceClick.filter((m) => m.type === 'playerStateUpdate');
  assert.deepEqual(states.map((m) => m.state), ['stopped', 'starting']);
  assert.equal(states[1].sessionId, null, 'no session yet');
  assert.equal(fetch.calls.length, requestsBefore, 'no speech request while the voices are awaited');
  assert.equal(playChunks(bg).length, 1);
  assert.equal(liveSession(bg).sessionId, old.sessionId);
  assert.equal(liveSession(bg).stopped, true);

  fetch.voiceCalls[0].respond();
  await settle();
  const fresh = playChunks(bg).at(-1);
  assert.notEqual(fresh.sessionId, old.sessionId);
  assert.equal(fresh.index, 0);
  assert.equal(fetch.calls[requestsBefore].body.voice, 'Olivia.wav');
  assert.deepEqual(bg.sent.slice(sentBefore).filter((m) => m.type === 'stop').length, 1, 'the stop is not repeated when the session begins');
  assert.deepEqual(bg.sent.slice(sentBefore).filter((m) => m.type === 'playerStateUpdate').map((m) => m.state), ['stopped', 'starting', 'loading', 'starting']);
});

test('G9: the existing starting state is reused: the player state is "starting", the same value playFromIndex uses for the first sentence', async () => {
  const { bg, fetch } = setup({ stored: { voice: 'Olivia.wav' }, voices: { gated: true } });
  rightClick(bg);
  await settle();
  assert.equal((await bg.send({ type: 'getPlayerState' }, { wait: true })).state, 'starting');
  fetch.voiceCalls[0].respond();
  await settle();
  assert.equal((await bg.send({ type: 'getPlayerState' }, { wait: true })).state, 'starting', 'and it is still starting while the first sentence is fetched');
});

test('G9: right-click while a session is paused: the paused session is replaced (a stop naming it) and the new read uses the checked voice', async () => {
  const fetch = createGatedFetch(SENTENCES, { auto: true });
  fetch.voices = { voices: ['Abigail.wav', 'Olivia.wav'] };
  const bg = loadBackground({ sentences: SENTENCES, localStorage: { voice: 'Olivia.wav' }, fetch });
  await pressPlayNoWait(bg);
  await settle();
  const first = playChunks(bg)[0];
  await chunkReady(bg, first);
  await endChunk(bg, first);
  const second = playChunks(bg)[1];
  await control(bg, 'pause', second.sessionId);
  await settle();
  assert.equal(liveSession(bg).paused, true);
  assert.equal(bg.sentOfType('stop').length, 0);

  rightClick(bg);
  await settle();

  assert.deepEqual(bg.sentOfType('stop'), [{ type: 'stop', sessionId: second.sessionId }]);
  const fresh = playChunks(bg).at(-1);
  assert.notEqual(fresh.sessionId, second.sessionId);
  assert.equal(fresh.index, 0);
  const speech = fetch.calls.filter((c) => c.body.voice === 'Olivia.wav');
  assert.ok(speech.length >= 1, 'the new read sent the checked voice');
  assert.equal(fetch.calls.filter((c) => c.body.voice === 'af_bella').length, fetch.calls.length - speech.length, 'the popup-started session kept its own voice');
  assert.equal(liveSession(bg).sessionId, fresh.sessionId);
  assert.equal(liveSession(bg).paused, false);
});

// --- Two starts ------------------------------------------------------------------------------------------

test('G9: two right-clicks in quick succession: the earlier voices fetch is aborted, only the later start proceeds, exactly one session exists', async () => {
  const { bg, fetch } = setup({ stored: { voice: 'Olivia.wav' }, voices: { gated: true }, sentences: SENTENCES });
  rightClick(bg);
  await settle();
  rightClick(bg);
  await settle();

  assert.equal(fetch.voiceCalls.length, 2);
  assert.equal(fetch.voiceCalls[0].signal.aborted, true, 'the earlier check was aborted by the newer start');
  assert.equal(fetch.voiceCalls[1].signal.aborted, false);

  fetch.voiceCalls[1].respond();
  await settle();

  const sessionIds = new Set(playChunks(bg).map((m) => m.sessionId));
  assert.equal(sessionIds.size, 1, 'exactly one session was started');
  assert.equal(playChunks(bg).filter((m) => m.index === 0).length, 1);
  assert.equal(bg.sentOfType('streamError').length, 0);
  assert.equal(fetch.calls.filter((c) => c.body.input === SENTENCES[0]).length, 1, 'the first sentence was fetched once');
  const log = (await bg.send({ type: 'getDebugLog' }, { wait: true })).log;
  assert.equal(log.events.filter((e) => e.type === 'session-start').length, 1);
  assert.deepEqual(log.events.filter((e) => e.type === 'start-superseded').map((e) => e.outcome), ['voice-check']);
});

test('G9: a late answer to the aborted earlier check changes nothing: still one session, one speech request', async () => {
  const { bg, fetch } = setup({ stored: { voice: 'Olivia.wav' }, voices: { gated: true } });
  rightClick(bg);
  await settle();
  rightClick(bg);
  await settle();

  fetch.voiceCalls[1].respond();
  await settle();
  assert.equal(new Set(playChunks(bg).map((m) => m.sessionId)).size, 1);
  fetch.voiceCalls[0].respond(); // too late: that fetch already rejected with the abort
  await settle();
  assert.equal(new Set(playChunks(bg).map((m) => m.sessionId)).size, 1, 'still one session');
  assert.equal(fetch.calls.length, 1, 'one speech request in all');
});

test('G9: Play pressed in the popup while a right-click start awaits its voices: the right-click start is aborted and never begins a session', async () => {
  const { bg, fetch } = setup({ stored: { voice: 'Olivia.wav' }, voices: { gated: true }, sentences: SENTENCES });
  rightClick(bg);
  await settle();
  assert.equal(fetch.voiceCalls[0].signal.aborted, false);

  await pressPlayNoWait(bg, { ...RAW_SETTINGS, voice: 'Thomas.wav' });
  await settle();
  assert.equal(fetch.voiceCalls[0].signal.aborted, true);
  const chunks = playChunks(bg);
  assert.equal(chunks.length, 1);
  assert.equal(fetch.calls[0].body.voice, 'Thomas.wav', 'the popup start sent the popup\'s own voice; it makes no voice check');
  assert.equal(fetch.voiceCalls.length, 1);
  assert.equal(liveSession(bg).sessionId, chunks[0].sessionId);
});

test('G9: a right-click start that is superseded after its check was answered (token check after the await) begins nothing', async () => {
  const { bg, fetch } = setup({ stored: { voice: 'Olivia.wav' }, voices: { gated: true }, sentences: SENTENCES });
  rightClick(bg);
  await settle();
  // Answer, and press Play before the right-click start gets to run again.
  fetch.voiceCalls[0].respond();
  const play = pressPlayNoWait(bg, { ...RAW_SETTINGS, voice: 'Thomas.wav' });
  await play;
  await settle();
  const sessionIds = new Set(playChunks(bg).map((m) => m.sessionId));
  assert.equal(sessionIds.size, 1);
  assert.deepEqual([...new Set(fetch.calls.map((c) => c.body.voice))], ['Thomas.wav']);
});

// --- A running session keeps what it started with ------------------------------------------------------------

test('F2: a session started by a right-click keeps its URL and voice when the stored ones change; no further voices check is made', async () => {
  const { bg, fetch } = setup({ stored: { voice: 'Olivia.wav' }, sentences: SENTENCES });
  rightClick(bg);
  await settle();
  const first = playChunks(bg)[0];
  await chunkReady(bg, first);

  await bg.chrome.storage.local.set({ voice: 'Thomas.wav', serverUrl: 'http://other.invalid/v1/audio/speech' });
  await endChunk(bg, first);
  await settle();

  assert.ok(fetch.calls.length >= 2, 'the session fetched its next sentence');
  for (const call of fetch.calls) {
    assert.equal(call.url, SPEECH_URL);
    assert.equal(call.body.voice, 'Olivia.wav');
  }
  assert.equal(fetch.voiceCalls.length, 1);
});

test('F2: one speech request per sentence, with the checked voice in every one', async () => {
  const { bg, fetch } = setup({ stored: { voice: 'Gone.wav' }, voices: { voices: LISTED }, sentences: SENTENCES });
  rightClick(bg);
  await settle();
  for (let i = 0; i < SENTENCES.length; i++) {
    const chunk = playChunks(bg)[i];
    await chunkReady(bg, chunk);
    await endChunk(bg, chunk);
  }
  assert.deepEqual(fetch.calls.map((c) => c.body.input), SENTENCES);
  assert.deepEqual([...new Set(fetch.calls.map((c) => c.body.voice))], ['Abigail.wav']);
  assert.equal(fetch.voiceCalls.length, 1);
  for (const call of fetch.calls) assert.deepEqual(Object.keys(call.body).sort(), ['input', 'model', 'speed', 'voice']);
});

// --- No tab ---------------------------------------------------------------------------------------------------

test('G9: a click with no tab id stops the old reading, makes no voices fetch and says so', async () => {
  const { bg, fetch } = setup({ stored: { voice: 'Olivia.wav' } });
  bg.listeners.menuClicked[0]({ menuItemId: 'readAloud', frameId: 0 }, {});
  await settle();
  assert.equal(fetch.log.length, 0);
  assert.deepEqual(errors(bg), ['No active tab to read from.']);
  assert.deepEqual(playerStates(bg), [], 'nothing was reading, so nothing changed');
});
