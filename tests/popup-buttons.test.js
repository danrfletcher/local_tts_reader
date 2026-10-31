'use strict';
/**
 * popup.js and audioPlayer.js (both run for real against a minimal DOM stub)
 * wired to the real background.js: which buttons each state enables, and
 * whether Play resumes the paused session or starts a new one.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  settle, loadBackground, jsonResponse, textResponse, hangUntilAbort
} = require('./helpers/fake-chrome.js');
const { playChunks } = require('./helpers/session.js');
const { VOICES: SERVER_VOICES } = require('./fixtures/fake-tts-server.js');
const { SENTENCES, createGatedFetch, liveSession, chunkReady, endChunk } = require('./helpers/pause.js');
// The popup stub (fakeElement, loadPopup) lives in helpers/popup.js, shared with
// popup-connection.test.js and popup-play-gate.test.js.
const { loadPopup, voicesBody, VOICES_URL } = require('./helpers/popup.js');

// --- updateControlButtons -----------------------------------------------------------------------

test('starting and loading enable Pause once a session exists, and keep it disabled before', async () => {
  const popup = loadPopup();
  await popup.ready;
  const { updateControlButtons } = popup.sandbox;
  for (const state of ['starting', 'loading']) {
    updateControlButtons(state, true);
    assert.deepEqual(popup.buttons(), { play: true, pause: false, stop: true }, `${state} with a session`);
    updateControlButtons(state, false);
    // Stop (disabled: true) stays off in 'loading'; 'starting' with no session is
    // a right-click read waiting on its voices check, which Stop cancels.
    assert.deepEqual(popup.buttons(), { play: true, pause: true, stop: state === 'loading' }, `${state} without one`);
  }
});

test('paused enables Play and disables Pause; stopped enables Play and disables Pause; playing the reverse', async () => {
  const popup = loadPopup();
  await popup.ready;
  const { updateControlButtons } = popup.sandbox;
  updateControlButtons('paused', true);
  assert.deepEqual(popup.buttons(), { play: false, pause: true, stop: false });
  updateControlButtons('stopped', false);
  assert.deepEqual(popup.buttons(), { play: false, pause: true, stop: false });
  updateControlButtons('playing', true);
  assert.deepEqual(popup.buttons(), { play: true, pause: false, stop: false });
});

test('ready disables Play while a session is live, and keeps it enabled with none', async () => {
  const popup = loadPopup();
  await popup.ready;
  const { updateControlButtons } = popup.sandbox;
  updateControlButtons('ready', true);
  assert.deepEqual(popup.buttons(), { play: true, pause: true, stop: false });
  updateControlButtons('ready', false);
  assert.deepEqual(popup.buttons(), { play: false, pause: true, stop: false });
});

test('playerStateUpdate with a session id enables Pause while starting/loading; without one it does not', async () => {
  const popup = loadPopup();
  await popup.ready;
  popup.deliverMessage({ type: 'playerStateUpdate', state: 'loading', sessionId: null });
  assert.equal(popup.buttons().pause, true);
  popup.deliverMessage({ type: 'playerStateUpdate', state: 'starting', sessionId: 'abcdef' });
  assert.equal(popup.buttons().pause, false);
  popup.deliverMessage({ type: 'playerStateUpdate', state: 'loading', sessionId: 'abcdef' });
  assert.equal(popup.buttons().pause, false);
  popup.deliverMessage({ type: 'playerStateUpdate', state: 'stopped', sessionId: null });
  popup.deliverMessage({ type: 'playerStateUpdate', state: 'loading', sessionId: null });
  assert.equal(popup.buttons().pause, true, 'the session id is forgotten on Stop');
});

// --- Against the real background ----------------------------------------------------------------------

async function startedBackground(sentences = SENTENCES) {
  const fetch = createGatedFetch(sentences, { auto: true });
  return loadBackground({ sentences, fetch });
}

test('Pause during a gated cold start is reachable from the popup: Pause enabled, one controlAudio with the id, state paused', async () => {
  const fetch = createGatedFetch(SENTENCES, { auto: false });
  const bg = loadBackground({ sentences: SENTENCES, fetch });
  const popup = loadPopup({ bg });
  await popup.ready;

  const playing = popup.getEl('playBtn').click();
  await settle();
  await popup.deliverBroadcasts();
  assert.equal(popup.getEl('pauseBtn').disabled, false, 'Pause is enabled while the first sentence loads');

  await popup.getEl('pauseBtn').click();
  await popup.deliverBroadcasts();
  const pauses = popup.sentOfType('controlAudio');
  assert.deepEqual(pauses, [{ type: 'controlAudio', action: 'pause', sessionId: liveSession(bg).sessionId }]);
  assert.equal(liveSession(bg).paused, true);
  assert.deepEqual(popup.buttons(), { play: false, pause: true, stop: false });

  fetch.entries[0].respond();
  await playing;
  await settle();
  assert.equal(playChunks(bg).length, 0, 'paused through the whole cold start');
});

test('popup Pause goes to the background (controlAudio), never straight to the offscreen document (no bare pause message)', async () => {
  const bg = await startedBackground();
  const popup = loadPopup({ bg });
  await popup.ready;
  await popup.getEl('playBtn').click();
  await popup.deliverBroadcasts();

  await popup.getEl('pauseBtn').click();
  assert.deepEqual(popup.sentMessages.filter((m) => m.type === 'pause' || m.type === 'play'), []);
  assert.equal(popup.sentOfType('controlAudio').length, 1);
  assert.equal(popup.sentOfType('controlAudio')[0].action, 'pause');
});

test('reopening the popup while paused shows paused: Play enabled, Pause disabled, "Sentence 2 of 6"', async () => {
  const bg = await startedBackground();
  const first = loadPopup({ bg });
  await first.ready;
  await first.getEl('playBtn').click();
  await first.deliverBroadcasts();
  const chunk0 = playChunks(bg)[0];
  await chunkReady(bg, chunk0);
  await endChunk(bg, chunk0);
  await first.deliverBroadcasts();
  await first.getEl('pauseBtn').click();
  await settle();
  await bg.timers.tick(180000);

  const reopened = loadPopup({ bg }); // a fresh popup knows nothing of the session
  await reopened.ready;
  await settle();

  assert.deepEqual(reopened.buttons(), { play: false, pause: true, stop: false });
  assert.equal(reopened.progress(), 'Sentence 2 of 6');
  assert.ok(reopened.sentMessages.some((m) => m.type === 'getSessionState'));
});

test('Play on the reopened paused popup resumes the same session: controlAudio play with its id, no startStreaming', async () => {
  const bg = await startedBackground();
  const first = loadPopup({ bg });
  await first.ready;
  await first.getEl('playBtn').click();
  await first.deliverBroadcasts();
  const chunk0 = playChunks(bg)[0];
  await first.getEl('pauseBtn').click();
  await settle();
  const scriptingBefore = bg.scriptingCalls.length;

  const reopened = loadPopup({ bg });
  await reopened.ready;
  await reopened.getEl('playBtn').click();
  await settle();

  assert.deepEqual(reopened.sentOfType('controlAudio'), [{ type: 'controlAudio', action: 'play', sessionId: chunk0.sessionId }]);
  assert.deepEqual(reopened.sentOfType('startStreaming'), []);
  assert.equal(liveSession(bg).sessionId, chunk0.sessionId);
  assert.equal(liveSession(bg).paused, false);
  assert.equal(bg.scriptingCalls.length, scriptingBefore, 'no new session');
  assert.equal(playChunks(bg).length, 1);
});

test('Play in \'ready\' with a live session does not replace it: Play is disabled, and a click sends nothing and keeps the session', async () => {
  const bg = await startedBackground();
  const popup = loadPopup({ bg });
  await popup.ready;
  await popup.getEl('playBtn').click();
  await popup.deliverBroadcasts();
  const chunk0 = playChunks(bg)[0];
  await chunkReady(bg, chunk0); // background moves to 'ready' on audioReady
  await popup.deliverBroadcasts();
  assert.equal(bg.sent.at(-1).state, 'ready');
  assert.equal(popup.buttons().play, true, 'Play is disabled while the live session is ready');

  const scriptingBefore = bg.scriptingCalls.length;
  const sentBefore = popup.sentMessages.length;
  await popup.getEl('playBtn').click(); // even if the click gets through
  await settle();

  assert.equal(popup.sentOfType('startStreaming').length, 1, 'no second session');
  assert.deepEqual(popup.sentOfType('controlAudio'), []);
  assert.deepEqual(popup.sentMessages.slice(sentBefore).map((m) => m.type), ['getSessionState']);
  assert.equal(liveSession(bg).sessionId, chunk0.sessionId);
  assert.equal(bg.scriptingCalls.length, scriptingBefore);
  assert.equal(playChunks(bg).length, 1, 'the sentence is not replayed from the start');
});

test('Play with a live session that is loading or playing is also a no-op', async () => {
  const bg = await startedBackground();
  const popup = loadPopup({ bg });
  await popup.ready;
  await popup.getEl('playBtn').click();
  await popup.deliverBroadcasts();
  const chunk0 = playChunks(bg)[0];

  await popup.getEl('playBtn').click(); // loading
  await bg.send({ type: 'stateUpdate', state: 'playing', sessionId: chunk0.sessionId });
  await popup.deliverBroadcasts();
  await popup.getEl('playBtn').click(); // playing
  await settle();

  assert.equal(popup.sentOfType('startStreaming').length, 1);
  assert.equal(liveSession(bg).sessionId, chunk0.sessionId);
  assert.equal(playChunks(bg).length, 1);
});

test('Play with no session starts a new session (startStreaming)', async () => {
  const bg = await startedBackground();
  const popup = loadPopup({ bg });
  await popup.ready;
  await popup.getEl('playBtn').click();
  assert.equal(popup.sentOfType('startStreaming').length, 1);
  assert.deepEqual(popup.sentOfType('controlAudio'), []);
  assert.equal(playChunks(bg).length, 1);
});

test('Play after Stop starts a new session, even though the popup last heard "paused"', async () => {
  const bg = await startedBackground();
  const popup = loadPopup({ bg });
  await popup.ready;
  await popup.getEl('playBtn').click();
  await popup.deliverBroadcasts();
  const old = playChunks(bg)[0];
  await popup.getEl('pauseBtn').click();
  await popup.deliverBroadcasts();
  await popup.getEl('stopBtn').click();
  await settle();
  assert.equal(liveSession(bg).stopped, true);
  assert.deepEqual(popup.sentOfType('controlAudio').map((m) => m.action), ['pause', 'stop']);
  assert.ok(popup.sentOfType('controlAudio').every((m) => m.sessionId === old.sessionId));

  await popup.getEl('playBtn').click();
  await settle();

  assert.equal(popup.sentOfType('startStreaming').length, 2);
  assert.notEqual(liveSession(bg).sessionId, old.sessionId);
  assert.equal(playChunks(bg).at(-1).index, 0);
});

test('Play after a session ended on its own starts a new session', async () => {
  const bg = await startedBackground(SENTENCES.slice(0, 1));
  const popup = loadPopup({ bg });
  await popup.ready;
  await popup.getEl('playBtn').click();
  const only = playChunks(bg)[0];
  await endChunk(bg, only);
  assert.equal(liveSession(bg).stopped, true);

  await popup.getEl('playBtn').click();
  await settle();
  assert.equal(popup.sentOfType('startStreaming').length, 2);
  assert.equal(playChunks(bg).length, 2);
});

test('the Stop button with no live session still sends an id-less Stop', async () => {
  const bg = await startedBackground();
  const popup = loadPopup({ bg });
  await popup.ready;
  await popup.getEl('stopBtn').click();
  assert.deepEqual(popup.sentOfType('controlAudio'), [{ type: 'controlAudio', action: 'stop' }]);
});

test('syncing on open with the offscreen document gone (as Chrome closes it while paused) does not throw', async () => {
  const bg = await startedBackground();
  const first = loadPopup({ bg });
  await first.ready;
  await first.getEl('playBtn').click();
  await first.getEl('pauseBtn').click();
  await settle();
  bg.closeOffscreen();
  bg.rejectMessages(() => true); // nobody is listening for getTimeInfo either

  const reopened = loadPopup({ bg });
  await reopened.ready;
  await settle(20);
  assert.deepEqual(reopened.buttons(), { play: false, pause: true, stop: false });
  assert.equal(reopened.progress(), 'Sentence 1 of 6');
});

// --- Connection light and Voice box -----------------------------------------------------------------------

const hangingVoices = ({ signal }) => hangUntilAbort(signal);
const light = (popup) => popup.getEl('connLight').className;
const label = (popup) => popup.getEl('connLabel').textContent;
const options = (popup) => popup.getEl('voice').children.map((o) => ({ value: o.value, text: o.textContent }));
const voiceBoxShown = (popup) => popup.getEl('voiceGroup').hidden === false;
/** Type into the Server URL box: the `input` event the popup debounces. */
async function typeUrl(popup, url) {
  popup.getEl('serverUrl').value = url;
  await popup.getEl('serverUrl').fire('input');
}

