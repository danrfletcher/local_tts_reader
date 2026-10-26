'use strict';
/**
 * The pure Pause/Play/Stop transitions in lib/playback.js, over every
 * combination of phase x event (and of the flags a paused session can hold).
 * The expected values are written out literally, not derived from the code.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { playbackTransition, startsSentence, PHASES, CONTROL_EVENTS } = require('../lib/playback.js');

const NONE = { held: false, advanceOnResume: false, fetchPending: false };

// [phase, event, expected phase, expected action] with no flags set.
const TABLE = [
  ['idle', 'pause', 'idle', 'none'],
  ['idle', 'play', 'idle', 'new-session'],
  ['idle', 'stop', 'idle', 'none'],
  ['idle', 'chunkEnded', 'idle', 'ignore'],
  ['idle', 'fetchDone', 'idle', 'discard'],

  ['loading', 'pause', 'paused', 'pause'],
  ['loading', 'play', 'loading', 'none'],
  ['loading', 'stop', 'stopped', 'stop'],
  ['loading', 'chunkEnded', 'loading', 'ignore'],
  ['loading', 'fetchDone', 'playing', 'play-chunk'],

  ['playing', 'pause', 'paused', 'pause'],
  ['playing', 'play', 'playing', 'none'],
  ['playing', 'stop', 'stopped', 'stop'],
  ['playing', 'chunkEnded', 'loading', 'advance'],
  ['playing', 'fetchDone', 'playing', 'keep-prefetch'],

  ['paused', 'pause', 'paused', 'none'],
  ['paused', 'play', 'playing', 'resume-audio'],
  ['paused', 'stop', 'stopped', 'stop'],
  ['paused', 'chunkEnded', 'paused', 'defer-advance'],
  ['paused', 'fetchDone', 'paused', 'hold-chunk'],

  ['stopped', 'pause', 'stopped', 'none'],
  ['stopped', 'play', 'stopped', 'new-session'],
  ['stopped', 'stop', 'stopped', 'none'],
  ['stopped', 'chunkEnded', 'stopped', 'ignore'],
  ['stopped', 'fetchDone', 'stopped', 'discard']
];

test('the table covers every phase x event exactly once', () => {
  assert.deepEqual(PHASES, ['idle', 'loading', 'playing', 'paused', 'stopped']);
  assert.deepEqual(CONTROL_EVENTS, ['pause', 'play', 'stop', 'chunkEnded', 'fetchDone']);
  const seen = TABLE.map(([phase, event]) => `${phase}/${event}`);
  assert.equal(new Set(seen).size, 25);
  for (const phase of PHASES) for (const event of CONTROL_EVENTS) assert.ok(seen.includes(`${phase}/${event}`));
});

for (const [phase, event, nextPhase, action] of TABLE) {
  test(`${phase} + ${event} -> ${action} (${nextPhase})`, () => {
    const result = playbackTransition(phase, event, NONE);
    assert.equal(result.action, action);
    assert.equal(result.phase, nextPhase);
  });
}

test('flags default to none when omitted', () => {
  assert.deepEqual(playbackTransition('paused', 'play'), playbackTransition('paused', 'play', NONE));
});

// What Play does depends on what the paused session is holding.
const RESUME = [
  ['nothing held, nothing in flight', {}, 'playing', 'resume-audio'],
  ['a fetch still in flight (E5)', { fetchPending: true }, 'loading', 'resume-wait'],
  ['a held chunk (E5)', { held: true }, 'loading', 'resume-held'],
  ['a sentence ended while paused (E6)', { advanceOnResume: true }, 'loading', 'resume-advance'],
  ['a held chunk wins over a stale in-flight flag', { held: true, fetchPending: true }, 'loading', 'resume-held'],
  ['a sentence ended while the next fetch is in flight', { advanceOnResume: true, fetchPending: true }, 'loading', 'resume-advance']
];
for (const [label, flags, nextPhase, action] of RESUME) {
  test(`paused + play with ${label} -> ${action}`, () => {
    const result = playbackTransition('paused', 'play', { ...NONE, ...flags });
    assert.equal(result.action, action);
    assert.equal(result.phase, nextPhase);
  });
}

test('Play consumes what the pause held: the flags it returns are cleared', () => {
  assert.deepEqual(
    playbackTransition('paused', 'play', { held: true, advanceOnResume: false, fetchPending: false }).flags,
    NONE
  );
  assert.equal(playbackTransition('paused', 'play', { advanceOnResume: true }).flags.advanceOnResume, false);
});

test('chunkEnded while paused records advanceOnResume and keeps what was held; fetchDone while paused records a held chunk', () => {
  const ended = playbackTransition('paused', 'chunkEnded', { fetchPending: true });
  assert.deepEqual(ended.flags, { held: false, advanceOnResume: true, fetchPending: true });
  const done = playbackTransition('paused', 'fetchDone', { fetchPending: true });
  assert.deepEqual(done.flags, { held: true, advanceOnResume: false, fetchPending: false });
});

test('Stop clears every flag', () => {
  for (const phase of ['loading', 'playing', 'paused']) {
    const result = playbackTransition(phase, 'stop', { held: true, advanceOnResume: true, fetchPending: true });
    assert.deepEqual(result.flags, NONE, phase);
  }
});

test('a transition never mutates the flags it is given', () => {
  const flags = Object.freeze({ held: true, advanceOnResume: true, fetchPending: true });
  for (const phase of PHASES) for (const event of CONTROL_EVENTS) playbackTransition(phase, event, flags);
});

test('unknown phases and events change nothing', () => {
  assert.equal(playbackTransition('sleeping', 'play', NONE).action, 'none');
  assert.equal(playbackTransition('playing', 'explode', NONE).action, 'none');
  assert.equal(playbackTransition('playing', 'explode', NONE).phase, 'playing');
});

// --- The rule that never breaks ---------------------------------------------------------

function allFlagCombinations() {
  const out = [];
  for (const held of [false, true]) {
    for (const advanceOnResume of [false, true]) {
      for (const fetchPending of [false, true]) out.push({ held, advanceOnResume, fetchPending });
    }
  }
  return out;
}

test('no state starts a sentence while paused: only Play does, and it leaves the paused phase', () => {
  let starts = 0;
  for (const phase of PHASES) {
    for (const event of CONTROL_EVENTS) {
      for (const flags of allFlagCombinations()) {
        const result = playbackTransition(phase, event, flags);
        const label = `${phase}/${event}/${JSON.stringify(flags)}`;
        if (startsSentence(result.action)) {
          starts++;
          assert.notEqual(result.phase, 'paused', `${label} starts a sentence but stays paused`);
          if (phase === 'paused') assert.equal(event, 'play', `${label} starts a sentence from paused without Play`);
        }
        if (result.phase === 'paused' && phase === 'paused') {
          assert.ok(!startsSentence(result.action), `${label} starts a sentence and ends paused`);
        }
      }
    }
  }
  assert.ok(starts > 0, 'the check saw sentence-starting actions');
});

test('from paused, chunkEnded and fetchDone never produce a sentence start (E5, E6)', () => {
  for (const flags of allFlagCombinations()) {
    for (const event of ['chunkEnded', 'fetchDone', 'pause']) {
      const result = playbackTransition('paused', event, flags);
      assert.equal(result.phase, 'paused');
      assert.ok(!startsSentence(result.action), `${event} ${JSON.stringify(flags)} -> ${result.action}`);
    }
  }
});

test('the sentence-starting actions are exactly play-chunk, advance, resume-held, resume-advance', () => {
  for (const action of ['play-chunk', 'advance', 'resume-held', 'resume-advance']) assert.ok(startsSentence(action), action);
  for (const action of ['none', 'pause', 'stop', 'resume-audio', 'resume-wait', 'defer-advance', 'hold-chunk', 'keep-prefetch', 'discard', 'ignore', 'new-session']) {
    assert.ok(!startsSentence(action), action);
  }
});
