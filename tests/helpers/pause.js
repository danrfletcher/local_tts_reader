'use strict';
/** Helpers shared by the Pause/Play/Stop tests: a fetch that resolves on demand, and the controls the popup sends. */
const vm = require('node:vm');

const { settle, createFakeFetch, okResponse, audioBytesFor } = require('./fake-chrome.js');
const { SETTINGS } = require('./session.js');

const ALARM = 'tts-reader-keepalive';

// Distinct sentences, sent verbatim (preprocessText off), so a fetch can be matched to its index.
const SENTENCES = [
  'Alpha sentence is first.',
  'Bravo sentence is second.',
  'Charlie sentence is third.',
  'Delta sentence is fourth.',
  'Echo sentence is fifth.',
  'Foxtrot sentence is sixth.'
];
const RAW_SETTINGS = { ...SETTINGS, preprocessText: false };

/** The session object inside the worker (a top-level `let`, so read it through the context). */
function liveSession(bg) {
  return vm.runInContext('session', bg.context);
}

/**
 * A fetch that holds every request until the test resolves it. Each entry
 * records which sentence index it asked for and its AbortSignal. With
 * `auto: true` it answers at once, like a fast server. A voices GET is
 * answered from `fetch.voices` (see createFakeFetch) and kept out of
 * `entries` and `calls`, so the speech bookkeeping below is unchanged.
 */
function createGatedFetch(sentences = SENTENCES, { auto = false, voices = true } = {}) {
  const entries = [];
  const fetchFn = createFakeFetch(({ body, signal }) => {
    const index = sentences.indexOf(body.input);
    const entry = { index, input: body.input, signal, settled: false };
    if (auto) {
      entry.settled = true;
      entries.push(entry);
      return okResponse(audioBytesFor(body.input));
    }
    entries.push(entry);
    return new Promise((resolve, reject) => {
      entry.respond = () => {
        entry.settled = true;
        resolve(okResponse(audioBytesFor(body.input)));
      };
      signal.addEventListener('abort', () => {
        const error = new Error('The operation was aborted.');
        error.name = 'AbortError';
        reject(error);
      });
    });
  }, { voices });
  fetchFn.entries = entries;
  /** Fetch entries for one sentence index. */
  fetchFn.forIndex = (index) => entries.filter((e) => e.index === index);
  /** Answer every request that is still waiting, in arrival order. */
  fetchFn.respondAll = async () => {
    for (const e of entries) if (!e.settled && e.respond) e.respond();
    await settle();
  };
  return fetchFn;
}

/** Press Play from the popup without waiting for the first sentence to arrive. */
function pressPlayNoWait(bg, settings = RAW_SETTINGS) {
  return bg.send({ type: 'startStreaming', settings, record: false, mode: 'selection' });
}

async function sessionState(bg) {
  return bg.send({ type: 'getSessionState' }, { wait: true });
}

async function playerState(bg) {
  return (await bg.send({ type: 'getPlayerState' }, { wait: true })).state;
}

/** The messages the popup sends: controlAudio with the session id. */
function control(bg, action, sessionId) {
  return bg.send({ type: 'controlAudio', action, sessionId });
}

/** The offscreen document's reports for one chunk: audioReady, then (optionally) a duration. */
async function chunkReady(bg, chunk, duration) {
  await bg.send({ type: 'audioReady', sessionId: chunk.sessionId, index: chunk.index, playNumber: chunk.playNumber, audioElements: 1 });
  if (duration !== undefined) {
    await bg.send({ type: 'audioDuration', sessionId: chunk.sessionId, index: chunk.index, playNumber: chunk.playNumber, duration });
  }
}

/** The offscreen document reports the sentence ended. */
async function endChunk(bg, chunk) {
  await bg.send({ type: 'chunkEnded', index: chunk.index, sessionId: chunk.sessionId, playNumber: chunk.playNumber });
  await settle();
}

module.exports = {
  ALARM,
  SENTENCES,
  RAW_SETTINGS,
  liveSession,
  createGatedFetch,
  pressPlayNoWait,
  sessionState,
  playerState,
  control,
  chunkReady,
  endChunk
};
