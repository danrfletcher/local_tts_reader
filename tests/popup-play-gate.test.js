'use strict';
/**
 * PR-2: the single Play gate in popup.js. Play is enabled only when the
 * connection gate (connOk, or connNoList with a non-empty voice name) and the
 * session gate (what the background's state broadcasts and getSessionState
 * say) both allow it. A connection check never touches the running session.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { settle, loadBackground, jsonResponse, hangUntilAbort } = require('./helpers/fake-chrome.js');
const { playChunks } = require('./helpers/session.js');
const { SENTENCES, createGatedFetch, liveSession, sessionState, chunkReady, endChunk } = require('./helpers/pause.js');
const { loadPopup, voicesBody, controlledVoices } = require('./helpers/popup.js');

const hanging = ({ signal }) => hangUntilAbort(signal);
const down = () => { throw new TypeError('Failed to fetch'); };

// Hand-written expectations (not derived from the code under test).
// Does the connection gate allow Play?
const CONNECTION_PLAYS = {
  idle: false, // before the first check
  checking: false,
  starting: false, // still checking after 3 s
  ok: true,
  noListNamed: true, // 404 with a voice name
  noListBlank: false, // 404 with no voice name
  noVoices: false, // 200, empty list
  failed: false // red
};
// Does the session gate allow Play, after this broadcast?
const SESSION_PLAYS = {
  none: true, // no broadcast yet: an idle session
  starting: false,
  loading: false,
  playing: false,
  ready: false, // a live session between fetch and audio
  paused: true,
  stopped: true
};

/** A popup in each connection state. `bg` is optional. */
async function popupIn(connection, { bg = null } = {}) {
  switch (connection) {
    case 'idle': {
      const popup = loadPopup({ bg, holdStorage: true });
      await settle();
      return popup;
    }
    case 'checking': {
      const popup = loadPopup({ bg, voicesFetch: hanging });
      await popup.ready;
      return popup;
    }
    case 'starting': {
      const popup = loadPopup({ bg, voicesFetch: hanging });
      await popup.ready;
      await popup.timers.tick(3000);
      return popup;
    }
    case 'ok': {
      const popup = loadPopup({ bg });
      await popup.ready;
      return popup;
    }
    case 'noListNamed': {
      const popup = loadPopup({ bg, voicesFetch: () => jsonResponse({}, 404), stored: { voice: 'Olivia.wav' } });
      await popup.ready;
      return popup;
    }
    case 'noListBlank': {
      const popup = loadPopup({ bg, voicesFetch: () => jsonResponse({}, 404) });
      await popup.ready;
      return popup;
    }
    case 'noVoices': {
      const popup = loadPopup({ bg, voicesFetch: () => voicesBody([]), stored: { voice: 'Olivia.wav' } });
      await popup.ready;
      return popup;
    }
    case 'failed': {
      const popup = loadPopup({ bg, voicesFetch: down });
      await popup.ready;
      return popup;
    }
    default:
      throw new Error(`unknown connection ${connection}`);
  }
}

const SESSION_ID = 'abcdef';
const broadcast = (popup, state) =>
  popup.deliverMessage({ type: 'playerStateUpdate', state, sessionId: state === 'stopped' ? null : SESSION_ID });

function permutations(items) {
  if (items.length <= 1) return [items];
  return items.flatMap((item, i) => permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest]));
}

// --- G11, G12: the gate matrix ---------------------------------------------------------------------------

test('G11: connection state x session state: Play is enabled only when both gates allow it', async () => {
  for (const connection of Object.keys(CONNECTION_PLAYS)) {
    for (const session of Object.keys(SESSION_PLAYS)) {
      const popup = await popupIn(connection);
      if (session !== 'none') broadcast(popup, session);
      assert.equal(
        popup.getEl('playBtn').disabled,
        !(CONNECTION_PLAYS[connection] && SESSION_PLAYS[session]),
        `connection ${connection}, session ${session}`
      );
    }
  }
});

test('G12: broadcast order. In every order of playing, paused, ready and stopped, Play follows both gates after each broadcast', async () => {
  for (const connection of Object.keys(CONNECTION_PLAYS)) {
    for (const order of permutations(['playing', 'paused', 'ready', 'stopped'])) {
      const popup = await popupIn(connection);
      for (const state of order) {
        broadcast(popup, state);
        assert.equal(
          popup.getEl('playBtn').disabled,
          !(CONNECTION_PLAYS[connection] && SESSION_PLAYS[state]),
          `${connection}: after ${order.slice(0, order.indexOf(state) + 1).join(' -> ')}`
        );
      }
    }
  }
});

