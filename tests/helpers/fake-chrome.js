'use strict';
/**
 * Test harness: a fake `chrome` namespace, fake timers, a fake fetch, and
 * loadBackground() which runs the real background.js (a classic service
 * worker) inside a node:vm context.
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..', '..');

function settle(rounds = 8) {
  // Let queued promise callbacks (and real I/O callbacks) run.
  let p = Promise.resolve();
  for (let i = 0; i < rounds; i++) p = p.then(() => new Promise((resolve) => setImmediate(resolve)));
  return p;
}

// --- Fake timers --------------------------------------------------------

function createFakeTimers() {
  let now = 0;
  let nextId = 1;
  const timers = new Map(); // id -> { at, fn }
  return {
    setTimeout(fn, ms = 0) {
      const id = nextId++;
      timers.set(id, { at: now + Number(ms), fn });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    get pending() {
      return timers.size;
    },
    /** Advance fake time, running due timers in order and letting promises settle between them. */
    async tick(ms) {
      const target = now + ms;
      await settle();
      for (;;) {
        let dueId = null;
        for (const [id, t] of timers) {
          if (t.at <= target && (dueId === null || t.at < timers.get(dueId).at)) dueId = id;
        }
        if (dueId === null) break;
        const t = timers.get(dueId);
        timers.delete(dueId);
        now = Math.max(now, t.at);
        t.fn();
        await settle();
      }
      now = target;
    }
  };
}

// --- Fake storage area ----------------------------------------------------

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function createStorageArea(initial = {}) {
  const data = new Map(Object.entries(clone(initial)));
  let failures = 0;
  let gate = null;
  const area = {
    setCalls: [],
    /** Make the next `n` set() calls reject. */
    failNextSets(n = 1) {
      failures = n;
    },
    /** Hold the next set(): it is "in flight" until the returned release() is called, then lands. */
    holdNextSet() {
      let release;
      gate = new Promise((resolve) => { release = resolve; });
      return release;
    },
    snapshot() {
      return Object.fromEntries(data);
    },
    async set(items) {
      const copy = clone(items); // Chrome serialises at call time
      area.setCalls.push(copy);
      const myGate = gate;
      gate = null;
      if (myGate) await myGate;
      if (failures > 0) {
        failures--;
        throw new Error('QUOTA_BYTES quota exceeded');
      }
      for (const [k, v] of Object.entries(copy)) data.set(k, v);
    },
    async remove(keys) {
      for (const k of [].concat(keys)) data.delete(k);
    }
  };
  async function getNow(keys) {
    const out = {};
    if (keys == null) {
      for (const [k, v] of data) out[k] = clone(v);
    } else if (typeof keys === 'string') {
      if (data.has(keys)) out[keys] = clone(data.get(keys));
    } else if (Array.isArray(keys)) {
      for (const k of keys) if (data.has(k)) out[k] = clone(data.get(k));
    } else {
      for (const [k, def] of Object.entries(keys)) out[k] = data.has(k) ? clone(data.get(k)) : def;
    }
    return out;
  }
  // chrome.storage.*.get(keys, callback) is also used by the extension.
  area.get = function (keys, callback) {
    const p = getNow(keys);
    if (typeof callback === 'function') {
      p.then(callback);
      return undefined;
    }
    return p;
  };
  return area;
}

// --- Fake chrome ------------------------------------------------------------

