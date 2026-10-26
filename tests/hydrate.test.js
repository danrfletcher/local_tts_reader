'use strict';
/**
 * E7: a service worker restarted while a session was paused. The stored
 * record is hydrated into a paused session before any handler runs; unusable
 * records are discarded and Play starts a new session.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');

const { settle, createFakeChrome, loadBackground } = require('./helpers/fake-chrome.js');
const { playChunks, startRead } = require('./helpers/session.js');
const { ALARM, RAW_SETTINGS, sessionState, playerState, control, pressPlayNoWait, chunkReady, endChunk } = require('./helpers/pause.js');
const { THREE, TEN, setupResume, readUpTo, readAndPause, restartWorker, createRecordingFetch, finishRead, logEvents, liveSession } = require('./helpers/resume.js');

const STATE_KEY = 'ttsSessionState';
const SENTENCES_KEY = 'ttsSessionSentences';
const TTS_URL = 'http://tts.invalid:9000/v1/audio/speech';

// A stored session, written out literally (not built by the code under test).
function storedMeta(overrides = {}) {
  return {
    v: 1,
    sessionId: 'abc123',
    count: 3,
    currentIndex: 1,
    playNumber: 1,
    paused: true,
    tabId: 7,
    frameId: 2,
    contentSessionId: 42,
    isRecording: false,
    settings: { voice: 'bf_emma', speed: '1.25', recordAudio: false, preprocessText: false },
    ...overrides
  };
}

function storedArea(meta = storedMeta(), sentences = THREE) {
  // `null` leaves that key out of storage altogether.
  const area = {};
  if (meta !== null) area[STATE_KEY] = meta;
  if (sentences !== null) area[SENTENCES_KEY] = sentences;
  return area;
}

/** A restarted worker with `session` storage as given. `gate` holds storage.session.get until released. */
function startWorker({ session = storedArea(), local = { serverUrl: TTS_URL }, gate = false, setup } = {}) {
  const fake = createFakeChrome({ sentences: THREE, sessionStorage: session, localStorage: local, offscreenUp: false });
  let release = () => {};
  if (gate) {
    const original = fake.chrome.storage.session.get;
    const open = new Promise((resolve) => { release = resolve; });
    fake.chrome.storage.session.get = (...args) => open.then(() => original(...args));
  }
  if (setup) setup(fake);
  const bg = loadBackground({ fake, fetch: undefined });
  return { bg, release };
}

const plain = (value) => JSON.parse(JSON.stringify(value)); // out of the worker's vm realm

// --- Rebuild ------------------------------------------------------------------------------------------

test('E7: hydrateSession rebuilds a paused session from the stored record', async () => {
  const { bg } = startWorker();
  await settle();
  const s = liveSession(bg);
  assert.ok(s, 'a session exists');
  assert.equal(s.paused, true);
  assert.equal(s.stopped, false);
  assert.equal(s.sessionId, 'abc123', 'the stored content session id and session id are kept');
  assert.equal(s.contentSessionId, 42);
  assert.deepEqual(plain(s.sentences), THREE);
  assert.equal(s.currentIndex, 1);
  assert.equal(s.tabId, 7);
  assert.equal(s.frameId, 2);
  assert.equal(s.prefetch, null);
  assert.equal(Object.prototype.toString.call(s.abortControllers), '[object Map]');
  assert.equal(s.abortControllers.size, 0, 'fresh, empty abortControllers');
  assert.equal(s.stallTimer, null);
  assert.equal(s.heldChunk, null);
  assert.equal(s.currentAudio, null, 'the bytes were lost with the old worker');
  assert.deepEqual(plain(s.settings), {
    voice: 'bf_emma', speed: '1.25', recordAudio: false, preprocessText: false, serverUrl: TTS_URL
  });
  assert.equal(bg.timers.pending, 0, 'nothing is armed while paused');
  assert.equal(await playerState(bg), 'paused');
  assert.deepEqual(await sessionState(bg), { active: true, sessionId: 'abc123', paused: true, index: 1, total: 3 });
  assert.equal((await logEvents(bg, 'session-hydrated')).length, 1);
});

