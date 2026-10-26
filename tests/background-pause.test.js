'use strict';
/**
 * Pause, Play and Stop through the real background.js: messages in via
 * chrome.runtime.onMessage, broadcasts and tabs.sendMessage calls out. Fetches
 * resolve when the test says so and record signal.aborted; time is the manual
 * clock from helpers/fake-chrome.js.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { loadBackground, settle } = require('./helpers/fake-chrome.js');
const { playChunks } = require('./helpers/session.js');
const {
  ALARM, SENTENCES, liveSession, createGatedFetch, pressPlayNoWait, sessionState, playerState, control, chunkReady, endChunk
} = require('./helpers/pause.js');

/** Start a read with fast fetches and play it up to sentence `index` (0-based), which is left playing. */
async function readUpTo(bg, index) {
  await pressPlayNoWait(bg);
  await settle();
  for (let i = 0; i < index; i++) {
    const chunk = playChunks(bg)[i];
    await chunkReady(bg, chunk);
    await endChunk(bg, chunk);
  }
  assert.equal(playChunks(bg).length, index + 1, `sentence ${index} is playing`);
  return playChunks(bg)[index];
}

function setup({ auto = true, sentences = SENTENCES } = {}) {
  const fetch = createGatedFetch(sentences, { auto });
  const bg = loadBackground({ sentences, fetch });
  return { bg, fetch };
}

const count = (bg, type) => bg.sentOfType(type).length;
const highlights = (bg) => bg.tabMessages.filter((m) => m.message.type === 'ttsHighlightSentence');
const clears = (bg) => bg.tabMessages.filter((m) => m.message.type === 'ttsClearHighlight');

// --- GP3 -------------------------------------------------------------------------------------

test('GP3: Pause at sentence 5 sets paused, clears the stall timer, tells the offscreen document and sets state paused itself', async () => {
  const { bg } = setup();
  const chunk = await readUpTo(bg, 4);
  assert.equal(chunk.index, 4);
  assert.equal(bg.timers.pending, 1, 'the stall timer for sentence 5 is running');
  assert.equal(await playerState(bg), 'loading');

  await control(bg, 'pause', chunk.sessionId);
  await settle();

  assert.equal(liveSession(bg).paused, true);
  assert.equal(liveSession(bg).stallTimer, null);
  assert.equal(bg.timers.pending, 0, 'no timer of any kind is left running');
  assert.deepEqual(bg.sentOfType('pause'), [{ type: 'pause', sessionId: chunk.sessionId }]);
  assert.equal(await playerState(bg), 'paused');
  const states = bg.sentOfType('playerStateUpdate');
  assert.deepEqual({ state: states.at(-1).state, sessionId: states.at(-1).sessionId }, { state: 'paused', sessionId: chunk.sessionId });
});

test('GP3: while paused for 3 minutes nothing starts: no playChunk, no fetch, no message at all; the keepalive alarm keeps running', async () => {
  const { bg, fetch } = setup();
  const chunk = await readUpTo(bg, 4);
  await control(bg, 'pause', chunk.sessionId);
  await settle();

  const sentBefore = bg.sent.length;
  const fetchesBefore = fetch.calls.length;
  const highlightsBefore = highlights(bg).length;
  assert.ok(bg.alarms.has(ALARM), 'the keepalive alarm exists while paused');

  for (let minute = 0; minute < 3; minute++) {
    await bg.timers.tick(60000);
    bg.listeners.alarm[0]({ name: ALARM }); // the alarm keeps firing and keeps the worker warm
    await settle();
  }

  assert.equal(playChunks(bg).length, 5, 'no further playChunk');
  assert.equal(fetch.calls.length, fetchesBefore, 'no further fetch');
  assert.equal(bg.sent.length, sentBefore, 'nothing was broadcast');
  assert.equal(highlights(bg).length, highlightsBefore, 'the highlight did not move');
  assert.equal(liveSession(bg).currentIndex, 4);
  assert.ok(bg.alarms.has(ALARM), 'still running; cleared only on Stop or completion');
  assert.equal(liveSession(bg).stopped, false);
});

test('GP3: reopening the popup while paused: getSessionState returns { active, sessionId, paused, index, total }', async () => {
  const { bg } = setup();
  const chunk = await readUpTo(bg, 4);
  assert.deepEqual(await sessionState(bg), { active: true, sessionId: chunk.sessionId, paused: false, index: 4, total: 6 });

  await control(bg, 'pause', chunk.sessionId);
  await settle();
  await bg.timers.tick(180000);

  assert.deepEqual(await sessionState(bg), { active: true, sessionId: chunk.sessionId, paused: true, index: 4, total: 6 });
  assert.equal(await playerState(bg), 'paused', 'the popup\'s getPlayerState read says paused too');
});

