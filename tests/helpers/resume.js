'use strict';
/**
 * Fixtures and drivers for the resume-after-long-Pause tests (PR-4): a
 * three-sentence and a ten-sentence array, a 1 KB fake audio buffer, a
 * recording fetch, a worker restart, and "read up to sentence N and pause".
 */
const { settle, createFakeChrome, createFakeFetch, okResponse, loadBackground } = require('./fake-chrome.js');
const { playChunks } = require('./session.js');
const { RAW_SETTINGS, pressPlayNoWait, control, chunkReady, endChunk, liveSession } = require('./pause.js');

const THREE = [
  'Alpha sentence is first.',
  'Bravo sentence is second.',
  'Charlie sentence is third.'
];

const TEN = [
  'Sentence one is read aloud.',
  'Sentence two is read aloud.',
  'Sentence three is read aloud.',
  'Sentence four is read aloud.',
  'Sentence five is read aloud.',
  'Sentence six is read aloud.',
  'Sentence seven is read aloud.',
  'Sentence eight is read aloud.',
  'Sentence nine is read aloud.',
  'Sentence ten is read aloud.'
];

/** 1 KB of fake audio. */
const AUDIO_1KB = Uint8Array.from({ length: 1024 }, (_, i) => (i * 31 + 7) & 0xff);

/** A fetch that answers at once with the 1 KB buffer and records which sentence each call asked for. */
function createRecordingFetch(sentences) {
  const fetchFn = createFakeFetch(() => okResponse(AUDIO_1KB));
  /** Sentence indexes fetched so far, in call order. */
  fetchFn.indexes = () => fetchFn.calls.map((c) => sentences.indexOf(c.body.input));
  return fetchFn;
}

/** A background with the recording fetch and the given sentences. Extra options go to createFakeChrome. */
function setupResume({ sentences = THREE, ...chromeOptions } = {}) {
  const fetch = createRecordingFetch(sentences);
  const bg = loadBackground({ sentences, fetch, ...chromeOptions });
  return { bg, fetch, sentences };
}

/** Press Play and play sentences 0..index-1 to their ends, leaving sentence `index` playing. */
async function readUpTo(bg, index) {
  await pressPlayNoWait(bg, RAW_SETTINGS);
  await settle();
  for (let i = 0; i < index; i++) {
    const chunk = playChunks(bg)[i];
    await chunkReady(bg, chunk);
    await endChunk(bg, chunk);
  }
  if (playChunks(bg).length !== index + 1) throw new Error(`sentence ${index} is not playing`);
  return playChunks(bg)[index];
}

/** readUpTo, then the audio element reports ready and Pause is pressed. Returns the playing chunk. */
async function readAndPause(bg, index) {
  const chunk = await readUpTo(bg, index);
  await chunkReady(bg, chunk);
  await control(bg, 'pause', chunk.sessionId);
  await settle();
  return chunk;
}

/**
 * The service worker restarts: a fresh `background.js` in a fresh vm context
 * and a fresh fake chrome whose storage areas and alarms hold what the old
 * one's did. The audio document is up or gone as `offscreenUp` says.
 */
function restartWorker(old, { sentences, offscreenUp = false, fetch, ...options } = {}) {
  const fake = createFakeChrome({
    sentences,
    offscreenUp,
    localStorage: old.chrome.storage.local.snapshot(),
    sessionStorage: old.chrome.storage.session.snapshot(),
    ...options
  });
  for (const [name, alarm] of old.alarms) fake.alarms.set(name, alarm);
  return loadBackground({ fake, fetch });
}

/** Play every remaining sentence in turn, from the one now playing, until the session ends. */
async function finishRead(bg, total, { from = 0 } = {}) {
  for (let i = from; i < total; i++) {
    await settle();
    const chunks = playChunks(bg).filter((c) => c.index === i);
    const chunk = chunks[chunks.length - 1];
    if (!chunk) throw new Error(`sentence ${i} was never played`);
    await chunkReady(bg, chunk);
    await endChunk(bg, chunk);
  }
  await settle();
}

/** The events of one type in the downloaded log. */
async function logEvents(bg, type) {
  const response = await bg.send({ type: 'getDebugLog' }, { wait: true });
  return response.log.events.filter((e) => e.type === type);
}

module.exports = {
  THREE,
  TEN,
  AUDIO_1KB,
  createRecordingFetch,
  setupResume,
  readUpTo,
  readAndPause,
  restartWorker,
  finishRead,
  logEvents,
  liveSession
};