test('E7: hydrate reads storage.session and chrome.tabs.get; with nothing stored it writes nothing and leaves the worker idle', async () => {
  const { bg } = startWorker({ session: {} });
  await settle();
  assert.equal(liveSession(bg), null);
  assert.equal(bg.chrome.storage.session.setCalls.length, 0);
  assert.deepEqual(await sessionState(bg), { active: false, sessionId: null, paused: false, index: 0, total: 0 });
  assert.equal(await playerState(bg), 'stopped');
});

test('E7: the serverUrl is not stored; it comes from chrome.storage.local, with the default when none is saved', async () => {
  const { bg } = startWorker({ local: {} });
  await settle();
  assert.equal(liveSession(bg).settings.serverUrl, 'http://localhost:8000/v1/audio/speech');
});

// --- The first message sees the hydrated state ---------------------------------------------------------

for (const [label, send, check] of [
  ['getPlayerState', (bg) => bg.send({ type: 'getPlayerState' }, { wait: true }), (r) => assert.deepEqual(r, { state: 'paused' })],
  ['getSessionState', (bg) => bg.send({ type: 'getSessionState' }, { wait: true }), (r) => {
    assert.equal(r.active, true);
    assert.equal(r.paused, true);
  }]
]) {
  test(`E7: the first message after a restart is ${label}: it waits for hydrate and never answers stopped`, async () => {
    const { bg, release } = startWorker({ gate: true });
    const pending = send(bg); // storage has not answered yet
    await settle();
    release();
    check(await pending);
  });
}

test('E7: the first message after a restart is Play: it resumes the hydrated session instead of being dropped as no-session', async () => {
  const { bg, release } = startWorker({ gate: true });
  const play = control(bg, 'play', 'abc123');
  await settle();
  release();
  await play;
  await settle(20);
  assert.equal((await logEvents(bg, 'dropped-control')).length, 0);
  assert.equal(playChunks(bg).length, 1, 'the current sentence was sent again');
  assert.equal(playChunks(bg)[0].index, 1);
});

test('E7: the first message after a restart is stopSession: it stops the hydrated session', async () => {
  const { bg, release } = startWorker({ gate: true });
  const stop = bg.send({ type: 'stopSession' }, { wait: true });
  await settle();
  release();
  await stop;
  await settle();
  assert.equal(liveSession(bg).stopped, true);
  assert.equal(bg.sentOfType('stop').length, 1);
  assert.equal((await logEvents(bg, 'session-end'))[0].reason, 'user');
});

test('E7: a message that arrives while hydration is pending is answered once, in order', async () => {
  const { bg, release } = startWorker({ gate: true });
  const first = bg.send({ type: 'getSessionState' }, { wait: true });
  const second = bg.send({ type: 'getPlayerState' }, { wait: true });
  release();
  assert.equal((await first).paused, true);
  assert.deepEqual(await second, { state: 'paused' });
});

// --- The keepalive alarm ---------------------------------------------------------------------------------

test('E7: the keepalive alarm keeps running when the worker wakes with a hydrated paused session', async () => {
  const { bg, release } = startWorker({ gate: true, setup: (fake) => fake.alarms.set(ALARM, { name: ALARM, periodInMinutes: 0.5 }) });
  const cleared = [];
  const clear = bg.chrome.alarms.clear;
  bg.chrome.alarms.clear = (name) => { cleared.push(name); return clear(name); };

  bg.listeners.alarm[0]({ name: ALARM }); // the alarm woke the worker; hydrate has not finished
  await settle();
  release();
  await settle();
  assert.deepEqual(cleared, [], 'never cleared, not even for a moment');
  assert.ok(bg.alarms.has(ALARM), 'the alarm is still there');
  bg.listeners.alarm[0]({ name: ALARM }); // and on its next ring
  await settle();
  assert.deepEqual(cleared, []);
  assert.ok(bg.alarms.has(ALARM));
});

test('E7: with no stored session the alarm still clears itself, as before', async () => {
  const { bg } = startWorker({ session: {}, setup: (fake) => fake.alarms.set(ALARM, { name: ALARM, periodInMinutes: 0.5 }) });
  bg.listeners.alarm[0]({ name: ALARM });
  await settle();
  assert.equal(bg.alarms.has(ALARM), false);
});

