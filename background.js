importScripts('constants.js', 'textProcessor.js', 'lib/voices.js', 'lib/playback.js');

let currentPlayerState = 'stopped';
let creating = null; // A global promise to avoid concurrency issues

// --- Active reading session state -------------------------------------
// A "session" covers one Play press through to Stop/completion/error.
// Only one session is active at a time.
let session = null;

// Every request to start reading takes a token the moment it arrives, before
// any await. A start whose token is no longer the latest has been superseded
// and returns without touching `session`, so overlapping starts (popup Play
// plus the context menu, or Play pressed twice) leave exactly one session.
const startTokens = TTSPlayback.createStartTokens();

// --- Always-on debug log -----------------------------------------------
// Appended to only from this file; lives in chrome.storage.local under
// 'ttsDebugLog'. Events are built from an allowlist (lib/playback.js), so
// they hold ids, counts, sizes and hashes — never sentence text or URLs.
// Logging must never change playback, so it never throws into the caller.
const debugLog = TTSPlayback.createDebugLog({
  storage: chrome.storage.local,
  key: TTSPlayback.LOG_STORAGE_KEY,
  onError: (error) => console.warn('[TTS Reader] Debug log write failed:', TTSPlayback.sanitizeError(error))
});

function logEvent(type, fields) {
  try {
    debugLog.append(TTSPlayback.buildEvent(type, fields));
  } catch (error) {
    console.warn('[TTS Reader] Could not log event:', TTSPlayback.sanitizeError(error));
  }
}

// Ids from a message (offscreen echoes them back) are only logged if they
// have the right shape; buildEvent drops anything else.
function messageIds(message) {
  return {
    sessionId: message.sessionId,
    index: message.index,
    playNumber: message.playNumber
  };
}

const FIRST_CHUNK_TIMEOUT_MS = 55000; // cold-start: backend may take ~30s to wake up
const SUBSEQUENT_CHUNK_TIMEOUT_MS = 18000; // warm backend: ~1-2s typical
const KEEPALIVE_ALARM_NAME = 'tts-reader-keepalive';
const MIN_READABLE_FRAME_LENGTH = 200;
const FRAME_PREFERENCE_MARGIN = 200;

// --- Session state kept across service-worker restarts -------------------
// Chrome stops the worker when it is idle and may restart it while a session
// is paused. The session's sentences and position are written to
// chrome.storage.session (browser memory only, cleared when the browser
// closes) on start, every play, Pause and Play; a restarted worker rebuilds a
// paused session from it (hydrateSession). Writes never throw into playback.
// The stored record holds the sentences (needed to carry on reading) but no
// page URL and no TTS server URL: see TTSPlayback.buildStoredSession.
const sessionStore = TTSPlayback.createSessionStore({
  storage: chrome.storage.session,
  onError: (error) => console.warn('[TTS Reader] Session state write failed:', TTSPlayback.sanitizeError(error))
});

function persistSession(s) {
  if (!s || s.stopped || session !== s || s.sentences.length === 0) return;
  try {
    sessionStore.save(TTSPlayback.buildStoredSession(s), s.sentences);
  } catch (error) {
    console.warn('[TTS Reader] Could not store session state:', TTSPlayback.sanitizeError(error));
  }
}

function forgetStoredSession() {
  try {
    sessionStore.clear();
  } catch (error) {
    console.warn('[TTS Reader] Could not clear session state:', TTSPlayback.sanitizeError(error));
  }
}

// Every handler waits for this before it looks at `session`, so the first
// message a restarted worker handles sees the rebuilt session instead of
// answering "stopped". It never rejects.
let hydrated = false;
let hydration = null;

function ensureHydrated() {
  if (!hydration) {
    hydration = hydrateSession()
      .catch((error) => console.warn('[TTS Reader] Could not rebuild the session:', TTSPlayback.sanitizeError(error)))
      .then(() => { hydrated = true; });
  }
  return hydration;
}

function discardStoredSession(reason) {
  logEvent('session-discarded', { reason });
  forgetStoredSession();
}

/**
 * Rebuild the paused session a previous worker stored, if there is one and it
 * is still usable: the stored shape is complete, the tab still exists and the
 * settings can be read. Anything else is discarded (and cleared from storage),
 * so Play starts a new session as usual. Resolves to the rebuilt session or
 * null; never throws.
 */
async function hydrateSession() {
  let loaded;
  try {
    loaded = await sessionStore.load();
  } catch (error) {
    console.warn('[TTS Reader] Could not read stored session state:', TTSPlayback.sanitizeError(error));
    discardStoredSession('read-failed');
    return null;
  }
  if (loaded.meta === undefined && loaded.sentences === undefined) return null; // nothing stored

  const parsed = TTSPlayback.parseStoredSession(loaded.meta, loaded.sentences);
  if (!parsed.ok) {
    discardStoredSession(parsed.reason);
    return null;
  }
  const stored = parsed.value;

  try {
    await chrome.tabs.get(stored.tabId);
  } catch (_error) {
    discardStoredSession('tab-gone'); // stale: the tab it was reading no longer exists
    return null;
  }

  let serverUrl;
  try {
    ({ serverUrl } = await chrome.storage.local.get({ serverUrl: DEFAULT_SETTINGS.serverUrl }));
  } catch (_error) {
    discardStoredSession('settings-failed');
    return null;
  }
  serverUrl = TTSVoices.normalizeServerUrl(serverUrl, DEFAULT_SETTINGS.serverUrl); // an old stored default counts as unset

  if (session) return null; // a session exists already; never replace it with an old one

  const s = newSession(stored.tabId, stored.frameId, { ...stored.settings, serverUrl }, stored.isRecording, stored.sessionId);
  s.sentences = stored.sentences;
  s.contentSessionId = stored.contentSessionId;
  s.currentIndex = stored.currentIndex;
  s.currentPlayNumber = stored.playNumber > 0 ? stored.playNumber : null;
  s.playCounter.seed(stored.currentIndex, stored.playNumber);
  s.paused = true;
  if (stored.advance) {
    // The sentence at currentIndex had already ended (or the next one was
    // loading) when the Pause happened: Play moves on to the next sentence,
    // as in the worker that stored this. Nothing about the old audio
    // document matters for that, so this is an ordinary paused session
    // waiting to advance, and playing the next sentence is not a replay.
    s.advanceOnResume = true;
  } else {
    s.hydrated = true;
  }
  session = s;
  currentPlayerState = 'paused';
  ensureKeepAlive(); // the alarm keeps running while paused
  logEvent('session-hydrated', {
    sessionId: s.sessionId,
    count: s.sentences.length,
    ...(s.currentIndex >= 0 ? { index: s.currentIndex } : {})
  });
  return s;
}