test('G1/GP1: starts grey and idle with Play disabled; Checking... for 3 s, then Starting voice engine...; no Voice box', async () => {
  const popup = loadPopup({ voicesFetch: hangingVoices, holdStorage: true });
  await settle();
  assert.equal(light(popup), 'conn-light connIdle', 'before the first check');
  assert.equal(popup.getEl('playBtn').disabled, true, 'Play starts disabled');
  assert.equal(voiceBoxShown(popup), false);
  popup.releaseStorage();
  await popup.ready;

  assert.equal(popup.getEl('serverUrl').value, 'http://localhost:8090/v1/audio/speech');
  assert.deepEqual(popup.voicesRequests.calls.map((c) => c.url), [VOICES_URL]);
  assert.equal(light(popup), 'conn-light connChecking');
  assert.equal(label(popup), 'Checking...');
  assert.equal(voiceBoxShown(popup), false);
  assert.equal(popup.getEl('playBtn').disabled, true);

  await popup.timers.tick(2999);
  assert.equal(label(popup), 'Checking...');
  await popup.timers.tick(1);
  assert.equal(light(popup), 'conn-light connStarting');
  assert.equal(label(popup), 'Starting voice engine...');
  assert.equal(popup.getEl('connLight').title, 'Starting voice engine...');
  assert.equal(voiceBoxShown(popup), false);
  assert.equal(popup.getEl('playBtn').disabled, true);
});