// --- Unusable stored state ----------------------------------------------------------------------------------

/** Discarded: no session, nothing stored, no error banner, and Play starts a new session. */
async function assertDiscardedAndPlayStartsNew(bg, reason) {
  await settle();
  assert.equal(liveSession(bg), null, 'no session was rebuilt');
  assert.equal(await playerState(bg), 'stopped');
  assert.deepEqual(await sessionState(bg), { active: false, sessionId: null, paused: false, index: 0, total: 0 });
  assert.equal(bg.sentOfType('streamError').length, 0, 'no error banner');
  assert.equal(bg.consoleCalls.error.length, 0, 'no crash logged');
  const snapshot = bg.chrome.storage.session.snapshot();
  assert.equal(snapshot[STATE_KEY], undefined, 'stored state was cleared');
  assert.equal(snapshot[SENTENCES_KEY], undefined);
  if (reason) assert.deepEqual((await logEvents(bg, 'session-discarded')).map((e) => e.reason), [reason]);

  await pressPlayNoWait(bg, RAW_SETTINGS);
  await settle();
  assert.equal(playChunks(bg).length, 1, 'Play started a new session');
  assert.notEqual(playChunks(bg)[0].sessionId, 'abc123');
  assert.equal(bg.sentOfType('streamError').length, 0);
}

test('E7: stored state is discarded when its tab no longer exists', async () => {
  const { bg } = startWorker({ setup: (fake) => fake.closeTab(7) });
  await assertDiscardedAndPlayStartsNew(bg, 'tab-gone');
});

test('E7: stored state is discarded when storage reads fail', async () => {
  const { bg } = startWorker({
    setup: (fake) => { fake.chrome.storage.session.get = async () => { throw new Error('storage unavailable'); }; }
  });
  await assertDiscardedAndPlayStartsNew(bg, 'read-failed');
});

test('E7: stored state is discarded when the settings cannot be read', async () => {
  const { bg } = startWorker({
    setup: (fake) => {
      const get = fake.chrome.storage.local.get;
      fake.chrome.storage.local.get = (keys, cb) => {
        if (keys && typeof keys === 'object' && !Array.isArray(keys) && 'serverUrl' in keys) return Promise.reject(new Error('local unavailable'));
        return get(keys, cb);
      };
    }
  });
  await assertDiscardedAndPlayStartsNew(bg, 'settings-failed');
});

const INCOMPLETE = [
  ['no session id', storedMeta({ sessionId: undefined })],
  ['a session id of the wrong shape', storedMeta({ sessionId: 'ABC' })],
  ['no paused flag', storedMeta({ paused: undefined })],
  ['no tab id', storedMeta({ tabId: undefined })],
  ['no frame id', storedMeta({ frameId: undefined })],
  ['no settings', storedMeta({ settings: undefined })],
  ['settings without a voice', storedMeta({ settings: { speed: '1', recordAudio: false, preprocessText: false } })],
  ['a sentence count that disagrees with the sentences', storedMeta({ count: 5 })],
  ['an unknown version', storedMeta({ v: 2 })],
  ['a current index that is not a number', storedMeta({ currentIndex: 'one' })],
  ['an index with no play number', storedMeta({ playNumber: 0 })],
  ['a record that is not an object', 'garbage']
];

for (const [label, meta] of INCOMPLETE) {
  test(`E7: stored state with ${label} is discarded and Play starts a new session`, async () => {
    const { bg } = startWorker({ session: storedArea(meta) });
    await assertDiscardedAndPlayStartsNew(bg);
  });
}

test('E7: a record without its sentences is incomplete', async () => {
  const { bg } = startWorker({ session: storedArea(storedMeta(), null) });
  await assertDiscardedAndPlayStartsNew(bg);
});

test('E7: sentences that are not an array are discarded', async () => {
  const { bg } = startWorker({ session: storedArea(storedMeta(), 'First sentence.') });
  await assertDiscardedAndPlayStartsNew(bg);
});

test('E7: sentences containing something other than text are discarded', async () => {
  const { bg } = startWorker({ session: storedArea(storedMeta({ count: 3 }), ['One.', 7, 'Three.']) });
  await assertDiscardedAndPlayStartsNew(bg);
});

