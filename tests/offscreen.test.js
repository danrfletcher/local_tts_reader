'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const { settle } = require('./helpers/fake-chrome.js');
const { loadOffscreen } = require('./helpers/offscreen.js');

const PLAY = { type: 'playChunk', audioData: [1, 2, 3], mimeType: 'audio/wav', index: 4, sessionId: 'abc123', playNumber: 1 };

test('playChunk produces audioReady, then chunkEnded, with the same three ids and one <audio> element', async () => {
  const page = loadOffscreen();
  page.deliver(PLAY);
  await settle();

  const ready = page.sent.filter((m) => m.type === 'audioReady');
  assert.deepEqual(ready, [{ type: 'audioReady', sessionId: 'abc123', index: 4, playNumber: 1, audioElements: 1 }]);
  assert.equal(page.audio.plays.length, 1, 'played once');

  page.audio.onended();
  const ended = page.sent.filter((m) => m.type === 'chunkEnded');
  assert.deepEqual(ended, [{ type: 'chunkEnded', index: 4, sessionId: 'abc123', playNumber: 1 }]);
});

test('audioReady reports the real <audio> element count, not a constant', () => {
  const page = loadOffscreen({ audioCount: 2 });
  page.deliver(PLAY);
  assert.equal(page.sent.find((m) => m.type === 'audioReady').audioElements, 2);
});

test('each new playChunk echoes its own ids', () => {
  const page = loadOffscreen();
  page.deliver(PLAY);
  page.audio.onended();
  page.deliver({ ...PLAY, index: 5, playNumber: 1 });
  page.audio.onended();
  page.deliver({ ...PLAY, index: 5, playNumber: 2 });
  page.audio.onended();
  const ended = page.sent.filter((m) => m.type === 'chunkEnded').map((m) => [m.sessionId, m.index, m.playNumber]);
  assert.deepEqual(ended, [['abc123', 4, 1], ['abc123', 5, 1], ['abc123', 5, 2]]);
});

test('after stop, an ended event carries no stale ids (and none is sent)', () => {
  const page = loadOffscreen();
  page.deliver(PLAY);
  page.deliver({ type: 'stop' });
  page.audio.onended();
  assert.equal(page.sent.filter((m) => m.type === 'chunkEnded').length, 0);
  assert.ok(page.sent.some((m) => m.type === 'stateUpdate' && m.state === 'stopped'));
});

test('a playChunk without ids (older background) still plays and echoes nulls', () => {
  const page = loadOffscreen();
  page.deliver({ type: 'playChunk', audioData: [1], mimeType: 'audio/wav', index: 0 });
  assert.equal(page.audio.plays.length, 1);
  const ready = page.sent.find((m) => m.type === 'audioReady');
  assert.equal(ready.sessionId, null);
  assert.equal(ready.playNumber, null);
});

// --- Duplicate and stale playChunk (E9) --------------------------------------------

test('E9: the same playChunk delivered twice sets src and calls play() once, and the drop is reported', async () => {
  const page = loadOffscreen();
  page.deliver(PLAY);
  const srcAfterFirst = page.audio.src;
  page.deliver(PLAY);
  await settle();

  assert.equal(page.audio.plays.length, 1, 'play() called once');
  assert.equal(page.audio.src, srcAfterFirst, 'src was not set a second time');
  assert.equal(page.sent.filter((m) => m.type === 'audioReady').length, 1);
  assert.deepEqual(page.sent.filter((m) => m.type === 'playDropped'), [
    { type: 'playDropped', sessionId: 'abc123', index: 4, playNumber: 1, reason: 'duplicate' }
  ]);
});

test('E9: a replay of the same sentence with a new play number does play', () => {
  const page = loadOffscreen();
  page.deliver(PLAY);
  page.deliver({ ...PLAY, playNumber: 2 });
  assert.equal(page.audio.plays.length, 2);
  assert.deepEqual(page.sent.filter((m) => m.type === 'audioReady').map((m) => m.playNumber), [1, 2]);
});

test('E9: an older play number for a sentence already played is dropped', () => {
  const page = loadOffscreen();
  page.deliver({ ...PLAY, playNumber: 2 });
  page.deliver({ ...PLAY, playNumber: 1 });
  assert.equal(page.audio.plays.length, 1);
  assert.equal(page.sent.find((m) => m.type === 'playDropped').reason, 'stale-play');
});

test('E8: a playChunk from a replaced session does not reach play()', () => {
  const page = loadOffscreen();
  page.deliver(PLAY); // session abc123
  page.deliver({ ...PLAY, sessionId: 'xyz789', index: 0 }); // replaced it
  page.deliver({ ...PLAY, index: 5 }); // late message from abc123
  assert.equal(page.audio.plays.length, 2);
  const dropped = page.sent.filter((m) => m.type === 'playDropped');
  assert.deepEqual(dropped.map((m) => [m.sessionId, m.index, m.reason]), [['abc123', 5, 'stale-session']]);
});

test('Added: a playChunk that arrives after stop does not reach play()', () => {
  const page = loadOffscreen();
  page.deliver(PLAY);
  page.deliver({ type: 'stop' });
  page.deliver({ ...PLAY, index: 5 }); // same session, sent before the stop was processed
  assert.equal(page.audio.plays.length, 1, 'only the first play happened');
  assert.equal(page.sent.find((m) => m.type === 'playDropped').reason, 'stale-session');
});

// --- Duration report (E10) ----------------------------------------------------------

test('E10: loadedmetadata posts the duration with session id, index and play number', () => {
  const page = loadOffscreen();
  page.deliver(PLAY);
  page.audio.duration = 12.5;
  page.audio.onloadedmetadata();
  assert.deepEqual(page.sent.filter((m) => m.type === 'audioDuration'), [
    { type: 'audioDuration', sessionId: 'abc123', index: 4, playNumber: 1, duration: 12.5 }
  ]);
});

test('E10: the duration report follows the current play, not an earlier one', () => {
  const page = loadOffscreen();
  page.deliver(PLAY);
  page.deliver({ ...PLAY, index: 5, playNumber: 1 });
  page.audio.duration = 3;
  page.audio.onloadedmetadata();
  const [report] = page.sent.filter((m) => m.type === 'audioDuration');
  assert.equal(report.index, 5);
});

test('E10: no duration is reported when nothing is loaded (after stop)', () => {
  const page = loadOffscreen();
  page.deliver(PLAY);
  page.deliver({ type: 'stop' });
  page.audio.onloadedmetadata();
  assert.equal(page.sent.filter((m) => m.type === 'audioDuration').length, 0);
});

test('E10: a NaN duration is posted as null (background ignores it)', () => {
  const page = loadOffscreen();
  page.deliver(PLAY);
  page.audio.duration = NaN;
  page.audio.onloadedmetadata();
  assert.equal(page.sent.find((m) => m.type === 'audioDuration').duration, null);
});