test('G12: a stopped or ready broadcast while red, grey, amber-empty or a blank name keeps Play disabled', async () => {
  for (const connection of ['failed', 'checking', 'starting', 'idle', 'noVoices', 'noListBlank']) {
    const popup = await popupIn(connection);
    for (const state of ['stopped', 'ready', 'paused', 'stopped']) {
      broadcast(popup, state);
      assert.equal(popup.getEl('playBtn').disabled, true, `${connection} after ${state}`);
    }
    // The same broadcasts with no sessionId (a Stop from another popup).
    popup.deliverMessage({ type: 'playerStateUpdate', state: 'stopped', sessionId: null });
    popup.deliverMessage({ type: 'streamError', error: 'boom' });
    assert.equal(popup.getEl('playBtn').disabled, true, `${connection} after a stream error`);
  }
});

test('G12: the gates combine whichever finishes last: a broadcast before, between and after a check', async () => {
  const controlled = controlledVoices();
  const popup = loadPopup({ voicesFetch: controlled.handler });
  await popup.ready;

  broadcast(popup, 'paused'); // session says yes, connection (checking) says no
  assert.equal(popup.getEl('playBtn').disabled, true);
  controlled.requests[0].answer(voicesBody());
  await settle();
  assert.equal(popup.getEl('playBtn').disabled, false, 'the check lands: both allow');

  broadcast(popup, 'playing');
  assert.equal(popup.getEl('playBtn').disabled, true, 'session closes it');
  await popup.getEl('connLight').click(); // a re-check during the session
  controlled.requests[1].answer(voicesBody());
  await settle();
  assert.equal(popup.getEl('playBtn').disabled, true, 'a green check never re-enables Play for a playing session');

  broadcast(popup, 'paused');
  assert.equal(popup.getEl('playBtn').disabled, false);
  await popup.getEl('connLight').click();
  controlled.requests[2].fail(new TypeError('Failed to fetch'));
  await settle();
  assert.equal(popup.getEl('connLight').className, 'conn-light connFailed');
  assert.equal(popup.getEl('playBtn').disabled, true, 'the check turned red while paused: Play closes');
  broadcast(popup, 'stopped');
  assert.equal(popup.getEl('playBtn').disabled, true, 'and the stopped broadcast does not reopen it');

  await popup.getEl('connLight').click();
  controlled.requests[3].answer(voicesBody());
  await settle();
  assert.equal(popup.getEl('playBtn').disabled, false, 'green again, session stopped');
});

test('E11/G11: emptying the Voice name closes the gate under every session state; retyping reopens it where the session allows', async () => {
  for (const session of ['none', 'stopped', 'paused', 'playing']) {
    const popup = await popupIn('noListNamed');
    if (session !== 'none') broadcast(popup, session);
    popup.getEl('voiceName').value = '';
    await popup.getEl('voiceName').fire('input');
    assert.equal(popup.getEl('playBtn').disabled, true, `${session}, emptied`);
    popup.getEl('voiceName').value = 'Olivia.wav';
    await popup.getEl('voiceName').fire('input');
    assert.equal(popup.getEl('playBtn').disabled, !SESSION_PLAYS[session], `${session}, retyped`);
  }
});

// --- A closed gate sends nothing ----------------------------------------------------------------------------

const PLAY_MESSAGES = ['startStreaming', 'controlAudio', 'play', 'pause', 'stopSession'];

test('Play click while the gate is closed sends no play message (the disabled attribute is not the only guard)', async () => {
  for (const connection of ['checking', 'starting', 'failed', 'noVoices', 'noListBlank']) {
    const bg = loadBackground({ sentences: SENTENCES, fetch: createGatedFetch(SENTENCES, { auto: true }) });
    const popup = await popupIn(connection, { bg });
    const before = popup.sentMessages.length;
    await popup.getEl('playBtn').click(); // the click gets through despite `disabled`
    await settle();
    assert.deepEqual(popup.sentMessages.slice(before), [], `${connection}: nothing at all is sent`);
    assert.deepEqual(popup.sentMessages.filter((m) => PLAY_MESSAGES.includes(m.type)), [], connection);
    assert.equal(bg.fetch.calls.length, 0, `${connection}: no speech request`);
    assert.equal(playChunks(bg).length, 0);
  }
});