test('E7: an empty sentence list is discarded', async () => {
  const { bg } = startWorker({ session: storedArea(storedMeta({ count: 0, currentIndex: -1, playNumber: 0 }), []) });
  await assertDiscardedAndPlayStartsNew(bg, 'empty');
});

test('E7: an index past the end of the sentences is discarded', async () => {
  const { bg } = startWorker({ session: storedArea(storedMeta({ currentIndex: 3 })) });
  await assertDiscardedAndPlayStartsNew(bg, 'index');
});

test('E7: a stored session that was not paused is discarded (its audio element is not known to the new worker)', async () => {
  const { bg } = startWorker({ session: storedArea(storedMeta({ paused: false })) });
  await assertDiscardedAndPlayStartsNew(bg, 'not-paused');
});

// --- A real restart: stored by one worker, rebuilt by the next ------------------------------------------

test('E7: what a running worker stores is what the next worker rebuilds', async () => {
  const { bg: first } = setupResume();
  const chunk = await readAndPause(first, 1);
  await settle();

  const stored = first.chrome.storage.session.snapshot();
  assert.deepEqual(stored[SENTENCES_KEY], THREE);
  assert.deepEqual(stored[STATE_KEY], {
    v: 1,
    sessionId: chunk.sessionId,
    count: 3,
    currentIndex: 1,
    playNumber: 1,
    advance: false,
    paused: true,
    tabId: 7,
    frameId: 0,
    contentSessionId: 1,
    isRecording: false,
    settings: { voice: 'af_bella', speed: '1', recordAudio: false, preprocessText: false }
  });

  const { bg: second } = startWorker({ session: stored, local: first.chrome.storage.local.snapshot() });
  await settle();
  assert.deepEqual(await sessionState(second), { active: true, sessionId: chunk.sessionId, paused: true, index: 1, total: 3 });
});

test('E7: a session that has not played yet is stored and rebuilt too (Pause during the cold start)', async () => {
  const { bg: first } = setupResume();
  await startRead(first, RAW_SETTINGS);
  const { sessionId } = await sessionState(first);
  await control(first, 'pause', sessionId);
  await settle();
  const meta = first.chrome.storage.session.snapshot()[STATE_KEY];
  assert.equal(meta.paused, true);

  const { bg: second } = startWorker({ session: first.chrome.storage.session.snapshot() });
  await settle();
  assert.equal(liveSession(second).paused, true);
});

test('E7: Stop, replacement and a finished read clear the stored state', async () => {
  const { bg } = setupResume();
  const chunk = await readAndPause(bg, 1);
  assert.ok(bg.chrome.storage.session.snapshot()[STATE_KEY]);
  await control(bg, 'stop', chunk.sessionId);
  await settle();
  assert.equal(bg.chrome.storage.session.snapshot()[STATE_KEY], undefined);
  assert.equal(bg.chrome.storage.session.snapshot()[SENTENCES_KEY], undefined);
});

test('E7: a failed write of the stored state never stops or disturbs playback', async () => {
  const { bg } = setupResume();
  bg.chrome.storage.session.failNextSets(3);
  await pressPlayNoWait(bg, RAW_SETTINGS);
  await settle();
  assert.equal(playChunks(bg).length, 1, 'the first sentence still played');
  assert.equal(bg.sentOfType('streamError').length, 0);
  assert.equal(liveSession(bg).stopped, false);
});

test('E7: Pause then Stop after a restart tears the hydrated session down (F3 guard)', async () => {
  const { bg: first } = setupResume();
  const chunk = await readAndPause(first, 1);
  await settle();
  assert.ok(first.alarms.has(ALARM));

  const second = restartWorker(first, { sentences: THREE });
  await settle();
  assert.equal(liveSession(second).paused, true);
  await control(second, 'stop', chunk.sessionId);
  await settle();

  assert.equal(liveSession(second).stopped, true);
  assert.deepEqual(second.sentOfType('stop'), [{ type: 'stop', sessionId: chunk.sessionId }]);
  const clears = second.tabMessages.filter((m) => m.message.type === 'ttsClearHighlight');
  assert.equal(clears.length, 1);
  assert.equal(clears[0].tabId, 7);
  assert.equal(clears[0].message.sessionId, 1, 'the stored content session id');
  assert.equal(clears[0].options.frameId, 0);
  assert.equal(second.alarms.has(ALARM), false, 'the keepalive alarm is cleared');
  assert.equal(second.chrome.storage.session.snapshot()[STATE_KEY], undefined);
  assert.equal(await playerState(second), 'stopped');
});