function newSession(tabId, frameId, settings, isRecording, sessionId) {
  const s = {
    sessionId, // minted here; separate from the content script's numeric id
    playCounter: TTSPlayback.createPlayCounter(),
    // Play number of the sentence handed to the audio element right now.
    currentPlayNumber: null,
    // Accepts each (session id, index, play number) of chunkEnded once.
    endedLedger: TTSPlayback.createPlayLedger(),
    playEnded: false, // the current play has been accepted as ended (or stalled)
    durationKnown: false, // the offscreen document reported this play's duration
    tabId,
    frameId,
    settings,
    isRecording,
    sentences: [],
    contentSessionId: null,
    currentIndex: -1,
    prefetch: null, // { index, promise } | { index, result: {arrayBuffer, mimeType} }
    abortControllers: new Map(), // index -> AbortController
    recordedChunks: [], // in order, for recordAudio
    stallTimer: null,
    // Pause state. The background owns it: Pause, Play and Stop reach it from
    // the popup (see handleControlAudio), never straight from the popup to the
    // offscreen document.
    paused: false,
    // The sentence whose bytes were loaded while paused, kept until Play:
    // { index, audioResult }.
    heldChunk: null,
    // The audio of the sentence handed to the audio element, { index,
    // audioResult }, kept until that sentence ends (or Stop / replacement) so
    // Play can replay it after Chrome closed the audio document, without
    // fetching it again.
    currentAudio: null,
    // audioDocumentGeneration when this session's current sentence was sent
    // to the audio document; null until the first playChunk.
    audioGeneration: null,
    // Rebuilt from chrome.storage.session after a worker restart and not played
    // since: the bytes are gone and the audio document's state is unknown.
    hydrated: false,
    // A Play is deciding how to resume (it awaits getContexts / the document
    // being recreated); a second Play meanwhile does nothing.
    resuming: false,
    // A sentence ended while paused; Play plays the one after it.
    advanceOnResume: false,
    // Index of the sentence playFromIndex is fetching or about to hand to the
    // audio element; null when none is in flight.
    loadingIndex: null,
    durationSec: null, // the current play's audio duration, once reported
    // Token of the start request that made this session. A later token means
    // this start was superseded; playFromIndex re-checks it for every
    // sentence, see supersededBeforePlay.
    startToken: null,
    stopped: false
  };
  s.endedLedger.begin(sessionId);
  return s;
}

function isActive(s) {
  return session === s && !s.stopped;
}

// Is the audio document there right now? getContexts rejecting counts as
// absent: the caller then tries to create it, and createDocument says if it
// was there after all.
async function offscreenDocumentPresent() {
  try {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [chrome.runtime.getURL('./offscreen.html')]
    });
    return contexts.length > 0;
  } catch (_error) {
    return false;
  }
}

// Chrome allows one offscreen document, and a second createDocument rejects
// with this message: the document is there, which is all we wanted.
function isSingleDocumentError(error) {
  return /Only a single offscreen document/i.test(String(error && error.message));
}

// Which audio document is up. Every time createDocument really creates one
// (not when it says one exists already) this goes up by one; each playChunk
// records the value it was sent under (s.audioGeneration). Chrome closes the
// document after 30 s without audio and the popup's setupOffscreen message
// then makes a fresh, empty one, so "a document exists" does not mean "the
// document that holds this session's sentence": only the same generation does.
let audioDocumentGeneration = 0;

async function setupOffscreenDocument() {
  const path = './offscreen.html';
  if (await offscreenDocumentPresent()) return;

  // One creation at a time: callers that arrive while it is in flight wait
  // for it instead of starting another.
  if (!creating) {
    const attempt = chrome.offscreen.createDocument({
      url: path,
      reasons: ['AUDIO_PLAYBACK'],
      justification: 'Playing TTS audio in the background'
    }).then(() => {
      audioDocumentGeneration += 1; // a new, empty document
    }, (error) => {
      if (!isSingleDocumentError(error)) throw error;
    });
    creating = attempt;
    // Reset on success and on failure, so one failed attempt cannot make
    // every later call await the same rejected promise.
    const reset = () => { if (creating === attempt) creating = null; };
    attempt.then(reset, reset);
  }
  await creating;
}

// Set up context menu items
function setupContextMenu() {
  chrome.contextMenus.create({
    id: "readAloud",
    title: "Read Aloud",
    contexts: ["selection", "page"]
  });
}

// Handle context menu clicks
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "readAloud") {
    // info.frameId is populated by Chrome itself (browser-level, not
    // page JS), so it correctly identifies the frame the user actually
    // right-clicked/selected in — including inside a cross-origin
    // iframe, which our own in-page window.getSelection() check could
    // never see (each frame has its own separate selection state).
    startReadingFromTab(tab.id, info.frameId);
  }
});

// contentScript.js's prepareSession() already falls back to the whole
// page when there's no active selection, so 'selection' mode covers
// both "text selected" and "nothing selected -> read the page" cases.
async function startReadingFromTab(tabId, frameId) {
  const token = startTokens.next();
  try {
    await ensureHydrated(); // a restarted worker's paused session is replaced like any other
    const settings = await chrome.storage.local.get({
      serverUrl: DEFAULT_SETTINGS.serverUrl,
      voice: DEFAULT_SETTINGS.voice,
      speed: DEFAULT_SETTINGS.speed,
      recordAudio: DEFAULT_SETTINGS.recordAudio,
      preprocessText: DEFAULT_SETTINGS.preprocessText
    });
    settings.serverUrl = TTSVoices.normalizeServerUrl(settings.serverUrl, DEFAULT_SETTINGS.serverUrl); // an old stored default counts as unset
    if (!startTokens.isCurrent(token)) {
      logSupersededStart('queued');
      return;
    }
    await beginSession(tabId, settings, settings.recordAudio, 'selection', frameId, token);
  } catch (error) {
    console.error('Error starting reading from tab:', error);
    if (startTokens.isCurrent(token)) broadcastError(error.message);
  }
}

