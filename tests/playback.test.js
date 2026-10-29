'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const nodeCrypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const TTSPlayback = require('../lib/playback.js');
const { createStorageArea, settle, ROOT } = require('./helpers/fake-chrome.js');

const {
  mintSessionId,
  createPlayCounter,
  createStartTokens,
  createPlayLedger,
  staleReason,
  isUsableDuration,
  stallTimeoutMs,
  sanitizeError,
  sha256Prefix,
  buildEvent,
  appendCapped,
  createDebugLog,
  summariseLog
} = TTSPlayback;

// Float sequence that mints exactly `id`, then keeps returning `rest`.
function rngFor(id, rest = 0.5) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const queue = [...id].map((c) => (alphabet.indexOf(c) + 0.5) / 36);
  return () => (queue.length ? queue.shift() : rest);
}

test('lib/playback.js: same API via require and via importScripts-style load', () => {
  const sandbox = {};
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'lib', 'playback.js'), 'utf8'), sandbox);
  assert.ok(sandbox.TTSPlayback, 'self.TTSPlayback is set when `module` is undefined');
  assert.deepEqual(Object.keys(sandbox.TTSPlayback).sort(), Object.keys(TTSPlayback).sort());
});

test('session ids: 6 characters from [a-z0-9]', () => {
  for (let i = 0; i < 200; i++) {
    assert.match(mintSessionId(), /^[a-z0-9]{6}$/);
  }
  assert.equal(mintSessionId(rngFor('a0z9k2')), 'a0z9k2');
});

test('session ids: re-rolls rather than reusing the id of a live session', () => {
  const live = new Set(['abc123']);
  const id = mintSessionId(rngFor('abc123', 0.9), (candidate) => live.has(candidate));
  assert.notEqual(id, 'abc123');
  assert.match(id, /^[a-z0-9]{6}$/);
});

test('session ids: gives up loudly if every roll is taken', () => {
  assert.throws(() => mintSessionId(() => 0, () => true), /unused session id/);
});

test('play numbers: count per sentence from 1; peek does not consume', () => {
  const counter = createPlayCounter();
  assert.equal(counter.peek(0), 1);
  assert.equal(counter.peek(0), 1);
  assert.equal(counter.next(0), 1);
  assert.equal(counter.next(1), 1);
  assert.equal(counter.peek(0), 2);
  assert.equal(counter.next(0), 2);
  assert.equal(counter.next(1), 2);
  assert.equal(counter.next(2), 1);
});

// --- E12: ring buffer ---------------------------------------------------------

test('E12: 2,005 events across three sessions keep exactly 2,000, oldest five dropped, in order', () => {
  let events = [];
  const sessions = ['aaaaaa', 'bbbbbb', 'cccccc'];
  for (let n = 0; n < 2005; n++) {
    const sessionId = sessions[Math.floor(n / 669)];
    events = appendCapped(events, { t: n, type: 'play', sessionId, index: n });
  }
  assert.equal(events.length, 2000);
  assert.equal(events[0].index, 5, 'the oldest five (0-4) are the ones dropped');
  assert.equal(events[1999].index, 2004);
  assert.deepEqual(events.map((e) => e.index), Array.from({ length: 2000 }, (_, i) => i + 5));
});

test('E12: the debug log caps memory and the stored copy at 2,000', async () => {
  const storage = createStorageArea();
  const log = createDebugLog({ storage });
  for (let n = 0; n < 2005; n++) log.append({ t: n, type: 'play', index: n });
  const all = await log.getAll();
  assert.equal(all.length, 2000);
  assert.equal(all[0].index, 5);
  assert.equal(await log.flush(), true);
  const stored = storage.snapshot().ttsDebugLog;
  assert.equal(stored.length, 2000);
  assert.equal(stored[0].index, 5);
  assert.equal(stored[1999].index, 2004);
});

test('E12: a stored log longer than the cap is trimmed to the newest 2,000 on load', async () => {
  const big = Array.from({ length: 2300 }, (_, i) => ({ t: i, type: 'play', index: i }));
  const log = createDebugLog({ storage: createStorageArea({ ttsDebugLog: big }) });
  const all = await log.getAll();
  assert.equal(all.length, 2000);
  assert.equal(all[0].index, 300);
});

