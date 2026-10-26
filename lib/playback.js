/**
 * Pure playback helpers for the TTS reader: session ids, per-sentence play
 * numbers, the always-on debug log (ring buffer + storage writer), error
 * sanitising and the per-sentence log summary.
 *
 * Classic script with the same dual export as constants.js: `require()`d in
 * Node tests, `importScripts('lib/playback.js')` in the service worker, where
 * it appears as `self.TTSPlayback`. No chrome.* calls happen here: the log
 * takes its storage area as an argument.
 */
(function () {
  const SESSION_ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const SESSION_ID_LENGTH = 6;
  const SESSION_ID_PATTERN = /^[a-z0-9]{6}$/;
  const MAX_LOG_EVENTS = 2000;
  const LOG_STORAGE_KEY = 'ttsDebugLog';
  const MAX_ERROR_LENGTH = 200;

  // --- Session ids and play numbers ------------------------------------

  /**
   * Mint a random 6-character [a-z0-9] session id. `rng` returns a number in
   * [0, 1) (injectable for tests); `isTaken(id)` says whether an id belongs
   * to a live session, in which case it is re-rolled rather than reused.
   */
  function mintSessionId(rng = Math.random, isTaken = () => false) {
    for (let attempt = 0; attempt < 1000; attempt++) {
      let id = '';
      for (let i = 0; i < SESSION_ID_LENGTH; i++) {
        const r = Number(rng());
        const slot = Math.min(SESSION_ID_ALPHABET.length - 1, Math.max(0, Math.floor(r * SESSION_ID_ALPHABET.length)));
        id += SESSION_ID_ALPHABET[Number.isNaN(slot) ? 0 : slot];
      }
      if (!isTaken(id)) return id;
    }
    throw new Error('Could not mint an unused session id.');
  }

  /**
   * Per-session play numbers: the Nth time sentence `index` is handed to the
   * audio element is play number N (1-based). `peek` says what the next play
   * of that sentence will be called without consuming it.
   */
  function createPlayCounter() {
    const counts = new Map();
    return {
      peek(index) {
        return (counts.get(index) || 0) + 1;
      },
      next(index) {
        const n = (counts.get(index) || 0) + 1;
        counts.set(index, n);
        return n;
      }
    };
  }

  // --- Sanitising -------------------------------------------------------

  const URL_PATTERN = /[a-z][a-z0-9+.-]*:\/\/[^\s<>"'`)\]}]+/gi;
  const BARE_QUERY_PATTERN = /\?[\w%.~-]+=\S*/g;

  /**
   * Turn an Error (or any thrown value) into a short log-safe string: every
   * URL (http, https, chrome-extension, ...) and stray query string becomes
   * `[url]`, and the result is capped at 200 characters.
   */
  function sanitizeError(err) {
    let text;
    if (err && typeof err === 'object' && 'message' in err) {
      text = String(err.message);
    } else {
      text = String(err == null ? '' : err);
    }
    text = text.replace(URL_PATTERN, (match) => {
      // Keep sentence punctuation that was glued to the end of the URL.
      const trailing = match.match(/[.,;:!?]+$/);
      return '[url]' + (trailing ? trailing[0] : '');
    });
    text = text.replace(BARE_QUERY_PATTERN, '[url]');
    text = text.replace(/\s+/g, ' ').trim();
    if (text.length > MAX_ERROR_LENGTH) {
      text = text.slice(0, MAX_ERROR_LENGTH - 1) + '…';
    }
    return text;
  }

  /** First 8 bytes of the SHA-256 of `data` as 16 lowercase hex characters. */
  async function sha256Prefix(data) {
    const bytes = data instanceof ArrayBuffer || ArrayBuffer.isView(data) ? data : new Uint8Array(data);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    let hex = '';
    for (let i = 0; i < 8; i++) {
      hex += digest[i].toString(16).padStart(2, '0');
    }
    return hex;
  }

  // --- Events -----------------------------------------------------------

  // Events are built from an allowlist, so sentence text, page text and URLs
  // cannot get into the log by accident: unknown keys are dropped, and every
  // allowed key has a value check. `error` is the only free text and goes
  // through sanitizeError.
  const INTEGER_FIELDS = ['index', 'playNumber', 'attempt', 'bytes', 'audioElements', 'count', 'ms', 'status', 'frameId'];
  const STRING_FIELDS = {
    sessionId: (v) => SESSION_ID_PATTERN.test(v),
    hash: (v) => /^[0-9a-f]{16}$/.test(v),
    mode: (v) => /^[a-z-]{1,20}$/.test(v),
    outcome: (v) => /^[a-z-]{1,20}$/.test(v),
    reason: (v) => /^[a-z-]{1,20}$/.test(v),
    extensionId: (v) => /^[a-z0-9]{1,64}$/.test(v),
    version: (v) => /^[0-9][0-9A-Za-z.+-]{0,31}$/.test(v)
  };

  /** Build one log event: `{ t, type, ...allowed fields }`. */
  function buildEvent(type, fields, now = Date.now()) {
    const event = { t: now, type: String(type) };
    const source = fields || {};
    for (const key of INTEGER_FIELDS) {
      const v = source[key];
      if (Number.isInteger(v)) event[key] = v;
    }
    for (const key of Object.keys(STRING_FIELDS)) {
      const v = source[key];
      if (typeof v === 'string' && STRING_FIELDS[key](v)) event[key] = v;
    }
    if (source.error !== undefined && source.error !== null) {
      event.error = sanitizeError(source.error);
    }
    return event;
  }

  /** Append to an events array, dropping the oldest beyond `cap`. Returns a new array. */
  function appendCapped(events, event, cap = MAX_LOG_EVENTS) {
    const next = events.concat([event]);
    return next.length > cap ? next.slice(next.length - cap) : next;
  }

  // --- The log ----------------------------------------------------------

  function normaliseStored(value, cap) {
    if (!Array.isArray(value)) return [];
    const events = value.filter((e) => e && typeof e === 'object' && !Array.isArray(e));
    return events.length > cap ? events.slice(events.length - cap) : events;
  }

  /**
   * The in-memory ring buffer plus its writer. Only the background creates
   * one. `storage` is a chrome.storage area (async get/set).
   *
   * - Hydrated from storage on first use, so it survives a worker restart.
   *   Events appended before hydration finishes are kept after the stored ones.
   * - Writes are serialised: one set() at a time, each writing the whole
   *   current buffer, so appends during a write are neither lost nor doubled.
   * - A failed set() keeps the in-memory events; the next flush writes them.
   * - clear() empties memory first, then waits behind any in-flight write and
   *   writes the (empty) buffer, so a late write can't bring events back.
   */
  function createDebugLog({ storage, key = LOG_STORAGE_KEY, cap = MAX_LOG_EVENTS, onError = () => {} }) {
    let events = [];
    let dirty = false;
    let version = 0; // bumped on every change to `events`
    let generation = 0; // bumped on clear, to void an in-flight hydration
    let hydration = null;
    let tail = Promise.resolve(true);
    let flushQueued = false;

    function hydrate() {
      if (hydration) return hydration;
      const startGeneration = generation;
      hydration = (async () => {
        let stored;
        try {
          const result = await storage.get(key);
          stored = result ? result[key] : undefined;
        } catch (error) {
          onError(error);
          return false;
        }
        if (generation === startGeneration) {
          events = normaliseStored(stored, cap).concat(events);
          if (events.length > cap) events = events.slice(events.length - cap);
        }
        return true;
      })().then((ok) => {
        if (!ok && generation === startGeneration) hydration = null; // a failed read is retried on the next use
        return ok;
      });
      return hydration;
    }

    async function writeOnce() {
      if (!(await hydrate())) return false;
      if (!dirty) return true;
      const writtenVersion = version;
      try {
        await storage.set({ [key]: events.slice() });
      } catch (error) {
        onError(error);
        return false; // stays dirty; in-memory events are kept
      }
      if (version === writtenVersion) dirty = false;
      return true;
    }

    /** Write the buffer to storage. Resolves true when storage is up to date. */
    function flush() {
      const run = tail.then(async () => {
        let ok = await writeOnce();
        // Appends that landed during the write left the buffer dirty.
        while (ok && dirty) ok = await writeOnce();
        return ok;
      });
      tail = run.catch(() => false);
      return run;
    }

    function scheduleFlush() {
      if (flushQueued) return;
      flushQueued = true;
      Promise.resolve().then(() => {
        flushQueued = false;
        return flush();
      }).catch((error) => onError(error));
    }

    return {
      append(event) {
        events = appendCapped(events, event, cap);
        version++;
        dirty = true;
        hydrate(); // first use loads what earlier workers stored
        scheduleFlush();
      },
      async getAll() {
        await hydrate();
        return events.slice();
      },
      flush,
      async clear() {
        generation++;
        events = [];
        version++;
        dirty = true;
        // Nothing stored is wanted back. Always replace `hydration`: an in-flight
        // read is voided by the generation bump, and if it later fails it must not
        // leave a failed hydration behind that blocks every write.
        hydration = Promise.resolve(true);
        return flush();
      }
    };
  }

  // --- Summary ----------------------------------------------------------

  /**
   * One row per (session, index, play number) that has fetch/play/audio
   * events: bytes and hash of the audio, fetch and play counts, `<audio>`
   * element count, plus the extension id and version of the session.
   */
  function summariseLog(events) {
    const sessions = new Map(); // sessionId -> { order, extensionId, version }
    const rows = new Map();
    for (const e of events || []) {
      if (!e || typeof e.sessionId !== 'string') continue;
      if (!sessions.has(e.sessionId)) {
        sessions.set(e.sessionId, { order: sessions.size, extensionId: null, version: null });
      }
      if (e.type === 'session-start') {
        const info = sessions.get(e.sessionId);
        info.extensionId = e.extensionId || null;
        info.version = e.version || null;
        continue;
      }
      if (!Number.isInteger(e.index) || !Number.isInteger(e.playNumber)) continue;
      const rowKey = `${e.sessionId}:${e.index}:${e.playNumber}`;
      let row = rows.get(rowKey);
      if (!row) {
        row = {
          sessionId: e.sessionId,
          index: e.index,
          playNumber: e.playNumber,
          bytes: null,
          hash: null,
          fetchCount: 0,
          playCount: 0,
          endedCount: 0,
          audioElements: null,
          extensionId: null,
          version: null
        };
        rows.set(rowKey, row);
      }
      switch (e.type) {
        case 'fetch':
          row.fetchCount++;
          if (e.outcome === 'ok') {
            if (Number.isInteger(e.bytes)) row.bytes = e.bytes;
            if (typeof e.hash === 'string') row.hash = e.hash;
          }
          break;
        case 'play':
          row.playCount++;
          break;
        case 'audio-ready':
          if (Number.isInteger(e.audioElements)) row.audioElements = e.audioElements;
          break;
        case 'chunk-ended':
          row.endedCount++;
          break;
      }
    }
    const list = Array.from(rows.values());
    for (const row of list) {
      const info = sessions.get(row.sessionId);
      row.extensionId = info.extensionId;
      row.version = info.version;
    }
    list.sort((a, b) =>
      sessions.get(a.sessionId).order - sessions.get(b.sessionId).order ||
      a.index - b.index ||
      a.playNumber - b.playNumber
    );
    return list;
  }

  const TTSPlayback = {
    MAX_LOG_EVENTS,
    LOG_STORAGE_KEY,
    SESSION_ID_PATTERN,
    mintSessionId,
    createPlayCounter,
    sanitizeError,
    sha256Prefix,
    buildEvent,
    appendCapped,
    createDebugLog,
    summariseLog
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = TTSPlayback;
  } else {
    self.TTSPlayback = TTSPlayback;
  }
})();