// Handle messages from popup or offscreen document. A restarted worker has no
// `session` until it has rebuilt the stored one, so until then a message waits
// (the channel stays open) and is handled once hydration is done: the first
// message after a restart sees the paused session, never "stopped".
const HANDLED_MESSAGE_TYPES = new Set([
  'setupOffscreen', 'startStreaming', 'controlAudio', 'stopSession', 'stateUpdate',
  'getSessionState', 'audioReady', 'chunkEnded', 'audioDuration', 'playDropped',
  'getPlayerState', 'seek', 'getTimeInfo', 'timeUpdate', 'getDebugLog', 'clearDebugLog'
]);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !HANDLED_MESSAGE_TYPES.has(message.type)) return false;
  if (hydrated) return handleMessage(message, sender, sendResponse);
  // A start takes its token on arrival, not once hydration is done, so the
  // order of overlapping starts is the order they were pressed in.
  const arrivalToken = message.type === 'startStreaming' ? startTokens.next() : undefined;
  ensureHydrated().then(() => handleMessage(message, sender, sendResponse, arrivalToken));
  return true;
});

function handleMessage(message, _sender, sendResponse, arrivalToken) {
  switch (message.type) {
    case 'setupOffscreen':
      setupOffscreenDocument().then(() => sendResponse({ success: true }));
      return true;

    case 'startStreaming': {
      const token = arrivalToken !== undefined ? arrivalToken : startTokens.next();
      (async () => {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        const tabId = tabs[0]?.id ?? null;
        if (!startTokens.isCurrent(token)) {
          logSupersededStart('queued');
          sendResponse({ success: true, superseded: true });
          return;
        }
        await beginSession(tabId, message.settings, message.record, message.mode || 'selection', undefined, token);
        sendResponse({ success: true });
      })();
      return true;
    }

    case 'controlAudio':
      handleControlAudio(message);
      return true;

    case 'stopSession':
      // The overlay's close button and Escape send this without a session id
      // (the content script does not know it): that is always a Stop. A Stop
      // that names a session only counts for the live one.
      handleControlAudio({ action: 'stop', sessionId: message.sessionId });
      sendResponse({ success: true });
      return true;

    case 'stateUpdate':
      handleOffscreenState(message);
      return true;

    case 'getSessionState':
      sendResponse(sessionStateSnapshot());
      return true;

    case 'audioReady':
      logEvent('audio-ready', { ...messageIds(message), audioElements: message.audioElements });
      // A late audioReady from a replaced session must not flip the state of
      // the session that replaced it.
      if (!session || session.stopped || message.sessionId !== session.sessionId) return true;
      if (currentPlayerState === 'loading' || currentPlayerState === 'starting') {
        // Through setPlayerState so the broadcast carries the session id; the
        // popup disables Play for a live session in 'ready'.
        setPlayerState('ready');
      }
      return true;

    case 'chunkEnded':
      logEvent('chunk-ended', messageIds(message));
      handleChunkEnded(message).catch((error) => {
        console.error('Error handling chunk end:', error);
        broadcastError(error.message);
        stopSession('error');
      });
      return true;

    case 'audioDuration':
      handleAudioDuration(message);
      return true;

    case 'playDropped':
      // The offscreen document refused a playChunk (duplicate or from a
      // replaced session). Only the background writes the log, so it records
      // the drop on the offscreen document's behalf.
      logEvent('dropped-play-chunk', { ...messageIds(message), reason: message.reason });
      return true;

    case 'getPlayerState':
      sendResponse({ state: currentPlayerState });
      return true;

    case 'seek':
      chrome.runtime.sendMessage({
        type: 'seek',
        time: message.time
      }, (response) => {
        sendResponse(response);
      });
      return true;

    case 'getTimeInfo':
      chrome.runtime.sendMessage({ type: 'getTimeInfo' })
        .then((response) => sendResponse(response))
        .catch(() => sendResponse(null)); // offscreen doc not up yet
      return true;

    case 'timeUpdate':
      broadcast(message);
      return true;

    case 'getDebugLog':
      buildDebugLogFile().then(
        (log) => sendResponse({ success: true, log }),
        (error) => sendResponse({ success: false, error: TTSPlayback.sanitizeError(error) })
      );
      return true;

    case 'clearDebugLog':
      debugLog.clear().then(
        (ok) => sendResponse({ success: ok }),
        (error) => sendResponse({ success: false, error: TTSPlayback.sanitizeError(error) })
      );
      return true;
  }
  return false;
}

// Fire-and-forget broadcast to other extension contexts (popup,
// offscreen document). If nothing is listening right now (e.g. the
// popup is closed) the promise rejects with "Could not establish
// connection" — expected and harmless, but must be caught or Chrome
// logs it as an uncaught error against the extension.
function broadcast(message) {
  chrome.runtime.sendMessage(message).catch(() => {});
}

// The popup's "Download log" asks the background (the only owner of the
// log) rather than the offscreen document, which may not be running.
async function buildDebugLogFile() {
  const events = await debugLog.getAll();
  return {
    generatedAt: new Date().toISOString(),
    extensionId: chrome.runtime.id,
    version: chrome.runtime.getManifest().version,
    eventCount: events.length,
    sentences: TTSPlayback.summariseLog(events),
    events
  };
}

// --- Pause, Play and Stop ------------------------------------------------
// The background owns the paused flag. Pause stops the stall timer, so a
// paused session never advances by itself; nothing below starts a sentence
// while `s.paused` is set except Play (see TTSPlayback.playbackTransition).

/** What the popup reads when it opens, and before it picks Play's meaning. */
function sessionStateSnapshot() {
  const s = session;
  if (!s || s.stopped) {
    return { active: false, sessionId: null, paused: false, index: 0, total: 0 };
  }
  return {
    active: true,
    sessionId: s.sessionId,
    paused: s.paused,
    index: Math.max(0, s.currentIndex),
    total: s.sentences.length
  };
}

