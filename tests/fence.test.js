'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { ROOT, loadBackground, settle } = require('./helpers/fake-chrome.js');
const { SETTINGS, startRead, playChunks } = require('./helpers/session.js');

const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

// --- F1: server URL, model, voice and speed settings --------------------------------

test('G10: DEFAULT_SETTINGS has the 8090 Server URL and an empty voice (meaning the first voice); the other keys are unchanged', () => {
  const { DEFAULT_SETTINGS } = require('../constants.js');
  assert.deepEqual(DEFAULT_SETTINGS, {
    serverUrl: 'http://localhost:8090/v1/audio/speech',
    voice: '',
    speed: 1.0,
    recordAudio: false,
    preprocessText: true
  });
});

test('G10: background.js imports constants.js and has no default URL or voice of its own', () => {
  const source = read('background.js');
  assert.match(source.split('\n')[0], /^importScripts\(.*'constants\.js'.*\);$/);
  assert.ok(!/DEFAULT_SERVER_URL/.test(source), 'no private DEFAULT_SERVER_URL');
  assert.ok(!/localhost:8000/.test(source), 'no port-8000 URL');
  assert.ok(!/af_bella/.test(source), 'no hard-coded voice');
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
    'lib/playback.js': read('lib/playback.js'),
    'lib/voices.js': read('lib/voices.js')
  };
  for (const [file, source] of Object.entries(sources)) {
    const text = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''); // comments may mention fetch()
    assert.ok(!/sendBeacon|XMLHttpRequest|WebSocket|EventSource/.test(text), `${file} has no beacon/XHR/socket`);
    const fetchCalls = (text.match(/\bfetch\s*\(/g) || []).length;
    assert.equal(fetchCalls, file === 'background.js' ? 1 : 0, `${file} fetch() calls`);
  }
});