test('E1: a cold start up to 90 s stays "Starting voice engine..." and is never red; at 90 s it is the timeout text', async () => {
  const popup = loadPopup({ voicesFetch: hangingVoices });
  await popup.ready;
  await popup.timers.tick(89999);
  assert.equal(light(popup), 'conn-light connStarting');
  await popup.timers.tick(1);
  assert.equal(light(popup), 'conn-light connFailed');
  assert.equal(label(popup), 'Timed out - click the light to retry');
  assert.equal(voiceBoxShown(popup), false);
  assert.equal(popup.getEl('playBtn').disabled, true);
});

test('G1: the 3 s timer restarts on every check', async () => {
  const popup = loadPopup({ voicesFetch: hangingVoices });
  await popup.ready;
  await popup.timers.tick(2000);
  await typeUrl(popup, 'http://localhost:9000/v1/audio/speech');
  await popup.timers.tick(500); // the debounce fires: a new check begins at t = 2.5 s
  assert.equal(popup.voicesRequests.calls.length, 2);
  assert.equal(light(popup), 'conn-light connChecking');
  await popup.timers.tick(2999); // 5.499 s: the first check's 3 s would be long gone
  assert.equal(label(popup), 'Checking...');
  await popup.timers.tick(1);
  assert.equal(label(popup), 'Starting voice engine...');
});