// Where the session is, for TTSPlayback.playbackTransition. A session that has
// not handed its first sentence over yet counts as loading.
function phaseOf(s) {
  if (!s) return 'idle';
  if (s.stopped) return 'stopped';
  if (s.paused) return 'paused';
  if (s.loadingIndex !== null || s.currentPlayNumber === null) return 'loading';
  return 'playing';
}

function flagsOf(s) {
  return {
    held: s.heldChunk !== null,
    advanceOnResume: s.advanceOnResume,
    fetchPending: s.loadingIndex !== null || s.currentPlayNumber === null
  };
}

function logControlDropped(message, reason) {
  logEvent('dropped-control', { sessionId: message.sessionId, reason });
}

function handleControlAudio(message) {
  const { action } = message;
  const s = session;
  const live = Boolean(s) && !s.stopped;

  if (action === 'stop') {
    // No id: the overlay's Escape / close button, always a Stop.
    if (message.sessionId == null) {
      stopSession('user');
      return;
    }
    if (!live || message.sessionId !== s.sessionId) {
      logControlDropped(message, live ? 'stale-session' : 'no-session');
      return;
    }
    stopSession('user');
    return;
  }

  if (action !== 'pause' && action !== 'play') return;
  if (!live) {
    logControlDropped(message, 'no-session');
    return;
  }
  if (message.sessionId !== s.sessionId) {
    logControlDropped(message, 'stale-session');
    return;
  }

  const transition = TTSPlayback.playbackTransition(phaseOf(s), action, flagsOf(s));
  // A rebuilt session has no audio element of its own to resume (its flags
  // cannot say what the audio document holds), so every Play decides afresh.
  const resumeAudio = action === 'play' && s.paused && (s.hydrated || transition.action === 'resume-audio');
  if (resumeAudio) {
    if (s.resuming) {
      // Play pressed again while the first is recreating the document.
      logControlDropped(message, 'resume-pending');
      return;
    }
    s.resuming = true; // synchronously, before the first await
    resumePausedAudio(s).catch((error) => {
      console.error('Error resuming after Play:', error);
      if (!isActive(s)) return;
      logEvent('error', { sessionId: s.sessionId, error });
      broadcastError(TTSPlayback.sanitizeError(error)); // the session stays paused
    });
    return;
  }
  switch (transition.action) {
    case 'pause':
      s.paused = true;
      clearStallTimer(s);
      // The offscreen document may be gone (Chrome closes it after 30 s
      // without audio); the pause is recorded here either way.
      broadcast({ type: 'pause', sessionId: s.sessionId });
      setPlayerState('paused');
      logEvent('pause', { sessionId: s.sessionId, ...(s.currentIndex >= 0 ? { index: s.currentIndex } : {}) });
      persistSession(s);
      break;

    case 'resume-held': {
      const index = s.heldChunk.index;
      s.paused = false;
      setPlayerState(index === 0 ? 'starting' : 'loading');
      logEvent('resume', { sessionId: s.sessionId, index, reason: 'resume-held' });
      runPlay(s, index);
      break;
    }

    case 'resume-advance': {
      const index = s.currentIndex + 1;
      s.paused = false;
      s.advanceOnResume = false;
      setPlayerState('loading');
      logEvent('resume', { sessionId: s.sessionId, index, reason: 'resume-advance' });
      runPlay(s, index);
      break;
    }

    case 'resume-wait':
      // A fetch is still in flight; when it lands it plays, because the
      // session is no longer paused.
      s.paused = false;
      setPlayerState(s.loadingIndex === null || s.loadingIndex === 0 ? 'starting' : 'loading');
      logEvent('resume', { sessionId: s.sessionId, reason: 'resume-wait' });
      persistSession(s);
      break;

    default:
      // 'none': Pause twice, Play twice, or Play when there is nothing to
      // resume (the popup starts a new session itself).
      logControlDropped(message, 'no-op');
  }
}

// Play on a paused session whose current sentence is already loaded in the
// audio element (the transition's 'resume-audio'), or on a rebuilt one. Which
// of the three resumes it gets depends on whether Chrome has closed the audio
// document since the Pause (TTSPlayback.decideResume); see the notes there.
// `s.resuming` is already set by the caller and is cleared here.
async function resumePausedAudio(s) {
  try {
    const offscreenPresent = await offscreenDocumentPresent();
    if (!isActive(s) || !s.paused) return; // Stopped or replaced meanwhile

    const kept = s.currentAudio && s.currentAudio.index === s.currentIndex ? s.currentAudio : null;
    // "Present" means the document that was sent this session's current
    // sentence. A document the popup (or anything else) created after Chrome
    // closed that one is present but empty, and a bare `play` would reach
    // nobody who can use it.
    const sameDocument = offscreenPresent && s.audioGeneration === audioDocumentGeneration;
    const decision = TTSPlayback.decideResume({
      paused: s.paused,
      offscreenPresent: sameDocument,
      haveBytes: kept !== null,
      hydrated: s.hydrated
    });

    if (decision === 'continue') {
      // Same session, same sentence, nothing to fetch: the audio element
      // carries on, and the stall timer is re-armed for that sentence.
      s.paused = false;
      broadcast({ type: 'play', sessionId: s.sessionId });
      armStallTimer(s, s.currentIndex, s.currentPlayNumber, s.durationSec);
      setPlayerState('playing');
      logEvent('resume', { sessionId: s.sessionId, index: s.currentIndex, reason: 'resume-audio' });
      persistSession(s);
      return;
    }
    if (decision === 'none') return;

    // The audio is gone. Bring the document back before leaving the paused
    // state: if that fails the session stays paused and says so.
    try {
      await setupOffscreenDocument();
    } catch (error) {
      console.error('Error recreating the offscreen document:', error);
      logEvent('error', { sessionId: s.sessionId, error });
      if (isActive(s)) broadcastError(TTSPlayback.sanitizeError(error) || 'Could not restart the audio player.');
      return;
    }
    if (!isActive(s) || !s.paused) return;

    // A session paused before its first sentence played starts at the first.
    const index = Math.max(0, s.currentIndex);
    s.paused = false;
    s.hydrated = false;
    if (decision === 'replay-from-bytes') s.heldChunk = { index, audioResult: kept.audioResult };
    setPlayerState(index === 0 ? 'starting' : 'loading');
    logEvent('resume', { sessionId: s.sessionId, index, reason: decision });
    runPlay(s, index, decision);
  } finally {
    s.resuming = false;
  }
}