test('E12: a failed storage set keeps the in-memory events and retries on the next flush', async () => {
  const storage = createStorageArea();
  const errors = [];
  const log = createDebugLog({ storage, onError: (e) => errors.push(e) });
  storage.failNextSets(1);
  log.append({ t: 1, type: 'a' });
  await settle();
  assert.equal(errors.length, 1);
  assert.equal(storage.snapshot().ttsDebugLog, undefined, 'nothing stored yet');
  assert.deepEqual(await log.getAll(), [{ t: 1, type: 'a' }], 'still in memory');

  log.append({ t: 2, type: 'b' });
  await settle();
  assert.deepEqual(storage.snapshot().ttsDebugLog, [{ t: 1, type: 'a' }, { t: 2, type: 'b' }]);
});

test('E12: two appends during one flush are neither lost nor duplicated', async () => {
  const storage = createStorageArea();
  const log = createDebugLog({ storage });
  log.append({ t: 1, type: 'first' });
  await settle(2);
  // Make the next write slow, then append twice while it is in flight.
  const release = storage.holdNextSet();
  log.append({ t: 2, type: 'second' });
  await settle(2);
  log.append({ t: 3, type: 'third' });
  log.append({ t: 4, type: 'fourth' });
  release();
  await settle();
  assert.deepEqual(storage.snapshot().ttsDebugLog.map((e) => e.type), ['first', 'second', 'third', 'fourth']);
  assert.deepEqual((await log.getAll()).map((e) => e.type), ['first', 'second', 'third', 'fourth']);
});

test('Added: Clear while a flush is in flight does not bring cleared events back', async () => {
  const storage = createStorageArea();
  const log = createDebugLog({ storage });
  log.append({ t: 1, type: 'old' });
  await settle();
  const release = storage.holdNextSet();
  log.append({ t: 2, type: 'old-in-flight' });
  await settle(2);
  const cleared = log.clear(); // the in-flight write still holds old events
  release();
  assert.equal(await cleared, true);
  await settle();
  assert.deepEqual(storage.snapshot().ttsDebugLog, []);
  assert.deepEqual(await log.getAll(), []);
  log.append({ t: 3, type: 'after-clear' });
  await settle();
  assert.deepEqual(storage.snapshot().ttsDebugLog.map((e) => e.type), ['after-clear']);
});

test('Added: Clear before the stored log has loaded does not resurrect stored events', async () => {
  const storage = createStorageArea({ ttsDebugLog: [{ t: 1, type: 'stored' }] });
  const log = createDebugLog({ storage });
  assert.equal(await log.clear(), true);
  assert.deepEqual(await log.getAll(), []);
  assert.deepEqual(storage.snapshot().ttsDebugLog, []);
});

test('Added: Clear while a failing hydration read is pending still clears and keeps logging', async () => {
  const inner = createStorageArea({ ttsDebugLog: [{ t: 1, type: 'stored' }] });
  let rejectGet;
  let getCalls = 0;
  const storage = {
    get(key) {
      getCalls++;
      if (getCalls === 1) return new Promise((_, reject) => { rejectGet = reject; });
      return inner.get(key);
    },
    set: (items) => inner.set(items)
  };
  const errors = [];
  const log = createDebugLog({ storage, onError: (e) => errors.push(e) });
  log.append({ t: 2, type: 'b' }); // starts the hydration read, which stays pending
  await settle();
  assert.equal(getCalls, 1);
  const cleared = log.clear();
  rejectGet(new Error('storage read failed'));
  assert.equal(await cleared, true, 'clear succeeds');
  await settle();
  assert.deepEqual(inner.snapshot().ttsDebugLog, [], 'the old stored log is gone');
  assert.deepEqual(await log.getAll(), []);
  log.append({ t: 3, type: 'after-clear' });
  await settle();
  assert.deepEqual(inner.snapshot().ttsDebugLog.map((e) => e.type), ['after-clear'], 'later events are stored');
  assert.equal(getCalls, 1, 'no further read is needed after a clear');
});