test('G2/G7/GP2: a 200 with 28 names is green, the Voice box lists them in server order without .wav, and Play is enabled', async () => {
  const popup = loadPopup();
  await popup.ready;
  assert.equal(light(popup), 'conn-light connOk');
  assert.equal(label(popup), 'Connected');
  assert.equal(voiceBoxShown(popup), true);
  assert.equal(popup.getEl('voice').disabled, false);
  const shown = options(popup);
  assert.equal(shown.length, 28);
  assert.deepEqual(shown.map((o) => o.value), SERVER_VOICES, 'the value is the raw id, in server order');
  assert.equal(shown[0].text, 'Abigail');
  assert.equal(shown.at(-1).text, 'Thomas');
  assert.ok(shown.every((o) => o.value.replace(/\.wav$/, '') === o.text), 'text is the id without .wav');
  assert.equal(popup.getEl('playBtn').disabled, false);
});

test('G7: server order is kept, not sorted; extension-only duplicates show raw ids (E9)', async () => {
  const popup = loadPopup({ voicesFetch: () => voicesBody(['Zed.wav', 'Olivia.wav', 'Amy.MP3', 'Olivia.mp3']) });
  await popup.ready;
  assert.deepEqual(options(popup), [
    { value: 'Zed.wav', text: 'Zed' },
    { value: 'Olivia.wav', text: 'Olivia.wav' },
    { value: 'Amy.MP3', text: 'Amy' },
    { value: 'Olivia.mp3', text: 'Olivia.mp3' }
  ]);
});

