class AudioPlayer {
    constructor() {
      this.isPlaying = false;
      this.isInitialized = false;
    }
  
    async init() {
      if (!this.isInitialized) {
        // Set up the offscreen document for background playback
        await chrome.runtime.sendMessage({ type: 'setupOffscreen' });
        this.isInitialized = true;
      }
    }
  
    async play(settings) {
      await this.init();

      try {
        // Start a new reading session. background.js (via a content
        // script) captures the selection/page text itself, splits it
        // into sentence chunks, and streams them in order.
        await chrome.runtime.sendMessage({
          type: 'startStreaming',
          settings: settings,
          record: settings.recordAudio,
          mode: 'selection'
        });

        this.isPlaying = true;
        return true;
      } catch (error) {
        console.error('Error playing audio:', error);
        throw error;
      }
    }
  
    // Pause, Play (resume) and Stop all go to background.js, which owns the
    // session and its paused flag; none is sent to the offscreen document
    // from here. Each names the session it means (from getSessionState), so
    // a message for a session that has since been replaced does nothing.
    // Stop without an id is an unconditional Stop.
    pause(sessionId) {
      if (this.isInitialized) {
        chrome.runtime.sendMessage({ type: 'controlAudio', action: 'pause', sessionId });
        this.isPlaying = false;
      }
    }
  
    resume(sessionId) {
      if (this.isInitialized) {
        chrome.runtime.sendMessage({ type: 'controlAudio', action: 'play', sessionId });
        this.isPlaying = true;
      }
    }
  
    stop(sessionId) {
      if (this.isInitialized) {
        // Lets background.js abort any in-flight/prefetch fetch, drop a
        // held chunk and clear the remaining sentence queue, not just halt
        // whatever's currently playing.
        chrome.runtime.sendMessage({ type: 'controlAudio', action: 'stop', sessionId });
        this.isPlaying = false;
      }
    }

    // { active, sessionId, paused, index, total } from the background.
    async getSessionState() {
      return new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: 'getSessionState' }, (response) => {
          resolve(response || { active: false, sessionId: null, paused: false, index: 0, total: 0 });
        });
      });
    }
  
    async seek(time) {
      if (this.isInitialized) {
        return new Promise((resolve) => {
          chrome.runtime.sendMessage({ type: 'seek', time: time }, (response) => {
            resolve(response && response.success);
          });
        });
      }
      return false;
    }
  
    async getState() {
      return new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: 'getPlayerState' }, (response) => {
          resolve((response && response.state) || 'stopped');
        });
      });
    }
  
    async getTimeInfo() {
      return new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: 'getTimeInfo' }, (response) => {
          // No response when the offscreen document is not running (Chrome
          // closes it after 30 s without audio, e.g. while paused).
          resolve((response && response.timeInfo) || null);
        });
      });
    }
  }
  
  window.AudioPlayer = AudioPlayer;