test('a blank Voice name, emptied by the user, blocks a Play click too', async () => {
  const bg = loadBackground({ sentences: SENTENCES, fetch: createGatedFetch(SENTENCES, { auto: true }) });
  const popup = await popupIn('noListNamed', { bg });
  popup.getEl('voiceName').value = '   ';
  await popup.getEl('voiceName').fire('input');
  await popup.getEl('playBtn').click();
  await settle();
  assert.deepEqual(popup.sentMessages.filter((m) => PLAY_MESSAGES.includes(m.type)), []);
  assert.equal(bg.fetch.calls.length, 0);
});

test('Play click on a paused session while the connection is red does not resume it', async () => {
  const bg = loadBackground({ sentences: SENTENCES, fetch: createGatedFetch(SENTENCES, { auto: true }) });
  const popup = loadPopup({ bg, voicesFetch: ({ url }) => (url.includes(':9999') ? down() : voicesBody()) });
  await popup.ready;
  await popup.getEl('playBtn').click();
  await popup.deliverBroadcasts();
  await popup.getEl('pauseBtn').click();
  await popup.deliverBroadcasts();
  assert.equal(liveSession(bg).paused, true);

  popup.getEl('serverUrl').value = 'http://localhost:9999/v1/audio/speech';
  await popup.getEl('serverUrl').fire('input');
  await popup.timers.tick(500);
  await settle();
  assert.equal(popup.getEl('connLight').className, 'conn-light connFailed');
  assert.equal(popup.getEl('playBtn').disabled, true);

  const controlBefore = popup.sentOfType('controlAudio').length;
  await popup.getEl('playBtn').click();
  await settle();
  assert.equal(popup.sentOfType('controlAudio').length, controlBefore, 'no controlAudio play');
  assert.equal(liveSession(bg).paused, true, 'the session is untouched');
});

// --- G12: a check never touches the running session ----------------------------------------------------------

async function startedPopup() {
  const bg = loadBackground({ sentences: SENTENCES, fetch: createGatedFetch(SENTENCES, { auto: true }) });
  const controlled = controlledVoices();
  const popup = loadPopup({ bg, voicesFetch: controlled.handler, stored: { voice: 'Olivia.wav' } });
  await popup.ready;
  controlled.requests[0].answer(voicesBody());
  await settle();
  return { bg, popup, controlled };
}

test('G12: checks completing during an active session leave the session, its id and its messages untouched', async () => {
  const { bg, popup, controlled } = await startedPopup();
  await popup.getEl('playBtn').click();
  await popup.deliverBroadcasts();
  const chunk0 = playChunks(bg)[0];
  const sessionBefore = await sessionState(bg);
  const idBefore = liveSession(bg).sessionId;
  assert.equal(sessionBefore.active, true);
  assert.equal(popup.getEl('playBtn').disabled, true, 'a live unpaused session keeps Play disabled');
  const messagesBefore = popup.sentMessages.length;
  const sentBefore = bg.sent.length;

  const results = [
    () => voicesBody(),
    () => jsonResponse({}, 404),
    () => voicesBody([]),
    () => jsonResponse({}, 500),
    () => voicesBody(['Other.wav'])
  ];
  const lights = [];
  for (const [i, result] of results.entries()) {
    await popup.getEl('connLight').click();
    controlled.requests[i + 1].answer(result());
    await settle();
    lights.push(popup.getEl('connLight').className);
    assert.deepEqual(await sessionState(bg), sessionBefore, `after check ${i + 1}`);
    assert.equal(liveSession(bg).sessionId, idBefore);
    assert.equal(popup.getEl('playBtn').disabled, true, `Play stays disabled for the live session after check ${i + 1}`);
  }
  assert.deepEqual(lights, [
    'conn-light connOk', 'conn-light connNoList', 'conn-light connNoVoices', 'conn-light connFailed', 'conn-light connOk'
  ], 'the light does refresh during the read');

  const sentByPopup = popup.sentMessages.slice(messagesBefore).map((m) => m.type);
  assert.ok(!sentByPopup.some((type) => ['stopSession', 'controlAudio', 'startStreaming', 'play', 'pause', 'stop'].includes(type)), sentByPopup.join());
  assert.deepEqual(bg.sent.slice(sentBefore).filter((m) => m.type === 'stop' || m.type === 'playChunk'), [], 'the background sent no stop or new chunk');
  assert.equal(playChunks(bg).length, 1);
  assert.equal(playChunks(bg)[0], chunk0);
  assert.equal(liveSession(bg).stopped, false);
  assert.equal(liveSession(bg).paused, false);
});

