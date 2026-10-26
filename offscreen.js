const audioElement = document.getElementById('audioElement');
let currentChunkIndex = null;
// Ids of the play attempt currently on the <audio> element, minted by
// background.js and echoed back on audioReady / chunkEnded.
let currentSessionId = null;
let currentPlayNumber = null;
let previousObjectUrl = null;

// Accepts each (session id, index, play number) once, so a duplicated
// playChunk cannot set `src` and call play() a second time, and a playChunk
// from a replaced or stopped session never reaches the <audio> element.
const playLedger = TTSPlayback.createPlayLedger();

function reportDroppedPlay(sessionId, index, playNumber, reason) {
  chrome.runtime.sendMessage({ type: 'playDropped', sessionId, index, playNumber, reason }).catch(() => {});
}

// Play one prefetched sentence chunk. background.js is responsible for
// ordering/prefetching; this just plays whatever it's told to, in order.
function playChunk(audioDataArray, mimeType, index, sessionId, playNumber) {
  try {
    const uint8Array = new Uint8Array(audioDataArray);
    const blob = new Blob([uint8Array], { type: mimeType });
    const audioUrl = URL.createObjectURL(blob);

    if (previousObjectUrl) {
      URL.revokeObjectURL(previousObjectUrl);
    }
    previousObjectUrl = audioUrl;
    currentChunkIndex = index;
    currentSessionId = sessionId ?? null;
    currentPlayNumber = playNumber ?? null;

    audioElement.src = audioUrl;
    audioElement.play().catch((err) => {
      console.error('Play error:', err);
      chrome.runtime.sendMessage({ type: 'streamError', error: err.message });
    });

    chrome.runtime.sendMessage({
      type: 'audioReady',
      sessionId: currentSessionId,
      index,
      playNumber: currentPlayNumber,
      audioElements: document.querySelectorAll('audio').length
    });
  } catch (error) {
    console.error('Error processing audio chunk:', error);
    chrome.runtime.sendMessage({ type: 'streamError', error: error.message });
  }
}

// Get current time and duration
function getTimeInfo() {
  return {
    currentTime: audioElement.currentTime,
    duration: audioElement.duration
  };
}

// Seek to a specific time (within the currently playing chunk)
function seekTo(time) {
  audioElement.currentTime = time;
}

// Handle messages from the background script
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  switch (message.type) {
    case 'playChunk':
      if (message.audioData) {
        // Messages from a background that sends no ids are played as before.
        if (message.sessionId != null) {
          const verdict = playLedger.accept(message.sessionId, message.index, message.playNumber, { adopt: true });
          if (!verdict.ok) {
            console.warn(`[TTS Reader] Ignoring playChunk ${message.index} (${verdict.reason}).`);
            reportDroppedPlay(message.sessionId, message.index, message.playNumber, verdict.reason);
            break;
          }
        }
        playChunk(message.audioData, message.mimeType, message.index, message.sessionId, message.playNumber);
      }
      break;

    case 'play':
      audioElement.play();
      break;

    case 'pause':
      audioElement.pause();
      break;

    case 'stop':
      // Whatever session was playing is over: a playChunk for it that is
      // still on its way must not start anything.
      playLedger.retire(playLedger.current);
      currentChunkIndex = null;
      currentSessionId = null;
      currentPlayNumber = null;
      audioElement.pause();
      audioElement.currentTime = 0;
      audioElement.removeAttribute('src');
      audioElement.load();
      if (previousObjectUrl) {
        URL.revokeObjectURL(previousObjectUrl);
        previousObjectUrl = null;
      }
      chrome.runtime.sendMessage({ type: 'stateUpdate', state: 'stopped' });
      break;

    case 'seek': {
      seekTo(message.time);
      return true;
    }
    case 'getTimeInfo':
      sendResponse({ timeInfo: getTimeInfo() });
      return true;
  }
});

// Initialize audio event handlers
audioElement.onplay = () => {
  chrome.runtime.sendMessage({ type: 'stateUpdate', state: 'playing' });
};

audioElement.onpause = () => {
  // Swapping `src` between chunks, or the explicit Stop handler above,
  // both leave currentTime at/near 0 without the user asking to pause —
  // only report a genuine user pause.
  if (!audioElement.ended && audioElement.currentTime > 0) {
    chrome.runtime.sendMessage({ type: 'stateUpdate', state: 'paused' });
  }
};

// The duration is known once the metadata has loaded. background.js uses it
// for the stall timeout. NaN and Infinity cross the message boundary as null
// and are ignored there.
audioElement.onloadedmetadata = () => {
  if (currentChunkIndex === null) return;
  chrome.runtime.sendMessage({
    type: 'audioDuration',
    sessionId: currentSessionId,
    index: currentChunkIndex,
    playNumber: currentPlayNumber,
    duration: audioElement.duration
  }).catch(() => {});
};

// A chunk finishing playback means "advance the queue", not "session
// over" — background.js decides whether there's a next chunk to play.
audioElement.onended = () => {
  if (currentChunkIndex !== null) {
    chrome.runtime.sendMessage({
      type: 'chunkEnded',
      index: currentChunkIndex,
      sessionId: currentSessionId,
      playNumber: currentPlayNumber
    });
  }
};

// Add timeupdate event for seeking
audioElement.ontimeupdate = () => {
  chrome.runtime.sendMessage({
    type: 'timeUpdate',
    timeInfo: {
      currentTime: audioElement?.currentTime ?? 0,
      duration: audioElement?.duration ?? 0
    }
  });
};