test('E4: a new read after a restart replaces the hydrated session; the old paused audio is stopped explicitly', async () => {
  const { bg: first } = setupResume();
  const chunk = await readAndPause(first, 1);
  const second = restartWorker(first, { sentences: THREE });
  await settle();
  const onClicked = second.listeners.menuClicked[0];
  onClicked({ menuItemId: 'readAloud', frameId: 0 }, { id: 7 });
  await settle(20);

  assert.deepEqual(second.sentOfType('stop').map((m) => m.sessionId), [chunk.sessionId]);
  assert.equal(playChunks(second).length, 1);
  assert.notEqual(playChunks(second)[0].sessionId, chunk.sessionId);
  assert.equal(vm.runInContext('session', second.context).sessionId, playChunks(second)[0].sessionId);
});

// --- Pure parts: the store, the counter seed, the message list ------------------------------------------

const TTSPlayback = require('../lib/playback.js');
const fs = require('node:fs');
const path = require('node:path');

test('createSessionStore: a Stop (remove) queued after a start (set) is never overtaken by it', async () => {
  const { createStorageArea } = require('./helpers/fake-chrome.js');
  const area = createStorageArea();
  const release = area.holdNextSet();
  const store = TTSPlayback.createSessionStore({ storage: area });
  const meta = TTSPlayback.buildStoredSession({
    sessionId: 'abc123', sentences: THREE, currentIndex: 0, currentPlayNumber: 1, paused: true,
    tabId: 7, frameId: 0, contentSessionId: 1, isRecording: false,
    settings: { voice: 'v', speed: 1, recordAudio: false, preprocessText: false, serverUrl: TTS_URL }
  });
  store.save(meta, THREE);
  store.clear();
  release();
  await store.flush();
  assert.deepEqual(area.snapshot(), {}, 'the remove ran last');
});

test('createSessionStore: sentences go with the first save only, and again after a failed one', async () => {
  const { createStorageArea } = require('./helpers/fake-chrome.js');
  const area = createStorageArea();
  const errors = [];
  const store = TTSPlayback.createSessionStore({ storage: area, onError: (e) => errors.push(e) });
  const meta = { sessionId: 'abc123' };
  area.failNextSets(1);
  await store.save(meta, THREE);
  assert.equal(errors.length, 1, 'a failed write is reported to onError, never thrown');
  await store.save(meta, THREE);
  await store.save(meta, THREE);
  const withSentences = area.setCalls.filter((c) => 'ttsSessionSentences' in c);
  assert.equal(withSentences.length, 2, 'the failed one, then the retry; the third save leaves them alone');
  assert.equal(area.setCalls.length, 3);
});

test('buildStoredSession keeps no URL and no sentence text, whatever the session holds', () => {
  const meta = TTSPlayback.buildStoredSession({
    sessionId: 'abc123', sentences: THREE, currentIndex: 2, currentPlayNumber: null, paused: true,
    tabId: 7, frameId: 0, contentSessionId: null, isRecording: true,
    url: 'https://example.test/page', title: 'Page',
    settings: { voice: 'v', speed: 1, recordAudio: true, preprocessText: true, serverUrl: TTS_URL, extra: 'x' }
  });
  assert.deepEqual(Object.keys(meta).sort(), [
    'advance', 'contentSessionId', 'count', 'currentIndex', 'frameId', 'isRecording', 'paused', 'playNumber', 'sessionId', 'settings', 'tabId', 'v'
  ]);
  assert.deepEqual(Object.keys(meta.settings).sort(), ['preprocessText', 'recordAudio', 'speed', 'voice']);
  assert.equal(meta.playNumber, 0);
  assert.ok(!/https?:|Alpha|Bravo/.test(JSON.stringify(meta)));
});

