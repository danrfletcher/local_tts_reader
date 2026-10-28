const DEFAULT_SETTINGS = {
    serverUrl: 'http://localhost:8090/v1/audio/speech',
    // Empty means "the first voice the connected server offers".
    voice: '',
    speed: 1.0,
    recordAudio: false,
    preprocessText: true
  };
  
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { DEFAULT_SETTINGS };
  } else {
    self.DEFAULT_SETTINGS = DEFAULT_SETTINGS;
  }