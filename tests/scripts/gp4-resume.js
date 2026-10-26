#!/usr/bin/env node
'use strict';
/**
 * GP4 scripted run: Pause, wait past the 30 s the audio document survives,
 * Play, and see the sentence replayed from its start and the read finish.
 *
 *   node tests/scripts/gp4-resume.js
 *
 * Loads the real background.js in a `vm` with the fake chrome, talks to a
 * local stub HTTP TTS server (a fixed 1 KB buffer) over real HTTP, and plays
 * the part of the offscreen document by hand. The stub listens on 127.0.0.1
 * on a port the OS picks (port 0), never the extension's default 8000, and is
 * closed before the script exits. No Chrome, no audio, no network beyond
 * loopback. Prints one line per step; exits 1 if any check fails.
 */
const http = require('node:http');
const assert = require('node:assert/strict');

const { loadBackground, settle } = require('../helpers/fake-chrome.js');
const { playChunks } = require('../helpers/session.js');
const { RAW_SETTINGS, control, chunkReady, endChunk } = require('../helpers/pause.js');
const { TEN, AUDIO_1KB, restartWorker, liveSession } = require('../helpers/resume.js');

const PAUSE_AT = 4; // index 4 is "sentence 5"
const label = (index) => `sentence ${index + 1}`;
const say = (line) => console.log(line);

function startStubServer() {
  const requests = []; // the sentence text each request asked for
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      requests.push(JSON.parse(body).input);
      res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': AUDIO_1KB.length });
      res.end(Buffer.from(AUDIO_1KB));
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({ server, requests, port: server.address().port }));
  });
}