test('Added: a corrupt or non-array ttsDebugLog value is treated as empty, not thrown', async () => {
  const bad = ['garbage', 42, { not: 'an array' }, null, true];
  for (const value of bad) {
    const storage = createStorageArea({ ttsDebugLog: value });
    const log = createDebugLog({ storage });
    assert.deepEqual(await log.getAll(), [], `value ${JSON.stringify(value)}`);
    log.append({ t: 1, type: 'ok' });
    await settle();
    assert.deepEqual(storage.snapshot().ttsDebugLog, [{ t: 1, type: 'ok' }]);
  }
  // Arrays with junk entries keep only the object entries.
  const mixed = createDebugLog({ storage: createStorageArea({ ttsDebugLog: [1, null, 'x', { t: 5, type: 'real' }, [3]] }) });
  assert.deepEqual(await mixed.getAll(), [{ t: 5, type: 'real' }]);
});

test('hydration: events appended before the stored log loads come after the stored ones', async () => {
  const storage = createStorageArea({ ttsDebugLog: [{ t: 1, type: 'stored' }] });
  const log = createDebugLog({ storage });
  log.append({ t: 2, type: 'new' });
  await settle();
  assert.deepEqual(storage.snapshot().ttsDebugLog.map((e) => e.type), ['stored', 'new']);
});

test('hydration: a failed read is retried and never overwrites the stored log', async () => {
  const stored = [{ t: 1, type: 'stored' }];
  const storage = createStorageArea({ ttsDebugLog: stored });
  const realGet = storage.get;
  let fail = true;
  storage.get = function (...args) {
    if (fail) return Promise.reject(new Error('storage unavailable'));
    return realGet.apply(this, args);
  };
  const log = createDebugLog({ storage });
  log.append({ t: 2, type: 'new' });
  await settle();
  assert.deepEqual(storage.snapshot().ttsDebugLog, stored, 'stored log untouched while it could not be read');
  fail = false;
  await log.flush();
  assert.deepEqual(storage.snapshot().ttsDebugLog.map((e) => e.type), ['stored', 'new']);
});

// --- sanitizeError ---------------------------------------------------------------

test('sanitizeError strips URLs of every shape', () => {
  const table = [
    ['https url', 'Failed to load https://example.test/private?q=1', 'Failed to load [url]'],
    ['http url', 'POST http://localhost:8000/v1/audio/speech failed', 'POST [url] failed'],
    ['chrome-extension url', 'Error at chrome-extension://abcdefghijklmnopabcdefghijklmnop/background.js:12', 'Error at [url]'],
    ['query string only', 'bad request ?token=SECRET&x=1 rejected', 'bad request [url] rejected'],
    ['url mid-sentence', 'The fetch to https://a.test/x?y=2 timed out, retrying', 'The fetch to [url] timed out, retrying'],
    ['url before a full stop', 'See https://a.test/path.', 'See [url].'],
    ['two urls', 'https://a.test/1 then http://b.test/2', '[url] then [url]'],
    ['no url', 'Failed to fetch', 'Failed to fetch'],
    ['Error object', new Error('HTTP error! status: 500'), 'HTTP error! status: 500'],
    ['Error object with url', new TypeError('NetworkError for https://x.test/y'), 'NetworkError for [url]'],
    ['non-error value', undefined, '']
  ];
  for (const [name, input, expected] of table) {
    assert.equal(sanitizeError(input), expected, name);
  }
});

test('sanitizeError caps length', () => {
  const out = sanitizeError('x'.repeat(5000));
  assert.ok(out.length <= 200);
});

// --- sha256Prefix --------------------------------------------------------------------

test('sha256Prefix: known vector abc -> ba7816bf8f01cfea', async () => {
  assert.equal(await sha256Prefix(new TextEncoder().encode('abc')), 'ba7816bf8f01cfea');
  assert.equal(await sha256Prefix(new TextEncoder().encode('abc').buffer), 'ba7816bf8f01cfea');
});