test('getSessionState with no session says inactive', async () => {
  const { bg } = setup();
  assert.deepEqual(await sessionState(bg), { active: false, sessionId: null, paused: false, index: 0, total: 0 });
});

test('Play on a paused session resumes the same session: same id and index, no new fetch, the stall timer re-armed for that sentence', async () => {
  const { bg, fetch } = setup();
  const chunk = await readUpTo(bg, 4);
  await chunkReady(bg, chunk, 5); // duration known: the timeout is 5 s + 5 s
  await control(bg, 'pause', chunk.sessionId);
  await settle();
  const fetchesBefore = fetch.calls.length;
  const scriptingBefore = bg.scriptingCalls.length;

  await bg.timers.tick(120000);
  await control(bg, 'play', chunk.sessionId);
  await settle();

  assert.deepEqual(bg.sentOfType('play'), [{ type: 'play', sessionId: chunk.sessionId }]);
  assert.equal(liveSession(bg).paused, false);
  assert.equal(liveSession(bg).sessionId, chunk.sessionId);
  assert.equal(liveSession(bg).currentIndex, 4);
  assert.equal(fetch.calls.length, fetchesBefore, 'no fetch for the current sentence');
  assert.equal(playChunks(bg).length, 5, 'the audio element carries on; no second playChunk');
  assert.equal(await playerState(bg), 'playing');
  assert.equal(bg.scriptingCalls.length, scriptingBefore, 'no new session: the page was not asked for sentences again');

  assert.equal(bg.timers.pending, 1, 'the stall timer is running again');
  await bg.timers.tick(9999);
  assert.equal(playChunks(bg).length, 5, 'not yet: duration + 5 s');
  await bg.timers.tick(1);
  assert.equal(playChunks(bg).length, 6, 'the re-armed timer advanced past sentence 5 when it never ended');
  assert.equal(playChunks(bg)[5].index, 5);
});

test('Stop after Pause clears paused, tears the audio down with a stop broadcast and a new Play is a new session', async () => {
  const { bg } = setup();
  const chunk = await readUpTo(bg, 2);
  await control(bg, 'pause', chunk.sessionId);
  await settle();

  await control(bg, 'stop', chunk.sessionId);
  await settle();

  assert.deepEqual(bg.sentOfType('stop'), [{ type: 'stop', sessionId: chunk.sessionId }]);
  assert.equal(liveSession(bg).paused, false);
  assert.equal(liveSession(bg).stopped, true);
  assert.equal(await playerState(bg), 'stopped');
  assert.deepEqual(await sessionState(bg), { active: false, sessionId: null, paused: false, index: 0, total: 0 });
  assert.ok(!bg.alarms.has(ALARM), 'the keepalive alarm is cleared on Stop');

  await pressPlayNoWait(bg);
  await settle();
  const fresh = playChunks(bg).at(-1);
  assert.notEqual(fresh.sessionId, chunk.sessionId);
  assert.equal(fresh.index, 0);
});

// --- E2 ----------------------------------------------------------------------------------------

test('E2: paused for 60 s, then 180 s: zero side effects while the stall timer would have fired', async () => {
  const { bg, fetch } = setup();
  const chunk = await readUpTo(bg, 1); // sentence 2, no duration reported: the 60 s hang timeout
  await control(bg, 'pause', chunk.sessionId);
  await settle();
  const sentBefore = bg.sent.length;
  const tabBefore = bg.tabMessages.length;
  const fetchesBefore = fetch.calls.length;

  await bg.timers.tick(60000);
  assert.equal(bg.sent.length, sentBefore);
  await bg.timers.tick(180000);

  assert.equal(bg.sent.length, sentBefore, 'no runtime message');
  assert.equal(bg.tabMessages.length, tabBefore, 'no tab message');
  assert.equal(fetch.calls.length, fetchesBefore);
  assert.equal(bg.timers.pending, 0);
  assert.equal(playChunks(bg).length, 2);
  assert.equal(bg.sentOfType('session-end').length, 0);
  const log = (await bg.send({ type: 'getDebugLog' }, { wait: true })).log;
  assert.equal(log.events.filter((e) => e.type === 'stall').length, 0, 'the stall timer never fired');
});

