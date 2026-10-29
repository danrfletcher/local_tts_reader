'use strict';
/**
 * The popup under test: popup.js, audioPlayer.js and lib/voices.js run for
 * real in a node:vm context against a minimal DOM stub, with fake timers, a
 * fake voices fetch and (optionally) the real background.js behind
 * chrome.runtime.sendMessage.
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');

const { ROOT, settle, createFakeTimers, createFakeFetch, jsonResponse } = require('./fake-chrome.js');
const { VOICES: SERVER_VOICES } = require('../fixtures/fake-tts-server.js');

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
    // Every assignment to .value is recorded, so a test can tell "the popup
    // rewrote the box" from "the popup left it alone".
    valueWrites: [],
    get value() {
      return this._value;
    },
    set value(next) {
      this._value = next;
      this.valueWrites.push(next);
    },
    _value: id === 'speed' ? '1' : '',
    checked: false,
    disabled: false,
    hidden: false,
    title: '',
    textContent: '',
    className: '',
    children: [],
    style: {},
    classList: { contains: () => false, add() {}, remove() {} },
    addEventListener(type, fn) {
      (listeners[type] = listeners[type] || []).push(fn);
    },
    replaceChildren(...nodes) {
      this.children = nodes;
    },
    async fire(type, event = {}) {
      for (const fn of listeners[type] || []) await fn({ target: this, ...event });
    },
    async click() {
      for (const fn of listeners.click || []) await fn({});
    }
  };
}

const SERVER_URL = 'http://localhost:8090/v1/audio/speech';
const VOICES_URL = 'http://localhost:8090/v1/audio/voices?model=tts-1';
const voicesBody = (ids = SERVER_VOICES) => jsonResponse({ status: 'ok', voices: ids });

/**
 * Load popup.js and audioPlayer.js. Runtime messages go to `bg` (the real
 * background) when given; the background's broadcasts reach the popup through
 * deliverBroadcasts(), as chrome.runtime.sendMessage does between pages.
 */
function loadPopup({ bg = null, voicesFetch = () => voicesBody(), stored = {}, holdStorage = false } = {}) {
  const elements = new Map();
  const getEl = (id) => {
    if (!elements.has(id)) elements.set(id, fakeElement(id));
    return elements.get(id);
  };
  const domListeners = [];
  const messageListeners = [];
  const sentMessages = [];
  const timers = createFakeTimers();
  const windowListeners = {};
  const storageSets = [];
  const consoleErrors = [];
  const voicesRequests = createFakeFetch(voicesFetch);
  let releaseStorage = null;
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
      storage: {
        local: {
          get(defaults, cb) {
            const answer = () => cb({ ...defaults, ...stored });
            if (holdStorage) releaseStorage = answer;
            else answer();
          },
          set: async (items) => { storageSets.push(JSON.parse(JSON.stringify(items))); }
        }
      }
    },
    DEFAULT_SETTINGS: { serverUrl: SERVER_URL, voice: '', speed: 1, recordAudio: false, preprocessText: false },
    fetch: voicesRequests,
    AbortController,
    addEventListener: (type, fn) => { (windowListeners[type] = windowListeners[type] || []).push(fn); },
    Blob,
    URL,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    setInterval: () => 1,
    clearInterval() {},
    console: { error: (...args) => consoleErrors.push(args), log() {}, warn() {} }
  };
  sandbox.window = sandbox;
  const context = vm.createContext(sandbox);
  for (const file of ['audioPlayer.js', 'lib/voices.js', 'popup.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), context, { filename: file });
  }
  assert.equal(domListeners.length, 1);
  // Ready once the handler has run and the voices check has had its answer
  // (a hanging check stays pending: fake time, not real time, moves it on).
  const ready = Promise.resolve(domListeners[0]()).then(() => settle());

  return {
    sandbox,
    getEl,
    sentMessages,
    ready,
    timers,
    storageSets,
    /** Every console.error the popup made. */
    consoleErrors,
    /** The voices requests the popup made (fetch calls). */
    voicesRequests,
    /** Answer the held chrome.storage.local.get (holdStorage). */
    releaseStorage: () => releaseStorage(),
    /** The popup page going away: Chrome fires pagehide. */
    closePopup: () => (windowListeners.pagehide || []).forEach((fn) => fn({})),
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

/**
 * A voices fetch the test answers by hand. `requests[i]` is the i-th GET with
 * its `signal`, and `answer(response)` / `fail(error)` settle it. Pass
 * `controlled.handler` as `voicesFetch`.
 */
function controlledVoices() {
  const requests = [];
  const handler = ({ signal, url }) => new Promise((resolve, reject) => {
    requests.push({ url, signal, answer: resolve, fail: reject });
  });
  return { requests, handler };
}

/** An AbortError, as fetch rejects with when its signal fires. */
function abortError() {
  const error = new Error('The operation was aborted.');
  error.name = 'AbortError';
  return error;
}

module.exports = {
  IDLE_REPLIES, fakeElement, SERVER_URL, VOICES_URL, voicesBody, loadPopup, controlledVoices, abortError
};