test('sha256Prefix: agrees with node:crypto on arbitrary bytes and is 16 hex chars', async () => {
  const bytes = nodeCrypto.randomBytes(1000);
  const expected = nodeCrypto.createHash('sha256').update(bytes).digest('hex').slice(0, 16);
  const got = await sha256Prefix(bytes);
  assert.equal(got, expected);
  assert.match(got, /^[0-9a-f]{16}$/);
});

// --- buildEvent ----------------------------------------------------------------------

test('buildEvent keeps allowed fields and drops text, URLs and unknown keys', () => {
  const event = buildEvent('play', {
    sessionId: 'abc123',
    index: 2,
    playNumber: 1,
    sentence: 'SECRET-SENTENCE-TEXT',
    url: 'https://example.test/private?q=1',
    mode: 'selection',
    hash: 'ba7816bf8f01cfea',
    bytes: 1234
  }, 1000);
  assert.deepEqual(event, {
    t: 1000, type: 'play', index: 2, playNumber: 1, bytes: 1234,
    sessionId: 'abc123', hash: 'ba7816bf8f01cfea', mode: 'selection'
  });
});

test('buildEvent rejects malformed values for allowed fields', () => {
  const event = buildEvent('x', {
    sessionId: 'SECRET-SENTENCE-TEXT',
    hash: 'not-a-hash',
    mode: 'https://example.test',
    outcome: 'a sentence with spaces',
    index: '3',
    bytes: 1.5,
    extensionId: 'https://x.test'
  }, 1);
  assert.deepEqual(event, { t: 1, type: 'x' });
});

test('buildEvent runs error text through sanitizeError', () => {
  const event = buildEvent('error', { error: new Error('failed https://example.test/private?q=1') }, 1);
  assert.equal(event.error, 'failed [url]');
});

// --- summariseLog ---------------------------------------------------------------------

test('summariseLog: one row per session, index and play number', () => {
  const ext = { extensionId: 'fakeextensionid', version: '1.0' };
  const events = [
    { t: 1, type: 'session-start', sessionId: 'aaaaaa', ...ext },
    { t: 2, type: 'fetch', sessionId: 'aaaaaa', index: 0, playNumber: 1, attempt: 1, outcome: 'timeout' },
    { t: 3, type: 'fetch', sessionId: 'aaaaaa', index: 0, playNumber: 1, attempt: 2, outcome: 'ok', bytes: 100, hash: '0123456789abcdef' },
    { t: 4, type: 'fetch', sessionId: 'aaaaaa', index: 1, playNumber: 1, attempt: 1, outcome: 'ok', bytes: 200, hash: 'fedcba9876543210' },
    { t: 5, type: 'play', sessionId: 'aaaaaa', index: 0, playNumber: 1 },
    { t: 6, type: 'audio-ready', sessionId: 'aaaaaa', index: 0, playNumber: 1, audioElements: 1 },
    { t: 7, type: 'chunk-ended', sessionId: 'aaaaaa', index: 0, playNumber: 1 },
    { t: 8, type: 'play', sessionId: 'aaaaaa', index: 1, playNumber: 1 },
    { t: 9, type: 'play', sessionId: 'aaaaaa', index: 1, playNumber: 2 }, // a replay is its own row
    { t: 10, type: 'session-start', sessionId: 'bbbbbb', extensionId: 'otherextid', version: '2.0' },
    { t: 11, type: 'play', sessionId: 'bbbbbb', index: 0, playNumber: 1 },
    { t: 12, type: 'timeless-event-without-ids' },
    { t: 13, type: 'session-end', sessionId: 'aaaaaa', reason: 'user' }
  ];
  const rows = summariseLog(events);
  assert.deepEqual(rows, [
    { sessionId: 'aaaaaa', index: 0, playNumber: 1, bytes: 100, hash: '0123456789abcdef', fetchCount: 2, playCount: 1, endedCount: 1, audioElements: 1, ...ext },
    { sessionId: 'aaaaaa', index: 1, playNumber: 1, bytes: 200, hash: 'fedcba9876543210', fetchCount: 1, playCount: 1, endedCount: 0, audioElements: null, ...ext },
    { sessionId: 'aaaaaa', index: 1, playNumber: 2, bytes: null, hash: null, fetchCount: 0, playCount: 1, endedCount: 0, audioElements: null, ...ext },
    { sessionId: 'bbbbbb', index: 0, playNumber: 1, bytes: null, hash: null, fetchCount: 0, playCount: 1, endedCount: 0, audioElements: null, extensionId: 'otherextid', version: '2.0' }
  ]);
});

