/**
 * Voice list and connection check for the TTS reader: derive the Voices URL
 * from the Server URL, run one plain GET against it and map the outcome to a
 * connection state, parse and label the server's voices, and pick the voice
 * to select.
 *
 * Classic script with the same dual export as constants.js and
 * lib/playback.js: `require()`d in Node tests, `importScripts()`d in the
 * service worker and loaded with a script tag in the popup, where it appears
 * as `self.TTSVoices`. No chrome.* calls happen here, and nothing is stored:
 * the voice list lives only in the popup that asked for it.
 */
(function () {
  // The popup's connection states. PR-2 and PR-3 build on these names.
  const CONN = {
    IDLE: 'connIdle', // nothing checked yet
    CHECKING: 'connChecking', // a check is running (first 3 s)
    STARTING: 'connStarting', // a check is still running after 3 s: the engine is waking up
    OK: 'connOk', // 200 with at least one voice
    NO_LIST: 'connNoList', // connected, but the server has no voices endpoint
    NO_VOICES: 'connNoVoices', // 200 with an empty list
    FAILED: 'connFailed' // unreachable, refused, timed out or answered badly
  };

  const VOICES_TIMEOUT_MS = 90000; // a cold start takes about 30 s; red only after this
  const STARTING_AFTER_MS = 3000; // "Checking..." turns into "Starting voice engine..."
  const VOICES_MODEL = 'tts-1'; // the alias the speech request uses
  const SPEECH_SUFFIX = '/audio/speech';
  const VOICES_SUFFIX = '/audio/voices';

  // The defaults before the Server URL / Kokoro voice list were replaced. A
  // stored copy of either is an untouched old default, so it counts as unset.
  const OLD_DEFAULT_SERVER_URL = 'http://localhost:8000/v1/audio/speech';
  const OLD_DEFAULT_VOICE = 'af_bella';

  const REASONS = {
    UNREACHABLE: "Can't reach server - is it running?",
    TIMED_OUT: 'Timed out - click the light to retry',
    UNEXPECTED: 'Unexpected response',
    NO_LIST: 'Connected, no voice list',
    NO_VOICES: 'Server has no voices',
    CANNOT_DERIVE: "Can't derive a voices address"
  };

  // What the label beside the light says when a result carries no reason.
  const STATE_TEXT = {
    [CONN.IDLE]: '',
    [CONN.CHECKING]: 'Checking...',
    [CONN.STARTING]: 'Starting voice engine...',
    [CONN.OK]: 'Connected',
    [CONN.NO_LIST]: REASONS.NO_LIST,
    [CONN.NO_VOICES]: REASONS.NO_VOICES,
    [CONN.FAILED]: REASONS.UNREACHABLE
  };

  // --- Server URL -----------------------------------------------------------

  /**
   * The Server URL to use: the stored one, unless it is missing, empty or the
   * old port-8000 default, which counts as unset and is replaced silently.
   */
  function normalizeServerUrl(stored, defaultUrl) {
    if (typeof stored !== 'string') return defaultUrl;
    const trimmed = stored.trim();
    if (trimmed === '' || trimmed === OLD_DEFAULT_SERVER_URL) return defaultUrl;
    return stored;
  }

  /**
   * The voices address for a speech address: same origin, a trailing
   * `/audio/speech` replaced by `/audio/voices`, any query and fragment
   * dropped, `?model=tts-1` added. Null when the address is not an http(s)
   * URL or its path does not end in `/audio/speech` (a trailing slash is
   * allowed): such a server counts as connected with no voice list.
   */
  function deriveVoicesUrl(serverUrl) {
    if (typeof serverUrl !== 'string') return null;
    let url;
    try {
      url = new URL(serverUrl.trim());
    } catch (_error) {
      return null;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    const path = url.pathname.replace(/\/+$/, '');
    if (!path.endsWith(SPEECH_SUFFIX)) return null;
    url.pathname = path.slice(0, path.length - SPEECH_SUFFIX.length) + VOICES_SUFFIX;
    url.search = `?model=${VOICES_MODEL}`;
    url.hash = '';
    return url.toString();
  }

  // --- Voices -----------------------------------------------------------------

  function entryId(entry) {
    if (typeof entry === 'string') return entry;
    if (entry && typeof entry === 'object') {
      for (const key of ['id', 'name', 'voice']) {
        if (typeof entry[key] === 'string' && entry[key].trim() !== '') return entry[key];
      }
    }
    return '';
  }

  /**
   * The raw voice ids in a voices response: `{voices: [...]}` or a bare
   * array; entries are strings, or objects read by `id`, then `name`, then
   * `voice`. Empties and duplicates are dropped and server order is kept.
   * Null when the data has neither shape (an empty list is `[]`, not null).
   */
  function parseVoices(data) {
    const list = Array.isArray(data) ? data : data && Array.isArray(data.voices) ? data.voices : null;
    if (!list) return null;
    const seen = new Set();
    const ids = [];
    for (const entry of list) {
      const id = entryId(entry);
      if (id.trim() === '' || seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
    }
    return ids;
  }

  /** A voice id without a trailing .wav, .mp3, .flac or .ogg (any case). */
  function stripExtension(id) {
    return String(id).replace(/\.(wav|mp3|flac|ogg)$/i, '');
  }

  /**
   * [{id, label}] in the given order. The label is the id without its audio
   * extension; where that would make two labels the same (Olivia.wav and
   * Olivia.mp3) those voices show their raw ids instead.
   */
  function labelVoices(ids) {
    const labels = ids.map((id) => stripExtension(id).trim() || id);
    const counts = new Map();
    for (const label of labels) counts.set(label, (counts.get(label) || 0) + 1);
    return ids.map((id, i) => ({ id, label: counts.get(labels[i]) > 1 ? id : labels[i] }));
  }

  /**
   * Which voice the Voice box should select. `voices` is [{id, label}]
   * (non-empty). A saved voice on the list is kept. An empty one, or the old
   * default when the server does not offer it, counts as unset: the first
   * voice and no note. Any other missing voice gives the first voice and a
   * note. This only decides; it never writes the choice anywhere.
   */
  function reconcileVoice(saved, voices) {
    const first = voices[0];
    const wanted = typeof saved === 'string' ? saved : '';
    if (wanted.trim() === '') return { voice: first.id, note: '' };
    if (voices.some((v) => v.id === wanted)) return { voice: wanted, note: '' };
    if (wanted === OLD_DEFAULT_VOICE) return { voice: first.id, note: '' };
    return { voice: first.id, note: `Voice ${wanted} is not on this server; using ${first.label}` };
  }

  // --- Connection check ----------------------------------------------------------

  /**
   * One plain GET of the Voices URL (no headers, no auth), mapped to
   *   { state, reason, voices }  - voices is [{id, label}] for connOk;
   *   { aborted: true }          - the caller's signal fired: apply nothing.
   * Any thrown fetch error is one state whatever its message (CORS, mixed
   * content, DNS, refused and offline are not told apart). The request is
   * given up after `timeoutMs` (90 s). `fetch`, `setTimeout` and
   * `clearTimeout` can be injected for tests.
   */
  async function checkVoices(options = {}) {
    const { serverUrl, signal, timeoutMs = VOICES_TIMEOUT_MS } = options;
    const url = deriveVoicesUrl(serverUrl);
    if (!url) return { state: CONN.NO_LIST, reason: REASONS.CANNOT_DERIVE, voices: [] };

    const setTimer = options.setTimeout || setTimeout;
    const clearTimer = options.clearTimeout || clearTimeout;
    const controller = new AbortController();
    let timedOut = false;
    const onCallerAbort = () => controller.abort();
    if (signal) {
      if (signal.aborted) return { aborted: true };
      signal.addEventListener('abort', onCallerAbort);
    }
    const timer = setTimer(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    const failed = (reason) => ({ state: CONN.FAILED, reason, voices: [] });
    try {
      let response;
      try {
        const doFetch = options.fetch || globalThis.fetch.bind(globalThis);
        response = await doFetch(url, { signal: controller.signal });
      } catch (_error) {
        if (timedOut) return failed(REASONS.TIMED_OUT);
        if (signal && signal.aborted) return { aborted: true };
        return failed(REASONS.UNREACHABLE);
      }

      if (signal && signal.aborted) return { aborted: true }; // an answer that arrives after the caller moved on

      const status = response.status;
      if (status === 404 || status === 405) return { state: CONN.NO_LIST, reason: REASONS.NO_LIST, voices: [] };
      if (status === 401 || status === 403) return failed(`Not authorised (${status})`);
      if (status !== 200) return failed(`Server error ${status}`);

      let data;
      try {
        data = await response.json(); // never quote the body: it is not ours to log
      } catch (_error) {
        if (timedOut) return failed(REASONS.TIMED_OUT);
        if (signal && signal.aborted) return { aborted: true };
        return failed(REASONS.UNEXPECTED);
      }
      const ids = parseVoices(data);
      if (!ids) return failed(REASONS.UNEXPECTED);
      if (ids.length === 0) return { state: CONN.NO_VOICES, reason: REASONS.NO_VOICES, voices: [] };
      return { state: CONN.OK, reason: '', voices: labelVoices(ids) };
    } finally {
      clearTimer(timer);
      if (signal) signal.removeEventListener('abort', onCallerAbort);
    }
  }

  // --- Play gate ---------------------------------------------------------------------

  /**
   * The connection's half of the Play gate: open only for connOk, or for
   * connNoList while there is a voice name to send. The session's half is the
   * caller's; Play is enabled only when both allow.
   */
  function connectionAllowsPlay(state, voiceName) {
    if (state === CONN.OK) return true;
    return state === CONN.NO_LIST && typeof voiceName === 'string' && voiceName.trim() !== '';
  }

  const TTSVoices = {
    CONN,
    REASONS,
    STATE_TEXT,
    VOICES_TIMEOUT_MS,
    STARTING_AFTER_MS,
    OLD_DEFAULT_SERVER_URL,
    OLD_DEFAULT_VOICE,
    normalizeServerUrl,
    deriveVoicesUrl,
    parseVoices,
    stripExtension,
    labelVoices,
    reconcileVoice,
    checkVoices,
    connectionAllowsPlay
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = TTSVoices;
  } else {
    const root = typeof self !== 'undefined' ? self : typeof window !== 'undefined' ? window : globalThis;
    root.TTSVoices = TTSVoices;
  }
})();
