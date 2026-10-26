/**
 * Pure playback helpers for the TTS reader: session ids, per-sentence play
 * numbers, start tokens, the play ledger (each session id / index / play
 * number accepted once), the stall timeout, the always-on debug log (ring
 * buffer + storage writer), error sanitising, the per-sentence log summary and
 * the Pause/Play/Stop state machine (playbackTransition).
 *
 * Classic script with the same dual export as constants.js: `require()`d in
 * Node tests, `importScripts('lib/playback.js')` in the service worker, where
 * it appears as `self.TTSPlayback` (offscreen.html loads it with a script
 * tag). No chrome.* calls happen here: the log
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

  // --- Start tokens -------------------------------------------------------

  /**
   * Start tokens make overlapping starts leave one session. Every request to
   * start reading takes a token the moment it arrives (before any await); a
   * start whose token is no longer the latest has been superseded and must
   * return without touching the session. The later token always wins,
   * whatever order the earlier awaits resolve in.
   */
  function createStartTokens() {
    let latest = 0;
    return {
      next() {
        latest += 1;
        return latest;
      },
      isCurrent(token) {
        return token === latest;
      }
    };
  }

  // --- Play ledger ----------------------------------------------------------

  const MAX_RETIRED_SESSIONS = 50;

  function isIndex(v) {
    return Number.isInteger(v) && v >= 0;
  }

  function isPlayNumber(v) {
    return Number.isInteger(v) && v >= 1;
  }

  /**
   * Accepts each (session id, index, play number) once. Rejections carry a
   * reason: 'invalid' (malformed ids), 'stale-session' (not the live session,
   * or one that has been retired), 'duplicate' (this exact triple was already
   * accepted) or 'stale-play' (an older play number than one already accepted
   * for that sentence).
   *
   * There is one live session at a time. `begin(id)` makes `id` the live
   * session and retires the previous one; a retired id is never accepted
   * again. `accept(..., { adopt: true })` is for a receiver (the offscreen
   * document) that learns of a new session from its first message: an id it
   * has not retired becomes the live session.
   */
  function createPlayLedger() {
    let current = null;
    const retired = new Set(); // insertion-ordered, capped
    let accepted = new Set(); // "index:playNumber" within the live session
    let highest = new Map(); // index -> highest accepted play number

    function retire(sessionId) {
      if (typeof sessionId !== 'string') return;
      retired.delete(sessionId);
      retired.add(sessionId);
      if (retired.size > MAX_RETIRED_SESSIONS) {
        retired.delete(retired.values().next().value);
      }
      if (current === sessionId) {
        current = null;
        accepted = new Set();
        highest = new Map();
      }
    }

    function begin(sessionId) {
      if (typeof sessionId !== 'string' || retired.has(sessionId)) return false;
      if (current === sessionId) return true;
      if (current !== null) retire(current);
      current = sessionId;
      accepted = new Set();
      highest = new Map();
      return true;
    }

    function accept(sessionId, index, playNumber, { adopt = false } = {}) {
      if (typeof sessionId !== 'string' || !isIndex(index) || !isPlayNumber(playNumber)) {
        return { ok: false, reason: 'invalid' };
      }
      if (retired.has(sessionId)) return { ok: false, reason: 'stale-session' };
      if (sessionId !== current) {
        if (!adopt) return { ok: false, reason: 'stale-session' };
        begin(sessionId);
      }
      const key = `${index}:${playNumber}`;
      if (accepted.has(key)) return { ok: false, reason: 'duplicate' };
      if ((highest.get(index) || 0) > playNumber) return { ok: false, reason: 'stale-play' };
      accepted.add(key);
      highest.set(index, playNumber);
      return { ok: true };
    }

    return {
      begin,
      retire,
      accept,
      get current() {
        return current;
      }
    };
  }

  /**
   * Does a message's (session id, index, play number) name the sentence that
   * is playing right now? `live` is `{ sessionId, index, playNumber }` or
   * null when nothing is playing. Returns null on a match, otherwise the
   * reason it is stale: 'no-session', 'stale-session', 'stale-index' or
   * 'stale-play'.
   */
  function staleReason(live, message) {
    if (!live) return 'no-session';
    if (!message || message.sessionId !== live.sessionId) return 'stale-session';
    if (message.index !== live.index) return 'stale-index';
    if (message.playNumber !== live.playNumber) return 'stale-play';
    return null;
  }

  // --- Stall timeout -----------------------------------------------------------

  const STALL_GRACE_MS = 5000; // added to the reported audio duration
  const HANG_TIMEOUT_MS = 60000; // used until the duration is known

  /** A reported duration is usable only if it is a finite number above zero. */
  function isUsableDuration(durationSec) {
    return typeof durationSec === 'number' && Number.isFinite(durationSec) && durationSec > 0;
  }

  /**
   * How long to wait for a sentence to report ended before advancing anyway:
   * the audio's own duration plus 5 s, or a fixed 60 s until the duration is
   * known (NaN, 0, Infinity, negative and non-numbers count as unknown).
   * Returns null while paused: a paused session has no deadline.
   */
  function stallTimeoutMs({ durationSec, paused = false } = {}) {
    if (paused) return null;
    if (!isUsableDuration(durationSec)) return HANG_TIMEOUT_MS;
    return Math.ceil(durationSec * 1000) + STALL_GRACE_MS;
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
  const SUMMARY_EVENT_TYPES = new Set(['fetch', 'play', 'audio-ready', 'chunk-ended']);

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
      // Dropped messages, stalls and durations name ids that never played
      // (stale or forged); they stay in `events` but do not get a row.
      if (!SUMMARY_EVENT_TYPES.has(e.type)) continue;
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

  // --- Pause, Play and Stop -------------------------------------------------

  const PHASES = ['idle', 'loading', 'playing', 'paused', 'stopped'];
  const CONTROL_EVENTS = ['pause', 'play', 'stop', 'chunkEnded', 'fetchDone'];

  // Actions that make a sentence start playing (or be sent to the audio
  // element). None of them may ever come out of a transition that leaves the
  // session paused: a paused session never starts a sentence on its own.
  const SENTENCE_STARTING_ACTIONS = ['play-chunk', 'advance', 'resume-held', 'resume-advance'];

  function startsSentence(action) {
    return SENTENCE_STARTING_ACTIONS.includes(action);
  }

  /**
   * The state machine behind Pause, Play and Stop. Pure: it only says what
   * the background should do; background.js does it.
   *
   * `phase` is where the session is:
   *   idle     no session
   *   stopped  the session was stopped or finished
   *   loading  a sentence is being fetched or handed to the audio element
   *   playing  a sentence is on the audio element
   *   paused   the background recorded a Pause (the only way to be paused)
   * `event` is 'pause' | 'play' | 'stop' | 'chunkEnded' (the audio element
   * finished a sentence) | 'fetchDone' (the sentence being loaded is ready).
   * `flags` is what the paused session is holding:
   *   held             the loaded sentence's bytes, kept for Play
   *   advanceOnResume  a sentence ended while paused; Play plays the next
   *   fetchPending     a sentence fetch is still in flight
   *
   * Returns { phase, action, flags }:
   *   pause          'pause' | 'none'
   *   play           'resume-held' | 'resume-advance' | 'resume-wait' |
   *                  'resume-audio' | 'new-session' | 'none'. 'new-session'
   *                  means there is nothing to resume; the popup starts a
   *                  new session itself (startStreaming), and the
   *                  background never starts one from a Play control.
   *   stop           'stop' | 'none'
   *   chunkEnded     'advance' | 'defer-advance' | 'ignore'
   *   fetchDone      'play-chunk' | 'hold-chunk' | 'keep-prefetch' | 'discard'
   */
  function playbackTransition(phase, event, flags = {}) {
    const held = Boolean(flags.held);
    const advanceOnResume = Boolean(flags.advanceOnResume);
    const fetchPending = Boolean(flags.fetchPending);
    const unchanged = { held, advanceOnResume, fetchPending };
    const result = (nextPhase, action, nextFlags = unchanged) => ({
      phase: nextPhase,
      action,
      flags: { ...nextFlags }
    });
    if (!PHASES.includes(phase) || !CONTROL_EVENTS.includes(event)) return result(phase, 'none');

    const live = phase === 'loading' || phase === 'playing';
    switch (event) {
      case 'pause':
        return live ? result('paused', 'pause') : result(phase, 'none');

      case 'play':
        if (phase === 'idle' || phase === 'stopped') return result(phase, 'new-session');
        if (phase !== 'paused') return result(phase, 'none');
        if (held) return result('loading', 'resume-held', { held: false, advanceOnResume: false, fetchPending: false });
        if (advanceOnResume) return result('loading', 'resume-advance', { held: false, advanceOnResume: false, fetchPending });
        if (fetchPending) return result('loading', 'resume-wait');
        return result('playing', 'resume-audio');

      case 'stop':
        return live || phase === 'paused'
          ? result('stopped', 'stop', { held: false, advanceOnResume: false, fetchPending: false })
          : result(phase, 'none');

      case 'chunkEnded':
        if (phase === 'playing') return result('loading', 'advance');
        if (phase === 'paused') return result('paused', 'defer-advance', { held, advanceOnResume: true, fetchPending });
        return result(phase, 'ignore');

      case 'fetchDone':
        if (phase === 'loading') return result('playing', 'play-chunk', { held, advanceOnResume, fetchPending: false });
        if (phase === 'paused') return result('paused', 'hold-chunk', { held: true, advanceOnResume, fetchPending: false });
        if (phase === 'playing') return result(phase, 'keep-prefetch');
        return result(phase, 'discard');
    }
    return result(phase, 'none');
  }

  const TTSPlayback = {
    PHASES,
    CONTROL_EVENTS,
    SENTENCE_STARTING_ACTIONS,
    startsSentence,
    playbackTransition,
    MAX_LOG_EVENTS,
    LOG_STORAGE_KEY,
    SESSION_ID_PATTERN,
    mintSessionId,
    createPlayCounter,
    STALL_GRACE_MS,
    HANG_TIMEOUT_MS,
    createStartTokens,
    createPlayLedger,
    staleReason,
    isUsableDuration,
    stallTimeoutMs,
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