test('summariseLog: empty and missing input give no rows', () => {
  assert.deepEqual(summariseLog([]), []);
  assert.deepEqual(summariseLog(undefined), []);
});

// --- F6: the pure module has no chrome or DOM ------------------------------------------------

test('F6: lib/playback.js loads in node with no chrome global and mentions no chrome.* or DOM', () => {
  assert.equal(typeof chrome, 'undefined');
  const sandbox = {};
  sandbox.self = sandbox; // a worker-like global, but with no `chrome`, `document` or `window`
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'lib', 'playback.js'), 'utf8'), sandbox);
  assert.equal(typeof sandbox.TTSPlayback.createPlayLedger, 'function');
  assert.equal(typeof sandbox.TTSPlayback.stallTimeoutMs, 'function');

  const code = fs.readFileSync(path.join(ROOT, 'lib', 'playback.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/\bchrome\b|\bdocument\b|\bwindow\b|\bnavigator\b/.test(code));
});

// --- E8: start tokens -------------------------------------------------------------------------

test('E8: the latest start token wins; earlier ones are superseded whatever order they finish in', () => {
  const tokens = createStartTokens();
  const first = tokens.next();
  assert.equal(tokens.isCurrent(first), true);
  const second = tokens.next();
  assert.notEqual(first, second);
  assert.equal(tokens.isCurrent(first), false, 'the earlier start is superseded');
  assert.equal(tokens.isCurrent(second), true);
  const third = tokens.next();
  assert.deepEqual([first, second, third].map((t) => tokens.isCurrent(t)), [false, false, true]);
});

test('E8: separate token sources do not affect each other, and a made-up token is never current', () => {
  const a = createStartTokens();
  const b = createStartTokens();
  const t = a.next();
  b.next();
  b.next();
  assert.equal(a.isCurrent(t), true);
  assert.equal(a.isCurrent(undefined), false);
  assert.equal(a.isCurrent(t + 1), false);
});

// --- E8 / E9: the play ledger ---------------------------------------------------------------------

test('E9: the ledger accepts each (session id, index, play number) once', () => {
  const ledger = createPlayLedger();
  ledger.begin('aaaaaa');
  assert.deepEqual(ledger.accept('aaaaaa', 0, 1), { ok: true });
  assert.deepEqual(ledger.accept('aaaaaa', 0, 1), { ok: false, reason: 'duplicate' });
  assert.deepEqual(ledger.accept('aaaaaa', 0, 1), { ok: false, reason: 'duplicate' }, 'still a duplicate the third time');
  assert.deepEqual(ledger.accept('aaaaaa', 1, 1), { ok: true }, 'another index is a new triple');
});

test('E9: a new play number for the same sentence is a new attempt; an older one is rejected', () => {
  const ledger = createPlayLedger();
  ledger.begin('aaaaaa');
  assert.equal(ledger.accept('aaaaaa', 3, 1).ok, true);
  assert.equal(ledger.accept('aaaaaa', 3, 2).ok, true, 'a replay');
  assert.deepEqual(ledger.accept('aaaaaa', 3, 1), { ok: false, reason: 'duplicate' });
  const ledger2 = createPlayLedger();
  ledger2.begin('aaaaaa');
  ledger2.accept('aaaaaa', 3, 2);
  assert.deepEqual(ledger2.accept('aaaaaa', 3, 1), { ok: false, reason: 'stale-play' }, '1 was never accepted but 2 already was');
  assert.equal(ledger2.accept('aaaaaa', 4, 1).ok, true, 'play numbers are per sentence');
});