test('E2: a duration report that arrives while paused does not start a timer', async () => {
  const { bg } = setup();
  const chunk = await readUpTo(bg, 1);
  await control(bg, 'pause', chunk.sessionId);
  await bg.send({ type: 'audioDuration', sessionId: chunk.sessionId, index: chunk.index, playNumber: chunk.playNumber, duration: 3 });
  assert.equal(bg.timers.pending, 0);
  await bg.timers.tick(600000);
  assert.equal(playChunks(bg).length, 2);
  // ...but it is remembered, so Play re-arms with duration + 5 s rather than 60 s.
  await control(bg, 'play', chunk.sessionId);
  await settle();
  await bg.timers.tick(8000);
  assert.equal(playChunks(bg).length, 3);
});

// --- E3 ---------------------------------------------------------------------------------------

test('E3: Pause then Stop clears the highlight on the session tab and frame; the popup shows stopped; the next Play is a new session', async () => {
  const { bg } = setup({ sentences: SENTENCES });
  const onClicked = bg.listeners.menuClicked[0];
  onClicked({ menuItemId: 'readAloud', frameId: 3 }, { id: 7 });
  await settle();
  const chunk = playChunks(bg)[0];
  await control(bg, 'pause', chunk.sessionId);
  await settle();
  assert.equal(clears(bg).length, 0, 'Pause alone leaves the highlight');

  await control(bg, 'stop', chunk.sessionId);
  await settle();

  assert.equal(clears(bg).length, 1);
  assert.equal(clears(bg)[0].tabId, 7);
  assert.equal(clears(bg)[0].options.frameId, 3);
  assert.equal(bg.sentOfType('playerStateUpdate').at(-1).state, 'stopped');
  assert.equal(await playerState(bg), 'stopped');

  await pressPlayNoWait(bg);
  await settle();
  assert.notEqual(playChunks(bg).at(-1).sessionId, chunk.sessionId);
});

test('E3: Stop from Escape in the overlay (stopSession, no id) after a Pause does the same', async () => {
  const { bg } = setup();
  const chunk = await readUpTo(bg, 1);
  await control(bg, 'pause', chunk.sessionId);
  await settle();

  await bg.send({ type: 'stopSession' }, { wait: true });
  await settle();

  assert.equal(clears(bg).length, 1);
  assert.deepEqual(bg.sentOfType('stop'), [{ type: 'stop', sessionId: chunk.sessionId }]);
  assert.equal(liveSession(bg).paused, false);
  assert.equal(await playerState(bg), 'stopped');
  assert.equal((await sessionState(bg)).active, false);
});

// --- E5 -----------------------------------------------------------------------------------------

test('E5: Pause during cold start: the fetch is not aborted, its bytes are held, nothing plays until Play, which sends the held chunk with no second fetch', async () => {
  const { bg, fetch } = setup({ auto: false });
  await pressPlayNoWait(bg);
  await settle();
  assert.equal(fetch.entries.length, 1);
  assert.equal(await playerState(bg), 'starting');
  const { sessionId } = await sessionState(bg);

  await control(bg, 'pause', sessionId);
  await settle();
  assert.equal(await playerState(bg), 'paused');
  assert.equal(fetch.entries[0].signal.aborted, false, 'the in-flight fetch is not aborted');

  fetch.entries[0].respond();
  await settle();
  assert.equal(playChunks(bg).length, 0, 'no playChunk while paused');
  assert.equal(liveSession(bg).heldChunk.index, 0, 'the bytes are kept');
  assert.equal(await playerState(bg), 'paused', 'the late response did not flip the state');
  await bg.timers.tick(180000);
  assert.equal(playChunks(bg).length, 0);
  assert.equal(fetch.forIndex(0).length, 1);

  await control(bg, 'play', sessionId);
  await settle();
  assert.deepEqual(playChunks(bg).map((c) => [c.sessionId, c.index, c.playNumber]), [[sessionId, 0, 1]]);
  assert.equal(liveSession(bg).heldChunk, null);
  assert.equal(fetch.forIndex(0).length, 1, 'index 0 was fetched exactly once');
  assert.deepEqual(fetch.entries.map((e) => e.index), [0, 1], 'only the usual prefetch of index 1 followed');
  assert.equal(await playerState(bg), 'starting', 'until the offscreen document reports ready');
});

test('E5: Play before the cold-start response arrives resumes the wait; the sentence then plays once, in the same session', async () => {
  const { bg, fetch } = setup({ auto: false });
  await pressPlayNoWait(bg);
  await settle();
  const { sessionId } = await sessionState(bg);

  await control(bg, 'pause', sessionId);
  await control(bg, 'play', sessionId);
  await settle();
  assert.equal(playChunks(bg).length, 0, 'still waiting for the server');
  assert.equal(await playerState(bg), 'starting');

  fetch.entries[0].respond();
  await settle();
  assert.deepEqual(playChunks(bg).map((c) => [c.sessionId, c.index]), [[sessionId, 0]]);
  assert.equal(fetch.forIndex(0).length, 1);
});

