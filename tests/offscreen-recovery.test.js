'use strict';
/**
 * E11 and E1: the audio (offscreen) document is closed by Chrome during a
 * pause or during playback, and Play brings it back. Drives the real
 * background.js through a fake chrome (getContexts, offscreen.createDocument,
 * runtime.sendMessage, storage.session, alarms, tabs) and a recording fetch,
 * and asserts the exact message sequence and the fetch count.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { settle } = require('./helpers/fake-chrome.js');
const { playChunks } = require('./helpers/session.js');
const { control, chunkReady, endChunk, sessionState, playerState, ALARM } = require('./helpers/pause.js');
const {
  THREE, TEN, AUDIO_1KB, createRecordingFetch, setupResume, readUpTo, readAndPause, restartWorker, finishRead, logEvents, liveSession
} = require('./helpers/resume.js');

const MESSAGE_TYPES = ['playChunk', 'play', 'pause', 'stop', 'sentenceProgress'];
/** The playback messages sent so far, as compact "type index/playNumber" strings. */
function sequence(bg) {
  return bg.sent
    .filter((m) => MESSAGE_TYPES.includes(m.type))
    .map((m) => (m.index === undefined ? m.type : `${m.type} ${m.index}/${m.playNumber}`));
}

// --- E1: Pause for 2+ minutes, then Play ---------------------------------------------------------------

test('E1: Pause for 2 minutes with the document closed: Play sends the sentence again from its start as the next play number', async () => {
  const { bg, fetch } = setupResume();
  const chunk = await readAndPause(bg, 1);
  const fetchesBefore = fetch.calls.length;
  assert.deepEqual(sequence(bg), ['playChunk 0/1', 'sentenceProgress 0/1', 'playChunk 1/1', 'sentenceProgress 1/1', 'pause']);

  bg.closeOffscreen(); // Chrome closes it 30 s after the audio stopped
  await bg.timers.tick(120000);
  assert.equal(playChunks(bg).length, 2, 'nothing started by itself during the 2 minutes');

  await control(bg, 'play', chunk.sessionId);
  await settle();

  assert.equal(bg.createdOffscreen.length, 2, 'the document was recreated');
  assert.equal(bg.createdOffscreen[1].reasons[0], 'AUDIO_PLAYBACK');
  assert.deepEqual(sequence(bg).slice(5), ['playChunk 1/2', 'sentenceProgress 1/2']);
  assert.equal(bg.sentOfType('play').length, 0, 'a `play` message to a closed document would reach nobody');
  assert.equal(fetch.calls.length, fetchesBefore, 'no re-fetch');
  assert.deepEqual(playChunks(bg)[2].audioData, playChunks(bg)[1].audioData, 'the same bytes');
  assert.equal(playChunks(bg)[2].audioData.length, 1024);
  assert.equal(await playerState(bg), 'loading');
  assert.equal((await sessionState(bg)).paused, false);
});

test('E1: Pause for 2 minutes with the element still alive: Play only sends `play`; same play number, no fetch, no new play event', async () => {
  const { bg, fetch } = setupResume();
  const chunk = await readAndPause(bg, 1);
  const fetchesBefore = fetch.calls.length;
  const createdBefore = bg.createdOffscreen.length;
  const playEventsBefore = (await logEvents(bg, 'play')).length;
  const sentBefore = bg.sent.length;

  await bg.timers.tick(120000);
  await control(bg, 'play', chunk.sessionId);
  await settle();

  assert.deepEqual(bg.sent.slice(sentBefore).filter((m) => MESSAGE_TYPES.includes(m.type)), [{ type: 'play', sessionId: chunk.sessionId }]);
  assert.equal(playChunks(bg).length, 2);
  assert.equal(liveSession(bg).currentPlayNumber, chunk.playNumber, 'play number unchanged');
  assert.equal(fetch.calls.length, fetchesBefore);
  assert.equal(bg.createdOffscreen.length, createdBefore);
  assert.equal((await logEvents(bg, 'play')).length, playEventsBefore);
  assert.equal((await logEvents(bg, 'replay')).length, 0);
  assert.equal(await playerState(bg), 'playing');
});