test('G12: a URL or voice changed mid-read applies to the next read only; the running session keeps its own', async () => {
  const { bg, popup, controlled } = await startedPopup();
  await popup.getEl('playBtn').click();
  await popup.deliverBroadcasts();
  const chunk0 = playChunks(bg)[0];
  const first = bg.fetch.calls[0];
  assert.equal(first.url, 'http://localhost:8090/v1/audio/speech');
  assert.equal(first.body.voice, 'Olivia.wav');

  popup.getEl('voice').value = 'Thomas.wav';
  await popup.getEl('voice').fire('change');
  popup.getEl('serverUrl').value = 'http://localhost:9005/v1/audio/speech';
  await popup.getEl('serverUrl').fire('input');
  await popup.getEl('serverUrl').fire('change');
  await popup.timers.tick(500);
  controlled.requests[1].answer(voicesBody(['Thomas.wav', 'Olivia.wav']));
  await settle();
  assert.equal(popup.storageSets.at(-1).serverUrl, 'http://localhost:9005/v1/audio/speech', 'the stored URL changed');

  await chunkReady(bg, chunk0);
  await endChunk(bg, chunk0);
  assert.ok(bg.fetch.calls.length >= 2, 'the session fetched its next sentence');
  for (const call of bg.fetch.calls) {
    assert.equal(call.url, 'http://localhost:8090/v1/audio/speech', 'still the URL it started with');
    assert.equal(call.body.voice, 'Olivia.wav', 'still the voice it started with');
  }

  // The next read picks up the new URL and voice.
  await popup.getEl('stopBtn').click();
  await popup.deliverBroadcasts();
  await popup.getEl('playBtn').click();
  await settle();
  const last = bg.fetch.calls.at(-1);
  assert.equal(last.url, 'http://localhost:9005/v1/audio/speech');
  assert.equal(last.body.voice, 'Thomas.wav');
});

// --- E6: popup opened during an active read -------------------------------------------------------------------

test('E6: a popup opened during a live unpaused read refreshes the light and list, and keeps Play disabled', async () => {
  const bg = loadBackground({ sentences: SENTENCES, fetch: createGatedFetch(SENTENCES, { auto: true }) });
  const first = loadPopup({ bg });
  await first.ready;
  await first.getEl('playBtn').click();
  await first.deliverBroadcasts();
  const id = liveSession(bg).sessionId;

  const controlled = controlledVoices();
  const reopened = loadPopup({ bg, voicesFetch: controlled.handler });
  await reopened.ready;
  await settle();
  assert.equal(reopened.getEl('playBtn').disabled, true, 'while the check runs');
  controlled.requests[0].answer(voicesBody());
  await settle();
  assert.equal(reopened.getEl('connLight').className, 'conn-light connOk', 'the light refreshed');
  assert.equal(reopened.getEl('voiceGroup').hidden, false, 'and the list');
  assert.equal(reopened.getEl('playBtn').disabled, true, 'a live unpaused session keeps Play disabled');
  assert.equal(reopened.getEl('connLabel').hidden, true, 'the connection label steps aside during a session');
  assert.equal(liveSession(bg).sessionId, id);
  assert.equal(reopened.sentOfType('startStreaming').length, 0);
});

test('E6: a popup opened during a paused read shows Play once the check allows it, and Pause stays disabled', async () => {
  const bg = loadBackground({ sentences: SENTENCES, fetch: createGatedFetch(SENTENCES, { auto: true }) });
  const first = loadPopup({ bg });
  await first.ready;
  await first.getEl('playBtn').click();
  await first.deliverBroadcasts();
  await first.getEl('pauseBtn').click();
  await settle();

  const green = loadPopup({ bg });
  await green.ready;
  await settle();
  assert.deepEqual(green.buttons(), { play: false, pause: true, stop: false }, 'paused session, green light: Play is shown');

  const red = loadPopup({ bg, voicesFetch: down });
  await red.ready;
  await settle();
  assert.equal(red.getEl('connLight').className, 'conn-light connFailed');
  assert.equal(red.getEl('playBtn').disabled, true, 'the connection gate closes it even for a paused session');
  assert.equal(red.getEl('pauseBtn').disabled, true);
  assert.equal(liveSession(bg).paused, true, 'the paused session was not touched');
});
