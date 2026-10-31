'use strict';
/**
 * Polish: findings deferred from the voice-list build, each through the real
 * popup.js / background.js (loadPopup, loadBackground).
 *   - the Play gate closes the moment the Server URL is edited (PR-1 R1, PR-2 R1)
 *   - the typed Voice name is saved and sent trimmed (PR-2 R3)
 *   - the "can't derive" note stays visible during a session (PR-2 R3)
 *   - Stop cancels a right-click read that is waiting on its voices check (PR-3 R1)
 *   - a saved old-default voice is sent as is when there is no list to say otherwise (PR-3 R2)
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { settle, loadBackground, createFakeFetch, jsonResponse } = require('./helpers/fake-chrome.js');
const { playChunks } = require('./helpers/session.js');
const { SENTENCES, createGatedFetch, control, liveSession } = require('./helpers/pause.js');
const { loadPopup, voicesBody, controlledVoices } = require('./helpers/popup.js');

const SPEECH = (port) => `http://localhost:${port}/v1/audio/speech`;

async function typeUrl(popup, url) {
  popup.getEl('serverUrl').value = url;
  await popup.getEl('serverUrl').fire('input');
}

async function typeVoiceName(popup, text) {
  popup.getEl('voiceName').value = text;
  await popup.getEl('voiceName').fire('input');
}

// --- PR-1 R1, PR-2 R1: the gate closes on the edit ---------------------------------------------------

test('PR-2 R1: from green, an edit of the Server URL closes Play and the list at once; the light itself waits for the debounce', async () => {
  const popup = loadPopup();
  await popup.ready;
  assert.equal(popup.getEl('playBtn').disabled, false);
  assert.equal(popup.getEl('connLight').className, 'conn-light connOk');

  await typeUrl(popup, SPEECH(9101));
  assert.equal(popup.getEl('playBtn').disabled, true, 'Play is closed inside the debounce window');
  assert.equal(popup.getEl('voice').disabled, true, 'the old list cannot be picked from');
  assert.equal(popup.getEl('connLight').className, 'conn-light connOk', 'GP4: the light changes only when the check starts');

  await popup.getEl('playBtn').click(); // the click guard, not only the disabled attribute
  assert.deepEqual(popup.sentOfType('startStreaming'), [], 'nothing is sent for the unchecked URL');
});

test('PR-2 R1: the gate reopens only with the answer of the check for the new URL', async () => {
  const controlled = controlledVoices();
  const popup = loadPopup({ voicesFetch: controlled.handler });
  await popup.ready;
  controlled.requests[0].answer(voicesBody(['Olivia.wav']));
  await settle();
  assert.equal(popup.getEl('playBtn').disabled, false);

  await typeUrl(popup, SPEECH(9102));
  await popup.timers.tick(500);
  assert.equal(controlled.requests.length, 2);
  assert.equal(popup.getEl('connLight').className, 'conn-light connChecking');
  assert.equal(popup.getEl('playBtn').disabled, true, 'closed while the new check runs');

  controlled.requests[1].answer(voicesBody(['Thomas.wav']));
  await settle();
  assert.equal(popup.getEl('playBtn').disabled, false);
  assert.equal(popup.getEl('voice').disabled, false);
  assert.deepEqual(popup.getEl('voice').children.map((o) => o.value), ['Thomas.wav']);
});

test('PR-2 R1: an edit followed by a click on the light checks at once and keeps Play closed until the answer', async () => {
  const controlled = controlledVoices();
  const popup = loadPopup({ voicesFetch: controlled.handler });
  await popup.ready;
  controlled.requests[0].answer(voicesBody(['Olivia.wav']));
  await settle();

  await typeUrl(popup, SPEECH(9103));
  await popup.getEl('connLight').click();
  assert.equal(controlled.requests.length, 2, 'the click started the check without waiting');
  assert.equal(popup.getEl('playBtn').disabled, true);
  await popup.timers.tick(5000); // the pending debounce was cancelled by the click's check
  assert.equal(controlled.requests.length, 2);
  controlled.requests[1].answer(voicesBody(['Thomas.wav']));
  await settle();
  assert.equal(popup.getEl('playBtn').disabled, false);
});

test('PR-1 R1: a check that finishes inside the debounce window is not applied to the new URL, and Play stays closed', async () => {
  const controlled = controlledVoices();
  const popup = loadPopup({ voicesFetch: controlled.handler });
  await popup.ready;

  await typeUrl(popup, SPEECH(9104)); // the first check is still running
  assert.equal(controlled.requests[0].signal.aborted, true, 'aborted by the edit, not by the debounce');
  controlled.requests[0].answer(voicesBody(['Old.wav'])); // it answers anyway
  await settle();
  assert.equal(popup.getEl('connLight').className, 'conn-light connChecking', 'the old answer was dropped');
  assert.equal(popup.getEl('voiceGroup').hidden, true);
  assert.equal(popup.getEl('playBtn').disabled, true);
  assert.equal(controlled.requests.length, 1, 'the new check has not started yet');

  await popup.timers.tick(500);
  assert.equal(controlled.requests.length, 2);
  assert.equal(controlled.requests[1].url.startsWith('http://localhost:9104/'), true);
});

test('PR-2 R1: closing the popup with an edit pending leaves no timer behind', async () => {
  const popup = loadPopup();
  await popup.ready;
  await typeUrl(popup, SPEECH(9105));
  popup.closePopup();
  await settle();
  assert.equal(popup.timers.pending, 0);
});

// --- PR-2 R3: trimmed Voice name; the note during a session ----------------------------------------------------------

test('PR-2 R3: a Voice name typed with a trailing space is saved and sent without it; the box keeps what was typed', async () => {
  const bg = loadBackground({ sentences: SENTENCES, fetch: createGatedFetch(SENTENCES, { auto: true }) });
  const popup = loadPopup({ bg, voicesFetch: () => jsonResponse({}, 404) });
  await popup.ready;

  await typeVoiceName(popup, ' Olivia.wav ');
  assert.equal(popup.getEl('playBtn').disabled, false);
  assert.deepEqual(popup.storageSets, [{ voice: 'Olivia.wav' }]);
  assert.equal(popup.getEl('voiceName').value, ' Olivia.wav ', 'the box is not rewritten under the caret');

  await popup.getEl('playBtn').click();
  await settle();
  assert.equal(popup.sentOfType('startStreaming')[0].settings.voice, 'Olivia.wav');
  assert.equal(bg.fetch.calls[0].body.voice, 'Olivia.wav');
});

test('PR-2 R3: a name with a space inside it is kept whole while typing', async () => {
  const popup = loadPopup({ voicesFetch: () => jsonResponse({}, 404) });
  await popup.ready;
  for (const text of ['My', 'My ', 'My V', 'My Voice']) await typeVoiceName(popup, text);
  assert.deepEqual(popup.storageSets.map((s) => s.voice), ['My', 'My', 'My V', 'My Voice']);
});

test('PR-2 R3: the "Can\'t derive a voices address" note stays visible during a session; other labels stay hidden', async () => {
  const noAddress = loadPopup({ stored: { serverUrl: 'http://tts.example.invalid:9000/synthesize', voice: 'Olivia.wav' } });
  await noAddress.ready;
  assert.equal(noAddress.getEl('connLabel').hidden, false);
  noAddress.deliverMessage({ type: 'playerStateUpdate', state: 'playing', sessionId: 'abcdef' });
  assert.equal(noAddress.getEl('connLabel').hidden, false, 'still shown with a session active');
  assert.equal(noAddress.getEl('connLabel').textContent, "Can't derive a voices address");

  const connected = loadPopup();
  await connected.ready;
  connected.deliverMessage({ type: 'playerStateUpdate', state: 'playing', sessionId: 'abcdef' });
  assert.equal(connected.getEl('connLabel').hidden, true, 'the existing rule for every other label');
});

test('PR-2 R3: a stored voice with stray spaces is sent trimmed by a right-click read when there is no voice list', async () => {
  const fetch = createFakeFetch(undefined, { voices: { status: 404 } });
  const bg = loadBackground({ sentences: ['Hello there friend.'], localStorage: { voice: 'Olivia.wav ' }, fetch });
  rightClick(bg);
  await settle();
  assert.equal(fetch.calls[0].body.voice, 'Olivia.wav');
});

// --- PR-3 R1: Stop cancels a start that is waiting on its voices ------------------------------------------------------

function rightClick(bg) {
  bg.listeners.menuClicked[0]({ menuItemId: 'readAloud', frameId: 0 }, { id: 7 });
}

const playerStates = (bg) => bg.sentOfType('playerStateUpdate').map((m) => m.state);

function waitingStart({ voices = { gated: true } } = {}) {
  const fetch = createFakeFetch(undefined, { voices });
  const bg = loadBackground({ sentences: SENTENCES, localStorage: { voice: 'Olivia.wav' }, fetch });
  return { bg, fetch };
}

test('PR-3 R1: an id-less Stop during the voices check aborts it, shows stopped, and the late answer starts nothing', async () => {
  const { bg, fetch } = waitingStart();
  rightClick(bg);
  await settle();
  assert.deepEqual(playerStates(bg), ['starting']);
  assert.equal(fetch.voiceCalls[0].signal.aborted, false);

  await control(bg, 'stop', undefined);
  await settle();
  assert.equal(fetch.voiceCalls[0].signal.aborted, true, 'the voices fetch was aborted');
  assert.deepEqual(playerStates(bg), ['starting', 'stopped']);

  fetch.voiceCalls[0].respond(); // too late
  await settle();
  assert.equal(fetch.calls.length, 0, 'no speech request');
  assert.equal(playChunks(bg).length, 0);
  assert.equal(bg.sentOfType('streamError').length, 0);
  assert.deepEqual(playerStates(bg), ['starting', 'stopped']);
  assert.ok(!liveSession(bg) || liveSession(bg).stopped, 'no live session');
});

test('PR-3 R1: after the Stop a new right-click starts normally', async () => {
  const { bg, fetch } = waitingStart();
  rightClick(bg);
  await settle();
  await control(bg, 'stop', undefined);
  await settle();

  rightClick(bg);
  await settle();
  assert.equal(fetch.voiceCalls.length, 2);
  fetch.voiceCalls[1].respond();
  await settle();
  assert.ok(fetch.calls.length >= 1, 'the new read began');
  assert.equal(fetch.calls[0].body.voice, 'Olivia.wav');
  assert.equal(playChunks(bg).length, 1);
});

test('PR-3 R1: a Stop that names a session id (a stale one) does not cancel the waiting start', async () => {
  const { bg, fetch } = waitingStart();
  rightClick(bg);
  await settle();
  await control(bg, 'stop', 'abcdef');
  await settle();
  assert.equal(fetch.voiceCalls[0].signal.aborted, false);
  fetch.voiceCalls[0].respond();
  await settle();
  assert.ok(fetch.calls.length >= 1, 'the read began');
});

test('PR-3 R1: the popup opened during the wait offers Stop, and clicking it cancels the start', async () => {
  const { bg, fetch } = waitingStart();
  rightClick(bg);
  await settle();
  const popup = loadPopup({ bg });
  await popup.ready;
  await settle();
  assert.equal(popup.getEl('stopBtn').disabled, false, 'Stop is offered while starting with no session');
  assert.equal(popup.getEl('playBtn').disabled, true);

  await popup.getEl('stopBtn').click();
  await settle();
  assert.deepEqual(popup.sentOfType('controlAudio'), [{ type: 'controlAudio', action: 'stop' }]);
  assert.equal(fetch.voiceCalls[0].signal.aborted, true);
  fetch.voiceCalls[0].respond();
  await settle();
  assert.equal(fetch.calls.length, 0);
});

test('PR-3 R1: a Stop with a live session still stops that session, not a start', async () => {
  const { bg, fetch } = waitingStart({ voices: { voices: ['Olivia.wav'] } });
  rightClick(bg);
  await settle();
  assert.equal(playChunks(bg).length, 1);
  const live = liveSession(bg);
  await control(bg, 'stop', undefined);
  await settle();
  assert.equal(live.stopped, true);
  assert.equal(fetch.voiceCalls.length, 1);
});

// --- PR-3 R2: the old default voice with no list -----------------------------------------------------------------------

const OLD_DEFAULT = ['af', 'bella'].join('_');

for (const [name, voices] of [
  ['a 404', { status: 404 }],
  ['a 405', { status: 405 }],
  ['a network error', { networkError: true }],
  ['a 500', { status: 500 }],
  ['a body that is not JSON', { text: 'oops' }]
]) {
  test(`PR-3 R2: with ${name} there is no list to say the old default voice is unset, so it is sent as is`, async () => {
    const fetch = createFakeFetch(undefined, { voices });
    const bg = loadBackground({ sentences: ['Hello there friend.'], localStorage: { voice: OLD_DEFAULT }, fetch });
    rightClick(bg);
    await settle();
    assert.equal(fetch.calls.length, 1);
    assert.equal(fetch.calls[0].body.voice, OLD_DEFAULT);
  });
}