test('E1: Play asks the document whether it exists (getContexts) before choosing', async () => {
  const { bg } = setupResume();
  const chunk = await readAndPause(bg, 1);
  let asked = 0;
  const original = bg.chrome.runtime.getContexts;
  bg.chrome.runtime.getContexts = async (query) => {
    asked++;
    assert.deepEqual(query.contextTypes, ['OFFSCREEN_DOCUMENT']);
    return original(query);
  };
  await control(bg, 'play', chunk.sessionId);
  await settle();
  assert.ok(asked >= 1);
});

// --- The popup recreates the document before Play (popup.js init -> setupOffscreen) --------------------

/** What the popup does on every open: ask the background to make sure the audio document exists. */
async function openPopup(bg) {
  await bg.send({ type: 'setupOffscreen' }, { wait: true });
  await settle();
}

test('E1/E11: Chrome closed the document, the popup was reopened (a fresh, empty document), then Play: the sentence is sent again as the next play number', async () => {
  const { bg, fetch } = setupResume({ sentences: TEN });
  const chunk = await readAndPause(bg, 4);
  const fetchesBefore = fetch.calls.length;

  bg.closeOffscreen();
  await bg.timers.tick(180000);
  await openPopup(bg);
  assert.equal(bg.createdOffscreen.length, 2, 'the popup made a new, empty document');
  const sentBefore = bg.sent.length;

  await control(bg, 'play', chunk.sessionId);
  await settle();

  const after = bg.sent.slice(sentBefore).filter((m) => MESSAGE_TYPES.includes(m.type)).map((m) => (m.index === undefined ? m.type : `${m.type} ${m.index}/${m.playNumber}`));
  assert.deepEqual(after, ['playChunk 4/2', 'sentenceProgress 4/2'], 'no bare `play` into the empty document');
  assert.equal(bg.createdOffscreen.length, 2, 'the document the popup made is reused');
  assert.equal(fetch.calls.length, fetchesBefore, 'no re-fetch');
  assert.equal((await logEvents(bg, 'replay'))[0].kind, 'replay-from-bytes');

  await finishRead(bg, 10, { from: 4 });
  assert.deepEqual(playChunks(bg).map((c) => `${c.index}/${c.playNumber}`), [
    '0/1', '1/1', '2/1', '3/1', '4/1', '4/2', '5/1', '6/1', '7/1', '8/1', '9/1'
  ]);
});

test('E1: popup opened while the document is still alive does not create one, and Play only sends `play`', async () => {
  const { bg } = setupResume({ sentences: TEN });
  const chunk = await readAndPause(bg, 4);
  await openPopup(bg);
  assert.equal(bg.createdOffscreen.length, 1);
  const sentBefore = bg.sent.length;
  await control(bg, 'play', chunk.sessionId);
  await settle();
  assert.deepEqual(bg.sent.slice(sentBefore).filter((m) => MESSAGE_TYPES.includes(m.type)), [{ type: 'play', sessionId: chunk.sessionId }]);
});

test('E1: a document that was recreated and then received this session\'s sentence is the one Play continues on', async () => {
  // Replay once (new document), pause again, popup opens (document alive, same generation): only `play`.
  const { bg } = setupResume({ sentences: TEN });
  const chunk = await readAndPause(bg, 4);
  bg.closeOffscreen();
  await openPopup(bg);
  await control(bg, 'play', chunk.sessionId);
  await settle();
  await control(bg, 'pause', chunk.sessionId);
  await settle();
  await openPopup(bg);
  const sentBefore = bg.sent.length;
  await control(bg, 'play', chunk.sessionId);
  await settle();
  assert.deepEqual(bg.sent.slice(sentBefore).filter((m) => MESSAGE_TYPES.includes(m.type)), [{ type: 'play', sessionId: chunk.sessionId }]);
  assert.equal(playChunks(bg).length, 6);
});

