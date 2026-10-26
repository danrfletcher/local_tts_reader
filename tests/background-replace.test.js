'use strict';
/**
 * E4 (a Pause followed by a replacement session) and the Pause/Play/Stop
 * no-op cases, through the real background.js (and, for the offscreen side of
 * E4, the real offscreen.js).
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { loadBackground, settle } = require('./helpers/fake-chrome.js');
const { playChunks } = require('./helpers/session.js');
const { loadOffscreen } = require('./helpers/offscreen.js');
const {
  SENTENCES, liveSession, createGatedFetch, pressPlayNoWait, sessionState, playerState, control, chunkReady, endChunk
} = require('./helpers/pause.js');

function setup() {
  const fetch = createGatedFetch(SENTENCES, { auto: true });
  return { bg: loadBackground({ sentences: SENTENCES, fetch }), fetch };
}

const count = (bg, type) => bg.sentOfType(type).length;

/** Read to sentence 2 (index 1) and Pause. Returns the paused session's current chunk. */
async function pausedAtSecond(bg) {
  await pressPlayNoWait(bg);
  await settle();
  const first = playChunks(bg)[0];
  await chunkReady(bg, first);
  await endChunk(bg, first);
  const second = playChunks(bg)[1];
  await control(bg, 'pause', second.sessionId);
  await settle();
  return second;
}

// --- E4 -------------------------------------------------------------------------------------------

test('E4: right-click Read Aloud while paused replaces the session; the old audio is torn down by a stop naming it and never resumes', async () => {
  const { bg } = setup();
  const old = await pausedAtSecond(bg);
  assert.equal(count(bg, 'stop'), 0);

  bg.listeners.menuClicked[0]({ menuItemId: 'readAloud', frameId: 0 }, { id: 7 });
  await settle();

  const stops = bg.sentOfType('stop');
  assert.deepEqual(stops, [{ type: 'stop', sessionId: old.sessionId }]);
  const fresh = playChunks(bg).at(-1);
  assert.notEqual(fresh.sessionId, old.sessionId);
  assert.equal(fresh.index, 0);
  const types = bg.sent.map((m) => m.type);
  assert.ok(types.indexOf('stop') < types.lastIndexOf('playChunk'), 'the old audio was stopped before the new session played');
  assert.equal(liveSession(bg).sessionId, fresh.sessionId);
  assert.equal(liveSession(bg).paused, false, 'the new session is not paused');
  assert.deepEqual(await sessionState(bg), { active: true, sessionId: fresh.sessionId, paused: false, index: 0, total: 6 });

  await bg.timers.tick(180000);
  assert.equal(playChunks(bg).filter((c) => c.sessionId === old.sessionId).length, 2, 'the old session sent nothing more');
});

test('E4: a late Play, Pause or Stop carrying the old session id is ignored by the background and does not touch the new session', async () => {
  const { bg } = setup();
  const old = await pausedAtSecond(bg);
  bg.listeners.menuClicked[0]({ menuItemId: 'readAloud', frameId: 0 }, { id: 7 });
  await settle();
  const fresh = playChunks(bg).at(-1);
  const sentBefore = bg.sent.length;
  const chunksBefore = playChunks(bg).length;

  await control(bg, 'play', old.sessionId);
  await control(bg, 'pause', old.sessionId);
  await control(bg, 'stop', old.sessionId);
  await settle();

  assert.equal(bg.sent.length, sentBefore, 'no message of any kind was sent');
  assert.equal(playChunks(bg).length, chunksBefore);
  assert.equal(liveSession(bg).sessionId, fresh.sessionId);
  assert.equal(liveSession(bg).stopped, false);
  assert.equal(liveSession(bg).paused, false);
});

test('E4: a late chunkEnded for the old session does not advance the new one', async () => {
  const { bg } = setup();
  const old = await pausedAtSecond(bg);
  bg.listeners.menuClicked[0]({ menuItemId: 'readAloud', frameId: 0 }, { id: 7 });
  await settle();
  const chunksBefore = playChunks(bg).length;

  await endChunk(bg, old);

  assert.equal(playChunks(bg).length, chunksBefore);
  assert.equal(liveSession(bg).currentIndex, 0);
});

test('E4: a late offscreen stateUpdate (stopped, playing) from the replaced session does not overwrite the new session\'s player state', async () => {
  const { bg } = setup();
  const old = await pausedAtSecond(bg);
  bg.listeners.menuClicked[0]({ menuItemId: 'readAloud', frameId: 0 }, { id: 7 });
  await settle();
  const fresh = playChunks(bg).at(-1);
  await chunkReady(bg, fresh);
  await bg.send({ type: 'stateUpdate', state: 'playing', sessionId: fresh.sessionId });
  assert.equal(await playerState(bg), 'playing');
  const updatesBefore = count(bg, 'playerStateUpdate');

  await bg.send({ type: 'stateUpdate', state: 'stopped', sessionId: old.sessionId });
  assert.equal(await playerState(bg), 'playing', 'a late "stopped" was dropped');
  await bg.send({ type: 'stateUpdate', state: 'playing', sessionId: old.sessionId });
  await bg.send({ type: 'stateUpdate', state: 'paused', sessionId: old.sessionId });
  await bg.send({ type: 'stateUpdate', state: 'stopped' }); // no id at all
  assert.equal(await playerState(bg), 'playing');
  assert.equal(count(bg, 'playerStateUpdate'), updatesBefore, 'nothing was broadcast for them');
});