test('E8: the ledger rejects other and replaced session ids', () => {
  const ledger = createPlayLedger();
  assert.deepEqual(ledger.accept('aaaaaa', 0, 1), { ok: false, reason: 'stale-session' }, 'no live session yet');
  ledger.begin('aaaaaa');
  assert.equal(ledger.accept('aaaaaa', 0, 1).ok, true);
  assert.deepEqual(ledger.accept('bbbbbb', 0, 1), { ok: false, reason: 'stale-session' }, 'not the live session');
  ledger.begin('bbbbbb');
  assert.equal(ledger.current, 'bbbbbb');
  assert.deepEqual(ledger.accept('aaaaaa', 1, 1), { ok: false, reason: 'stale-session' }, 'replaced');
  assert.equal(ledger.accept('bbbbbb', 0, 1).ok, true, 'the new session starts with an empty ledger');
  assert.equal(ledger.begin('aaaaaa'), false, 'a retired id cannot come back');
  assert.equal(ledger.current, 'bbbbbb');
});

test('E8: retire() ends the live session for good', () => {
  const ledger = createPlayLedger();
  ledger.begin('aaaaaa');
  ledger.retire('aaaaaa');
  assert.equal(ledger.current, null);
  assert.deepEqual(ledger.accept('aaaaaa', 0, 1), { ok: false, reason: 'stale-session' });
  assert.deepEqual(ledger.accept('aaaaaa', 0, 1, { adopt: true }), { ok: false, reason: 'stale-session' }, 'adopt cannot revive it');
  ledger.retire(null); // harmless
  ledger.retire(undefined);
});

test('E9: adopt lets a receiver learn the live session from its first message', () => {
  const ledger = createPlayLedger();
  assert.equal(ledger.accept('aaaaaa', 0, 1, { adopt: true }).ok, true);
  assert.equal(ledger.current, 'aaaaaa');
  assert.deepEqual(ledger.accept('aaaaaa', 0, 1, { adopt: true }), { ok: false, reason: 'duplicate' });
  assert.equal(ledger.accept('bbbbbb', 0, 1, { adopt: true }).ok, true, 'a newer session replaces it');
  assert.deepEqual(ledger.accept('aaaaaa', 1, 1, { adopt: true }), { ok: false, reason: 'stale-session' }, 'and the old one is retired');
});

test('E9: malformed ids are rejected as invalid', () => {
  const ledger = createPlayLedger();
  ledger.begin('aaaaaa');
  for (const args of [
    [undefined, 0, 1], [null, 0, 1], [7, 0, 1],
    ['aaaaaa', -1, 1], ['aaaaaa', 1.5, 1], ['aaaaaa', '0', 1], ['aaaaaa', NaN, 1], ['aaaaaa', undefined, 1],
    ['aaaaaa', 0, 0], ['aaaaaa', 0, -2], ['aaaaaa', 0, 1.5], ['aaaaaa', 0, null], ['aaaaaa', 0, undefined]
  ]) {
    assert.deepEqual(ledger.accept(...args), { ok: false, reason: 'invalid' }, JSON.stringify(args));
  }
  assert.equal(ledger.accept('aaaaaa', 0, 1).ok, true, 'rejected input left the ledger untouched');
});

test('the ledger remembers only a bounded number of retired sessions', () => {
  const ledger = createPlayLedger();
  for (let i = 0; i < 120; i++) ledger.begin(`s${String(i).padStart(5, '0')}`);
  assert.equal(ledger.current, 's00119');
  assert.equal(ledger.accept('s00118', 0, 1).ok, false, 'a recent one is still known to be stale');
  assert.equal(ledger.accept('s00000', 0, 1).reason, 'stale-session', 'an ancient one is stale too: it is not the live session');
});

