'use strict';
/**
 * popup.js and audioPlayer.js (both run for real against a minimal DOM stub)
 * wired to the real background.js: which buttons each state enables, and
 * whether Play resumes the paused session or starts a new one.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { ROOT, settle, loadBackground, createFakeTimers } = require('./helpers/fake-chrome.js');
const { playChunks } = require('./helpers/session.js');
const { SENTENCES, createGatedFetch, liveSession, chunkReady, endChunk } = require('./helpers/pause.js');

// What an idle background answers when no real one is attached.
const IDLE_REPLIES = {
  getSessionState: { active: false, sessionId: null, paused: false, index: 0, total: 0 },
  getPlayerState: { state: 'stopped' },
  getTimeInfo: null
};

function fakeElement(id) {
  const listeners = {};
  return {
    id,
    listeners,
    value: id === 'speed' ? '1' : '',
    checked: false,
    disabled: false,
    textContent: '',
    className: '',
    style: {},
    classList: { contains: () => false, add() {}, remove() {} },
    addEventListener(type, fn) {
      (listeners[type] = listeners[type] || []).push(fn);
    },
    async click() {
      for (const fn of listeners.click || []) await fn({});
    }
  };
}

/**
 * Load popup.js and audioPlayer.js. Runtime messages go to `bg` (the real
 * background) when given; the background's broadcasts reach the popup through
 * deliverBroadcasts(), as chrome.runtime.sendMessage does between pages.
 */