test('E1: the popup recreated the document and the worker restarted too: Play refetches once and replays', async () => {
  const { bg: first } = setupResume({ sentences: TEN });
  const chunk = await readAndPause(first, 4);
  first.closeOffscreen();
  await openPopup(first);
  const fetch = createRecordingFetch(TEN);
  const second = restartWorker(first, { sentences: TEN, offscreenUp: true, fetch });
  await settle();
  await control(second, 'play', chunk.sessionId);
  await settle();
  assert.equal(second.sentOfType('play').length, 0);
  assert.deepEqual(playChunks(second).map((c) => `${c.index}/${c.playNumber}`), ['4/2']);
});

// --- GP4: the whole path --------------------------------------------------------------------------------

test('GP4: pause at sentence 5 of 10, the document closes, Play replays sentence 5 from its start and 6 to 10 follow in order', async () => {
  const { bg, fetch } = setupResume({ sentences: TEN });
  const chunk = await readAndPause(bg, 4);
  assert.equal(chunk.index, 4);
  assert.equal(liveSession(bg).paused, true);
  assert.equal(liveSession(bg).stallTimer, null);
  assert.equal(bg.timers.pending, 0);
  assert.equal(fetch.indexes().filter((i) => i === 4).length, 1);

  bg.closeOffscreen();
  await bg.timers.tick(30000);
  const fetchesBefore = fetch.calls.length;
  await control(bg, 'play', chunk.sessionId);
  await settle();

  assert.equal(playChunks(bg).length, 6);
  assert.deepEqual(
    { index: playChunks(bg)[5].index, playNumber: playChunks(bg)[5].playNumber },
    { index: 4, playNumber: 2 }
  );
  assert.equal(fetch.calls.length, fetchesBefore, 'the replay itself fetched nothing');
  assert.equal(fetch.indexes().filter((i) => i === 5).length, 1, 'sentence 6 was fetched once (the prefetch), not again');

  await finishRead(bg, 10, { from: 4 });
  assert.deepEqual(playChunks(bg).map((c) => `${c.index}/${c.playNumber}`), [
    '0/1', '1/1', '2/1', '3/1', '4/1', '4/2', '5/1', '6/1', '7/1', '8/1', '9/1'
  ]);
  assert.equal(liveSession(bg).stopped, true);
  assert.equal(await playerState(bg), 'stopped');
  assert.equal(bg.chrome.storage.session.snapshot().ttsSessionState, undefined, 'a finished read leaves nothing stored');
});

// --- E7: Play after a restart --------------------------------------------------------------------------

for (const offscreenUp of [false, true]) {
  test(`E7: Play after a restart (audio document ${offscreenUp ? 'present' : 'gone'}): the current sentence is fetched once, replayed as the next play number, and the rest follow`, async () => {
    const { bg: first } = setupResume({ sentences: TEN });
    const chunk = await readAndPause(first, 4);
    await settle();

    const fetch = createRecordingFetch(TEN);
    const second = restartWorker(first, { sentences: TEN, offscreenUp, fetch });
    await settle();
    assert.equal(fetch.calls.length, 0, 'hydrating fetches nothing');

    await control(second, 'play', chunk.sessionId);
    await settle();

    assert.equal(fetch.indexes().filter((i) => i === 4).length, 1, 'the current sentence is fetched once');
    const replay = playChunks(second)[0];
    assert.deepEqual({ index: replay.index, playNumber: replay.playNumber, sessionId: replay.sessionId }, {
      index: 4, playNumber: 2, sessionId: chunk.sessionId
    });
    assert.equal(second.sentOfType('play').length, 0);
    const replays = await logEvents(second, 'replay');
    assert.equal(replays.length, 1);
    assert.equal(replays[0].kind, 'refetch-then-play');
    assert.equal(second.createdOffscreen.length, offscreenUp ? 0 : 1);

    await finishRead(second, 10, { from: 4 });
    assert.deepEqual(playChunks(second).map((c) => `${c.index}/${c.playNumber}`), ['4/2', '5/1', '6/1', '7/1', '8/1', '9/1']);
    assert.equal(fetch.indexes().filter((i) => i === 4).length, 1, 'never fetched again');
    assert.equal(liveSession(second).stopped, true);
    assert.equal(second.chrome.storage.session.snapshot().ttsSessionState, undefined);
    assert.equal(second.alarms.has(ALARM), false, 'the finished read clears the alarm');
  });
}

