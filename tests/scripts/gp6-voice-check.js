#!/usr/bin/env node
'use strict';
/**
 * GP6 / E12 scripted run: right-click Read Aloud with the popup closed, against
 * a local stub HTTP server that serves the voices route and the speech route.
 *
 *   node tests/scripts/gp6-voice-check.js
 *
 * Loads the real background.js in a `vm` with the fake chrome and talks to the
 * stub over real HTTP (Node's own fetch). The stub listens on 127.0.0.1 on a
 * port the OS picks (port 0), never the extension's default 8090, and is
 * closed before the script exits (and mid-run, for checkpoint 3). No Chrome,
 * no audio, no network beyond loopback. Prints the stub's request log for
 * each checkpoint; exits 1 if any check fails.
 *
 *   Checkpoint 1: one GET /v1/audio/voices?model=tts-1 before the first POST
 *                 /v1/audio/speech.
 *   Checkpoint 2: the first POST carries "Olivia.wav" when the stub lists it,
 *                 and the first listed voice when the saved voice is absent.
 *   Checkpoint 3: with the stub stopped, the failed GET, then the saved voice
 *                 in the POST attempt and the existing error broadcast.
 */
const http = require('node:http');
const assert = require('node:assert/strict');

const { loadBackground, settle, createFakeChrome } = require('../helpers/fake-chrome.js');
const { playChunks } = require('../helpers/session.js');
const { AUDIO_1KB } = require('../helpers/resume.js');

const say = (line) => console.log(line);
const VOICES = ['Abigail.wav', 'Olivia.wav', 'Thomas.wav'];

function startStubServer() {
  const requests = []; // { method, path, voice }
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const entry = { method: req.method, path: req.url, voice: body ? JSON.parse(body).voice : undefined };
      requests.push(entry);
      if (req.method === 'GET' && req.url === '/v1/audio/voices?model=tts-1') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', voices: VOICES }));
      } else if (req.method === 'POST' && req.url === '/v1/audio/speech') {
        res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': AUDIO_1KB.length });
        res.end(Buffer.from(AUDIO_1KB));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({ server, requests, port: server.address().port }));
  });
}

function stopServer(server) {
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
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

function rightClick(bg) {
  bg.listeners.menuClicked[0]({ menuItemId: 'readAloud', frameId: 0 }, { id: 7 });
}

function printLog(stub) {
  for (const r of stub.requests) say(`    ${r.method} ${r.path}${r.voice !== undefined ? `  voice: ${JSON.stringify(r.voice)}` : ''}`);
}

async function main() {
  const stub = await startStubServer();
  const serverUrl = `http://127.0.0.1:${stub.port}/v1/audio/speech`;
  say(`stub server on 127.0.0.1:${stub.port} (OS-picked port)`);

  // The popup is closed: the only thing that runs is the background worker.
  // `attempts` is the extension's side of the log: every request it made and
  // how it ended, which is the only record when the stub is stopped.
  const attempts = [];
  async function rightClickRead(saved) {
    const fake = createFakeChrome({ sentences: ['Hello there friend.'], localStorage: { serverUrl, voice: saved } });
    const bg = loadBackground({
      fake,
      fetch: async (url, init = {}) => {
        const attempt = { method: init.method || 'GET', path: new URL(url).pathname + new URL(url).search, voice: init.body ? JSON.parse(init.body).voice : undefined };
        attempts.push(attempt);
        try {
          const response = await fetch(url, init);
          attempt.outcome = response.status;
          return response;
        } catch (error) {
          attempt.outcome = `failed (${error.message})`;
          throw error;
        }
      }
    });
    stub.requests.length = 0;
    attempts.length = 0;
    rightClick(bg);
    return bg;
  }

  try {
    say('\nCheckpoint 1 + 2a: saved voice Olivia.wav, the stub lists it');
    let bg = await rightClickRead('Olivia.wav');
    await waitFor(() => stub.requests.some((r) => r.method === 'POST'), 'the speech request');
    await settle();
    printLog(stub);
    assert.deepEqual(stub.requests.map((r) => `${r.method} ${r.path}`), ['GET /v1/audio/voices?model=tts-1', 'POST /v1/audio/speech']);
    assert.equal(stub.requests[1].voice, 'Olivia.wav');
    const states = bg.sentOfType('playerStateUpdate').map((m) => m.state);
    say(`    player states: ${states.join(' -> ')}`);
    assert.equal(states[0], 'starting', '"Starting voice engine..." shows first, before the voices answer');
    await waitFor(() => playChunks(bg).length === 1, 'the first sentence to play');
    say('    ok: one voices GET, then the POST with Olivia.wav; the sentence reached the audio player');

    say('\nCheckpoint 2b: saved voice Gone.wav is not on the stub: the first listed voice is sent');
    bg = await rightClickRead('Gone.wav');
    await waitFor(() => stub.requests.some((r) => r.method === 'POST'), 'the speech request');
    printLog(stub);
    assert.equal(stub.requests[0].method, 'GET');
    assert.equal(stub.requests[1].voice, VOICES[0]);
    say(`    ok: the POST carries ${VOICES[0]}`);

    say('\nCheckpoint 3: the stub is stopped; saved voice Olivia.wav');
    await stopServer(stub.server);
    const down = await rightClickRead('Olivia.wav');
    await waitFor(() => down.sentOfType('streamError').length > 0, 'the error broadcast');
    say('    stub request log: (empty: nothing reached the stopped server)');
    assert.deepEqual(stub.requests, []);
    say('    the extension\'s own request log:');
    for (const a of attempts) say(`      ${a.method} ${a.path}${a.voice !== undefined ? `  voice: ${JSON.stringify(a.voice)}` : ''}  -> ${a.outcome}`);
    say(`    error broadcast: ${JSON.stringify(down.sentOfType('streamError').map((m) => m.error))}`);
    assert.deepEqual(attempts.map((a) => `${a.method} ${a.path}`), ['GET /v1/audio/voices?model=tts-1', 'POST /v1/audio/speech'], 'the voices GET failed, then exactly one speech attempt');
    assert.ok(attempts.every((a) => String(a.outcome).startsWith('failed')));
    assert.equal(attempts[1].voice, 'Olivia.wav', 'with the saved voice');
    assert.equal(down.sentOfType('streamError').length, 1);
    say('    ok: failed voices GET, then the speech attempt with the saved voice, then the existing error');
  } finally {
    await stopServer(stub.server).catch(() => {});
  }
  say('\nall checkpoints passed');
}

main().catch((error) => {
  console.error('FAILED:', error && error.stack ? error.stack : error);
  process.exit(1);
});