test('staleReason: names which part of a message does not match the live sentence', () => {
  const live = { sessionId: 'aaaaaa', index: 2, playNumber: 1 };
  assert.equal(staleReason(live, { sessionId: 'aaaaaa', index: 2, playNumber: 1 }), null);
  assert.equal(staleReason(null, { sessionId: 'aaaaaa', index: 2, playNumber: 1 }), 'no-session');
  assert.equal(staleReason(live, { sessionId: 'bbbbbb', index: 2, playNumber: 1 }), 'stale-session');
  assert.equal(staleReason(live, { index: 2, playNumber: 1 }), 'stale-session');
  assert.equal(staleReason(live, undefined), 'stale-session');
  assert.equal(staleReason(live, { sessionId: 'aaaaaa', index: 1, playNumber: 1 }), 'stale-index');
  assert.equal(staleReason(live, { sessionId: 'aaaaaa', index: 2, playNumber: 2 }), 'stale-play', 'newer play number');
  assert.equal(staleReason({ ...live, playNumber: 2 }, { sessionId: 'aaaaaa', index: 2, playNumber: 1 }), 'stale-play', 'older play number');
  assert.equal(staleReason(live, { sessionId: 'aaaaaa', index: 2 }), 'stale-play');
});

// --- E10: stall timeout ------------------------------------------------------------------------------

test('E10: stallTimeoutMs table: duration + 5 s when known, 60 s when not, none while paused', () => {
  const table = [
    ['duration known, 2 s', { durationSec: 2 }, 7000],
    ['duration known, 0.25x speed, 40 s sentence', { durationSec: 40 }, 45000],
    ['duration known, fractional', { durationSec: 1.2345 }, 6235],
    ['duration known, very short', { durationSec: 0.001 }, 5001],
    ['duration unknown (undefined)', { durationSec: undefined }, 60000],
    ['duration unknown (no argument object fields)', {}, 60000],
    ['NaN', { durationSec: NaN }, 60000],
    ['null (NaN after JSON)', { durationSec: null }, 60000],
    ['zero', { durationSec: 0 }, 60000],
    ['negative', { durationSec: -3 }, 60000],
    ['Infinity', { durationSec: Infinity }, 60000],
    ['a string', { durationSec: '40' }, 60000],
    ['paused, duration known', { durationSec: 40, paused: true }, null],
    ['paused, duration unknown', { durationSec: NaN, paused: true }, null],
    ['paused false is not paused', { durationSec: 40, paused: false }, 45000]
  ];
  for (const [name, args, expected] of table) {
    assert.equal(stallTimeoutMs(args), expected, name);
  }
  assert.equal(stallTimeoutMs(), 60000, 'no argument at all');
  assert.equal(TTSPlayback.STALL_GRACE_MS, 5000);
  assert.equal(TTSPlayback.HANG_TIMEOUT_MS, 60000);
});

test('E10: isUsableDuration accepts only finite numbers above zero', () => {
  for (const good of [0.001, 1, 40, 3600]) assert.equal(isUsableDuration(good), true, String(good));
  for (const bad of [0, -1, NaN, Infinity, -Infinity, null, undefined, '5', {}, [], true]) {
    assert.equal(isUsableDuration(bad), false, String(bad));
  }
});

test('summariseLog: dropped messages, stalls and durations do not add rows for ids that never played', () => {
  const rows = summariseLog([
    { t: 1, type: 'session-start', sessionId: 'aaaaaa', extensionId: 'x', version: '1.0' },
    { t: 2, type: 'play', sessionId: 'aaaaaa', index: 0, playNumber: 1 },
    { t: 3, type: 'dropped-chunk-ended', sessionId: 'aaaaaa', index: 0, playNumber: 7, reason: 'stale-play' },
    { t: 4, type: 'dropped-chunk-ended', sessionId: 'bbbbbb', index: 0, playNumber: 1, reason: 'stale-session' },
    { t: 5, type: 'stall', sessionId: 'aaaaaa', index: 0, playNumber: 1, ms: 60000 },
    { t: 6, type: 'audio-duration', sessionId: 'aaaaaa', index: 0, playNumber: 1, ms: 4000 }
  ]);
  assert.deepEqual(rows.map((r) => [r.sessionId, r.index, r.playNumber]), [['aaaaaa', 0, 1]]);
});
