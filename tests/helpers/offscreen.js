'use strict';
/**
 * Run the real offscreen.js (and the lib/playback.js its page loads) against
 * a fake document with `audioCount` <audio> elements. `onMessageToBackground`
 * (optional) is called with every message the page sends to the background.
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { ROOT } = require('./fake-chrome.js');

function loadOffscreen({ audioCount = 1, onMessageToBackground = null } = {}) {
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
    console: { ...console, warn() {} },
    chrome: {
      runtime: {
        sendMessage(message) {
          const copy = JSON.parse(JSON.stringify(message));
          sent.push(copy);
          if (onMessageToBackground) onMessageToBackground(copy);
          return Promise.resolve();
        },
        onMessage: { addListener: (fn) => listeners.push(fn) }
      }
    }
  };
  sandbox.self = sandbox; // as in a page: lib/playback.js sets self.TTSPlayback
  const context = vm.createContext(sandbox);
  // offscreen.html loads these two classic scripts, in this order.
  for (const file of ['lib/playback.js', 'offscreen.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), context, { filename: file });
  }
  return {
    audio,
    sent,
    deliver(message) {
      for (const l of listeners) l(JSON.parse(JSON.stringify(message)), {}, () => {});
    }
  };
}

module.exports = { loadOffscreen };
