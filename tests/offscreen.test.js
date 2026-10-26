'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { ROOT, settle } = require('./helpers/fake-chrome.js');

/** Run the real offscreen.js against a fake document with `audioCount` <audio> elements. */
function loadOffscreen({ audioCount = 1 } = {}) {
  const sent = [];
  const listeners = [];
  const audio = {
    src: '',
    currentTime: 0,
    duration: NaN,
    ended: false,
    plays: [],
    play() {
      this.plays.push(this.src);
      return Promise.resolve();
    },
    pause() {},
    load() {},
    removeAttribute() {}
  };
  const document = {
    getElementById: (id) => (id === 'audioElement' ? audio : null),
    querySelectorAll: (selector) => (selector === 'audio' ? Array.from({ length: audioCount }, () => audio) : [])
  };
  const sandbox = {
    document,
    Blob,
    Uint8Array,
    URL: {
      createObjectURL: (() => { let n = 0; return () => `blob:fake-${++n}`; })(),
      revokeObjectURL() {}
    },
    console,
    chrome: {
      runtime: {
        sendMessage(message) {
          sent.push(JSON.parse(JSON.stringify(message)));
          return Promise.resolve();
        },
        onMessage: { addListener: (fn) => listeners.push(fn) }
      }
    }
  };
  const context = vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'offscreen.js'), 'utf8'), context, { filename: 'offscreen.js' });
  return {
    audio,
    sent,
    deliver(message) {
      for (const l of listeners) l(JSON.parse(JSON.stringify(message)), {}, () => {});
    }
  };
}

const PLAY = { type: 'playChunk', audioData: [1, 2, 3], mimeType: 'audio/wav', index: 4, sessionId: 'abc123', playNumber: 1 };

test('playChunk produces audioReady, then chunkEnded, with the same three ids and one <audio> element', async () => {
  const page = loadOffscreen();
  page.deliver(PLAY);
  await settle();

  const ready = page.sent.filter((m) => m.type === 'audioReady');
  assert.deepEqual(ready, [{ type: 'audioReady', sessionId: 'abc123', index: 4, playNumber: 1, audioElements: 1 }]);
  assert.equal(page.audio.plays.length, 1, 'played once');

  page.audio.onended();
  const ended = page.sent.filter((m) => m.type === 'chunkEnded');
  assert.deepEqual(ended, [{ type: 'chunkEnded', index: 4, sessionId: 'abc123', playNumber: 1 }]);
});

test('audioReady reports the real <audio> element count, not a constant', () => {
  const page = loadOffscreen({ audioCount: 2 });
  page.deliver(PLAY);
  assert.equal(page.sent.find((m) => m.type === 'audioReady').audioElements, 2);
});

test('each new playChunk echoes its own ids', () => {
  const page = loadOffscreen();
  page.deliver(PLAY);
  page.audio.onended();
  page.deliver({ ...PLAY, index: 5, playNumber: 1 });
  page.audio.onended();
  page.deliver({ ...PLAY, index: 5, playNumber: 2 });
  page.audio.onended();
  const ended = page.sent.filter((m) => m.type === 'chunkEnded').map((m) => [m.sessionId, m.index, m.playNumber]);
  assert.deepEqual(ended, [['abc123', 4, 1], ['abc123', 5, 1], ['abc123', 5, 2]]);
});

test('after stop, an ended event carries no stale ids (and none is sent)', () => {
  const page = loadOffscreen();
  page.deliver(PLAY);
  page.deliver({ type: 'stop' });
  page.audio.onended();
  assert.equal(page.sent.filter((m) => m.type === 'chunkEnded').length, 0);
  assert.ok(page.sent.some((m) => m.type === 'stateUpdate' && m.state === 'stopped'));
});

test('a playChunk without ids (older background) still plays and echoes nulls', () => {
  const page = loadOffscreen();
  page.deliver({ type: 'playChunk', audioData: [1], mimeType: 'audio/wav', index: 0 });
  assert.equal(page.audio.plays.length, 1);
  const ready = page.sent.find((m) => m.type === 'audioReady');
  assert.equal(ready.sessionId, null);
  assert.equal(ready.playNumber, null);
});