test('E5: Pause while the next sentence loads: the fetch finishes and is kept; Play sends it and continues the same session', async () => {
  const { bg, fetch } = setup({ auto: false });
  await pressPlayNoWait(bg);
  await settle();
  fetch.entries[0].respond();
  await settle();
  const first = playChunks(bg)[0];
  assert.equal(fetch.forIndex(1).length, 1, 'the prefetch of sentence 2 is in flight');

  await endChunk(bg, first); // sentence 1 ends; sentence 2 is awaited
  assert.equal(await playerState(bg), 'loading');
  await control(bg, 'pause', first.sessionId);
  await settle();
  assert.equal(fetch.forIndex(1)[0].signal.aborted, false);

  fetch.forIndex(1)[0].respond();
  await settle();
  assert.equal(playChunks(bg).length, 1, 'nothing plays while paused');
  assert.equal(liveSession(bg).heldChunk.index, 1);
  await bg.timers.tick(120000);
  assert.equal(playChunks(bg).length, 1);

  await control(bg, 'play', first.sessionId);
  await settle();
  assert.deepEqual(playChunks(bg).map((c) => [c.sessionId, c.index]), [[first.sessionId, 0], [first.sessionId, 1]]);
  assert.equal(fetch.forIndex(1).length, 1, 'sentence 2 was fetched once');
});

test('E5: Pause while the prefetch for index+1 is in flight: it finishes and is kept, and the later advance consumes it without a refetch', async () => {
  const { bg, fetch } = setup({ auto: false });
  await pressPlayNoWait(bg);
  await settle();
  fetch.entries[0].respond();
  await settle();
  const first = playChunks(bg)[0];
  const prefetch = fetch.forIndex(1)[0];
  assert.equal(prefetch.settled, false);

  await control(bg, 'pause', first.sessionId);
  await settle();
  assert.equal(prefetch.signal.aborted, false, 'Pause does not abort the prefetch');
  prefetch.respond();
  await settle();
  assert.equal(playChunks(bg).length, 1, 'finishing the prefetch does not play it');

  await control(bg, 'play', first.sessionId);
  await settle();
  await endChunk(bg, first);
  assert.deepEqual(playChunks(bg).map((c) => c.index), [0, 1]);
  assert.equal(fetch.forIndex(1).length, 1, 'consumed, not refetched');
});

// --- E6 -----------------------------------------------------------------------------------------

test('E6: chunkEnded after the pause was recorded: no advance, advanceOnResume is set, and Play plays index+1 once', async () => {
  const { bg, fetch } = setup();
  const chunk = await readUpTo(bg, 1);
  await control(bg, 'pause', chunk.sessionId);
  await settle();
  const fetchesBefore = fetch.calls.length;

  await endChunk(bg, chunk);
  assert.equal(playChunks(bg).length, 2, 'no advance while paused');
  assert.equal(liveSession(bg).advanceOnResume, true);
  assert.equal(await playerState(bg), 'paused');
  await endChunk(bg, chunk); // a duplicate changes nothing
  await bg.timers.tick(180000);
  assert.equal(playChunks(bg).length, 2);
  assert.equal(fetch.calls.length, fetchesBefore);

  await control(bg, 'play', chunk.sessionId);
  await settle();
  assert.deepEqual(playChunks(bg).map((c) => c.index), [0, 1, 2]);
  assert.equal(playChunks(bg)[2].playNumber, 1);
  assert.equal(liveSession(bg).advanceOnResume, false);
  assert.equal(fetch.forIndex(2).length, 1, 'the prefetched sentence was used, not refetched');

  await control(bg, 'play', chunk.sessionId); // Play twice: nothing more
  await settle();
  assert.deepEqual(playChunks(bg).map((c) => c.index), [0, 1, 2]);
});

test('E6: chunkEnded handled just before the pause: the next sentence is held as in E5 and Play continues from it, with no skip or double', async () => {
  const { bg, fetch } = setup({ auto: false });
  await pressPlayNoWait(bg);
  await settle();
  fetch.entries[0].respond();
  await settle();
  const first = playChunks(bg)[0];

  await endChunk(bg, first); // advance started: sentence 2's fetch is awaited
  await control(bg, 'pause', first.sessionId); // ...and the pause arrives right after
  await settle();
  fetch.forIndex(1)[0].respond();
  await settle();
  assert.equal(playChunks(bg).length, 1, 'held, not played');
  assert.equal(liveSession(bg).heldChunk.index, 1);
  assert.equal(liveSession(bg).advanceOnResume, false);

  await control(bg, 'play', first.sessionId);
  await settle();
  const second = playChunks(bg)[1];
  assert.equal(second.index, 1);
  fetch.forIndex(2)[0].respond();
  await endChunk(bg, second);
  await settle();
  assert.deepEqual(playChunks(bg).map((c) => [c.index, c.playNumber]), [[0, 1], [1, 1], [2, 1]], 'no skipped or doubled sentence');
  assert.equal(fetch.forIndex(1).length, 1);
});

