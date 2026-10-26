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

// Does a control message (play, pause) name the session that owns the audio
// element right now?
function isCurrentSession(message) {
  return message.sessionId != null && message.sessionId === currentSessionId;
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

    // Play and Pause come from the background, which owns the paused flag, and
    // carry the session id. One that does not name the session on the audio
    // element (a late message from a replaced session) is ignored.
    case 'play':
      if (!isCurrentSession(message)) {
        console.warn('[TTS Reader] Ignoring play for another session.');
        break;
      }
      audioElement.play().catch((err) => console.warn('Resume error:', err));
      break;

    case 'pause':
      if (!isCurrentSession(message)) {
        console.warn('[TTS Reader] Ignoring pause for another session.');
        break;
      }
      audioElement.pause();
      break;

    case 'stop': {
      // A Stop for a replaced session must not tear down the audio of the
      // session that replaced it. A Stop with no id, or one arriving when
      // nothing is loaded, always tears down.
      if (message.sessionId != null && currentSessionId !== null && message.sessionId !== currentSessionId) {
        console.warn('[TTS Reader] Ignoring stop for another session.');
        break;
      }
      const stoppedSessionId = message.sessionId ?? currentSessionId;
      // Whatever session was playing is over: a playChunk for it that is
      // still on its way must not start anything.
      playLedger.retire(playLedger.current);
      if (message.sessionId != null) playLedger.retire(message.sessionId);
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
      chrome.runtime.sendMessage({ type: 'stateUpdate', state: 'stopped', sessionId: stoppedSessionId });
      break;
    }

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
// Tagged with the session id so the background can drop a report from a
// replaced session.
audioElement.onplay = () => {
  chrome.runtime.sendMessage({ type: 'stateUpdate', state: 'playing', sessionId: currentSessionId });
};

// There is deliberately no onpause report: Pause goes popup -> background,
// which records `paused` itself and then tells this document to pause. An
// element that pauses on its own (a `src` swap, Stop) is not a user Pause.

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