// --- E11: closed during playback -------------------------------------------------------------------------

test('E11: the document closes during playback: the next playChunk recreates it and the next sentence plays once, with no replay logged', async () => {
  const { bg, fetch } = setupResume({ sentences: TEN });
  const chunk = await readUpTo(bg, 2);
  await chunkReady(bg, chunk);
  bg.closeOffscreen();
  const created = bg.createdOffscreen.length;

  await endChunk(bg, chunk);
  await settle();

  assert.equal(bg.createdOffscreen.length, created + 1);
  assert.equal(playChunks(bg).length, 4);
  assert.deepEqual({ index: playChunks(bg)[3].index, playNumber: playChunks(bg)[3].playNumber }, { index: 3, playNumber: 1 });
  assert.equal((await logEvents(bg, 'replay')).length, 0, 'a new index is not a replay');
  assert.equal(fetch.indexes().filter((i) => i === 3).length, 1);
  assert.equal(playChunks(bg).filter((c) => c.index === 3).length, 1, 'plays once');
});

// --- E11: getContexts and createDocument failures --------------------------------------------------------

test('E11: getContexts rejects: treated as absent, recreation is attempted, and "Only a single offscreen document" means it was there', async () => {
  const { bg, fetch } = setupResume();
  const chunk = await readAndPause(bg, 1);
  const fetchesBefore = fetch.calls.length;
  bg.failGetContexts(new Error('getContexts is not available'));
  const created = bg.createdOffscreen.length;

  await control(bg, 'play', chunk.sessionId);
  await settle();

  assert.ok(bg.createdOffscreen.length > created, 'recreation was attempted');
  assert.equal(playChunks(bg).length, 3, 'and the sentence replayed once');
  assert.equal(playChunks(bg)[2].playNumber, 2);
  assert.equal(bg.sentOfType('streamError').length, 0);
  assert.equal(liveSession(bg).stopped, false);
  assert.equal(fetch.calls.length, fetchesBefore);
});

test('E11: createDocument failing with "Only a single offscreen document" is treated as present', async () => {
  const { bg } = setupResume();
  const chunk = await readAndPause(bg, 1);
  bg.closeOffscreen();
  bg.failCreateDocument(new Error('Only a single offscreen document may be created.'));

  await control(bg, 'play', chunk.sessionId);
  await settle();

  assert.equal(bg.sentOfType('streamError').length, 0);
  assert.equal(playChunks(bg).length, 3);
  assert.equal((await logEvents(bg, 'replay')).length, 1);
});

test('E11: any other createDocument failure shows streamError and leaves the session paused, not stopped', async () => {
  const { bg, fetch } = setupResume();
  const chunk = await readAndPause(bg, 1);
  const fetchesBefore = fetch.calls.length;
  bg.closeOffscreen();
  bg.failCreateDocument(new Error('Offscreen documents are blocked by policy'));

  await control(bg, 'play', chunk.sessionId);
  await settle();

  const errors = bg.sentOfType('streamError');
  assert.equal(errors.length, 1);
  assert.match(errors[0].error, /blocked by policy/);
  const s = liveSession(bg);
  assert.equal(s.paused, true);
  assert.equal(s.stopped, false);
  assert.deepEqual(await sessionState(bg), { active: true, sessionId: chunk.sessionId, paused: true, index: 1, total: 3 });
  assert.equal(await playerState(bg), 'paused');
  assert.equal(playChunks(bg).length, 2, 'nothing was played');
  assert.equal(fetch.calls.length, fetchesBefore);
  assert.equal(bg.timers.pending, 0, 'no stall timer while it stays paused');
  assert.equal((await logEvents(bg, 'session-end')).length, 0, 'the session did not end');
  assert.ok(bg.chrome.storage.session.snapshot().ttsSessionState, 'and is still stored');

  // The failure is not remembered: once the document can be created, Play works.
  bg.failCreateDocument(null);
  await control(bg, 'play', chunk.sessionId);
  await settle();
  assert.equal(playChunks(bg).length, 3);
  assert.equal(playChunks(bg)[2].playNumber, 2);
  assert.equal(bg.sentOfType('streamError').length, 1, 'no second error');
});