test('G3/E2/E7: each failure shows its exact text on a red light, hides the Voice box and disables Play', async () => {
  const cases = [
    [() => { throw new TypeError('Failed to fetch'); }, "Can't reach server - is it running?"],
    [() => Promise.reject(new TypeError('net::ERR_CONNECTION_REFUSED')), "Can't reach server - is it running?"],
    [() => jsonResponse({}, 401), 'Not authorised (401)'],
    [() => jsonResponse({}, 403), 'Not authorised (403)'],
    [() => jsonResponse({}, 500), 'Server error 500'],
    [() => jsonResponse({}, 503), 'Server error 503'],
    [() => textResponse('<html></html>'), 'Unexpected response'],
    [() => jsonResponse({ status: 'ok' }), 'Unexpected response']
  ];
  for (const [respond, text] of cases) {
    const popup = loadPopup({ voicesFetch: respond });
    await popup.ready;
    assert.equal(light(popup), 'conn-light connFailed', text);
    assert.equal(label(popup), text);
    assert.equal(popup.getEl('connLight').title, text);
    assert.equal(voiceBoxShown(popup), false, text);
    assert.equal(popup.getEl('playBtn').disabled, true, text);
  }
});

test('E3/G4 smoke: 404/405 and an empty list are amber states with no Voice box; Play only with a voice name (full table in popup-connection.test.js)', async () => {
  const noList = loadPopup({ voicesFetch: () => jsonResponse({}, 404) });
  await noList.ready;
  assert.equal(light(noList), 'conn-light connNoList');
  assert.equal(label(noList), 'Connected, no voice list');
  assert.equal(voiceBoxShown(noList), false);
  assert.equal(noList.getEl('playBtn').disabled, true, 'no saved voice name to send');

  const withName = loadPopup({ voicesFetch: () => jsonResponse({}, 405), stored: { voice: 'Olivia.wav' } });
  await withName.ready;
  assert.equal(withName.getEl('playBtn').disabled, false);

  const empty = loadPopup({ voicesFetch: () => voicesBody([]), stored: { voice: 'Olivia.wav' } });
  await empty.ready;
  assert.equal(light(empty), 'conn-light connNoVoices');
  assert.equal(label(empty), 'Server has no voices');
  assert.equal(empty.getEl('playBtn').disabled, true);
});

test('GP7/G10: a fresh install opens on the 8090 URL with the first server voice selected, and writes nothing', async () => {
  const popup = loadPopup();
  await popup.ready;
  assert.equal(popup.getEl('serverUrl').value, 'http://localhost:8090/v1/audio/speech');
  assert.equal(popup.getEl('voice').value, 'Abigail.wav');
  assert.equal(popup.getEl('voiceNote').hidden, true);
  assert.deepEqual(popup.storageSets, []);
});

test('G10: a stored old port-8000 URL is replaced by the 8090 default, and the check goes to 8090', async () => {
  const popup = loadPopup({ stored: { serverUrl: 'http://localhost:8000/v1/audio/speech' } });
  await popup.ready;
  assert.equal(popup.getEl('serverUrl').value, 'http://localhost:8090/v1/audio/speech');
  assert.deepEqual(popup.voicesRequests.calls.map((c) => c.url), [VOICES_URL]);
});

test('G8: a saved voice missing from the list selects the first voice with a note, and writes nothing', async () => {
  const popup = loadPopup({ stored: { voice: 'Zed.wav' } });
  await popup.ready;
  assert.equal(popup.getEl('voice').value, 'Abigail.wav');
  assert.equal(popup.getEl('voiceNote').hidden, false);
  assert.equal(popup.getEl('voiceNote').textContent, 'Voice Zed.wav is not on this server; using Abigail');
  assert.deepEqual(popup.storageSets, [], 'storage is not written');
});

test('G8: the note clears when the user picks a voice (which is then the only write of `voice`)', async () => {
  const popup = loadPopup({ stored: { voice: 'Zed.wav' } });
  await popup.ready;
  popup.getEl('voice').value = 'Olivia.wav';
  await popup.getEl('voice').fire('change');
  assert.equal(popup.getEl('voiceNote').hidden, true);
  assert.equal(popup.getEl('voiceNote').textContent, '');
  assert.deepEqual(popup.storageSets, [{ voice: 'Olivia.wav' }]);
});

