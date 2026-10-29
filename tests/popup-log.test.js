'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { ROOT, settle, createFakeTimers, loadBackground } = require('./helpers/fake-chrome.js');
const { startRead, readToEnd, playChunks } = require('./helpers/session.js');

function fakeElement(id) {
  const listeners = {};
  return {
    id,
    listeners,
    value: '',
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
 * Run the real popup.js against a fake document. `sendMessage(message)`
 * answers the popup's runtime messages. There is deliberately no
 * chrome.downloads, so any use of it would throw.
 */
function loadPopup({ sendMessage, playerInitFails = false } = {}) {
  const elements = new Map();
  const getEl = (id) => {
    if (!elements.has(id)) elements.set(id, fakeElement(id));
    return elements.get(id);
  };
  const anchors = [];
  const blobs = [];
  const body = { appended: [], removed: [], appendChild(a) { this.appended.push(a); }, removeChild(a) { this.removed.push(a); } };
  const domListeners = [];
  const timers = createFakeTimers();
  const sentMessages = [];

  const sandbox = {
    document: {
      getElementById: getEl,
      querySelector: () => fakeElement('query'),
      createElement(tag) {
        const el = fakeElement(tag);
        el.click = () => { el.clicked = (el.clicked || 0) + 1; };
        anchors.push(el);
        return el;
      },
      body,
      addEventListener: (type, fn) => { if (type === 'DOMContentLoaded') domListeners.push(fn); }
    },
    chrome: {
      runtime: {
        sendMessage: async (message) => {
          sentMessages.push(JSON.parse(JSON.stringify(message))); // plain host-realm copy
          return sendMessage ? sendMessage(message) : undefined;
        },
        onMessage: { addListener() {} }
      },
      storage: { local: { get: (_defaults, cb) => cb({}), set: async () => {} } }
    },
    AudioPlayer: class {
      async init() { if (playerInitFails) throw new Error('player init failed'); }
      async getState() { return 'stopped'; }
      async getSessionState() { return { active: false, sessionId: null, paused: false, index: 0, total: 0 }; }
      async getTimeInfo() { return null; }
    },
    DEFAULT_SETTINGS: { serverUrl: 'x', voice: '', speed: 1, recordAudio: false, preprocessText: true },
    AbortController,
    Blob,
    URL: {
      createObjectURL(blob) { blobs.push(blob); return `blob:fake-${blobs.length}`; },
      revokeObjectURL() {}
    },
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    setInterval: () => 1,
    clearInterval() {},
    console: { error() {}, log() {}, warn() {} }
  };
  const context = vm.createContext(sandbox);
  for (const file of ['lib/voices.js', 'popup.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), context, { filename: file });
  }
  assert.equal(domListeners.length, 1, 'popup.js registers one DOMContentLoaded handler');
  const ready = Promise.resolve(domListeners[0]()).catch(() => {});
  return { getEl, anchors, blobs, body, sentMessages, ready, status: () => getEl('status') };
}

test('Download log builds a Blob and clicks an anchor with a .json filename (no downloads API)', async () => {
  const log = { extensionId: 'abc', version: '1.0', events: [{ t: 1, type: 'play' }], sentences: [] };
  const popup = loadPopup({ sendMessage: () => ({ success: true, log }) });
  await popup.getEl('downloadLogBtn').click();

  assert.deepEqual(popup.sentMessages.filter((m) => m.type === 'getDebugLog'), [{ type: 'getDebugLog' }]);
  assert.equal(popup.blobs.length, 1);
  assert.equal(popup.blobs[0].type, 'application/json');
  assert.deepEqual(JSON.parse(await popup.blobs[0].text()), log);

  assert.equal(popup.anchors.length, 1);
  const anchor = popup.anchors[0];
  assert.match(anchor.download, /^tts-reader-log-[0-9T-]+Z?\.json$/);
  assert.equal(anchor.href, 'blob:fake-1');
  assert.equal(anchor.clicked, 1);
  assert.deepEqual(popup.body.appended, [anchor]);
  assert.deepEqual(popup.body.removed, [anchor]);
  assert.equal(popup.status().textContent, 'Log downloaded');
  assert.match(popup.status().className, /success/);
});

test('Download log shows an error and saves nothing when the background gives no log', async () => {
  for (const reply of [undefined, { success: false, error: 'storage unavailable' }]) {
    const popup = loadPopup({ sendMessage: () => reply });
    await popup.getEl('downloadLogBtn').click();
    assert.equal(popup.blobs.length, 0);
    assert.equal(popup.anchors.length, 0);
    assert.match(popup.status().className, /error/);
    assert.match(popup.status().textContent, /Could not download log/);
  }
});

test('Clear log sends clearDebugLog and shows a status', async () => {
  const popup = loadPopup({ sendMessage: () => ({ success: true }) });
  await popup.getEl('clearLogBtn').click();
  assert.deepEqual(popup.sentMessages.filter((m) => m.type === 'clearDebugLog'), [{ type: 'clearDebugLog' }]);
  assert.equal(popup.status().textContent, 'Log cleared');
  assert.match(popup.status().className, /success/);
});

test('Clear log reports a failure instead of claiming success', async () => {
  const popup = loadPopup({ sendMessage: () => ({ success: false }) });
  await popup.getEl('clearLogBtn').click();
  assert.match(popup.status().className, /error/);
  assert.match(popup.status().textContent, /Could not clear log/);
});

test('both buttons work with the player idle, even if the audio player cannot start', async () => {
  const popup = loadPopup({ playerInitFails: true, sendMessage: () => ({ success: true, log: { events: [] } }) });
  await popup.ready;
  await popup.getEl('downloadLogBtn').click();
  await popup.getEl('clearLogBtn').click();
  assert.equal(popup.anchors.length, 1);
  assert.deepEqual(popup.sentMessages.map((m) => m.type), ['getDebugLog', 'clearDebugLog']);
});

test('popup talks to the real background: Download gets the log with no offscreen document, Clear empties it', async () => {
  const bg = loadBackground({ sentences: ['One sentence here.', 'Another sentence here.'] });
  await startRead(bg);
  await readToEnd(bg, 2);
  bg.closeOffscreen(); // not up when Download is pressed
  assert.equal(bg.createdOffscreen.length, 1);

  const popup = loadPopup({ sendMessage: (m) => bg.send(m, { wait: true }) });
  await popup.getEl('downloadLogBtn').click();
  const file = JSON.parse(await popup.blobs[0].text());
  assert.equal(file.sentences.length, 2);
  assert.equal(file.sentences[0].sessionId, playChunks(bg)[0].sessionId);
  assert.equal(bg.createdOffscreen.length, 1, 'Download did not recreate the offscreen document');

  await popup.getEl('clearLogBtn').click();
  await settle();
  assert.deepEqual(bg.chrome.storage.local.snapshot().ttsDebugLog, []);
  assert.equal(popup.status().textContent, 'Log cleared');
});