test('E11: a createDocument failure after a restart also leaves the rebuilt session paused', async () => {
  const { bg: first } = setupResume();
  const chunk = await readAndPause(first, 1);
  const second = restartWorker(first, { sentences: THREE });
  second.failCreateDocument(new Error('no audio for you'));
  await settle();

  await control(second, 'play', chunk.sessionId);
  await settle();
  assert.equal(second.sentOfType('streamError').length, 1);
  assert.equal(liveSession(second).paused, true);
  assert.equal(liveSession(second).stopped, false);
  assert.equal(second.fetch.calls.length, 0);
});

// --- E11: the replay log entry -----------------------------------------------------------------------

test('E11: a replay is logged once with session id, index, new play number and kind, and no text or URL', async () => {
  const { bg } = setupResume();
  const chunk = await readAndPause(bg, 1);
  bg.closeOffscreen();
  await control(bg, 'play', chunk.sessionId);
  await settle();

  const replays = await logEvents(bg, 'replay');
  assert.equal(replays.length, 1);
  const { t, ...fields } = replays[0];
  assert.equal(typeof t, 'number');
  assert.deepEqual(fields, { type: 'replay', sessionId: chunk.sessionId, index: 1, playNumber: 2, kind: 'replay-from-bytes' });
});

// --- Stall timer -------------------------------------------------------------------------------------------

test('Added: the replayed sentence arms the stall timer afresh with the fixed 60 s until its duration is reported; nothing is armed while paused', async () => {
  const { bg } = setupResume();
  const chunk = await readAndPause(bg, 1);
  assert.equal(bg.timers.pending, 0, 'nothing armed while paused');

  bg.closeOffscreen();
  const release = bg.holdCreateDocument();
  await control(bg, 'play', chunk.sessionId);
  await settle();
  assert.equal(bg.timers.pending, 0, 'nothing armed while the document is being recreated');
  release();
  await settle();

  assert.equal(bg.timers.pending, 1, 'armed for the replay');
  await bg.timers.tick(59999);
  assert.equal(playChunks(bg).length, 3, 'not yet');

  // The duration arrives: duration + 5 s from now replaces the hang timeout.
  const replay = playChunks(bg)[2];
  await bg.send({ type: 'audioDuration', sessionId: replay.sessionId, index: replay.index, playNumber: replay.playNumber, duration: 100 });
  await settle();
  await bg.timers.tick(104999);
  assert.equal(playChunks(bg).length, 3, 'a 100 s sentence is not cut off at 60 s');
  await bg.timers.tick(1);
  assert.equal(playChunks(bg).length, 4, 'duration + 5 s later the stall advanced to the next sentence');
  assert.equal(playChunks(bg)[3].index, 2);
});

test('Added: the replay without a reported duration stalls at exactly 60 s', async () => {
  const { bg } = setupResume();
  const chunk = await readAndPause(bg, 1);
  bg.closeOffscreen();
  await control(bg, 'play', chunk.sessionId);
  await settle();
  await bg.timers.tick(59999);
  assert.equal(playChunks(bg).length, 3);
  await bg.timers.tick(1);
  assert.equal(playChunks(bg).length, 4);
  assert.equal((await logEvents(bg, 'stall'))[0].ms, 60000);
});