test('E4 (offscreen side): after the replacement, a late play or playChunk carrying the old session id never reaches the audio element', () => {
  const page = loadOffscreen();
  const A = 'aaaaaa';
  const B = 'bbbbbb';
  const PLAY = (sessionId, index, playNumber) => ({ type: 'playChunk', audioData: [1, 2], mimeType: 'audio/wav', index, sessionId, playNumber });
  page.deliver(PLAY(A, 1, 1));
  page.deliver({ type: 'pause', sessionId: A }); // the session is paused
  page.deliver({ type: 'stop', sessionId: A }); // replaced: torn down explicitly
  assert.deepEqual(page.audio.removedAttributes, ['src']);
  page.deliver(PLAY(B, 0, 1));
  const playsBefore = page.audio.plays.length;

  page.deliver({ type: 'play', sessionId: A });
  page.deliver(PLAY(A, 2, 1));
  page.deliver(PLAY(A, 1, 2));

  assert.equal(page.audio.plays.length, playsBefore, 'nothing from session A played again');
  assert.equal(page.audio.src, 'blob:fake-2', 'B is still on the element');
});

// --- No-ops ------------------------------------------------------------------------------------------

test('Pause, Play and Stop with no active session are no-ops: no new session, no throw, nothing sent', async () => {
  const { bg, fetch } = setup();
  for (const action of ['pause', 'play', 'stop']) {
    await control(bg, action, 'abcdef');
    await control(bg, action, undefined);
  }
  await settle();
  assert.deepEqual(bg.sent.filter((m) => m.type === 'pause' || m.type === 'play' || m.type === 'playChunk'), []);
  assert.equal(bg.scriptingCalls.length, 0, 'no session was started');
  assert.equal(fetch.calls.length, 0);
  assert.equal(liveSession(bg), null);
  assert.equal(await playerState(bg), 'stopped');
});

test('Pause twice sends one pause; Play twice sends one play', async () => {
  const { bg } = setup();
  const second = await pausedAtSecond(bg);
  await control(bg, 'pause', second.sessionId);
  await settle();
  assert.equal(count(bg, 'pause'), 1, 'the second Pause did nothing');
  assert.equal(liveSession(bg).paused, true);

  await control(bg, 'play', second.sessionId);
  await control(bg, 'play', second.sessionId);
  await settle();
  assert.equal(count(bg, 'play'), 1, 'the second Play did nothing');
  assert.equal(liveSession(bg).paused, false);
  assert.equal(playChunks(bg).length, 2);
  assert.equal(bg.scriptingCalls.length, 3, 'no new session (inject, prepare and frame probe for the first only)');
});

test('Play on a session that is not paused is a no-op', async () => {
  const { bg } = setup();
  await pressPlayNoWait(bg);
  await settle();
  const first = playChunks(bg)[0];
  await control(bg, 'play', first.sessionId);
  await settle();
  assert.equal(count(bg, 'play'), 0);
  assert.equal(playChunks(bg).length, 1);
});

test('Pause, Play and Stop naming a session that is not the current one are no-ops', async () => {
  const { bg } = setup();
  const second = await pausedAtSecond(bg);
  const sentBefore = bg.sent.length;

  for (const action of ['pause', 'play', 'stop']) await control(bg, action, 'zzzzzz');
  await settle();

  assert.equal(bg.sent.length, sentBefore);
  assert.equal(liveSession(bg).sessionId, second.sessionId);
  assert.equal(liveSession(bg).paused, true, 'still paused: the wrong-id Play did not resume');
  assert.equal(liveSession(bg).stopped, false, 'and the wrong-id Stop did not stop');
});

test('Pause and Play with no session id are no-ops (only Stop may omit it)', async () => {
  const { bg } = setup();
  await pressPlayNoWait(bg);
  await settle();
  const first = playChunks(bg)[0];
  await control(bg, 'pause', undefined);
  await settle();
  assert.equal(liveSession(bg).paused, false);
  await control(bg, 'pause', first.sessionId);
  await control(bg, 'play', undefined);
  await settle();
  assert.equal(liveSession(bg).paused, true);
});

test('after Stop, Pause and Play naming the stopped session are no-ops: no new session starts', async () => {
  const { bg, fetch } = setup();
  const second = await pausedAtSecond(bg);
  await control(bg, 'stop', second.sessionId);
  await settle();
  const sentBefore = bg.sent.length;
  const fetchesBefore = fetch.calls.length;
  const scriptingBefore = bg.scriptingCalls.length;

  await control(bg, 'play', second.sessionId);
  await control(bg, 'pause', second.sessionId);
  await control(bg, 'stop', second.sessionId);
  await settle();

  assert.equal(bg.sent.length, sentBefore);
  assert.equal(fetch.calls.length, fetchesBefore);
  assert.equal(bg.scriptingCalls.length, scriptingBefore);
  assert.equal(await playerState(bg), 'stopped');
});
