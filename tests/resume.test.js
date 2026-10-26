'use strict';
/**
 * Resume after a long Pause: the pure decision (TTSPlayback.decideResume) and
 * the two-Plays race through the real background.js.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { settle } = require('./helpers/fake-chrome.js');
const { playChunks } = require('./helpers/session.js');
const { control } = require('./helpers/pause.js');
const TTSPlayback = require('../lib/playback.js');
const { THREE, setupResume, readAndPause, logEvents, liveSession } = require('./helpers/resume.js');

// --- decideResume ---------------------------------------------------------------------------------

// Written out by hand, one row per combination, so a change to the rule shows up here.
//   paused, offscreenPresent, haveBytes, hydrated -> decision
const TABLE = [
  [false, false, false, false, 'none'],
  [false, false, false, true, 'none'],
  [false, false, true, false, 'none'],
  [false, false, true, true, 'none'],
  [false, true, false, false, 'none'],
  [false, true, false, true, 'none'],
  [false, true, true, false, 'none'],
  [false, true, true, true, 'none'],
  [true, false, false, false, 'refetch-then-play'],
  [true, false, false, true, 'refetch-then-play'],
  [true, false, true, false, 'replay-from-bytes'],
  [true, false, true, true, 'replay-from-bytes'],
  [true, true, false, false, 'continue'],
  [true, true, false, true, 'refetch-then-play'],
  [true, true, true, false, 'continue'],
  [true, true, true, true, 'replay-from-bytes']
];

for (const [paused, offscreenPresent, haveBytes, hydrated, expected] of TABLE) {
  test(`decideResume paused=${paused} offscreen=${offscreenPresent} bytes=${haveBytes} hydrated=${hydrated} -> ${expected}`, () => {
    assert.equal(TTSPlayback.decideResume({ paused, offscreenPresent, haveBytes, hydrated }), expected);
  });
}

test('decideResume covers all 16 combinations of its four flags exactly once', () => {
  const seen = new Set(TABLE.map((row) => row.slice(0, 4).join()));
  assert.equal(seen.size, 16);
});

test('decideResume: missing flags count as false, and no argument at all means no paused session', () => {
  assert.equal(TTSPlayback.decideResume(), 'none');
  assert.equal(TTSPlayback.decideResume({}), 'none');
  assert.equal(TTSPlayback.decideResume({ paused: true }), 'refetch-then-play');
  assert.equal(TTSPlayback.decideResume({ paused: true, offscreenPresent: true }), 'continue');
});

test('decideResume is pure: it returns one of the four documented values and does not touch its input', () => {
  const input = Object.freeze({ paused: true, offscreenPresent: false, haveBytes: true, hydrated: false });
  assert.equal(TTSPlayback.decideResume(input), 'replay-from-bytes');
  assert.deepEqual(input, { paused: true, offscreenPresent: false, haveBytes: true, hydrated: false });
});

// --- Play twice while the document is being recreated ----------------------------------------------

test('Added: Play clicked twice while the document is being recreated gives one replay: one createDocument, one play number step', async () => {
  const { bg, fetch } = setupResume();
  const chunk = await readAndPause(bg, 1);
  assert.equal(bg.createdOffscreen.length, 1, 'created once at the start of the read');
  const fetchesBefore = fetch.calls.length;

  bg.closeOffscreen(); // Chrome closed it during the pause
  const release = bg.holdCreateDocument();
  await control(bg, 'play', chunk.sessionId);
  await settle();
  await control(bg, 'play', chunk.sessionId); // second click, document still being created
  await settle();
  assert.equal(bg.createdOffscreen.length, 2, 'one creation in flight');
  assert.equal(playChunks(bg).length, 2, 'nothing plays before the document exists');
  assert.equal(liveSession(bg).paused, true, 'still paused while it is recreated');
  assert.equal(bg.timers.pending, 0, 'no stall timer is armed while paused');

  release();
  await settle();
  await control(bg, 'play', chunk.sessionId); // a third click after the replay started
  await settle();

  const chunks = playChunks(bg);
  assert.equal(chunks.length, 3, 'exactly one replay was sent');
  assert.equal(chunks[2].index, chunk.index);
  assert.equal(chunks[2].playNumber, chunk.playNumber + 1, 'play number stepped once');
  assert.equal(chunks[2].sessionId, chunk.sessionId);
  assert.equal(bg.createdOffscreen.length, 2, 'still one extra document');
  assert.equal(fetch.calls.length, fetchesBefore, 'the kept bytes were replayed');
  assert.equal((await logEvents(bg, 'replay')).length, 1);
  const dropped = (await logEvents(bg, 'dropped-control')).map((e) => e.reason);
  assert.deepEqual(dropped, ['resume-pending', 'no-op']);
});

test('Added: Play twice in the same tick (a double click) with the document gone is also one replay', async () => {
  const { bg } = setupResume();
  const chunk = await readAndPause(bg, 1);
  bg.closeOffscreen();
  control(bg, 'play', chunk.sessionId);
  control(bg, 'play', chunk.sessionId);
  await settle();
  assert.equal(playChunks(bg).length, 3);
  assert.equal(bg.createdOffscreen.length, 2);
  assert.equal((await logEvents(bg, 'replay')).length, 1);
});

test('Added: Play after the session was stopped while the document was being recreated plays nothing', async () => {
  const { bg } = setupResume();
  const chunk = await readAndPause(bg, 1);
  bg.closeOffscreen();
  const release = bg.holdCreateDocument();
  await control(bg, 'play', chunk.sessionId);
  await settle();
  await control(bg, 'stop', chunk.sessionId);
  release();
  await settle();
  assert.equal(playChunks(bg).length, 2, 'the replay never started');
  assert.equal(liveSession(bg).stopped, true);
  assert.equal((await logEvents(bg, 'replay')).length, 0);
});

test('fixtures: the three-sentence array has three distinct sentences', () => {
  assert.equal(new Set(THREE).size, 3);
});
