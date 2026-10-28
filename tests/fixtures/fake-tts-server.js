#!/usr/bin/env node
'use strict';
/**
 * Fake OpenAI-compatible TTS server for container / manual checks.
 *
 *   node tests/fixtures/fake-tts-server.js            # port 8090 (the extension default)
 *   PORT=18765 node tests/fixtures/fake-tts-server.js # any other port
 *   HOST=0.0.0.0 ...                                   # listen beyond loopback (e.g. for a container)
 *   VOICES_DELAY_MS=30000 ...                          # hold the voices answer, like a cold start
 *
 * GET  /v1/audio/voices  -> {"status":"ok","voices":["Abigail.wav", ...]} (28 files, as Chatterbox
 *                           behind llama-swap answers), after VOICES_DELAY_MS if set.
 * POST /v1/audio/speech  -> a 0.4 s mono 16-bit 22.05 kHz WAV (quiet 440 Hz tone).
 * GET  /article.html     -> tests/fixtures/article.html, so a page can be served from the same place.
 * Every request is logged to stdout as one line; request bodies are not printed.
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PORT = Number(process.env.PORT || process.argv[2] || 8090);
const HOST = process.env.HOST || '127.0.0.1';

function makeWav({ seconds = 0.4, sampleRate = 22050, frequency = 440, amplitude = 0.2 } = {}) {
  const samples = Math.round(seconds * sampleRate);
  const data = Buffer.alloc(samples * 2);
  const fade = Math.round(sampleRate * 0.01); // 10 ms fade in/out avoids clicks
  for (let i = 0; i < samples; i++) {
    const envelope = Math.min(1, i / fade, (samples - 1 - i) / fade);
    const value = Math.sin((2 * Math.PI * frequency * i) / sampleRate) * amplitude * envelope;
    data.writeInt16LE(Math.round(value * 32767), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

const WAV = makeWav();

// 28 voice files, Abigail to Thomas, in the order the server lists them.
const VOICES = [
  'Abigail', 'Adrian', 'Alexander', 'Alice', 'Austin', 'Axel', 'Bella', 'Brian', 'Connor', 'Cora',
  'Elena', 'Emily', 'Everett', 'Gabriel', 'Gianna', 'Henry', 'Jade', 'Jeremiah', 'Jordan', 'Julian',
  'Layla', 'Leonardo', 'Michael', 'Miles', 'Olivia', 'Ryan', 'Taylor', 'Thomas'
].map((name) => `${name}.wav`);

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  console.log(`${new Date().toISOString()} ${req.method} ${url.pathname}`);
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS'
  };
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors);
    res.end();
    return;
  }
  if (req.method === 'GET' && url.pathname === '/v1/audio/voices') {
    const delay = Number(process.env.VOICES_DELAY_MS || 0);
    setTimeout(() => {
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', voices: VOICES }));
    }, delay);
    return;
  }
  if (req.method === 'POST' && url.pathname === '/v1/audio/speech') {
    req.resume(); // the body is ignored
    req.on('end', () => {
      res.writeHead(200, { ...cors, 'Content-Type': 'audio/wav', 'Content-Length': WAV.length });
      res.end(WAV);
    });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/article.html') {
    res.writeHead(200, { ...cors, 'Content-Type': 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(path.join(__dirname, 'article.html')));
    return;
  }
  res.writeHead(404, cors);
  res.end('not found');
});

if (require.main === module) {
  server.listen(PORT, HOST, () => console.log(`fake TTS server on http://${HOST}:${PORT}`));
}

module.exports = { server, makeWav, VOICES };
