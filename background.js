importScripts('textProcessor.js', 'lib/playback.js');

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

async function setupOffscreenDocument() {
  const path = './offscreen.html';
  const offscreenUrl = chrome.runtime.getURL(path);
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [offscreenUrl],
  });

  if (existingContexts.length > 0) {
    return;
  }

  if (creating) {
    await creating;
  } else {
    creating = chrome.offscreen.createDocument({
      url: path,
      reasons: ['AUDIO_PLAYBACK'],
      justification: 'Playing TTS audio in the background'
    });
    await creating;
    creating = null;
  }
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
    const settings = await chrome.storage.local.get({
      serverUrl: 'http://localhost:8000/v1/audio/speech',
      voice: 'af_bella',
      speed: 1.0,
      recordAudio: false,
      preprocessText: true
    });
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

// Handle messages from popup or offscreen document
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  switch (message.type) {
    case 'setupOffscreen':
      setupOffscreenDocument().then(() => sendResponse({ success: true }));
      return true;

    case 'startStreaming': {
      const token = startTokens.next();
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
});

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
  switch (transition.action) {
    case 'pause':
      s.paused = true;
      clearStallTimer(s);
      // The offscreen document may be gone (Chrome closes it after 30 s
      // without audio); the pause is recorded here either way.
      broadcast({ type: 'pause', sessionId: s.sessionId });
      setPlayerState('paused');
      logEvent('pause', { sessionId: s.sessionId, ...(s.currentIndex >= 0 ? { index: s.currentIndex } : {}) });
      break;

    case 'resume-audio':
      // Same session, same sentence, nothing to fetch: the audio element
      // carries on, and the stall timer is re-armed for that sentence.
      s.paused = false;
      broadcast({ type: 'play', sessionId: s.sessionId });
      armStallTimer(s, s.currentIndex, s.currentPlayNumber, s.durationSec);
      setPlayerState('playing');
      logEvent('resume', { sessionId: s.sessionId, index: s.currentIndex, reason: 'resume-audio' });
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
      break;

    default:
      // 'none': Pause twice, Play twice, or Play when there is nothing to
      // resume (the popup starts a new session itself).
      logControlDropped(message, 'no-op');
  }
}

/** playFromIndex from a control path, with the same failure handling as a stall advance. */
function runPlay(s, index) {
  playFromIndex(s, index).catch((error) => {
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

async function playFromIndex(s, index) {
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
  if (s.isRecording) {
    s.recordedChunks.push(audioResult);
  }

  const playNumber = s.playCounter.next(index);
  s.currentPlayNumber = playNumber;
  s.playEnded = false;
  s.durationKnown = false;
  s.durationSec = null;
  broadcast({
    type: 'playChunk',
    audioData: Array.from(new Uint8Array(audioResult.arrayBuffer)),
    mimeType: audioResult.mimeType,
    index,
    sessionId: s.sessionId,
    playNumber
  });
  logEvent('play', { sessionId: s.sessionId, index, playNumber });

  broadcast({
    type: 'sentenceProgress',
    index,
    total: s.sentences.length,
    sessionId: s.sessionId,
    playNumber
  });

  notifyHighlight(s, index);
  armStallTimer(s, index, playNumber, undefined);

  // Start prefetching the next chunk while this one plays.
  const nextIndex = index + 1;
  if (nextIndex < s.sentences.length) {
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
  clearStallTimer(s);
  const transition = TTSPlayback.playbackTransition(phaseOf(s), 'chunkEnded', flagsOf(s));
  if (transition.action === 'defer-advance') {
    // Paused: the sentence ended but the session must not move on. Play
    // plays the next one, once.
    s.advanceOnResume = true;
    logEvent('advance-deferred', { sessionId: s.sessionId, index: message.index });
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
  s.advanceOnResume = false;
  s.loadingIndex = null;
}

function finishSession(s) {
  if (!isActive(s)) return;
  s.stopped = true;
  clearPauseState(s);
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
  if (!session || session.stopped) {
    chrome.alarms.clear(KEEPALIVE_ALARM_NAME);
    return;
  }
  // Any extension-API call is enough to register activity and keep the
  // worker warm through a long in-flight fetch.
  chrome.storage.local.get('__ttsKeepAlivePing', () => {});
});

// Initialize context menu when extension is installed or updated
chrome.runtime.onInstalled.addListener(() => {
  setupContextMenu();
});