test('createPlayCounter.seed: a rebuilt session continues from the play number its predecessor reached', () => {
  const counter = TTSPlayback.createPlayCounter();
  counter.seed(4, 1);
  assert.equal(counter.peek(4), 2);
  assert.equal(counter.next(4), 2);
  assert.equal(counter.peek(5), 1, 'other sentences are untouched');
  counter.seed(-1, 3); // index -1: nothing has played; ignored
  counter.seed(6, 0);
  assert.equal(counter.peek(6), 1);
});

test('buildEvent keeps a well-formed `kind` and drops a malformed one', () => {
  assert.equal(TTSPlayback.buildEvent('replay', { kind: 'replay-from-bytes' }).kind, 'replay-from-bytes');
  assert.equal(TTSPlayback.buildEvent('replay', { kind: 'Some sentence text, with spaces' }).kind, undefined);
});

test('every message type background.js handles is in HANDLED_MESSAGE_TYPES, which the hydrate gate relies on', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');
  const body = source.slice(source.indexOf('function handleMessage('), source.indexOf('// Fire-and-forget broadcast'));
  const cases = [...body.matchAll(/^ {4}case '([A-Za-z]+)':/gm)].map((m) => m[1]).sort();
  const listed = [...source.match(/const HANDLED_MESSAGE_TYPES = new Set\(\[([\s\S]*?)\]\);/)[1].matchAll(/'([A-Za-z]+)'/g)].map((m) => m[1]).sort();
  assert.ok(cases.length >= 16);
  assert.deepEqual(listed, cases);
});

// --- E6 / E5 across a restart: Play moves on, it does not replay the sentence that ended ------------------

const order = (bg) => playChunks(bg).map((c) => `${c.index}/${c.playNumber}`);

test('E6: a sentence that ends while paused is stored as "advance", and a restarted worker plays the next sentence, not a replay', async () => {
  const { bg: first } = setupResume({ sentences: TEN });
  const chunk = await readAndPause(first, 4);
  await endChunk(first, chunk); // the audio finished at the instant of the Pause
  await settle();
  assert.equal(first.chrome.storage.session.snapshot()[STATE_KEY].advance, true, 'stored when the sentence ended');
  assert.equal(first.chrome.storage.session.snapshot()[STATE_KEY].currentIndex, 4);

  const fetch = createRecordingFetch(TEN);
  const second = restartWorker(first, { sentences: TEN, fetch });
  await settle();
  assert.equal(liveSession(second).advanceOnResume, true);
  assert.equal(liveSession(second).hydrated, false, 'nothing about the old audio matters: it only advances');
  assert.deepEqual(await sessionState(second), { active: true, sessionId: chunk.sessionId, paused: true, index: 4, total: 10 });

  await control(second, 'play', chunk.sessionId);
  await settle();
  assert.deepEqual(order(second), ['5/1'], 'sentence 6 (index 5) is next; sentence 5 is not replayed');
  assert.deepEqual(fetch.indexes().filter((i) => i <= 5), [5], 'only the next sentence was fetched');
  assert.equal((await logEvents(second, 'replay')).length, 0, 'not logged as a replay');

  await finishRead(second, 10, { from: 5 });
  assert.deepEqual(order(second), ['5/1', '6/1', '7/1', '8/1', '9/1']);
  assert.equal(liveSession(second).stopped, true);
});

test('E6: the last sentence ended while paused, worker restarts, Play finishes the session', async () => {
  const { bg: first } = setupResume();
  const chunk = await readAndPause(first, 2);
  await endChunk(first, chunk);
  await settle();

  const second = restartWorker(first, { sentences: THREE });
  await settle();
  await control(second, 'play', chunk.sessionId);
  await settle();
  assert.equal(playChunks(second).length, 0, 'nothing is replayed');
  assert.equal(liveSession(second).stopped, true);
  assert.equal(second.chrome.storage.session.snapshot()[STATE_KEY], undefined);
});