test('Added: Pause during the replay load keeps the session paused and the replay waits for Play', async () => {
  const { bg } = setupResume();
  const chunk = await readAndPause(bg, 1);
  bg.closeOffscreen();
  const release = bg.holdCreateDocument();
  await control(bg, 'play', chunk.sessionId);
  await settle();
  await control(bg, 'pause', chunk.sessionId); // already paused: a no-op
  release();
  await settle();
  assert.equal(playChunks(bg).length, 3);
  await control(bg, 'pause', chunk.sessionId);
  await settle();
  assert.equal(liveSession(bg).paused, true);
  assert.equal(bg.timers.pending, 0);
});

// --- Play after a Stop or a finished session ---------------------------------------------------------------

test('Added: Play after a Stop does not resume anything; the popup starts a new session as today', async () => {
  const { bg, fetch } = setupResume();
  const chunk = await readAndPause(bg, 1);
  await control(bg, 'stop', chunk.sessionId);
  await settle();
  const createdBefore = bg.createdOffscreen.length;
  const fetchesBefore = fetch.calls.length;
  const sentBefore = bg.sent.length;

  await control(bg, 'play', chunk.sessionId);
  await settle();
  assert.deepEqual(bg.sent.slice(sentBefore).filter((m) => MESSAGE_TYPES.includes(m.type)), []);
  assert.equal(bg.createdOffscreen.length, createdBefore);
  assert.equal(fetch.calls.length, fetchesBefore);
  assert.deepEqual((await sessionState(bg)).active, false, 'the popup sees no session and calls startStreaming');
  const dropped = await logEvents(bg, 'dropped-control');
  assert.equal(dropped.at(-1).reason, 'no-session');
});

test('Added: Play after a finished read does not resume anything either', async () => {
  const { bg } = setupResume({ sentences: THREE.slice(0, 2) });
  const chunk = await readAndPause(bg, 1);
  await control(bg, 'play', chunk.sessionId);
  await settle();
  await endChunk(bg, chunk);
  await settle();
  assert.equal((await sessionState(bg)).active, false);
  const playsBefore = playChunks(bg).length;
  await control(bg, 'play', chunk.sessionId);
  await settle();
  assert.equal(playChunks(bg).length, playsBefore);
});

// --- The bytes the session keeps ------------------------------------------------------------------------

test('The session keeps the current sentence (and the finished prefetch of the next) until the sentence ends, and drops them on advance', async () => {
  const { bg } = setupResume({ sentences: TEN });
  const chunk = await readUpTo(bg, 1);
  await settle();
  const s = liveSession(bg);
  assert.equal(s.currentAudio.index, 1);
  assert.equal(s.currentAudio.audioResult.arrayBuffer.byteLength, AUDIO_1KB.length);
  assert.equal(s.prefetch.index, 2);
  assert.equal((await s.prefetch.promise).arrayBuffer.byteLength, AUDIO_1KB.length, 'the next sentence is already fetched');

  await chunkReady(bg, chunk);
  await bg.send({ type: 'chunkEnded', index: chunk.index, sessionId: chunk.sessionId, playNumber: chunk.playNumber });
  // The advance consumed the prefetch; sentence 2's bytes replaced sentence 1's.
  await settle();
  assert.equal(s.currentAudio.index, 2);
  assert.equal(s.prefetch.index, 3);
});

test('The kept bytes are dropped when the sentence ends, before the next one has arrived', async () => {
  const { bg } = setupResume({ sentences: TEN });
  const chunk = await readUpTo(bg, 1);
  const s = liveSession(bg);
  s.prefetch = null; // as if the next sentence were still being fetched
  const original = bg.context.fetch;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  bg.context.fetch = async (...args) => { await gate; return original(...args); };

  await chunkReady(bg, chunk);
  await bg.send({ type: 'chunkEnded', index: chunk.index, sessionId: chunk.sessionId, playNumber: chunk.playNumber });
  await settle();
  assert.equal(s.currentAudio, null, 'dropped on advance, while the next sentence is still loading');
  release();
  await settle();
  assert.equal(s.currentAudio.index, 2);
});