test('G8: the note clears on the next successful check where the saved voice is present', async () => {
  let ids = SERVER_VOICES;
  const popup = loadPopup({ stored: { voice: 'Zed.wav' }, voicesFetch: () => voicesBody(ids) });
  await popup.ready;
  assert.equal(popup.getEl('voiceNote').hidden, false);
  ids = ['Zed.wav', ...SERVER_VOICES];
  await typeUrl(popup, 'http://localhost:8090/v1/audio/speech/');
  await popup.timers.tick(500);
  await settle();
  assert.equal(popup.getEl('voice').value, 'Zed.wav');
  assert.equal(popup.getEl('voiceNote').hidden, true);
  assert.deepEqual(popup.storageSets, []);
});

test('E10: an empty saved voice, or af_bella the server does not offer, is unset (first voice, no note); af_bella is kept when offered', async () => {
  for (const voice of ['', 'af_bella']) {
    const popup = loadPopup({ stored: { voice } });
    await popup.ready;
    assert.equal(popup.getEl('voice').value, 'Abigail.wav', JSON.stringify(voice));
    assert.equal(popup.getEl('voiceNote').hidden, true);
    assert.deepEqual(popup.storageSets, []);
  }
  const kokoro = loadPopup({ stored: { voice: 'af_bella' }, voicesFetch: () => jsonResponse(['am_adam', 'af_bella']) });
  await kokoro.ready;
  assert.equal(kokoro.getEl('voice').value, 'af_bella');
  assert.equal(kokoro.getEl('voiceNote').hidden, true);
});

test('G1/G6: a re-check from green keeps the old list visible but disabled, then enables it (or hides it on failure)', async () => {
  let respond = () => voicesBody();
  const popup = loadPopup({ voicesFetch: (call) => respond(call) });
  await popup.ready;
  popup.getEl('voice').value = 'Olivia.wav';
  await popup.getEl('voice').fire('change');

  respond = hangingVoices;
  await typeUrl(popup, 'http://localhost:8090/v1/audio/speech?x=1');
  await popup.timers.tick(500);
  assert.equal(light(popup), 'conn-light connChecking');
  assert.equal(voiceBoxShown(popup), true, 'the old list stays visible');
  assert.equal(popup.getEl('voice').disabled, true, 'but disabled');
  assert.equal(options(popup).length, 28);
  assert.equal(popup.getEl('playBtn').disabled, true, 'Play is closed while the connection is re-checked');

  respond = () => voicesBody();
  await typeUrl(popup, 'http://localhost:8090/v1/audio/speech');
  await popup.timers.tick(500);
  await settle();
  assert.equal(light(popup), 'conn-light connOk');
  assert.equal(popup.getEl('voice').disabled, false);
  assert.equal(popup.getEl('voice').value, 'Olivia.wav', 'the picked voice is still selected');
  assert.equal(popup.getEl('playBtn').disabled, false);

  respond = () => { throw new TypeError('Failed to fetch'); };
  await typeUrl(popup, 'http://localhost:9999/v1/audio/speech');
  await popup.timers.tick(500);
  await settle();
  assert.equal(label(popup), "Can't reach server - is it running?");
  assert.equal(voiceBoxShown(popup), false);
  assert.equal(popup.getEl('playBtn').disabled, true);
  assert.deepEqual(popup.storageSets, [{ voice: 'Olivia.wav' }], 'a failed check writes nothing');
});

test('E8: saving other settings (URL, speed, checkboxes, Play) never writes `voice`; the pick is the only write', async () => {
  const popup = loadPopup();
  await popup.ready;
  for (const id of ['serverUrl', 'speed', 'recordAudio', 'preprocessText']) await popup.getEl(id).fire('change');
  await popup.getEl('playBtn').click();
  assert.equal(popup.storageSets.length, 5);
  for (const saved of popup.storageSets) {
    assert.deepEqual(Object.keys(saved).sort(), ['preprocessText', 'recordAudio', 'serverUrl', 'speed']);
  }
  popup.getEl('voice').value = 'Thomas.wav';
  await popup.getEl('voice').fire('change');
  assert.deepEqual(popup.storageSets.at(-1), { voice: 'Thomas.wav' });
});

