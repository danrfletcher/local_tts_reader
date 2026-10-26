'use strict';
/** Helpers for driving a faked reading session through the real background.js. */
const { settle } = require('./fake-chrome.js');

const SETTINGS = {
  serverUrl: 'http://localhost:8000/v1/audio/speech',
  voice: 'af_bella',
  speed: '1',
  recordAudio: false,
  preprocessText: true
};

/** Press Play: the popup's startStreaming message. Resolves when the first sentence has been sent. */
function startRead(bg, settings = SETTINGS) {
  return bg.send({ type: 'startStreaming', settings, record: false, mode: 'selection' }, { wait: true });
}

function playChunks(bg) {
  return bg.sentOfType('playChunk');
}

/**
 * Act as the offscreen document for one chunk: echo the ids on audioReady
 * (with one <audio> element), then report it ended.
 */
async function finishChunk(bg, chunk, { audioElements = 1 } = {}) {
  await bg.send({
    type: 'audioReady',
    sessionId: chunk.sessionId,
    index: chunk.index,
    playNumber: chunk.playNumber,
    audioElements
  });
  await bg.send({
    type: 'chunkEnded',
    index: chunk.index,
    sessionId: chunk.sessionId,
    playNumber: chunk.playNumber
  });
  await settle();
}

/** Play every sentence in turn until the session ends. */
async function readToEnd(bg, expectedChunks) {
  for (let i = 0; i < expectedChunks; i++) {
    const chunk = playChunks(bg)[i];
    if (!chunk) throw new Error(`playChunk ${i} was never sent`);
    await finishChunk(bg, chunk);
  }
}

async function downloadLog(bg) {
  const response = await bg.send({ type: 'getDebugLog' }, { wait: true });
  if (!response || !response.success) throw new Error('getDebugLog failed');
  return response.log;
}

module.exports = { SETTINGS, startRead, playChunks, finishChunk, readToEnd, downloadLog };