/** playFromIndex from a control path, with the same failure handling as a stall advance. */
function runPlay(s, index, replayKind) {
  playFromIndex(s, index, { replayKind }).catch((error) => {
    console.error('Error playing after Play:', error);
    if (!isActive(s)) return;
    broadcastError(error.message);
    stopSession('error');
  });
}

// The offscreen document reports the audio element's own state. The
// background owns paused and stopped, so only a 'playing' report from the
// live, unpaused session is taken; anything from another session, or arriving
// while paused or after Stop, is dropped.
function handleOffscreenState(message) {
  const s = session;
  let reason = null;
  if (!s || message.sessionId !== s.sessionId) reason = 'stale-session';
  else if (s.stopped) reason = 'stopped';
  else if (s.paused) reason = 'paused';
  else if (message.state !== 'playing') reason = 'not-playing';
  if (reason) {
    logEvent('dropped-state-update', { sessionId: message.sessionId, reason });
    return;
  }
  setPlayerState('playing');
}

// --- Session lifecycle ---------------------------------------------------

function logSupersededStart(stage, sessionId) {
  logEvent('start-superseded', { sessionId, outcome: stage });
}

// `token` comes from startTokens.next() and is taken when the start request
// arrived; a direct call without one takes its token now. After every await
// below, a start that is no longer the latest returns without touching
// `session` (and tears down its own session if it had already created one).
async function beginSession(tabId, settings, isRecording, mode, frameId, token = startTokens.next()) {
  // Mint before replacing the old session so a new id never repeats the id
  // of the session it replaces.
  const sessionId = TTSPlayback.mintSessionId(Math.random, (id) => !!session && session.sessionId === id);

  // Any previous session is replaced.
  stopSession('replaced');

  if (!tabId) {
    broadcastError('No active tab to read from.');
    return;
  }

  setPlayerState('loading');

  // The popup's Play button has no frame context (unlike the context
  // menu, which gives us info.frameId directly) — probe every frame in
  // the tab for one with an active selection, or failing that, whoever
  // has substantially more text than the main frame (e.g. a page like
  // wikiroulette.co that embeds the actual article in a same/cross-
  // origin iframe and leaves only nav chrome in the main frame).
  const resolvedFrameId = frameId != null ? frameId : await pickBestFrame(tabId, mode);
  if (!startTokens.isCurrent(token)) {
    logSupersededStart('frame-probe', sessionId);
    return;
  }

  const s = newSession(tabId, resolvedFrameId, settings, isRecording, sessionId);
  s.startToken = token;
  session = s;
  logEvent('session-start', {
    sessionId,
    mode,
    frameId: resolvedFrameId,
    extensionId: chrome.runtime.id,
    version: chrome.runtime.getManifest().version
  });

  try {
    await chrome.scripting.executeScript({
      target: { tabId, frameIds: [resolvedFrameId] },
      files: ['vendor/readability.js', 'sentenceSplitter.js', 'contentScript.js']
    });
    if (abandonIfSuperseded(s, token, 'inject')) return;

    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [resolvedFrameId] },
      func: (mode) => window.__ttsPrepareSession(mode),
      args: [mode]
    });

    if (abandonIfSuperseded(s, token, 'prepare') || !isActive(s)) return;

    const sentences = (result && result.sentences) || [];
    if (sentences.length === 0) {
      broadcastError('No readable text found.');
      stopSession('empty');
      return;
    }

    s.sentences = sentences;
    s.contentSessionId = result.sessionId;
    logEvent('sentences', { sessionId, count: sentences.length });
    persistSession(s); // from here a restarted worker can rebuild this session

    await setupOffscreenDocument();
    if (abandonIfSuperseded(s, token, 'offscreen') || !isActive(s)) return;

    ensureKeepAlive();
    await playFromIndex(s, 0);
  } catch (error) {
    console.error('Error beginning session:', error);
    logEvent('error', { sessionId, error });
    if (isActive(s)) {
      broadcastError(error.message);
      stopSession('error');
    }
  }
}

// A start that lost to a later one. Normally the later start's stopSession
// already stopped `s`; if that later start never got that far, stop it here so
// a superseded session is not left half-started.
function abandonIfSuperseded(s, token, stage) {
  if (startTokens.isCurrent(token)) return false;
  logSupersededStart(stage, s.sessionId);
  if (session === s && !s.stopped) stopSession('superseded');
  return true;
}

/**
 * Pick which frame in the tab to read from. A lightweight, standalone
 * probe (no dependency on our other injected files) run in every frame
 * via allFrames — cross-origin frames are reachable too, since the
 * manifest's host_permissions already cover all http/https origins.
 *
 * - If reading a selection, prefer whichever frame actually has one.
 * - Otherwise prefer the frame with substantially more text than the
 *   main frame, so a page that embeds its real content in an iframe
 *   (leaving only nav chrome in the main frame) still reads correctly.
 *   The margin avoids being fooled by a modest ad/tracker iframe.
 * - Falls back to the main frame (0) if probing fails entirely, or if
 *   nothing clearly beats it.
 */
async function pickBestFrame(tabId, mode) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => {
        const sel = window.getSelection();
        const hasSelection = !!(sel && sel.rangeCount > 0 && !sel.isCollapsed && sel.toString().trim());
        const textLength = document.body ? document.body.innerText.trim().length : 0;
        return { hasSelection, textLength };
      }
    });

    if (mode === 'selection') {
      const withSelection = results.find((r) => r.result && r.result.hasSelection);
      if (withSelection) return withSelection.frameId;
    }

    const mainFrame = results.find((r) => r.frameId === 0);
    const mainLength = mainFrame?.result?.textLength || 0;
    let best = mainFrame || results[0];
    let bestLength = mainLength;
    for (const r of results) {
      const len = r.result?.textLength || 0;
      if (r.frameId !== 0 && len >= MIN_READABLE_FRAME_LENGTH && len > mainLength + FRAME_PREFERENCE_MARGIN && len > bestLength) {
        best = r;
        bestLength = len;
      }
    }
    return best ? best.frameId : 0;
  } catch (error) {
    console.error('Error probing frames:', error);
    return 0;
  }
}

