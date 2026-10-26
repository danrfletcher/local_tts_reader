'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { ROOT, loadBackground, settle } = require('./helpers/fake-chrome.js');
const { SETTINGS, startRead, playChunks } = require('./helpers/session.js');

const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

// --- F1: server URL, model, voice and speed settings --------------------------------

test('F1: DEFAULT_SETTINGS keys and values are unchanged', () => {
  const { DEFAULT_SETTINGS } = require('../constants.js');
  assert.deepEqual(DEFAULT_SETTINGS, {
    serverUrl: 'http://localhost:8000/v1/audio/speech',
    voice: 'af_bella',
    speed: 1.0,
    recordAudio: false,
    preprocessText: true
  });
});

test('F1: the fetch body keys are exactly model, voice, input, speed; voice and speed come from the session settings', async () => {
  const bg = loadBackground({ sentences: ['Hello there friend.'] });
  await startRead(bg, { ...SETTINGS, voice: 'bf_emma', speed: '1.75', serverUrl: 'http://tts.invalid/v1/audio/speech' });
  assert.equal(bg.fetch.calls.length, 1);
  const { body, url, init } = bg.fetch.calls[0];
  assert.deepEqual(Object.keys(body).sort(), ['input', 'model', 'speed', 'voice']);
  assert.equal(body.voice, 'bf_emma');
  assert.equal(body.speed, 1.75);
  assert.equal(typeof body.model, 'string'); // the model value itself is deliberately not pinned here
  assert.ok(body.model.length > 0);
  assert.equal(url, 'http://tts.invalid/v1/audio/speech');
  assert.equal(init.method, 'POST');
});

// --- F2: manifest ------------------------------------------------------------------------

test('F2: manifest permissions are unchanged and the background is a classic worker', () => {
  const manifest = JSON.parse(read('manifest.json'));
  assert.deepEqual(manifest.permissions, ['activeTab', 'storage', 'scripting', 'offscreen', 'contextMenus', 'alarms']);
  assert.deepEqual(manifest.host_permissions, ['http://localhost:8000/*', 'http://*/*', 'https://*/*']);
  assert.deepEqual(manifest.background, { service_worker: 'background.js' });
  assert.ok(!('type' in manifest.background), 'no "type": "module"');
  assert.equal(manifest.manifest_version, 3);
});

// --- F3: Stop clears the highlight on the session's tab and frame ----------------------

test('F3: Stop sends ttsClearHighlight to the session tab and frame, and broadcasts stop', async () => {
  const bg = loadBackground({ sentences: ['One sentence here.', 'Two sentences here.'], tabId: 7 });
  // Right-click Read Aloud inside frame 3 of tab 7.
  const onClicked = bg.listeners.menuClicked[0];
  onClicked({ menuItemId: 'readAloud', frameId: 3 }, { id: 7 });
  await settle();
  assert.equal(playChunks(bg).length, 1);
  assert.equal(bg.tabMessages.find((m) => m.message.type === 'ttsHighlightSentence').options.frameId, 3);

  const before = bg.sentOfType('stop').length;
  await bg.send({ type: 'stopSession' }, { wait: true });
  const clears = bg.tabMessages.filter((m) => m.message.type === 'ttsClearHighlight');
  assert.equal(clears.length, 1);
  assert.equal(clears[0].tabId, 7);
  assert.equal(clears[0].options.frameId, 3);
  assert.equal(bg.sentOfType('stop').length, before + 1);
});

test('F3: the popup Stop button route (controlAudio stop) does the same', async () => {
  const bg = loadBackground({ sentences: ['One sentence here.'] });
  await startRead(bg);
  await bg.send({ type: 'controlAudio', action: 'stop' });
  await settle();
  assert.equal(bg.tabMessages.filter((m) => m.message.type === 'ttsClearHighlight').length, 1);
  assert.equal(bg.sentOfType('stop').length, 1);
});

// --- F4: logging is always on, offline and quiet ----------------------------------------------

test('F4: logging does not depend on any setting', async () => {
  for (const flags of [{ recordAudio: false, preprocessText: false }, { recordAudio: true, preprocessText: true }]) {
    const bg = loadBackground({ sentences: ['One sentence here.'] });
    await startRead(bg, { ...SETTINGS, ...flags });
    const response = await bg.send({ type: 'getDebugLog' }, { wait: true });
    assert.ok(response.log.events.some((e) => e.type === 'session-start'), JSON.stringify(flags));
    assert.ok(response.log.events.some((e) => e.type === 'play'));
  }
});

test('F4: no sendBeacon, XHR, socket or extra fetch anywhere in the extension code', () => {
  const sources = {
    'background.js': read('background.js'),
    'offscreen.js': read('offscreen.js'),
    'popup.js': read('popup.js'),
    'lib/playback.js': read('lib/playback.js')
  };
  for (const [file, source] of Object.entries(sources)) {
    const text = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''); // comments may mention fetch()
    assert.ok(!/sendBeacon|XMLHttpRequest|WebSocket|EventSource/.test(text), `${file} has no beacon/XHR/socket`);
    const fetchCalls = (text.match(/\bfetch\s*\(/g) || []).length;
    assert.equal(fetchCalls, file === 'background.js' ? 1 : 0, `${file} fetch() calls`);
  }
});

test('F4: popup.html gains no checkbox or toggle for logging', () => {
  const html = read('popup.html');
  const checkboxes = [...html.matchAll(/<input[^>]*type="checkbox"[^>]*>/g)].map((m) => m[0].match(/id="([^"]+)"/)[1]);
  assert.deepEqual(checkboxes, ['recordAudio', 'preprocessText']);
  assert.ok(!/<input[^>]*type="(radio)"/.test(html));
  assert.ok(html.includes('id="downloadLogBtn"') && html.includes('id="clearLogBtn"'));
});

// --- F5: no audio processing ---------------------------------------------------------------------

test('F5: background.js and offscreen.js add no AudioContext, media-element source, filter or gain node', () => {
  for (const file of ['background.js', 'offscreen.js', 'lib/playback.js']) {
    const text = read(file);
    assert.ok(
      !/AudioContext|createMediaElementSource|createGain|GainNode|createBiquadFilter|BiquadFilter|DynamicsCompressor|createDelay/.test(text),
      `${file} has no Web Audio processing`
    );
  }
});

// --- F6: no dependencies, no bundler --------------------------------------------------------------

test('F6: package.json has only a test script and no dependencies', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.deepEqual(pkg.scripts, { test: 'node --test' });
  for (const key of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies', 'bundledDependencies']) {
    assert.ok(!(key in pkg), `no ${key}`);
  }
});

test('F6: no bundler or TypeScript config exists', () => {
  const entries = fs.readdirSync(ROOT);
  const banned = /^(webpack|rollup|vite|esbuild|parcel|tsconfig|babel|\.babelrc|swc)/i;
  assert.deepEqual(entries.filter((name) => banned.test(name)), []);
});

// --- F7: no sentence slider -------------------------------------------------------------------------

test('F7: popup.html range inputs are still only speed and seekBar', () => {
  const html = read('popup.html');
  const ranges = [...html.matchAll(/<input[^>]*type="range"[^>]*>/g)].map((m) => m[0].match(/id="([^"]+)"/)[1]);
  assert.deepEqual(ranges.sort(), ['seekBar', 'speed']);
});
