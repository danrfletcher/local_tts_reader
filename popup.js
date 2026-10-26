let audioPlayer = null;
let currentAudioUrl = null;
// Id of the background's live reading session, or null. Kept from the state
// updates the background broadcasts and from getSessionState when the popup
// opens; Pause is only offered during starting/loading once one exists.
let activeSessionId = null;

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
}

function getSettings() {
  return {
    serverUrl: document.getElementById('serverUrl').value,
    voice: document.getElementById('voice').value,
    speed: document.getElementById('speed').value,
    recordAudio: document.getElementById('recordAudio').checked,
    preprocessText: document.getElementById('preprocessText').checked
  };
}

async function saveSettings() {
  const settings = getSettings();
  await chrome.storage.local.set(settings);
  updateStatus('Settings saved!', false);
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

  // Initialize audio player
  audioPlayer = new AudioPlayer();
  await audioPlayer.init();
  
  // Load saved settings
  chrome.storage.local.get({
    serverUrl: DEFAULT_SETTINGS.serverUrl,
    voice: DEFAULT_SETTINGS.voice,
    speed: DEFAULT_SETTINGS.speed,
    recordAudio: DEFAULT_SETTINGS.recordAudio,
    preprocessText: DEFAULT_SETTINGS.preprocessText
  }, function(result) {
    document.getElementById('serverUrl').value = result.serverUrl;
    document.getElementById('voice').value = result.voice;
    document.getElementById('speed').value = result.speed;
    document.getElementById('recordAudio').checked = result.recordAudio;
    document.getElementById('preprocessText').checked = result.preprocessText;
    document.querySelector('.speed-value').textContent = `${result.speed}x`;
  });
  
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
  
  // Save settings
  ['serverUrl', 'voice', 'speed', 'recordAudio', 'preprocessText'].forEach(id => {
    document.getElementById(id).addEventListener('change', saveSettings);
  });
  
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