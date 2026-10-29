let audioPlayer = null;
let currentAudioUrl = null;
// Id of the background's live reading session, or null. Kept from the state
// updates the background broadcasts and from getSessionState when the popup
// opens; Pause is only offered during starting/loading once one exists.
let activeSessionId = null;

// --- Connection light and voice list -------------------------------------
// The popup asks the connected server for its voices (lib/voices.js) when it
// opens, 500 ms after the Server URL is edited, and on a click (or Enter) on
// the light. There is no polling. Nothing is cached or
// stored: a new popup always checks again. The connection states (conn*) and
// their label are separate from the player's own 'starting' state and its
// overlay (updateControlButtons); the label is hidden while a session is
// active so the two never say "Starting voice engine" at once.
const CONN = TTSVoices.CONN;
const URL_CHECK_DEBOUNCE_MS = 500;
let connState = CONN.IDLE;
let connReason = '';
let voiceListShown = false; // the Voice box is visible (a green list, possibly mid re-check)
let voiceNameShown = false; // the "Voice name" text input is visible (amber: no voice list)
let voiceNote = '';
// The voice the user last picked or typed (or that was stored); '' means
// "first voice". It is only ever changed by the user: picking from the list or
// typing a name. A reconcile, a failed or stale check and saving other
// settings never write `voice`.
let savedVoice = '';
let checkController = null;
let checkSeq = 0;
let startingTimer = null;
let urlCheckTimer = null;
// What the player state alone says about Play; the connection gate is applied on top.
let playAllowedByPlayer = true;

// The connection's half of the Play gate: connOk, or connNoList with a
// non-empty voice name (read from whichever voice element is live).
function connectionGateOpen() {
  return TTSVoices.connectionAllowsPlay(connState, currentVoice());
}

// Play is enabled only when the player state (session gate) and the
// connection gate both allow it.
function refreshPlayGate() {
  document.getElementById('playBtn').disabled = !playAllowedByPlayer || !connectionGateOpen();
}

function renderConnection(sessionActive = activeSessionId !== null) {
  const light = document.getElementById('connLight');
  const label = document.getElementById('connLabel');
  const voiceGroup = document.getElementById('voiceGroup');
  const voiceEl = document.getElementById('voice');
  const noteEl = document.getElementById('voiceNote');
  const text = connReason || TTSVoices.STATE_TEXT[connState] || '';

  light.className = `conn-light ${connState}`;
  light.title = text || 'Not checked yet';
  label.textContent = text;
  label.hidden = sessionActive || text === '';

  voiceGroup.hidden = !voiceListShown;
  voiceEl.disabled = connState !== CONN.OK; // a re-check keeps the old list, but not usable
  // The Voice name box is never disabled or rewritten here: the user may be
  // typing in it while a check lands.
  document.getElementById('voiceNameGroup').hidden = !voiceNameShown;
  noteEl.textContent = voiceNote;
  noteEl.hidden = voiceNote === '';

  refreshPlayGate();
}

function fillVoiceSelect(voices, selectedId) {
  const voiceEl = document.getElementById('voice');
  const options = voices.map((voice) => {
    const option = document.createElement('option');
    option.value = voice.id; // the raw id is what is sent to the server
    option.textContent = voice.label;
    return option;
  });
  voiceEl.replaceChildren(...options);
  voiceEl.value = selectedId;
}

function applyCheckResult(result) {
  connState = result.state;
  connReason = result.reason || '';
  if (result.state === CONN.OK) {
    const pick = TTSVoices.reconcileVoice(savedVoice, result.voices);
    fillVoiceSelect(result.voices, pick.voice);
    voiceNote = pick.note; // cleared here when the saved voice is on the list; not written anywhere
    voiceListShown = true;
    voiceNameShown = false;
  } else {
    voiceListShown = false;
    voiceNote = '';
    // No voice list (404/405, or no derivable address): the Voice name box
    // takes the Voice box's place. It is prefilled with the saved voice only
    // when it appears; if it is already showing (a re-check) it keeps what
    // the user typed, so a result never moves the caret or clears the text.
    const showName = result.state === CONN.NO_LIST;
    if (showName && !voiceNameShown) document.getElementById('voiceName').value = savedVoice;
    voiceNameShown = showName;
  }
  renderConnection();
}