/** Wait on the real clock (the extension's own timers are fake). */
async function waitFor(condition, what, ms = 5000) {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const fetchedCount = (stub, index) => stub.requests.filter((text) => text === TEN[index]).length;

/** The offscreen document's part for one sentence: audio ready, then ended. */
async function playToEnd(bg, index) {
  await waitFor(() => playChunks(bg).some((c) => c.index === index), label(index));
  const chunks = playChunks(bg).filter((c) => c.index === index);
  const chunk = chunks[chunks.length - 1];
  await chunkReady(bg, chunk);
  await endChunk(bg, chunk);
}

/** Press Play with nothing selected and read sentences 1 to PAUSE_AT, leaving sentence 5 playing; then Pause. */
async function readAndPause(bg, stub) {
  bg.send({ type: 'startStreaming', settings: { ...RAW_SETTINGS, serverUrl: stub.url }, record: false, mode: 'selection' });
  await waitFor(() => playChunks(bg).length === 1, 'sentence 1');
  for (let i = 0; i < PAUSE_AT; i++) await playToEnd(bg, i);
  await waitFor(() => playChunks(bg).some((c) => c.index === PAUSE_AT), label(PAUSE_AT));
  const chunk = playChunks(bg).find((c) => c.index === PAUSE_AT);
  await chunkReady(bg, chunk);
  await waitFor(() => fetchedCount(stub, PAUSE_AT + 1) === 1, `${label(PAUSE_AT + 1)} prefetched`);
  await control(bg, 'pause', chunk.sessionId);
  await settle();
  return chunk;
}

async function finish(bg, stub, from) {
  for (let i = from; i < TEN.length; i++) await playToEnd(bg, i);
  await waitFor(() => liveSession(bg).stopped, 'the session to end');
  await settle();
}

const order = (bg) => playChunks(bg).map((c) => `${c.index + 1}${c.playNumber > 1 ? `(play ${c.playNumber})` : ''}`).join(' ');

// `popup`: Dan reopens the popup before pressing Play. Every popup open sends
// setupOffscreen (popup.js init -> audioPlayer.init), which makes a fresh, empty
// audio document when Chrome has closed the old one. Play must not treat that
// empty document as the one holding the sentence.
async function runSameWorker(stub, { popup }) {
  say(`--- Run ${popup ? 'A2' : 'A'}: Pause, the audio document closes after 30 s, ${popup ? 'the popup is reopened, ' : ''}Play (same worker) ---`);
  const bg = loadBackground({ sentences: TEN, fetch: globalThis.fetch, localStorage: { serverUrl: stub.url } });
  const contexts = [];
  const getContexts = bg.chrome.runtime.getContexts;
  bg.chrome.runtime.getContexts = async (...args) => {
    const result = await getContexts(...args);
    contexts.push(result.length);
    return result;
  };

  const chunk = await readAndPause(bg, stub);
  const s = liveSession(bg);
  say(`step 1  read ${PAUSE_AT} sentences, then paused during ${label(PAUSE_AT)} (index ${PAUSE_AT}, play ${chunk.playNumber})`);
  say(`CHECKPOINT 1  paused flag=${s.paused}  stall timer=${s.stallTimer === null ? 'cleared' : 'RUNNING'}  pending timers=${bg.timers.pending}`);
  assert.equal(s.paused, true);
  assert.equal(s.stallTimer, null);
  assert.equal(bg.timers.pending, 0);

  bg.closeOffscreen();
  await bg.timers.tick(30000);
  say('step 2  30 s passed with no audio: Chrome closed the offscreen document (fake)');
  assert.equal(playChunks(bg).length, PAUSE_AT + 1, 'nothing started by itself');

  const created = bg.createdOffscreen.length;
  if (popup) {
    await bg.send({ type: 'setupOffscreen' }, { wait: true });
    await settle();
    say(`step 2b popup reopened: it sent setupOffscreen and a new, empty audio document was created (createDocument calls since the close = ${bg.createdOffscreen.length - created})`);
    assert.equal(bg.createdOffscreen.length, created + 1);
  }
  const requestsBefore = stub.requests.length;
  contexts.length = 0;
  await control(bg, 'play', chunk.sessionId);
  await waitFor(() => playChunks(bg).length === PAUSE_AT + 2, 'the replay');
  const replay = playChunks(bg)[PAUSE_AT + 1];
  const replayEvent = (await bg.send({ type: 'getDebugLog' }, { wait: true })).log.events.find((e) => e.type === 'replay');
  say(`CHECKPOINT 2  first getContexts on Play found ${contexts[0]} documents (then ${contexts.length - 1} more calls)  createDocument calls=${bg.createdOffscreen.length - created}  replay: ${label(replay.index)} (index ${replay.index}) play number ${replay.playNumber}, logged as ${replayEvent.kind}`);
  say(`            fetches for ${label(PAUSE_AT)} = ${fetchedCount(stub, PAUSE_AT)} (never re-fetched), new fetches since Play = ${stub.requests.length - requestsBefore}`);
  assert.equal(contexts[0], popup ? 1 : 0);
  assert.equal(bg.createdOffscreen.length, created + 1, popup ? 'Play reused the popup\'s document' : 'Play recreated the document');
  assert.equal(bg.sentOfType('play').length, 0, 'no bare `play` into a closed or empty document');
  assert.deepEqual({ index: replay.index, playNumber: replay.playNumber }, { index: PAUSE_AT, playNumber: 2 });
  assert.equal(replayEvent.playNumber, 2);
  assert.equal(replayEvent.index, PAUSE_AT);
  assert.equal(fetchedCount(stub, PAUSE_AT), 1);
  assert.equal(stub.requests.length, requestsBefore, 'the replay used the kept bytes');

  await finish(bg, stub, PAUSE_AT);
  say(`step 3  played in order: ${order(bg)}`);
  say(`CHECKPOINT 3  sentences ${PAUSE_AT + 2} to ${TEN.length} followed; session stopped=${liveSession(bg).stopped}; stored state cleared=${bg.chrome.storage.session.snapshot().ttsSessionState === undefined}`);
  assert.deepEqual(playChunks(bg).map((c) => `${c.index}/${c.playNumber}`), [
    '0/1', '1/1', '2/1', '3/1', '4/1', '4/2', '5/1', '6/1', '7/1', '8/1', '9/1'
  ]);
  assert.equal(liveSession(bg).stopped, true);
  assert.equal(bg.chrome.storage.session.snapshot().ttsSessionState, undefined);
}

async function runAfterRestart(stub) {
  say('--- Run B: the service worker restarts while paused (fresh vm, same storage) ---');
  stub.requests.length = 0;
  const first = loadBackground({ sentences: TEN, fetch: globalThis.fetch, localStorage: { serverUrl: stub.url } });
  const chunk = await readAndPause(first, stub);
  say(`step 1  paused during ${label(PAUSE_AT)}; first worker stored the session (${first.chrome.storage.session.snapshot().ttsSessionSentences.length} sentences)`);

  const second = restartWorker(first, { sentences: TEN, offscreenUp: false, fetch: globalThis.fetch });
  await settle();
  const rebuilt = liveSession(second);
  say(`CHECKPOINT 4a worker restarted: rebuilt session paused=${rebuilt.paused} stopped=${rebuilt.stopped} index=${rebuilt.currentIndex} id=${rebuilt.sessionId}  getPlayerState -> ${(await second.send({ type: 'getPlayerState' }, { wait: true })).state}`);
  assert.equal(rebuilt.paused, true);
  assert.equal(rebuilt.sessionId, chunk.sessionId);

  const requestsBefore = stub.requests.length;
  await control(second, 'play', chunk.sessionId);
  await waitFor(() => playChunks(second).length === 1, 'the replay');
  const replay = playChunks(second)[0];
  const replayEvent = (await second.send({ type: 'getDebugLog' }, { wait: true })).log.events.find((e) => e.type === 'replay');
  say(`CHECKPOINT 4b Play: refetches of ${label(PAUSE_AT)} = ${stub.requests.slice(requestsBefore).filter((t) => t === TEN[PAUSE_AT]).length}  replay index ${replay.index} play number ${replay.playNumber}, logged as ${replayEvent.kind}`);
  assert.equal(stub.requests.slice(requestsBefore).filter((t) => t === TEN[PAUSE_AT]).length, 1);
  assert.deepEqual({ index: replay.index, playNumber: replay.playNumber }, { index: PAUSE_AT, playNumber: 2 });
  assert.equal(replayEvent.kind, 'refetch-then-play');

  await finish(second, stub, PAUSE_AT);
  say(`step 2  played in order after the restart: ${order(second)}`);
  say(`CHECKPOINT 4c finished; session stopped=${liveSession(second).stopped}; stored state cleared=${second.chrome.storage.session.snapshot().ttsSessionState === undefined}`);
  assert.equal(liveSession(second).stopped, true);
  assert.deepEqual(playChunks(second).map((c) => `${c.index}/${c.playNumber}`), ['4/2', '5/1', '6/1', '7/1', '8/1', '9/1']);
}

async function runEndedWhilePausedThenRestart(stub) {
  say('--- Run C: sentence 5 ends at the instant of the Pause, the worker restarts, Play ---');
  stub.requests.length = 0;
  const first = loadBackground({ sentences: TEN, fetch: globalThis.fetch, localStorage: { serverUrl: stub.url } });
  const chunk = await readAndPause(first, stub);
  await endChunk(first, chunk);
  await settle();
  const stored = first.chrome.storage.session.snapshot().ttsSessionState;
  say(`step 1  ${label(PAUSE_AT)} ended while paused; stored index=${stored.currentIndex} advance=${stored.advance}`);
  assert.equal(stored.advance, true);

  const second = restartWorker(first, { sentences: TEN, offscreenUp: false, fetch: globalThis.fetch });
  await settle();
  const requestsBefore = stub.requests.length;
  await control(second, 'play', chunk.sessionId);
  await waitFor(() => playChunks(second).length === 1, 'the next sentence');
  const next = playChunks(second)[0];
  const replays = (await second.send({ type: 'getDebugLog' }, { wait: true })).log.events.filter((e) => e.type === 'replay').length;
  say(`CHECKPOINT 5  Play after the restart went to ${label(next.index)} (index ${next.index}) play number ${next.playNumber}; replays logged=${replays}; refetches of ${label(PAUSE_AT)}=${stub.requests.slice(requestsBefore).filter((t) => t === TEN[PAUSE_AT]).length}`);
  assert.deepEqual({ index: next.index, playNumber: next.playNumber }, { index: PAUSE_AT + 1, playNumber: 1 });
  assert.equal(replays, 0);

  await finish(second, stub, PAUSE_AT + 1);
  assert.deepEqual(playChunks(second).map((c) => `${c.index}/${c.playNumber}`), ['5/1', '6/1', '7/1', '8/1', '9/1']);
  say(`step 2  played in order after the restart: ${order(second)}`);
}

async function main() {
  const stub = await startStubServer();
  stub.url = `http://127.0.0.1:${stub.port}/v1/audio/speech`;
  say(`stub TTS server: pid ${process.pid}, ${stub.url} (scratch port, OS-assigned)`);
  try {
    await runSameWorker(stub, { popup: false });
    stub.requests.length = 0;
    await runSameWorker(stub, { popup: true });
    await runAfterRestart(stub);
    await runEndedWhilePausedThenRestart(stub);
    say('GP4 OK');
  } finally {
    await new Promise((resolve) => stub.server.close(resolve));
    say(`stub TTS server closed (port ${stub.port} released)`);
  }
}

main().catch((error) => {
  console.error('GP4 FAILED:', error && error.stack ? error.stack : error);
  process.exit(1);
});