/** Sentence 4 ends, its successor is being fetched (the fetch is held), and Pause is pressed. */
async function pauseWhileNextLoads() {
  const { bg: first } = setupResume({ sentences: TEN });
  const chunk = await readUpTo(first, 4);
  await chunkReady(first, chunk);
  liveSession(first).prefetch = null; // the next sentence is not fetched yet
  const original = first.context.fetch;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  first.context.fetch = async (...args) => { await gate; return original(...args); };
  await endChunk(first, chunk); // advances: sentence index 5 starts loading
  await settle();
  assert.equal(liveSession(first).loadingIndex, 5);
  await control(first, 'pause', chunk.sessionId);
  await settle();
  return { first, chunk, release };
}

test('E5: Pause while the next sentence loads is stored as "advance"; a restarted worker plays the next sentence, not the one that finished', async () => {
  const { first, chunk } = await pauseWhileNextLoads();
  assert.equal(first.chrome.storage.session.snapshot()[STATE_KEY].advance, true);
  assert.equal(first.chrome.storage.session.snapshot()[STATE_KEY].currentIndex, 4);

  const fetch = createRecordingFetch(TEN);
  const second = restartWorker(first, { sentences: TEN, fetch });
  await settle();
  await control(second, 'play', chunk.sessionId);
  await settle();
  assert.deepEqual(order(second), ['5/1']);
  assert.equal((await logEvents(second, 'replay')).length, 0);
  assert.deepEqual(fetch.indexes(), [5, 6], 'sentence 6 (index 5) fetched once, then its prefetch');
});

test('E5: the same, when the held fetch lands during the pause before the worker restarts', async () => {
  const { first, chunk, release } = await pauseWhileNextLoads();
  release();
  await settle();
  assert.equal(liveSession(first).heldChunk.index, 5, 'the sentence landed while paused and is held');
  assert.equal(first.chrome.storage.session.snapshot()[STATE_KEY].advance, true);

  const second = restartWorker(first, { sentences: TEN, fetch: createRecordingFetch(TEN) });
  await settle();
  await control(second, 'play', chunk.sessionId);
  await settle();
  assert.deepEqual(order(second), ['5/1']);
  assert.equal((await logEvents(second, 'replay')).length, 0);
});

test('E5/E6: without a worker restart nothing changed: Play after the held fetch plays the held sentence once', async () => {
  const { first, chunk, release } = await pauseWhileNextLoads();
  release();
  await settle();
  await control(first, 'play', chunk.sessionId);
  await settle();
  assert.deepEqual(order(first).slice(-1), ['5/1']);
});

test('a session paused in the middle of a sentence is stored as not advancing, and still replays that sentence after a restart', async () => {
  const { bg: first } = setupResume({ sentences: TEN });
  const chunk = await readAndPause(first, 4);
  assert.equal(first.chrome.storage.session.snapshot()[STATE_KEY].advance, false);
  const second = restartWorker(first, { sentences: TEN, fetch: createRecordingFetch(TEN) });
  await settle();
  await control(second, 'play', chunk.sessionId);
  await settle();
  assert.deepEqual(order(second), ['4/2']);
  assert.equal((await logEvents(second, 'replay')).length, 1);
});

test('stored "advance": a record without the field means false; a field that is not a boolean is discarded', async () => {
  const { advance: _omitted, ...withoutAdvance } = storedMeta();
  const old = startWorker({ session: storedArea(withoutAdvance) });
  await settle();
  assert.equal(liveSession(old.bg).paused, true);
  assert.equal(liveSession(old.bg).advanceOnResume, false);
  assert.equal(liveSession(old.bg).hydrated, true);

  const bad = startWorker({ session: storedArea(storedMeta({ advance: 'yes' })) });
  await assertDiscardedAndPlayStartsNew(bad.bg);
});

test('a session that has not played yet is never stored as advancing, even when the first sentence was loading', async () => {
  const meta = TTSPlayback.buildStoredSession({
    sessionId: 'abc123', sentences: THREE, currentIndex: -1, currentPlayNumber: null, paused: true,
    loadingIndex: 0, advanceOnResume: false, heldChunk: null, tabId: 7, frameId: 0, contentSessionId: null,
    isRecording: false, settings: { voice: 'v', speed: 1, recordAudio: false, preprocessText: false }
  });
  assert.equal(meta.advance, false);
});
