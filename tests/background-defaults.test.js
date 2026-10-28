'use strict';
/**
 * G10: right-click Read Aloud (startReadingFromTab) reads its settings from
 * chrome.storage.local with the shared defaults from constants.js, and a
 * stored old port-8000 default counts as unset.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { settle, loadBackground } = require('./helpers/fake-chrome.js');
const { DEFAULT_SETTINGS } = require('../constants.js');

async function rightClickRead(localStorage) {
  const bg = loadBackground({ sentences: ['Hello there friend.'], localStorage });
  bg.listeners.menuClicked[0]({ menuItemId: 'readAloud', frameId: 0 }, { id: 7 });
  await settle();
  return bg;
}

test('G10: with nothing stored, a right-click read uses the shared default URL, and the first voice the server lists (the shared default voice is empty)', async () => {
  const bg = await rightClickRead({});
  assert.equal(bg.fetch.calls.length, 1);
  assert.equal(bg.fetch.calls[0].url, 'http://localhost:8090/v1/audio/speech');
  assert.equal(bg.fetch.calls[0].url, DEFAULT_SETTINGS.serverUrl);
  assert.equal(DEFAULT_SETTINGS.voice, '');
  assert.equal(bg.fetch.calls[0].body.voice, 'Olivia.wav', 'empty counts as unset: the first voice of the fake server');
});

test('G10: a stored old port-8000 default is replaced by the shared default, silently (nothing is written back)', async () => {
  const bg = await rightClickRead({ serverUrl: 'http://localhost:8000/v1/audio/speech', voice: 'Olivia.wav' });
  assert.equal(bg.fetch.calls[0].url, 'http://localhost:8090/v1/audio/speech');
  assert.equal(bg.fetch.calls[0].body.voice, 'Olivia.wav', 'the stored voice is kept');
  assert.deepEqual(bg.chrome.storage.local.setCalls.filter((c) => 'serverUrl' in c || 'voice' in c), []);
});

test('G10: a stored URL and voice that are not the old defaults are used as stored', async () => {
  const bg = await rightClickRead({ serverUrl: 'http://tts.example.invalid:9999/v1/audio/speech', voice: 'Thomas.wav', speed: 1.5 });
  assert.equal(bg.fetch.calls[0].url, 'http://tts.example.invalid:9999/v1/audio/speech');
  assert.equal(bg.fetch.calls[0].body.voice, 'Thomas.wav');
  assert.equal(bg.fetch.calls[0].body.speed, 1.5);
});

test('F1: the speech request body keeps exactly the keys model, voice, input, speed on the right-click path', async () => {
  const bg = await rightClickRead({});
  assert.deepEqual(Object.keys(bg.fetch.calls[0].body).sort(), ['input', 'model', 'speed', 'voice']);
  assert.equal(bg.fetch.calls[0].body.model, 'tts-1');
});
