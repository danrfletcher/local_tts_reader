'use strict';
/**
 * offscreen.js (run for real against a fake <audio> element): Pause, Play and
 * Stop act only for the session whose audio is on the element, Stop tears the
 * audio down, and the element's own pause event no longer reports `paused`.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { loadOffscreen } = require('./helpers/offscreen.js');

const A = 'aaaaaa';
const B = 'bbbbbb';
const chunk = (sessionId, index = 2, playNumber = 1) => ({
  type: 'playChunk', audioData: [1, 2, 3], mimeType: 'audio/wav', index, sessionId, playNumber
});
const stateUpdates = (page) => page.sent.filter((m) => m.type === 'stateUpdate');

test('pause for the session on the element pauses it', () => {
  const page = loadOffscreen();
  page.deliver(chunk(A));
  page.audio.currentTime = 1.5;
  page.deliver({ type: 'pause', sessionId: A });
  assert.equal(page.audio.pauses, 1);
});

test('pause for another session, or with no id, does nothing', () => {
  const page = loadOffscreen();
  page.deliver(chunk(A));
  page.deliver({ type: 'pause', sessionId: B });
  page.deliver({ type: 'pause' });
  assert.equal(page.audio.pauses, 0);
});

test('pause with nothing loaded does nothing', () => {
  const page = loadOffscreen();
  page.deliver({ type: 'pause', sessionId: A });
  assert.equal(page.audio.pauses, 0);
});

test('play for the session on the element resumes it, without setting a new src', () => {
  const page = loadOffscreen();
  page.deliver(chunk(A));
  const src = page.audio.src;
  page.deliver({ type: 'pause', sessionId: A });
  page.deliver({ type: 'play', sessionId: A });
  assert.equal(page.audio.plays.length, 2, 'play() called once for the chunk and once for the resume');
  assert.equal(page.audio.src, src);
});

test('play for another session or with no id is ignored (a late Play for a replaced session)', () => {
  const page = loadOffscreen();
  page.deliver(chunk(B));
  page.deliver({ type: 'play', sessionId: A });
  page.deliver({ type: 'play' });
  assert.equal(page.audio.plays.length, 1, 'only the chunk\'s own play()');
});

test('stop tears the audio down: pause, remove src, load(), revoke the object URL', () => {
  const page = loadOffscreen();
  page.deliver(chunk(A));
  assert.deepEqual(page.created, ['blob:fake-1']);
  page.deliver({ type: 'stop', sessionId: A });

  assert.equal(page.audio.pauses, 1);
  assert.deepEqual(page.audio.removedAttributes, ['src']);
  assert.equal(page.audio.src, '');
  assert.equal(page.audio.loads, 1);
  assert.equal(page.audio.currentTime, 0);
  assert.deepEqual(page.revoked, ['blob:fake-1']);
});

test('stop reports stopped with the id of the session it stopped', () => {
  const page = loadOffscreen();
  page.deliver(chunk(A));
  page.deliver({ type: 'stop', sessionId: A });
  assert.deepEqual(stateUpdates(page).filter((m) => m.state === 'stopped'), [{ type: 'stateUpdate', state: 'stopped', sessionId: A }]);
});

test('stop for a replaced session does not tear down the audio of the session that replaced it', () => {
  const page = loadOffscreen();
  page.deliver(chunk(A));
  page.deliver({ type: 'stop', sessionId: A });
  page.deliver(chunk(B, 0));
  const pausesBefore = page.audio.pauses;

  page.deliver({ type: 'stop', sessionId: A }); // late and duplicated

  assert.equal(page.audio.pauses, pausesBefore);
  assert.equal(page.audio.loads, 1, 'only the first Stop loaded an empty source');
  assert.equal(page.audio.src, 'blob:fake-2', 'session B is still on the element');
  page.audio.onended();
  assert.equal(page.sent.filter((m) => m.type === 'chunkEnded').at(-1).sessionId, B);
});

test('stop with no id (older senders) still tears down', () => {
  const page = loadOffscreen();
  page.deliver(chunk(A));
  page.deliver({ type: 'stop' });
  assert.deepEqual(page.audio.removedAttributes, ['src']);
  assert.deepEqual(page.revoked, ['blob:fake-1']);
});

test('stop when nothing is loaded is harmless', () => {
  const page = loadOffscreen();
  page.deliver({ type: 'stop', sessionId: A });
  assert.equal(page.audio.loads, 1);
  assert.deepEqual(page.revoked, []);
});

test('after Stop, a late playChunk for the stopped session is ignored and a late play does nothing', () => {
  const page = loadOffscreen();
  page.deliver(chunk(A));
  page.deliver({ type: 'stop', sessionId: A });
  const playsBefore = page.audio.plays.length;

  page.deliver(chunk(A, 3, 1));
  page.deliver({ type: 'play', sessionId: A });

  assert.equal(page.audio.plays.length, playsBefore);
  assert.ok(page.sent.some((m) => m.type === 'playDropped' && m.sessionId === A));
});

test('a late playChunk carrying the replaced session id never plays once the new session has started', () => {
  const page = loadOffscreen();
  page.deliver(chunk(A));
  page.deliver({ type: 'stop', sessionId: A });
  page.deliver(chunk(B, 0));
  const playsBefore = page.audio.plays.length;

  page.deliver(chunk(A, 5, 1));

  assert.equal(page.audio.plays.length, playsBefore);
  assert.equal(page.audio.src, 'blob:fake-2');
});

test('the element pausing no longer reports paused (the background records Pause itself)', () => {
  const page = loadOffscreen();
  page.deliver(chunk(A));
  page.audio.currentTime = 2; // mid-sentence, the case the old onpause reported
  page.deliver({ type: 'pause', sessionId: A });
  page.audio.pause(); // and the element's own pause event for good measure
  assert.equal(page.audio.pauses, 2);
  assert.deepEqual(stateUpdates(page).filter((m) => m.state === 'paused'), []);
  assert.deepEqual(page.sent.filter((m) => m.type === 'stateUpdate' && m.state !== 'playing' && m.state !== 'stopped'), []);
});

test('onplay reports playing tagged with the session id', () => {
  const page = loadOffscreen();
  page.deliver(chunk(A));
  page.audio.onplay();
  assert.deepEqual(stateUpdates(page), [{ type: 'stateUpdate', state: 'playing', sessionId: A }]);
});