// A play that was abandoned because its session was replaced or stopped while
// it waited on a fetch or the offscreen document. Nothing was sent to the
// audio element; the log says why.
function logSkippedPlay(s, index) {
  logEvent('play-skipped', {
    sessionId: s.sessionId,
    index,
    reason: session === s ? 'stopped' : 'replaced'
  });
}

// A later start takes its token on arrival but only stops this session once it
// reaches beginSession, so between those two moments this session must not
// reach playChunk. beginSession checks the token after each of its own awaits;
// playFromIndex re-checks it here for every sentence (not just the first)
// after each await and before the playChunk broadcast. `stage` names the
// check in the start-superseded log: `${first|next}-${advance|fetch|offscreen}`
// (advance = the check on entry, before any await).
// Returns true when `s` was superseded (and has been stopped). A session that
// is already stopped (replaced by right-click Read Aloud, Stop then Play, an
// error) was never a start that lost a race: return false without logging, and
// the caller's isActive check skips the play and logs play-skipped instead.
function supersededBeforePlay(s, index, step) {
  if (s.startToken === null || s.stopped) return false;
  return abandonIfSuperseded(s, s.startToken, `${index === 0 ? 'first' : 'next'}-${step}`);
}

async function playFromIndex(s, index, { replayKind } = {}) {
  // Checked before the end-of-read branch too: a superseded session must not
  // announce that it finished.
  if (supersededBeforePlay(s, index, 'advance')) {
    logSkippedPlay(s, index);
    return;
  }
  if (!isActive(s) || index >= s.sentences.length) {
    finishSession(s);
    return;
  }

  s.loadingIndex = index;
  // A paused session keeps showing paused while its sentence loads.
  if (!s.paused) setPlayerState(index === 0 ? 'starting' : 'loading');

  let audioResult;
  try {
    if (s.heldChunk && s.heldChunk.index === index) {
      // Held while paused: its bytes are already here, nothing to fetch.
      audioResult = s.heldChunk.audioResult;
      s.heldChunk = null;
    } else if (s.prefetch && s.prefetch.index === index) {
      audioResult = await s.prefetch.promise;
      s.prefetch = null;
    } else {
      audioResult = await fetchChunkAudio(s, index);
    }
  } catch (error) {
    if (supersededBeforePlay(s, index, 'fetch') || !isActive(s)) {
      logSkippedPlay(s, index);
      return;
    }
    console.error(`Error fetching chunk ${index}:`, error);
    logEvent('error', { sessionId: s.sessionId, index, error });
    broadcastError(error.message || 'Failed to reach the TTS server.');
    stopSession('error');
    return;
  }

  if (supersededBeforePlay(s, index, 'fetch') || !isActive(s)) {
    logSkippedPlay(s, index);
    return;
  }

  // Re-verify (cheap no-op if it already exists) rather than trusting
  // the one-time setup at session start — guards against the offscreen
  // document having been silently torn down mid-session, which would
  // otherwise leave every future playChunk broadcast with no listener.
  await setupOffscreenDocument();
  if (supersededBeforePlay(s, index, 'offscreen') || !isActive(s)) {
    logSkippedPlay(s, index);
    return;
  }

  // Pause may have arrived while this sentence loaded. Keep its bytes and
  // send nothing until Play; the fetch is never aborted for a Pause.
  const fetched = TTSPlayback.playbackTransition(phaseOf(s), 'fetchDone', flagsOf(s));
  s.loadingIndex = null;
  if (fetched.action === 'hold-chunk') {
    s.heldChunk = { index, audioResult };
    logEvent('chunk-held', { sessionId: s.sessionId, index });
    return;
  }

  s.currentIndex = index;
  // Not a new sentence when a resume plays the current one again: it was
  // recorded the first time.
  if (s.isRecording && !replayKind) {
    s.recordedChunks.push(audioResult);
  }

  const playNumber = s.playCounter.next(index);
  s.currentPlayNumber = playNumber;
  s.playEnded = false;
  s.durationKnown = false;
  s.durationSec = null;
  // Kept until this sentence ends, for a replay after Chrome closes the audio.
  s.currentAudio = { index, audioResult };
  s.audioGeneration = audioDocumentGeneration; // the document this goes to (setupOffscreenDocument ran just above)
  broadcast({
    type: 'playChunk',
    audioData: Array.from(new Uint8Array(audioResult.arrayBuffer)),
    mimeType: audioResult.mimeType,
    index,
    sessionId: s.sessionId,
    playNumber
  });
  logEvent('play', { sessionId: s.sessionId, index, playNumber });
  // A play number above 1 is this sentence handed over again: no text, no URL.
  if (replayKind && playNumber > 1) {
    logEvent('replay', { sessionId: s.sessionId, index, playNumber, kind: replayKind });
  }
  persistSession(s);

  broadcast({
    type: 'sentenceProgress',
    index,
    total: s.sentences.length,
    sessionId: s.sessionId,
    playNumber
  });

  notifyHighlight(s, index);
  // Always the fixed hang timeout here: the duration is only known once the
  // audio document reports loadedmetadata for this play.
  armStallTimer(s, index, playNumber, undefined);

  // Start prefetching the next chunk while this one plays (a replay already
  // has it, or its fetch, from the first play).
  const nextIndex = index + 1;
  if (nextIndex < s.sentences.length && !(s.prefetch && s.prefetch.index === nextIndex)) {
    const promise = fetchChunkAudio(s, nextIndex);
    s.prefetch = { index: nextIndex, promise };
    promise.catch(() => {}); // handled when it's actually consumed
  }
}