test('Added: the Server URL check runs on input (debounced 500 ms); change only saves settings', async () => {
  const popup = loadPopup();
  await popup.ready;
  assert.equal(popup.voicesRequests.calls.length, 1);

  await typeUrl(popup, 'http://localhost:9000/v1/audio/speech');
  await popup.timers.tick(499);
  assert.equal(popup.voicesRequests.calls.length, 1, 'nothing before 500 ms');
  await typeUrl(popup, 'http://localhost:9001/v1/audio/speech'); // typing again restarts the wait
  await popup.timers.tick(499);
  assert.equal(popup.voicesRequests.calls.length, 1);
  await popup.timers.tick(1);
  assert.equal(popup.voicesRequests.calls.length, 2);
  assert.equal(popup.voicesRequests.calls[1].url, 'http://localhost:9001/v1/audio/voices?model=tts-1');

  await popup.getEl('serverUrl').fire('change');
  await popup.timers.tick(5000);
  assert.equal(popup.voicesRequests.calls.length, 2, 'change does not check');
  assert.equal(popup.storageSets.at(-1).serverUrl, 'http://localhost:9001/v1/audio/speech');
});

test('Added/E4: editing the URL during a check aborts the earlier fetch silently; only the latest result is applied', async () => {
  const late = [];
  const popup = loadPopup({
    voicesFetch: ({ call, signal }) => {
      if (call === 1) {
        // A server that answers after the abort anyway (the abort is not what rejects it).
        return new Promise((resolve) => late.push(() => resolve(voicesBody(['Stale.wav']))));
      }
      return voicesBody();
    }
  });
  await popup.ready;
  await typeUrl(popup, 'http://localhost:8091/v1/audio/speech');
  await popup.timers.tick(500);
  await settle();

  assert.equal(popup.voicesRequests.calls[0].init.signal.aborted, true, 'the earlier fetch is aborted');
  assert.equal(light(popup), 'conn-light connOk');
  assert.equal(options(popup).length, 28);
  late[0](); // the old request answering late changes nothing
  await settle();
  assert.equal(light(popup), 'conn-light connOk');
  assert.equal(options(popup).length, 28);
  assert.equal(popup.getEl('voice').value, 'Abigail.wav');
});

test('Added/C18: typing in the URL box aborts the running check at once; a result that arrives inside the 500 ms debounce is not applied', async () => {
  const answers = [];
  const popup = loadPopup({
    voicesFetch: ({ call }) => {
      if (call === 1) return new Promise((resolve) => answers.push(() => resolve(voicesBody(['Old.wav']))));
      return voicesBody();
    }
  });
  await popup.ready;
  await typeUrl(popup, 'http://localhost:8091/v1/audio/speech');
  await settle();
  // Before the debounce fires: the earlier fetch is already aborted, nothing new has started.
  assert.equal(popup.voicesRequests.calls.length, 1);
  assert.equal(popup.voicesRequests.calls[0].init.signal.aborted, true, 'aborted on input, not when the debounce fires');

  answers[0](); // the old server answers inside the window
  await settle();
  assert.equal(light(popup), 'conn-light connChecking', 'the old result is not applied');
  assert.equal(popup.getEl('playBtn').disabled, true, 'Play is not enabled for the old server');
  assert.equal(voiceBoxShown(popup), false);

  await popup.timers.tick(500);
  await settle();
  assert.equal(light(popup), 'conn-light connOk');
  assert.equal(options(popup).length, 28, 'only the new server list is shown');
});

test('Added/E4: an aborted fetch that rejects with AbortError is silent: no red light, no label change', async () => {
  const popup = loadPopup({ voicesFetch: hangingVoices });
  await popup.ready;
  await typeUrl(popup, 'http://localhost:8091/v1/audio/speech');
  await popup.timers.tick(500); // aborts the first (hanging) fetch, which rejects with AbortError
  await settle();
  assert.equal(popup.voicesRequests.calls[0].init.signal.aborted, true);
  assert.equal(light(popup), 'conn-light connChecking');
  assert.equal(label(popup), 'Checking...');
});