test('The kept bytes are dropped on Stop and on session replacement', async () => {
  const { bg } = setupResume({ sentences: TEN });
  const chunk = await readUpTo(bg, 1);
  const stopped = liveSession(bg);
  assert.ok(stopped.currentAudio);
  await control(bg, 'stop', chunk.sessionId);
  await settle();
  assert.equal(stopped.currentAudio, null, 'Stop');
  assert.equal(stopped.prefetch, null);

  const { bg: bg2 } = setupResume({ sentences: TEN });
  await readUpTo(bg2, 1);
  const replaced = liveSession(bg2);
  assert.ok(replaced.currentAudio);
  bg2.listeners.menuClicked[0]({ menuItemId: 'readAloud', frameId: 0 }, { id: 7 });
  await settle(20);
  assert.notEqual(liveSession(bg2), replaced);
  assert.equal(replaced.currentAudio, null, 'replacement');
});

test('Pausing after a sentence ended keeps no bytes for it: Play moves on to the next sentence', async () => {
  const { bg, fetch } = setupResume({ sentences: TEN });
  const chunk = await readUpTo(bg, 1);
  await chunkReady(bg, chunk);
  await control(bg, 'pause', chunk.sessionId);
  await bg.send({ type: 'chunkEnded', index: chunk.index, sessionId: chunk.sessionId, playNumber: chunk.playNumber });
  await settle();
  assert.equal(liveSession(bg).currentAudio, null);

  bg.closeOffscreen();
  await control(bg, 'play', chunk.sessionId);
  await settle();
  assert.deepEqual({ index: playChunks(bg).at(-1).index, playNumber: playChunks(bg).at(-1).playNumber }, { index: 2, playNumber: 1 });
  assert.equal(fetch.indexes().filter((i) => i === 1).length, 1);
});

// --- F4: nothing sensitive in what this PR writes -------------------------------------------------------

test('F4: the stored session state has no sentence text and no URL (the sentences sit under their own key), and the log has neither', async () => {
  const { bg } = setupResume({ sentences: TEN, tabUrl: 'https://example.test/private?q=1' });
  const chunk = await readAndPause(bg, 2);
  bg.closeOffscreen();
  await control(bg, 'play', chunk.sessionId);
  await settle();
  await control(bg, 'pause', chunk.sessionId);
  await settle();

  const stored = bg.chrome.storage.session.snapshot();
  const { ttsSessionSentences, ...rest } = stored;
  assert.deepEqual(ttsSessionSentences, TEN, 'the sentences are stored once, under their own key');
  const serialisedState = JSON.stringify(rest);
  for (const sentence of TEN) assert.ok(!serialisedState.includes(sentence.slice(0, 12)), `state has no text: ${sentence}`);
  assert.ok(!/https?:|:\/\/|example\.test|tts\.invalid|localhost/i.test(serialisedState), 'state has no URL');
  assert.ok(!/ttsDebugLog/.test(serialisedState), 'the log is not in session storage');

  const response = await bg.send({ type: 'getDebugLog' }, { wait: true });
  const serialisedLog = JSON.stringify(response.log);
  for (const sentence of TEN) assert.ok(!serialisedLog.includes(sentence.slice(0, 12)), `log has no text: ${sentence}`);
  assert.ok(!/https?:|:\/\/|example\.test|localhost/i.test(serialisedLog), 'log has no URL');
  assert.ok(response.log.events.some((e) => e.type === 'replay'));
});

test('F4: the stored state is written once per change and sentences are written once per session', async () => {
  const { bg } = setupResume({ sentences: TEN });
  await readAndPause(bg, 3);
  await settle();
  const withSentences = bg.chrome.storage.session.setCalls.filter((c) => 'ttsSessionSentences' in c);
  assert.equal(withSentences.length, 1);
  assert.ok(bg.chrome.storage.session.setCalls.length > 1);
});