function cancelConnectionCheck() {
  clearTimeout(urlCheckTimer);
  urlCheckTimer = null;
  clearTimeout(startingTimer);
  startingTimer = null;
  if (checkController) checkController.abort();
  checkController = null;
}

// One check at a time: a new one aborts the running one, and only the latest
// check's result is applied (an aborted fetch is silent).
async function runConnectionCheck() {
  cancelConnectionCheck();
  const controller = new AbortController();
  checkController = controller;
  const seq = ++checkSeq;

  connState = CONN.CHECKING;
  connReason = '';
  renderConnection(); // the Voice box (or Voice name box) stays only if it was showing; the list is disabled
  startingTimer = setTimeout(() => {
    if (seq === checkSeq && connState === CONN.CHECKING) {
      connState = CONN.STARTING;
      renderConnection();
    }
  }, TTSVoices.STARTING_AFTER_MS);

  let result;
  try {
    result = await TTSVoices.checkVoices({
      serverUrl: document.getElementById('serverUrl').value,
      signal: controller.signal
    });
  } catch (error) {
    console.error('Error checking the voices:', error);
    result = { state: CONN.FAILED, reason: TTSVoices.REASONS.UNREACHABLE, voices: [] };
  }
  if (seq !== checkSeq || result.aborted) return;
  clearTimeout(startingTimer);
  startingTimer = null;
  checkController = null;
  applyCheckResult(result);
}

// Every edit aborts the running check at once (not only when the debounce
// fires), so a check for the old URL cannot land while the box shows a new one.
// Bumping checkSeq drops a result that already resolved. The light stays as it
// was (Checking... if a check was running) until the debounced check starts.
function scheduleConnectionCheck() {
  cancelConnectionCheck();
  checkSeq++;
  urlCheckTimer = setTimeout(() => {
    urlCheckTimer = null;
    runConnectionCheck().catch((error) => console.error('Error checking the voices:', error));
  }, URL_CHECK_DEBOUNCE_MS);
}

// The voice a new session would use, read from whichever element is live: the
// typed name while the Voice name box shows, the picked option while the list
// shows, otherwise the stored one.
function currentVoice() {
  if (voiceNameShown) return document.getElementById('voiceName').value;
  return voiceListShown ? document.getElementById('voice').value : savedVoice;
}

// Play resumes a paused session, starts a new one only when there is no live
// session (never started, stopped, or finished), and does nothing for a live
// session that is not paused (it is already reading or about to). The choice
// comes from the background's flags (getSessionState), never from the player
// state, which is only what the popup last heard.
function playButtonAction(sessionState) {
  if (!sessionState || !sessionState.active) return 'new';
  return sessionState.paused ? 'resume' : 'none';
}

function updateSentenceProgress(info) {
  const el = document.getElementById('sentenceProgress');
  if (!el) return;
  if (!info || !info.total) {
    el.textContent = '';
    return;
  }
  el.textContent = `Sentence ${info.index + 1} of ${info.total}`;
}

function updateStatus(message, isError = false) {
  const status = document.getElementById('status');
  status.textContent = message;
  status.className = `visible ${isError ? 'error' : 'success'}`;
  setTimeout(() => status.className = '', 3000);
}

// --- Debug log ---------------------------------------------------------
// The log belongs to background.js; the popup only asks for it (so this
// works with the player idle and with no offscreen document running) and
// saves it with a Blob + anchor, which needs no `downloads` permission.