function loadPopup({ bg = null } = {}) {
  const elements = new Map();
  const getEl = (id) => {
    if (!elements.has(id)) elements.set(id, fakeElement(id));
    return elements.get(id);
  };
  const domListeners = [];
  const messageListeners = [];
  const sentMessages = [];
  const timers = createFakeTimers();
  let forwarded = bg ? bg.sent.length : 0;

  const sandbox = {
    document: {
      getElementById: getEl,
      querySelector: () => fakeElement('query'),
      createElement: (tag) => fakeElement(tag),
      body: { appendChild() {}, removeChild() {} },
      addEventListener: (type, fn) => { if (type === 'DOMContentLoaded') domListeners.push(fn); }
    },
    chrome: {
      runtime: {
        sendMessage(message, callback) {
          sentMessages.push(JSON.parse(JSON.stringify(message)));
          const reply = bg ? bg.send(message) : Promise.resolve(IDLE_REPLIES[message.type]);
          if (typeof callback === 'function') {
            reply.then(callback);
            return undefined;
          }
          return reply;
        },
        onMessage: { addListener: (fn) => messageListeners.push(fn) }
      },
      storage: { local: { get: (_defaults, cb) => cb({}), set: async () => {} } }
    },
    DEFAULT_SETTINGS: { serverUrl: 'http://localhost:8000/v1/audio/speech', voice: 'af_bella', speed: 1, recordAudio: false, preprocessText: false },
    Blob,
    URL,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    setInterval: () => 1,
    clearInterval() {},
    console: { error() {}, log() {}, warn() {} }
  };
  sandbox.window = sandbox;
  const context = vm.createContext(sandbox);
  for (const file of ['audioPlayer.js', 'popup.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), context, { filename: file });
  }
  assert.equal(domListeners.length, 1);
  const ready = Promise.resolve(domListeners[0]());

  return {
    sandbox,
    getEl,
    sentMessages,
    ready,
    sentOfType: (type) => sentMessages.filter((m) => m.type === type),
    /** Pass the background's new broadcasts to the popup's onMessage listener. */
    async deliverBroadcasts() {
      await settle();
      const fresh = bg.sent.slice(forwarded);
      forwarded = bg.sent.length;
      for (const message of fresh) for (const l of messageListeners) l(JSON.parse(JSON.stringify(message)), {}, () => {});
    },
    deliverMessage(message) {
      for (const l of messageListeners) l(message, {}, () => {});
    },
    buttons: () => ({
      play: getEl('playBtn').disabled,
      pause: getEl('pauseBtn').disabled,
      stop: getEl('stopBtn').disabled
    }),
    progress: () => getEl('sentenceProgress').textContent
  };
}

// --- updateControlButtons -----------------------------------------------------------------------

test('starting and loading enable Pause once a session exists, and keep it disabled before', async () => {
  const popup = loadPopup();
  await popup.ready;
  const { updateControlButtons } = popup.sandbox;
  for (const state of ['starting', 'loading']) {
    updateControlButtons(state, true);
    assert.deepEqual(popup.buttons(), { play: true, pause: false, stop: true }, `${state} with a session`);
    updateControlButtons(state, false);
    assert.deepEqual(popup.buttons(), { play: true, pause: true, stop: true }, `${state} without one`);
  }
});

test('paused enables Play and disables Pause; stopped enables Play and disables Pause; playing the reverse', async () => {
  const popup = loadPopup();
  await popup.ready;
  const { updateControlButtons } = popup.sandbox;
  updateControlButtons('paused', true);
  assert.deepEqual(popup.buttons(), { play: false, pause: true, stop: false });
  updateControlButtons('stopped', false);
  assert.deepEqual(popup.buttons(), { play: false, pause: true, stop: false });
  updateControlButtons('playing', true);
  assert.deepEqual(popup.buttons(), { play: true, pause: false, stop: false });
});

test('ready disables Play while a session is live, and keeps it enabled with none', async () => {
  const popup = loadPopup();
  await popup.ready;
  const { updateControlButtons } = popup.sandbox;
  updateControlButtons('ready', true);
  assert.deepEqual(popup.buttons(), { play: true, pause: true, stop: false });
  updateControlButtons('ready', false);
  assert.deepEqual(popup.buttons(), { play: false, pause: true, stop: false });
});

test('playerStateUpdate with a session id enables Pause while starting/loading; without one it does not', async () => {
  const popup = loadPopup();
  await popup.ready;
  popup.deliverMessage({ type: 'playerStateUpdate', state: 'loading', sessionId: null });
  assert.equal(popup.buttons().pause, true);
  popup.deliverMessage({ type: 'playerStateUpdate', state: 'starting', sessionId: 'abcdef' });
  assert.equal(popup.buttons().pause, false);
  popup.deliverMessage({ type: 'playerStateUpdate', state: 'loading', sessionId: 'abcdef' });
  assert.equal(popup.buttons().pause, false);
  popup.deliverMessage({ type: 'playerStateUpdate', state: 'stopped', sessionId: null });
  popup.deliverMessage({ type: 'playerStateUpdate', state: 'loading', sessionId: null });
  assert.equal(popup.buttons().pause, true, 'the session id is forgotten on Stop');
});

// --- Against the real background ----------------------------------------------------------------------

async function startedBackground(sentences = SENTENCES) {
  const fetch = createGatedFetch(sentences, { auto: true });
  return loadBackground({ sentences, fetch });
}

test('Pause during a gated cold start is reachable from the popup: Pause enabled, one controlAudio with the id, state paused', async () => {
  const fetch = createGatedFetch(SENTENCES, { auto: false });
  const bg = loadBackground({ sentences: SENTENCES, fetch });
  const popup = loadPopup({ bg });
  await popup.ready;

  const playing = popup.getEl('playBtn').click();
  await settle();
  await popup.deliverBroadcasts();
  assert.equal(popup.getEl('pauseBtn').disabled, false, 'Pause is enabled while the first sentence loads');

  await popup.getEl('pauseBtn').click();
  await popup.deliverBroadcasts();
  const pauses = popup.sentOfType('controlAudio');
  assert.deepEqual(pauses, [{ type: 'controlAudio', action: 'pause', sessionId: liveSession(bg).sessionId }]);
  assert.equal(liveSession(bg).paused, true);
  assert.deepEqual(popup.buttons(), { play: false, pause: true, stop: false });

  fetch.entries[0].respond();
  await playing;
  await settle();
  assert.equal(playChunks(bg).length, 0, 'paused through the whole cold start');
});

test('popup Pause goes to the background (controlAudio), never straight to the offscreen document (no bare pause message)', async () => {
  const bg = await startedBackground();
  const popup = loadPopup({ bg });
  await popup.ready;
  await popup.getEl('playBtn').click();
  await popup.deliverBroadcasts();

  await popup.getEl('pauseBtn').click();
  assert.deepEqual(popup.sentMessages.filter((m) => m.type === 'pause' || m.type === 'play'), []);
  assert.equal(popup.sentOfType('controlAudio').length, 1);
  assert.equal(popup.sentOfType('controlAudio')[0].action, 'pause');
});

test('reopening the popup while paused shows paused: Play enabled, Pause disabled, "Sentence 2 of 6"', async () => {
  const bg = await startedBackground();
  const first = loadPopup({ bg });
  await first.ready;
  await first.getEl('playBtn').click();
  await first.deliverBroadcasts();
  const chunk0 = playChunks(bg)[0];
  await chunkReady(bg, chunk0);
  await endChunk(bg, chunk0);
  await first.deliverBroadcasts();
  await first.getEl('pauseBtn').click();
  await settle();
  await bg.timers.tick(180000);

  const reopened = loadPopup({ bg }); // a fresh popup knows nothing of the session
  await reopened.ready;
  await settle();

  assert.deepEqual(reopened.buttons(), { play: false, pause: true, stop: false });
  assert.equal(reopened.progress(), 'Sentence 2 of 6');
  assert.ok(reopened.sentMessages.some((m) => m.type === 'getSessionState'));
});

test('Play on the reopened paused popup resumes the same session: controlAudio play with its id, no startStreaming', async () => {
  const bg = await startedBackground();
  const first = loadPopup({ bg });
  await first.ready;
  await first.getEl('playBtn').click();
  await first.deliverBroadcasts();
  const chunk0 = playChunks(bg)[0];
  await first.getEl('pauseBtn').click();
  await settle();
  const scriptingBefore = bg.scriptingCalls.length;

  const reopened = loadPopup({ bg });
  await reopened.ready;
  await reopened.getEl('playBtn').click();
  await settle();

  assert.deepEqual(reopened.sentOfType('controlAudio'), [{ type: 'controlAudio', action: 'play', sessionId: chunk0.sessionId }]);
  assert.deepEqual(reopened.sentOfType('startStreaming'), []);
  assert.equal(liveSession(bg).sessionId, chunk0.sessionId);
  assert.equal(liveSession(bg).paused, false);
  assert.equal(bg.scriptingCalls.length, scriptingBefore, 'no new session');
  assert.equal(playChunks(bg).length, 1);
});

test('Play in \'ready\' with a live session does not replace it: Play is disabled, and a click sends nothing and keeps the session', async () => {
  const bg = await startedBackground();
  const popup = loadPopup({ bg });
  await popup.ready;
  await popup.getEl('playBtn').click();
  await popup.deliverBroadcasts();
  const chunk0 = playChunks(bg)[0];
  await chunkReady(bg, chunk0); // background moves to 'ready' on audioReady
  await popup.deliverBroadcasts();
  assert.equal(bg.sent.at(-1).state, 'ready');
  assert.equal(popup.buttons().play, true, 'Play is disabled while the live session is ready');

  const scriptingBefore = bg.scriptingCalls.length;
  const sentBefore = popup.sentMessages.length;
  await popup.getEl('playBtn').click(); // even if the click gets through
  await settle();

  assert.equal(popup.sentOfType('startStreaming').length, 1, 'no second session');
  assert.deepEqual(popup.sentOfType('controlAudio'), []);
  assert.deepEqual(popup.sentMessages.slice(sentBefore).map((m) => m.type), ['getSessionState']);
  assert.equal(liveSession(bg).sessionId, chunk0.sessionId);
  assert.equal(bg.scriptingCalls.length, scriptingBefore);
  assert.equal(playChunks(bg).length, 1, 'the sentence is not replayed from the start');
});

test('Play with a live session that is loading or playing is also a no-op', async () => {
  const bg = await startedBackground();
  const popup = loadPopup({ bg });
  await popup.ready;
  await popup.getEl('playBtn').click();
  await popup.deliverBroadcasts();
  const chunk0 = playChunks(bg)[0];

  await popup.getEl('playBtn').click(); // loading
  await bg.send({ type: 'stateUpdate', state: 'playing', sessionId: chunk0.sessionId });
  await popup.deliverBroadcasts();
  await popup.getEl('playBtn').click(); // playing
  await settle();

  assert.equal(popup.sentOfType('startStreaming').length, 1);
  assert.equal(liveSession(bg).sessionId, chunk0.sessionId);
  assert.equal(playChunks(bg).length, 1);
});

test('Play with no session starts a new session (startStreaming)', async () => {
  const bg = await startedBackground();
  const popup = loadPopup({ bg });
  await popup.ready;
  await popup.getEl('playBtn').click();
  assert.equal(popup.sentOfType('startStreaming').length, 1);
  assert.deepEqual(popup.sentOfType('controlAudio'), []);
  assert.equal(playChunks(bg).length, 1);
});

test('Play after Stop starts a new session, even though the popup last heard "paused"', async () => {
  const bg = await startedBackground();
  const popup = loadPopup({ bg });
  await popup.ready;
  await popup.getEl('playBtn').click();
  await popup.deliverBroadcasts();
  const old = playChunks(bg)[0];
  await popup.getEl('pauseBtn').click();
  await popup.deliverBroadcasts();
  await popup.getEl('stopBtn').click();
  await settle();
  assert.equal(liveSession(bg).stopped, true);
  assert.deepEqual(popup.sentOfType('controlAudio').map((m) => m.action), ['pause', 'stop']);
  assert.ok(popup.sentOfType('controlAudio').every((m) => m.sessionId === old.sessionId));

  await popup.getEl('playBtn').click();
  await settle();

  assert.equal(popup.sentOfType('startStreaming').length, 2);
  assert.notEqual(liveSession(bg).sessionId, old.sessionId);
  assert.equal(playChunks(bg).at(-1).index, 0);
});

test('Play after a session ended on its own starts a new session', async () => {
  const bg = await startedBackground(SENTENCES.slice(0, 1));
  const popup = loadPopup({ bg });
  await popup.ready;
  await popup.getEl('playBtn').click();
  const only = playChunks(bg)[0];
  await endChunk(bg, only);
  assert.equal(liveSession(bg).stopped, true);

  await popup.getEl('playBtn').click();
  await settle();
  assert.equal(popup.sentOfType('startStreaming').length, 2);
  assert.equal(playChunks(bg).length, 2);
});

test('the Stop button with no live session still sends an id-less Stop', async () => {
  const bg = await startedBackground();
  const popup = loadPopup({ bg });
  await popup.ready;
  await popup.getEl('stopBtn').click();
  assert.deepEqual(popup.sentOfType('controlAudio'), [{ type: 'controlAudio', action: 'stop' }]);
});

test('syncing on open with the offscreen document gone (as Chrome closes it while paused) does not throw', async () => {
  const bg = await startedBackground();
  const first = loadPopup({ bg });
  await first.ready;
  await first.getEl('playBtn').click();
  await first.getEl('pauseBtn').click();
  await settle();
  bg.closeOffscreen();
  bg.rejectMessages(() => true); // nobody is listening for getTimeInfo either

  const reopened = loadPopup({ bg });
  await reopened.ready;
  await settle(20);
  assert.deepEqual(reopened.buttons(), { play: false, pause: true, stop: false });
  assert.equal(reopened.progress(), 'Sentence 1 of 6');
});