function createFakeChrome(options = {}) {
  const {
    extensionId = 'fakeextensionid',
    version = '1.0',
    sentences = ['First sentence.', 'Second sentence.', 'Third sentence.'],
    tabId = 7,
    tabUrl = 'https://example.test/private?q=1',
    frameId = 0,
    localStorage = {},
    sessionStorage = {},
    offscreenUp = false
  } = options;

  const listeners = { message: [], menuClicked: [], alarm: [], installed: [] };
  const sent = []; // every runtime.sendMessage from the extension
  const tabMessages = []; // every tabs.sendMessage
  const scriptingCalls = [];
  const alarmsState = new Map();
  let offscreenContexts = offscreenUp
    ? [{ contextType: 'OFFSCREEN_DOCUMENT', documentUrl: `chrome-extension://${extensionId}/offscreen.html` }]
    : [];
  const createdOffscreen = [];
  const contextMenusCreated = [];
  let rejectMessage = null; // (message) => boolean: nobody is listening for it

  const chrome = {
    storage: { local: createStorageArea(localStorage), session: createStorageArea(sessionStorage) },
    runtime: {
      id: extensionId,
      getManifest: () => ({ manifest_version: 3, version }),
      getURL: (p) => `chrome-extension://${extensionId}/${String(p).replace(/^\.\//, '')}`,
      sendMessage(message, callback) {
        sent.push(clone(message));
        if (rejectMessage && rejectMessage(message)) {
          // As Chrome does when the receiving page (e.g. the offscreen document) is gone.
          return Promise.reject(new Error('Could not establish connection. Receiving end does not exist.'));
        }
        if (typeof callback === 'function') {
          callback(undefined);
          return undefined;
        }
        return Promise.resolve(undefined);
      },
      getContexts: async () => offscreenContexts.slice(),
      onMessage: { addListener: (fn) => listeners.message.push(fn) },
      onInstalled: { addListener: (fn) => listeners.installed.push(fn) }
    },
    offscreen: {
      async createDocument(opts) {
        createdOffscreen.push(opts);
        offscreenContexts = [{ contextType: 'OFFSCREEN_DOCUMENT', documentUrl: chrome.runtime.getURL(opts.url) }];
      }
    },
    tabs: {
      query: async () => [{ id: tabId, url: tabUrl }],
      sendMessage(id, message, opts) {
        tabMessages.push({ tabId: id, message: clone(message), options: opts });
        return Promise.resolve();
      }
    },
    scripting: {
      async executeScript(opts) {
        scriptingCalls.push(opts);
        if (opts.target && opts.target.allFrames) {
          return [{ frameId: 0, result: { hasSelection: false, textLength: 5000 } }];
        }
        if (opts.files) return [{ frameId }];
        // The __ttsPrepareSession call.
        return [{ frameId, result: { sentences: sentences.slice(), sessionId: 1 } }];
      }
    },
    alarms: {
      get(name, callback) {
        callback(alarmsState.get(name));
      },
      create(name, info) {
        alarmsState.set(name, { name, ...info });
      },
      clear(name) {
        alarmsState.delete(name);
        return Promise.resolve(true);
      },
      onAlarm: { addListener: (fn) => listeners.alarm.push(fn) }
    },
    contextMenus: {
      create: (item) => contextMenusCreated.push(item),
      onClicked: { addListener: (fn) => listeners.menuClicked.push(fn) }
    }
  };

  return {
    chrome,
    sent,
    tabMessages,
    scriptingCalls,
    alarms: alarmsState,
    createdOffscreen,
    contextMenusCreated,
    listeners,
    closeOffscreen() {
      offscreenContexts = [];
    },
    /** Make runtime.sendMessage reject for messages matching `predicate` (null to stop). */
    rejectMessages(predicate) {
      rejectMessage = predicate;
    },
    /**
     * Deliver a runtime message to the extension's listeners. Resolves with
     * the sendResponse value. Many handlers return true without ever
     * responding, so by default this gives up after a short settle and
     * resolves undefined; pass { wait: true } to wait for a response.
     */
    send(message, { wait = false } = {}) {
      const response = new Promise((resolve) => {
        const sendResponse = (value) => resolve(clone(value)); // as if it crossed a process boundary
        for (const listener of listeners.message) {
          listener(clone(message), {}, sendResponse);
        }
      });
      return wait ? response : Promise.race([response, settle(30).then(() => undefined)]);
    },
    sentOfType(type) {
      return sent.filter((m) => m.type === type);
    }
  };
}

// --- Fake fetch -------------------------------------------------------------

/**
 * `respond({url, init, body, signal, call})` may return a Response-like
 * object, a promise of one, or throw. `hangUntilAbort` builds a response
 * that never arrives and rejects with an AbortError when the signal fires.
 */
function createFakeFetch(respond) {
  const calls = [];
  async function fakeFetch(url, init = {}) {
    const call = { url, init, body: init.body ? JSON.parse(init.body) : null };
    calls.push(call);
    const handler = respond || defaultResponder;
    return handler({ ...call, signal: init.signal, call: calls.length });
  }
  fakeFetch.calls = calls;
  return fakeFetch;
}

function audioBytesFor(text) {
  // Deterministic "audio": length depends on the input text.
  const bytes = new Uint8Array(64 + String(text).length);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7 + String(text).length) & 0xff;
  return bytes;
}

function okResponse(bytes, type = 'audio/wav') {
  return {
    ok: true,
    status: 200,
    blob: async () => ({
      type,
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
    })
  };
}

function defaultResponder({ body }) {
  return okResponse(audioBytesFor(body.input));
}

function hangUntilAbort(signal) {
  return new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => {
      const error = new Error('The operation was aborted.');
      error.name = 'AbortError';
      reject(error);
    });
  });
}

// --- Loading the real scripts --------------------------------------------------

function runScript(context, relativePath) {
  const file = path.join(ROOT, relativePath);
  vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
}

/**
 * Run the real background.js in a vm context with fake chrome, timers and
 * fetch. `importScripts` loads classic scripts into the same context, as in
 * a real service worker.
 */
function loadBackground(options = {}) {
  const fake = options.fake || createFakeChrome(options);
  const timers = options.timers || createFakeTimers();
  const fetchFn = options.fetch || createFakeFetch();
  const consoleCalls = { error: [], warn: [], log: [] };

  const sandbox = {
    chrome: fake.chrome,
    fetch: fetchFn,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    AbortController,
    Blob,
    URL,
    crypto: globalThis.crypto,
    console: {
      error: (...a) => consoleCalls.error.push(a),
      warn: (...a) => consoleCalls.warn.push(a),
      log: (...a) => consoleCalls.log.push(a)
    }
  };
  sandbox.self = sandbox;
  const context = vm.createContext(sandbox);
  sandbox.importScripts = (...files) => files.forEach((f) => runScript(context, f));
  if (options.random) vm.runInContext('Math', context).random = options.random;

  runScript(context, 'background.js');

  return { ...fake, context, timers, fetch: fetchFn, consoleCalls, sandbox };
}

module.exports = {
  ROOT,
  settle,
  createFakeTimers,
  createStorageArea,
  createFakeChrome,
  createFakeFetch,
  audioBytesFor,
  okResponse,
  hangUntilAbort,
  runScript,
  loadBackground
};