// Chrome's tab-audio pipeline has occasionally been observed (verified
// live, testing long infobox/reference-heavy pages) to silently stop
// advancing after many dozens of rapid, very short chunks in a row: the
// offscreen document acks 'audioReady' but neither onplay nor onended
// ever fires afterward, and background.js has no signal that anything
// went wrong — the session just sits there forever. Rather than leave
// the whole read hung on one bad chunk, force-advance if a chunk we
// believe is playing hasn't reported ended in time.
//
// "In time" depends on the sentence: until the offscreen document reports
// the audio's duration the timeout is a fixed 60 s; once it has, the timeout
// is duration + 5 s, so a long sentence (e.g. at 0.25x speed) is never cut
// off. See TTSPlayback.stallTimeoutMs.

function armStallTimer(s, index, playNumber, durationSec) {
  clearStallTimer(s);
  const timeoutMs = TTSPlayback.stallTimeoutMs({ durationSec, paused: Boolean(s.paused) });
  if (timeoutMs === null) return; // paused: no deadline
  s.stallTimer = setTimeout(() => {
    s.stallTimer = null;
    if (!isActive(s) || s.paused || s.currentIndex !== index || s.currentPlayNumber !== playNumber) return;
    // Counts as this play's end: a chunkEnded that turns up later is then a
    // duplicate and is ignored, and a stall after a real end does nothing.
    if (!s.endedLedger.accept(s.sessionId, index, playNumber).ok) return;
    s.playEnded = true;
    s.currentAudio = null; // this sentence is over; its bytes are not needed again
    console.warn(`[TTS Reader] Chunk ${index} never reported ended after ${timeoutMs}ms; advancing anyway.`);
    logEvent('stall', { sessionId: s.sessionId, index, playNumber, ms: timeoutMs });
    playFromIndex(s, index + 1).catch((error) => {
      console.error('Error advancing after a stall:', error);
      if (!isActive(s)) return;
      broadcastError(error.message);
      stopSession('error');
    });
  }, timeoutMs);
}

function clearStallTimer(s) {
  if (s.stallTimer) {
    clearTimeout(s.stallTimer);
    s.stallTimer = null;
  }
}

// The sentence playing right now, as the (session id, index, play number)
// that messages about it must carry; null when nothing is playing.
function liveTriple() {
  const s = session;
  if (!s || s.stopped || s.currentIndex < 0 || s.currentPlayNumber === null) return null;
  return { sessionId: s.sessionId, index: s.currentIndex, playNumber: s.currentPlayNumber };
}

async function handleChunkEnded(message) {
  const reason = TTSPlayback.staleReason(liveTriple(), message);
  if (reason) {
    logEvent('dropped-chunk-ended', { ...messageIds(message), reason });
    return;
  }
  const s = session;
  // Accepted once per triple, synchronously, so a second chunkEnded that
  // arrives while playFromIndex is still awaiting the prefetch is a duplicate.
  const verdict = s.endedLedger.accept(message.sessionId, message.index, message.playNumber);
  if (!verdict.ok) {
    logEvent('dropped-chunk-ended', { ...messageIds(message), reason: verdict.reason });
    return;
  }
  s.playEnded = true;
  s.currentAudio = null; // this sentence is over; its bytes are not needed again
  clearStallTimer(s);
  const transition = TTSPlayback.playbackTransition(phaseOf(s), 'chunkEnded', flagsOf(s));
  if (transition.action === 'defer-advance') {
    // Paused: the sentence ended but the session must not move on. Play
    // plays the next one, once.
    s.advanceOnResume = true;
    logEvent('advance-deferred', { sessionId: s.sessionId, index: message.index });
    persistSession(s); // a restarted worker must also move on, not replay the sentence that ended
    return;
  }
  if (transition.action !== 'advance') return;
  await playFromIndex(s, message.index + 1);
}

// The offscreen document reports the audio's duration once its metadata has
// loaded. The first usable report for the current play replaces the 60 s
// hang timeout with duration + 5 s. Anything else is ignored: a report for
// another play, a duration of NaN, 0 or Infinity (which arrives as null),
// a repeat, or one for a play that has already ended.
function handleAudioDuration(message) {
  const reason = TTSPlayback.staleReason(liveTriple(), message);
  const s = session;
  let ignore = reason;
  if (!ignore && !TTSPlayback.isUsableDuration(message.duration)) ignore = 'bad-duration';
  if (!ignore && s.durationKnown) ignore = 'duplicate';
  if (!ignore && s.playEnded) ignore = 'ended';
  if (ignore) {
    logEvent('dropped-audio-duration', { ...messageIds(message), reason: ignore });
    return;
  }
  s.durationKnown = true;
  s.durationSec = message.duration;
  logEvent('audio-duration', { ...messageIds(message), ms: Math.round(message.duration * 1000) });
  armStallTimer(s, message.index, message.playNumber, message.duration);
}

async function fetchChunkAudio(s, index, attempt = 1) {
  const isFirst = index === 0;
  const timeoutMs = isFirst ? FIRST_CHUNK_TIMEOUT_MS : SUBSEQUENT_CHUNK_TIMEOUT_MS;
  const controller = new AbortController();
  s.abortControllers.set(index, controller);
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  // Every HTTP attempt is one 'fetch' event, so a timeout retry shows as two.
  let attemptLogged = false;
  const logFetch = (fields) => {
    attemptLogged = true;
    logEvent('fetch', {
      sessionId: s.sessionId,
      index,
      playNumber: s.playCounter.peek(index),
      attempt,
      ms: Date.now() - startedAt,
      ...fields
    });
  };

  try {
    const response = await fetch(s.settings.serverUrl, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'audio/mpeg, audio/wav, audio/*'
      },
      body: JSON.stringify({
        model: 'tts-1',
        voice: s.settings.voice,
        input: preprocessSentence(s.sentences[index], s.settings),
        speed: Number.parseFloat(s.settings.speed)
      })
    });

    if (!response.ok) {
      logFetch({ outcome: 'http-error', status: response.status });
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const audioBlob = await response.blob();
    const mimeType = audioBlob.type || 'audio/mpeg';
    const arrayBuffer = await audioBlob.arrayBuffer();
    let hash;
    try {
      hash = await TTSPlayback.sha256Prefix(arrayBuffer);
    } catch (hashError) {
      console.warn('[TTS Reader] Could not hash audio:', TTSPlayback.sanitizeError(hashError));
    }
    logFetch({ outcome: 'ok', bytes: arrayBuffer.byteLength, hash });
    return { arrayBuffer, mimeType };
  } catch (error) {
    const wasAborted = error.name === 'AbortError';
    if (!attemptLogged) {
      logFetch(wasAborted
        ? { outcome: isActive(s) ? 'timeout' : 'aborted' }
        : { outcome: 'error', error });
    }
    if (wasAborted && attempt < 2 && isActive(s)) {
      // One retry on timeout before surfacing an error.
      return fetchChunkAudio(s, index, attempt + 1);
    }
    if (wasAborted) {
      throw new Error('The TTS server took too long to respond.');
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
    // On a timeout retry, a newer controller may already have replaced
    // this one under the same `index` key by the time this `finally`
    // runs (the recursive retry call starts synchronously before this
    // block executes) — only delete our own entry, never a newer one.
    if (s.abortControllers.get(index) === controller) {
      s.abortControllers.delete(index);
    }
  }
}