async function downloadDebugLog() {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'getDebugLog' });
    if (!response || !response.success) {
      throw new Error((response && response.error) || 'No response from the background.');
    }
    const blob = new Blob([JSON.stringify(response.log, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const a = document.createElement('a');
    a.href = url;
    a.download = `tts-reader-log-${stamp}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    updateStatus('Log downloaded', false);
  } catch (error) {
    console.error('Error downloading log:', error);
    updateStatus(`Could not download log: ${error.message}`, true);
  }
}

async function clearDebugLog() {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'clearDebugLog' });
    if (!response || !response.success) {
      throw new Error((response && response.error) || 'The log could not be cleared.');
    }
    updateStatus('Log cleared', false);
  } catch (error) {
    console.error('Error clearing log:', error);
    updateStatus(`Could not clear log: ${error.message}`, true);
  }
}

function updateControlButtons(state, sessionActive = activeSessionId !== null) {
  const playBtn = document.getElementById('playBtn');
  const pauseBtn = document.getElementById('pauseBtn');
  const stopBtn = document.getElementById('stopBtn');
  const downloadBtn = document.getElementById('downloadBtn');
  const loadingIndicator = document.getElementById('loadingIndicator');
  const loadingLabel = document.getElementById('loadingLabel');
  const seekBar = document.getElementById('seekBar');

  // Hide loading indicator by default
  loadingIndicator.style.display = 'none';

  // Stop button is always enabled (except during loading/starting)
  stopBtn.disabled = state === 'loading' || state === 'starting';

  switch(state) {
    case 'starting':
      playBtn.disabled = true;
      pauseBtn.disabled = !sessionActive;
      downloadBtn.disabled = true;
      seekBar.disabled = true;
      loadingLabel.textContent = 'Starting voice engine…';
      loadingIndicator.style.display = 'flex';
      break;
    case 'loading':
      playBtn.disabled = true;
      pauseBtn.disabled = !sessionActive;
      downloadBtn.disabled = true;
      seekBar.disabled = true;
      loadingLabel.textContent = 'Loading…';
      loadingIndicator.style.display = 'flex';
      break;
    case 'ready':
      // With a live session 'ready' is the gap between a sentence being
      // fetched and its audio starting; Play there would have nothing to do.
      playBtn.disabled = sessionActive;
      pauseBtn.disabled = true;
      downloadBtn.disabled = !currentAudioUrl;
      seekBar.disabled = false;
      break;
    case 'playing':
      playBtn.disabled = true;
      pauseBtn.disabled = false;
      downloadBtn.disabled = !currentAudioUrl;
      seekBar.disabled = false;
      break;
    case 'paused':
      playBtn.disabled = false;
      pauseBtn.disabled = true;
      downloadBtn.disabled = !currentAudioUrl;
      seekBar.disabled = false;
      break;
    case 'stopped':
      playBtn.disabled = false;
      pauseBtn.disabled = true;
      downloadBtn.disabled = !currentAudioUrl;
      seekBar.disabled = true;
      // Reset seek bar to beginning
      seekBar.value = 0;
      document.getElementById('currentTime').textContent = '0:00';
      document.getElementById('duration').textContent = '0:00';
      break;
    default:
      playBtn.disabled = false;
      pauseBtn.disabled = true;
      downloadBtn.disabled = true;
      seekBar.disabled = true;
  }

  // The player state decides Play first; the connection gate can only close it.
  playAllowedByPlayer = !playBtn.disabled;
  renderConnection(sessionActive);
}

function getSettings() {
  return {
    serverUrl: document.getElementById('serverUrl').value,
    voice: currentVoice(),
    speed: document.getElementById('speed').value,
    recordAudio: document.getElementById('recordAudio').checked,
    preprocessText: document.getElementById('preprocessText').checked
  };
}

// Saves everything except `voice`, which is written only when the user picks
// one (saveVoice): the voice shown may be a reconcile, not a choice.
async function saveSettings() {
  const { voice: _voice, ...settings } = getSettings();
  await chrome.storage.local.set(settings);
  updateStatus('Settings saved!', false);
}

async function saveVoice() {
  savedVoice = document.getElementById('voice').value;
  voiceNote = '';
  renderConnection();
  await chrome.storage.local.set({ voice: savedVoice });
  updateStatus('Settings saved!', false);
}

// The typed Voice name saves on every `input` (the only other write of
// `voice` besides a pick). Play follows the box at once: enabled only while
// it is non-empty.
async function saveTypedVoice() {
  savedVoice = document.getElementById('voiceName').value;
  refreshPlayGate();
  try {
    await chrome.storage.local.set({ voice: savedVoice });
  } catch (error) {
    console.error('Error saving the voice name:', error);
  }
}

// Format time in seconds to MM:SS format
function formatTime(seconds) {
  if (isNaN(seconds)) return '0:00';
  
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.floor(seconds % 60);
  return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
}

// Sync player state when popup opens
async function syncPlayerState() {
  if (audioPlayer) {
    // The background says whether the session is paused; a paused session
    // shows Play enabled, Pause disabled and its sentence.
    const info = await audioPlayer.getSessionState();
    activeSessionId = info.active ? info.sessionId : null;
    if (info.active && info.paused) {
      updateControlButtons('paused');
    } else {
      updateControlButtons(await audioPlayer.getState());
    }
    if (info.active) updateSentenceProgress(info);
    
    // Also sync the seek bar
    const timeInfo = await audioPlayer.getTimeInfo();
    if (timeInfo) {
      const seekBar = document.getElementById('seekBar');
      seekBar.max = timeInfo.duration;
      seekBar.value = timeInfo.currentTime;
      document.getElementById('currentTime').textContent = formatTime(timeInfo.currentTime);
      document.getElementById('duration').textContent = formatTime(timeInfo.duration);
    }
  }
}

// Update seek bar periodically
function startSeekBarUpdates() {
  const updateInterval = setInterval(async () => {
    if (!audioPlayer) return;
    
    const state = await audioPlayer.getState();
    if (state !== 'playing' && state !== 'paused') {
      clearInterval(updateInterval);
      return;
    }
    
    const timeInfo = await audioPlayer.getTimeInfo();
    if (timeInfo) {
      const seekBar = document.getElementById('seekBar');
      // Only update if user is not currently dragging
      if (!seekBar.classList.contains('seeking')) {
        seekBar.max = timeInfo.duration;
        seekBar.value = timeInfo.currentTime;
        document.getElementById('currentTime').textContent = formatTime(timeInfo.currentTime);
        document.getElementById('duration').textContent = formatTime(timeInfo.duration);
      }
    }
  }, 1000);
  
  return updateInterval;
}

document.addEventListener('DOMContentLoaded', async function() {
  // Wired first, and independent of the player, so the log buttons work
  // even if the audio player below fails to initialise.
  document.getElementById('downloadLogBtn').addEventListener('click', downloadDebugLog);
  document.getElementById('clearLogBtn').addEventListener('click', clearDebugLog);

  // A click on the light re-checks at once (and restarts a running check).
  // Enter does the same; preventDefault stops the browser's own Enter-click
  // from checking a second time.
  const connLight = document.getElementById('connLight');
  const recheckNow = () => {
    runConnectionCheck().catch((error) => console.error('Error checking the voices:', error));
  };
  connLight.addEventListener('click', recheckNow);
  connLight.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    recheckNow();
  });

  document.getElementById('voiceName').addEventListener('input', saveTypedVoice);

  // Closed popup: give up on the check (a new popup starts a fresh one).
  if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('pagehide', cancelConnectionCheck);
  }

  // Load saved settings, then check the server they point at. The Voice box
  // stays hidden and Play disabled until that check succeeds.
  renderConnection();
  const result = await new Promise((resolve) => chrome.storage.local.get({
    serverUrl: DEFAULT_SETTINGS.serverUrl,
    voice: DEFAULT_SETTINGS.voice,
    speed: DEFAULT_SETTINGS.speed,
    recordAudio: DEFAULT_SETTINGS.recordAudio,
    preprocessText: DEFAULT_SETTINGS.preprocessText
  }, resolve));
  // A stored copy of the old port-8000 default counts as unset.
  document.getElementById('serverUrl').value = TTSVoices.normalizeServerUrl(result.serverUrl, DEFAULT_SETTINGS.serverUrl);
  savedVoice = typeof result.voice === 'string' ? result.voice : '';
  document.getElementById('speed').value = result.speed;
  document.getElementById('recordAudio').checked = result.recordAudio;
  document.getElementById('preprocessText').checked = result.preprocessText;
  document.querySelector('.speed-value').textContent = `${result.speed}x`;
  runConnectionCheck().catch((error) => console.error('Error checking the voices:', error));

  // Initialize audio player
  audioPlayer = new AudioPlayer();
  await audioPlayer.init();

  // Sync player state
  syncPlayerState().catch((error) => console.error('Error syncing player state:', error));
  
  // Start seek bar updates
  let updateInterval = startSeekBarUpdates();
  
  // Set up seek bar events
  const seekBar = document.getElementById('seekBar');
  
  // When user starts seeking
  seekBar.addEventListener('mousedown', function() {
    seekBar.classList.add('seeking');
  });
  
  // When user is seeking
  seekBar.addEventListener('input', function() {
    document.getElementById('currentTime').textContent = formatTime(seekBar.value);
  });
  
  // When user finishes seeking
  seekBar.addEventListener('change', async function() {
    const newTime = parseFloat(seekBar.value);
    await audioPlayer.seek(newTime);
    seekBar.classList.remove('seeking');
  });
  
  // Speed slider
  document.getElementById('speed').addEventListener('input', function(e) {
    document.querySelector('.speed-value').textContent = `${e.target.value}x`;
  });
  
  // Play button
  document.getElementById('playBtn').addEventListener('click', async function() {
    // The disabled attribute is not the only guard: a closed connection gate
    // (red, grey, amber-empty, blank voice name) sends nothing.
    if (!connectionGateOpen()) return;
    try {
      const sessionState = await audioPlayer.getSessionState();
      const action = playButtonAction(sessionState);

      if (action === 'none') return; // live, unpaused session: never replace it

      if (action === 'resume') {
        audioPlayer.resume(sessionState.sessionId);
        updateControlButtons('playing');
        
        // Restart seek bar updates
        if (updateInterval) clearInterval(updateInterval);
        updateInterval = startSeekBarUpdates();
      } else {
        // Text capture (selection or whole page), sentence splitting,
        // and per-sentence preprocessing all happen in background.js /
        // contentScript.js now, so the popup just kicks off a session.
        const settings = getSettings();

        await saveSettings();
        updateControlButtons('loading');
        await audioPlayer.play(settings);

        // Restart seek bar updates
        if (updateInterval) clearInterval(updateInterval);
        updateInterval = startSeekBarUpdates();
      }
    } catch (error) {
      console.error('Error:', error);
      updateStatus(error.message, true);
      updateControlButtons('stopped');
    }
  });
  
  // Pause button
  document.getElementById('pauseBtn').addEventListener('click', async function() {
    const sessionState = await audioPlayer.getSessionState();
    if (!sessionState.active) return; // nothing to pause
    audioPlayer.pause(sessionState.sessionId);
    updateControlButtons('paused');
  });
  
  // Stop button
  document.getElementById('stopBtn').addEventListener('click', async function() {
    const sessionState = await audioPlayer.getSessionState();
    // No live session: an id-less Stop still tears down any stray audio.
    audioPlayer.stop(sessionState.active ? sessionState.sessionId : undefined);
    updateControlButtons('stopped');
    if (updateInterval) {
      clearInterval(updateInterval);
      updateInterval = null;
    }
  });
  
  // Download button
  document.getElementById('downloadBtn').addEventListener('click', function() {
    if (currentAudioUrl) {
      const a = document.createElement('a');
      a.href = currentAudioUrl;
      a.download = 'speech.mp3';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      updateStatus('Audio downloaded', false);
    }
  });
  
  // Save settings (never the voice; see saveSettings)
  ['serverUrl', 'speed', 'recordAudio', 'preprocessText'].forEach(id => {
    document.getElementById(id).addEventListener('change', saveSettings);
  });
  document.getElementById('voice').addEventListener('change', saveVoice);

  // The Server URL is checked while typing (debounced); saving stays on `change`.
  document.getElementById('serverUrl').addEventListener('input', scheduleConnectionCheck);
  
  // Listen for messages from background script
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    switch (message.type) {
      case 'playerStateUpdate':
        activeSessionId = message.sessionId || null;
        updateControlButtons(message.state);
        if (message.state === 'playing' && !updateInterval) {
          updateInterval = startSeekBarUpdates();
        }
        if (message.state === 'stopped') {
          updateSentenceProgress(null);
        }
        break;

      case 'recordingComplete':
        currentAudioUrl = message.audioUrl;
        break;

      case 'streamError':
        updateStatus(message.error, true);
        updateControlButtons('stopped');
        updateSentenceProgress(null);
        break;

      case 'sentenceProgress':
        updateSentenceProgress(message);
        break;

      case 'timeUpdate':
        if (message.timeInfo && !seekBar.classList.contains('seeking')) {
          seekBar.max = message.timeInfo.duration;
          seekBar.value = message.timeInfo.currentTime;
          document.getElementById('currentTime').textContent = formatTime(message.timeInfo.currentTime);
          document.getElementById('duration').textContent = formatTime(message.timeInfo.duration);
        }
        break;
    }
  });
});