test('E1/F4: closing the popup aborts the check; reopening issues a fresh request (no caching)', async () => {
  const first = loadPopup({ voicesFetch: hangingVoices });
  await first.ready;
  assert.equal(first.voicesRequests.calls[0].init.signal.aborted, false);
  first.closePopup();
  assert.equal(first.voicesRequests.calls[0].init.signal.aborted, true);
  await settle();
  assert.equal(light(first), 'conn-light connChecking', 'the abort changes no state');

  const second = loadPopup();
  await second.ready;
  assert.equal(second.voicesRequests.calls.length, 1, 'a new popup asks again');
  assert.equal(light(second), 'conn-light connOk');
  assert.deepEqual(second.storageSets, [], 'and stores nothing about the list');
});

test('G11/G12: a player-state broadcast never re-enables Play while the connection gate is closed', async () => {
  const closed = loadPopup({ voicesFetch: () => { throw new TypeError('Failed to fetch'); } });
  await closed.ready;
  for (const state of ['stopped', 'paused', 'ready']) {
    closed.deliverMessage({ type: 'playerStateUpdate', state, sessionId: null });
    assert.equal(closed.getEl('playBtn').disabled, true, state);
  }
  const open = loadPopup();
  await open.ready;
  open.deliverMessage({ type: 'playerStateUpdate', state: 'stopped', sessionId: null });
  assert.equal(open.getEl('playBtn').disabled, false);
  open.deliverMessage({ type: 'playerStateUpdate', state: 'playing', sessionId: 'abcdef' });
  assert.equal(open.getEl('playBtn').disabled, true, 'the session gate still closes Play');
  open.deliverMessage({ type: 'playerStateUpdate', state: 'stopped', sessionId: null });
  assert.equal(open.getEl('playBtn').disabled, false);
});

test('E13: the connection label is separate from the player overlay label, and hidden while a session is active', async () => {
  const popup = loadPopup();
  await popup.ready;
  assert.notEqual(popup.getEl('connLabel'), popup.getEl('loadingLabel'));
  assert.equal(popup.getEl('connLabel').hidden, false);

  popup.deliverMessage({ type: 'playerStateUpdate', state: 'starting', sessionId: 'abcdef' });
  assert.equal(popup.getEl('loadingLabel').textContent, 'Starting voice engine…', "the player's own overlay");
  assert.equal(popup.getEl('connLabel').hidden, true, 'the connection label steps aside during a session');
  assert.equal(light(popup), 'conn-light connOk', 'the light itself stays');

  popup.deliverMessage({ type: 'playerStateUpdate', state: 'stopped', sessionId: null });
  assert.equal(popup.getEl('connLabel').hidden, false);
});

test('GP3/F1: picking Olivia and pressing Play sends a speech request whose body voice is Olivia.wav', async () => {
  const bg = await startedBackground();
  const popup = loadPopup({ bg });
  await popup.ready;
  popup.getEl('voice').value = 'Olivia.wav';
  await popup.getEl('voice').fire('change');
  await popup.getEl('playBtn').click();
  await settle();

  const start = popup.sentOfType('startStreaming')[0];
  assert.equal(start.settings.voice, 'Olivia.wav');
  assert.equal(start.settings.serverUrl, 'http://localhost:8090/v1/audio/speech');
  assert.equal(bg.fetch.calls.length >= 1, true);
  assert.equal(bg.fetch.calls[0].body.voice, 'Olivia.wav');
  assert.deepEqual(Object.keys(bg.fetch.calls[0].body).sort(), ['input', 'model', 'speed', 'voice']);
  assert.equal(bg.fetch.calls[0].url, 'http://localhost:8090/v1/audio/speech');
});

test('GP7: Play on a fresh install sends the first server voice without having stored it', async () => {
  const bg = await startedBackground();
  const popup = loadPopup({ bg });
  await popup.ready;
  await popup.getEl('playBtn').click();
  await settle();
  assert.equal(bg.fetch.calls[0].body.voice, 'Abigail.wav');
  assert.ok(popup.storageSets.every((saved) => !('voice' in saved)));
});

test('F7: the voices request is a plain GET: no headers, no Authorization, and a 401 is reported, not retried', async () => {
  const popup = loadPopup({ voicesFetch: () => jsonResponse({}, 401) });
  await popup.ready;
  assert.equal(popup.voicesRequests.calls.length, 1);
  const { init } = popup.voicesRequests.calls[0];
  assert.deepEqual(Object.keys(init), ['signal']);
  assert.equal(label(popup), 'Not authorised (401)');
});