function preprocessSentence(text, settings) {
  if (settings.preprocessText && typeof TextProcessor !== 'undefined') {
    try {
      return TextProcessor.process(text);
    } catch (e) {
      console.error('Error preprocessing sentence:', e);
    }
  }
  return text;
}

function notifyHighlight(s, index) {
  if (s.tabId == null || s.contentSessionId == null) return;
  chrome.tabs.sendMessage(s.tabId, {
    type: 'ttsHighlightSentence',
    sessionId: s.contentSessionId,
    index
  }, { frameId: s.frameId }).catch(() => {}); // tab/frame may have navigated away; ignore
}

function clearPageHighlight(s) {
  if (!s || s.tabId == null) return;
  chrome.tabs.sendMessage(s.tabId, {
    type: 'ttsClearHighlight',
    sessionId: s.contentSessionId
  }, { frameId: s.frameId }).catch(() => {});
}

function clearPauseState(s) {
  s.paused = false;
  s.heldChunk = null;
  s.currentAudio = null;
  s.advanceOnResume = false;
  s.loadingIndex = null;
}

function finishSession(s) {
  if (!isActive(s)) return;
  s.stopped = true;
  clearPauseState(s);
  forgetStoredSession();
  logEvent('session-end', { sessionId: s.sessionId, reason: 'finished' });
  clearStallTimer(s);
  clearPageHighlight(s);
  finalizeRecording(s);
  clearKeepAliveIfIdle();
  setPlayerState('stopped');
}

function stopSession(reason) {
  const s = session;
  if (!s) return;
  if (!s.stopped) logEvent('session-end', { sessionId: s.sessionId, reason });
  s.stopped = true;
  clearPauseState(s); // a Stop (or replacement) ends a pause and drops any held chunk
  forgetStoredSession();
  clearStallTimer(s);
  for (const controller of s.abortControllers.values()) {
    controller.abort();
  }
  s.abortControllers.clear();
  s.prefetch = null;
  // Carries the id so the offscreen document tears down only this session's
  // audio, and a late Stop for a replaced session cannot hit the new one.
  broadcast({ type: 'stop', sessionId: s.sessionId });
  clearPageHighlight(s);
  finalizeRecording(s);
  clearKeepAliveIfIdle();
  if (session === s) {
    currentPlayerState = 'stopped';
    broadcast({ type: 'playerStateUpdate', state: 'stopped', sessionId: null });
  }
}

function finalizeRecording(s) {
  if (!s.isRecording || s.recordedChunks.length === 0) return;
  try {
    const mimeType = s.recordedChunks[0].mimeType || 'audio/mpeg';
    const buffers = s.recordedChunks.map((c) => c.arrayBuffer);
    const blob = new Blob(buffers, { type: mimeType });
    const audioUrl = URL.createObjectURL(blob);
    broadcast({ type: 'recordingComplete', audioUrl });
  } catch (e) {
    console.error('Error assembling recorded audio:', e);
  }
}

// The popup enables Pause during starting/loading only once a session exists,
// so every state update says which session (if any) is live.
function setPlayerState(state) {
  currentPlayerState = state;
  const live = session && !session.stopped ? session.sessionId : null;
  broadcast({ type: 'playerStateUpdate', state, sessionId: live });
}

function broadcastError(message) {
  broadcast({ type: 'streamError', error: message });
}

// --- Keep-alive heartbeat -------------------------------------------------
// MV3 service workers can be terminated by Chrome after ~30s of perceived
// inactivity; a raw fetch() awaiting a slow (cold-start) backend isn't
// always treated as "activity". A periodic alarm wakes the worker and
// performs a trivial extension-API call, which resets that idle clock.

function ensureKeepAlive() {
  chrome.alarms.get(KEEPALIVE_ALARM_NAME, (existing) => {
    if (!existing) {
      chrome.alarms.create(KEEPALIVE_ALARM_NAME, { periodInMinutes: 0.5 });
    }
  });
}

function clearKeepAliveIfIdle() {
  if (!session || session.stopped) {
    chrome.alarms.clear(KEEPALIVE_ALARM_NAME);
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== KEEPALIVE_ALARM_NAME) return;
  // A worker the alarm just woke has no `session` until it has rebuilt the
  // stored paused one; deciding before that would clear the alarm that is
  // keeping the paused session alive.
  if (hydrated) onKeepAlive();
  else ensureHydrated().then(onKeepAlive);
});

function onKeepAlive() {
  if (!session || session.stopped) {
    chrome.alarms.clear(KEEPALIVE_ALARM_NAME);
    return;
  }
  // Any extension-API call is enough to register activity and keep the
  // worker warm through a long in-flight fetch.
  chrome.storage.local.get('__ttsKeepAlivePing', () => {});
}

// Initialize context menu when extension is installed or updated
chrome.runtime.onInstalled.addListener(() => {
  setupContextMenu();
});

// A worker that just started looks for a paused session its predecessor stored.
// Every handler above waits for this (ensureHydrated / `hydrated`).
ensureHydrated();