test('E6: Pause, chunkEnded of the last sentence, Play finishes the session instead of replaying it', async () => {
  const { bg } = setup({ sentences: SENTENCES.slice(0, 2) });
  const first = await readUpTo(bg, 0);
  await endChunk(bg, first);
  const last = playChunks(bg)[1];
  await control(bg, 'pause', last.sessionId);
  await endChunk(bg, last);
  assert.equal((await sessionState(bg)).active, true);

  await control(bg, 'play', last.sessionId);
  await settle();
  assert.equal(playChunks(bg).length, 2);
  assert.equal((await sessionState(bg)).active, false);
  assert.equal(await playerState(bg), 'stopped');
});

// --- Added ----------------------------------------------------------------------------------------

test('Added: a late offscreen "playing" report while paused does not flip the state to playing', async () => {
  const { bg } = setup();
  const chunk = await readUpTo(bg, 1);
  await control(bg, 'pause', chunk.sessionId);
  await settle();
  const updatesBefore = count(bg, 'playerStateUpdate');

  await bg.send({ type: 'stateUpdate', state: 'playing', sessionId: chunk.sessionId });
  await settle();

  assert.equal(await playerState(bg), 'paused');
  assert.equal(count(bg, 'playerStateUpdate'), updatesBefore, 'no state was broadcast');
  assert.equal((await sessionState(bg)).paused, true);
});

test('Added: the offscreen "playing" report of an unpaused session still sets playing', async () => {
  const { bg } = setup();
  const chunk = await readUpTo(bg, 1);
  await bg.send({ type: 'stateUpdate', state: 'playing', sessionId: chunk.sessionId });
  assert.equal(await playerState(bg), 'playing');
});

test('Added: the offscreen document is unreachable at Pause: paused is still recorded, the failure is swallowed, and Play starts nothing on its own', async () => {
  const { bg, fetch } = setup();
  const chunk = await readUpTo(bg, 1);
  bg.closeOffscreen();
  bg.rejectMessages((m) => m.type === 'pause' || m.type === 'play');
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    await control(bg, 'pause', chunk.sessionId);
    await settle();
    assert.equal(liveSession(bg).paused, true, 'paused is recorded although the pause message failed');
    assert.equal(await playerState(bg), 'paused');
    assert.equal(count(bg, 'pause'), 1, 'the pause message was attempted');
    assert.equal(bg.timers.pending, 0);

    const createdBefore = bg.createdOffscreen.length;
    const fetchesBefore = fetch.calls.length;
    await control(bg, 'play', chunk.sessionId);
    await settle();
    assert.equal(count(bg, 'play'), 1);
    assert.equal(playChunks(bg).length, 2, 'Play did not start a sentence');
    assert.equal(bg.createdOffscreen.length, createdBefore, 'Play did not recreate the offscreen document (that is PR-4)');
    assert.equal(fetch.calls.length, fetchesBefore);
    await settle();
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
  assert.deepEqual(unhandled, []);
});

test('Added: a held chunk is dropped by Stop, so a later session never plays it', async () => {
  const { bg, fetch } = setup({ auto: false });
  await pressPlayNoWait(bg);
  await settle();
  const { sessionId } = await sessionState(bg);
  await control(bg, 'pause', sessionId);
  fetch.entries[0].respond();
  await settle();
  const s = liveSession(bg);
  assert.ok(s.heldChunk);

  await control(bg, 'stop', sessionId);
  await settle();
  assert.equal(s.heldChunk, null);
  assert.equal(playChunks(bg).length, 0);
});

test('Added: Stop aborts the fetches that are in flight (a held chunk is only kept on Pause)', async () => {
  const { bg, fetch } = setup({ auto: false });
  await pressPlayNoWait(bg);
  await settle();
  const { sessionId } = await sessionState(bg);
  await control(bg, 'pause', sessionId);
  await settle();
  assert.equal(fetch.entries[0].signal.aborted, false);

  await control(bg, 'stop', sessionId);
  await settle();
  assert.equal(fetch.entries[0].signal.aborted, true);
  assert.equal(playChunks(bg).length, 0);
});