test('F7: the voices request has one call site (popup.js -> TTSVoices.checkVoices -> doFetch), a plain GET with only a signal', () => {
  const strip = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const popup = strip(read('popup.js'));
  const voices = strip(read('lib/voices.js'));
  assert.equal((popup.match(/TTSVoices\.checkVoices\(/g) || []).length, 1, 'popup.js asks for the voices in one place');
  assert.equal((voices.match(/\bdoFetch\(/g) || []).length, 1, 'lib/voices.js makes one request');
  assert.ok(voices.includes('doFetch(url, { signal: controller.signal })'), 'the only init field is the abort signal');
  assert.ok(!/headers|Authorization|Bearer|method\s*:/i.test(voices), 'no headers, no auth, no method override');
  assert.ok(!/headers|Authorization|Bearer/i.test(popup), 'popup.js adds no headers or auth');
});

test('F3: no polling timer. popup.js has the one seek-bar setInterval; connection checks use only the 500 ms debounce, the 3 s label timer and the 90 s timeout', () => {
  const strip = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const popup = strip(read('popup.js'));
  const voices = strip(read('lib/voices.js'));

  assert.equal((popup.match(/\bsetInterval\s*\(/g) || []).length, 1, 'popup.js: only the seek-bar setInterval');
  assert.match(popup, /const updateInterval = setInterval\(async \(\) => \{\s*if \(!audioPlayer\) return;\s*const state = await audioPlayer\.getState\(\);/);
  assert.ok(!/\bsetInterval\s*\(/.test(voices), 'lib/voices.js has no setInterval');
  assert.ok(!/chrome\.alarms/.test(popup) && !/chrome\.alarms/.test(voices), 'no chrome.alarms in the popup or voices module');

  // The only setTimeout calls in popup.js: the status fade (3 s), the log URL
  // revoke, and the two connection timers (both cleared on restart and on close).
  const timeouts = [...popup.matchAll(/(\w+\s*=\s*)?setTimeout\(/g)].map((m) => (m[1] || '').replace(/\s*=\s*$/, ''));
  assert.deepEqual(timeouts.sort(), ['', '', 'startingTimer', 'urlCheckTimer']);
  assert.match(popup, /startingTimer = setTimeout\([\s\S]*?\}, TTSVoices\.STARTING_AFTER_MS\);/);
  assert.match(popup, /urlCheckTimer = setTimeout\([\s\S]*?\}, URL_CHECK_DEBOUNCE_MS\);/);
  assert.match(popup, /const URL_CHECK_DEBOUNCE_MS = 500;/);
  assert.match(popup, /function cancelConnectionCheck\(\) \{\s*clearTimeout\(urlCheckTimer\);[\s\S]*?clearTimeout\(startingTimer\);[\s\S]*?checkController\.abort\(\);/);
  assert.match(popup, /window\.addEventListener\('pagehide', cancelConnectionCheck\)/);
  assert.match(popup, /async function runConnectionCheck\(\) \{\s*cancelConnectionCheck\(\);/);

  const { STARTING_AFTER_MS, VOICES_TIMEOUT_MS } = require('../lib/voices.js');
  assert.equal(STARTING_AFTER_MS, 3000);
  assert.equal(VOICES_TIMEOUT_MS, 90000);
  assert.equal((voices.match(/\bsetTimer\(/g) || []).length, 1, 'one timeout, the 90 s cap');
  assert.equal((voices.match(/\bclearTimer\(/g) || []).length, 1, 'cleared in finally');
});

test('F3: the three triggers are the only callers of a check: open, Server URL input (debounced) and the light', () => {
  const strip = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const popup = strip(read('popup.js'));
  const callers = [...popup.matchAll(/\brunConnectionCheck\(\)/g)].length;
  // definition + scheduleConnectionCheck's timer + the light's recheck + the first check on open
  assert.equal(callers, 4);
  assert.match(popup, /addEventListener\('input', scheduleConnectionCheck\)/);
  assert.match(popup, /connLight\.addEventListener\('click', recheckNow\)/);
  assert.match(popup, /connLight\.addEventListener\('keydown'/);
  assert.ok(!/addEventListener\('(change|blur|focus|keyup)', (scheduleConnectionCheck|runConnectionCheck|recheckNow)/.test(popup));
  assert.ok(!/visibilitychange|onfocus|storage\.onChanged/.test(popup), 'no other trigger');
});

test('F4: nothing about the voice list is stored: no new chrome.storage key, and no storage call in lib/voices.js', () => {
  const voices = read('lib/voices.js');
  assert.ok(!/chrome\./.test(voices.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')), 'lib/voices.js touches no chrome.* API');
  const popup = read('popup.js');
  const keys = new Set([...popup.matchAll(/chrome\.storage\.local\.set\(\{\s*(\w+)/g)].map((m) => m[1]));
  assert.deepEqual([...keys].sort(), ['voice']);
  assert.ok(/chrome\.storage\.local\.set\(settings\)/.test(popup), 'the settings save is unchanged');
});

test('F5: no table from Kokoro ids to Chatterbox files in lib/voices.js, popup.js or background.js', () => {
  for (const file of ['lib/voices.js', 'popup.js', 'background.js']) {
    const text = read(file);
    assert.ok(!/am_adam|af_nicole|bf_emma|af_sarah|bm_george|bf_isabella|am_michael|af_sky/.test(text), `${file} lists no Kokoro voices`);
    assert.ok(!/\.wav['\"]/.test(text), `${file} names no voice files`);
    const bella = (text.match(/af_bella/g) || []).length;
    assert.equal(bella, file === 'lib/voices.js' ? 1 : 0, `${file}: af_bella appears only as the one old-default constant`);
  }
  assert.ok(/OLD_DEFAULT_VOICE = 'af_bella';/.test(read('lib/voices.js')));
});

test('F6: popup.html gains no button beyond the connection light', () => {
  const html = read('popup.html');
  const buttons = [...html.matchAll(/<button\b[^>]*>/g)].map((m) => m[0].match(/id="([^"]+)"/)[1]);
  assert.deepEqual(buttons, ['playBtn', 'pauseBtn', 'stopBtn', 'downloadBtn', 'connLight', 'downloadLogBtn', 'clearLogBtn']);
  assert.ok(!/<option\b/.test(html), 'the static Kokoro options are gone');
  const scripts = [...html.matchAll(/<script\b[^>]*>/g)].map((m) => m[0]);
  assert.deepEqual(scripts, [
    '<script src="audioPlayer.js">', '<script src="constants.js">', '<script src="lib/voices.js">', '<script src="popup.js">'
  ]);
});

test('PR-2: popup.html has the hidden Voice name group (a labelled text input) and the light is a focusable button with role status', () => {
  const html = read('popup.html');
  assert.match(html, /<div class="setting-group" id="voiceNameGroup" hidden>\s*<label for="voiceName">Voice name<\/label>\s*<input type="text" id="voiceName"[^>]*>/);
  assert.match(html, /<button type="button" id="connLight" class="conn-light connIdle" role="status" title="[^"]*"><\/button>/);
  assert.ok(!/<select[^>]*id="voiceName"/.test(html));
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

test('F6: offscreen.html loads lib/playback.js (a classic script) before offscreen.js, with no module scripts', () => {
  const html = read('offscreen.html');
  const scripts = [...html.matchAll(/<script\b[^>]*>/g)].map((m) => m[0]);
  assert.deepEqual(scripts, ['<script src="lib/playback.js">', '<script src="offscreen.js">']);
});

// --- F7: no sentence slider -------------------------------------------------------------------------

test('F7: popup.html range inputs are still only speed and seekBar', () => {
  const html = read('popup.html');
  const ranges = [...html.matchAll(/<input[^>]*type="range"[^>]*>/g)].map((m) => m[0].match(/id="([^"]+)"/)[1]);
  assert.deepEqual(ranges.sort(), ['seekBar', 'speed']);
});
