'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const nodeCrypto = require('node:crypto');

const {
  loadBackground, settle, createFakeFetch, okResponse, audioBytesFor, hangUntilAbort
} = require('./helpers/fake-chrome.js');
const { SETTINGS, startRead, playChunks, finishChunk, readToEnd, downloadLog } = require('./helpers/session.js');

const SENTENCES = ['First sentence here.', 'Second sentence here.', 'Third sentence here.'];

function eventsOf(log, type) {
  return log.events.filter((e) => e.type === type);
}

// Float sequence that mints exactly the given ids, in order.
function rngForIds(...ids) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const queue = ids.join('').split('').map((c) => (alphabet.indexOf(c) + 0.5) / 36);
  return () => (queue.length ? queue.shift() : 0.5);
}

// --- Existing behaviour, as on origin/main -------------------------------------

test('existing behaviour: a 3-sentence read plays indices 0, 1, 2 once each and ends stopped', async () => {
  const bg = loadBackground({ sentences: SENTENCES });
  await startRead(bg);
  await readToEnd(bg, 3);

  assert.deepEqual(playChunks(bg).map((m) => m.index), [0, 1, 2]);
  const states = bg.sentOfType('playerStateUpdate').map((m) => m.state);
  assert.equal(states[states.length - 1], 'stopped');
  assert.deepEqual(await bg.send({ type: 'getPlayerState' }), { state: 'stopped' });
  assert.equal(bg.fetch.calls.length, 3, 'each sentence fetched once');
  // The highlight follows each sentence and is cleared at the end.
  assert.deepEqual(
    bg.tabMessages.filter((m) => m.message.type === 'ttsHighlightSentence').map((m) => m.message.index),
    [0, 1, 2]
  );
  assert.equal(bg.tabMessages.filter((m) => m.message.type === 'ttsClearHighlight').length, 1);
});

// --- Ids and log events for a normal read --------------------------------------

test('a read of 3 sentences: ids on every playChunk, and the expected events per sentence', async () => {
  const bg = loadBackground({ sentences: SENTENCES, extensionId: 'fakeextensionid', version: '1.0' });
  await startRead(bg);
  await readToEnd(bg, 3);
  const log = await downloadLog(bg);

  const chunks = playChunks(bg);
  const sessionId = chunks[0].sessionId;
  assert.match(sessionId, /^[a-z0-9]{6}$/);
  assert.notEqual(sessionId, '1', 'not the content script numeric id');
  chunks.forEach((chunk, i) => {
    assert.equal(chunk.sessionId, sessionId);
    assert.equal(chunk.index, i);
    assert.equal(chunk.playNumber, 1);
  });

  // GP1: session-start, fetch, play for this session, with no setting turned on.
  const types = log.events.filter((e) => e.sessionId === sessionId).map((e) => e.type);
  assert.deepEqual(types.slice(0, 3), ['session-start', 'sentences', 'fetch']);
  assert.ok(types.indexOf('play') > types.indexOf('fetch'));
  assert.equal(eventsOf(log, 'session-start').length, 1);
  assert.equal(eventsOf(log, 'session-start')[0].extensionId, 'fakeextensionid');
  assert.equal(eventsOf(log, 'session-start')[0].version, '1.0');
  assert.equal(eventsOf(log, 'sentences')[0].count, 3);
  assert.equal(eventsOf(log, 'session-end').length, 1);
  assert.equal(eventsOf(log, 'session-end')[0].reason, 'finished');

  // GP6: one summary row per sentence with the documented fields.
  assert.equal(log.sentences.length, 3);
  log.sentences.forEach((row, i) => {
    const input = bg.fetch.calls[i].body.input;
    const bytes = audioBytesFor(input);
    assert.deepEqual(row, {
      sessionId,
      index: i,
      playNumber: 1,
      bytes: bytes.length,
      hash: nodeCrypto.createHash('sha256').update(bytes).digest('hex').slice(0, 16),
      fetchCount: 1,
      playCount: 1,
      endedCount: 1,
      audioElements: 1,
      extensionId: 'fakeextensionid',
      version: '1.0'
    });
  });
  assert.equal(log.extensionId, 'fakeextensionid');
  assert.equal(log.version, '1.0');
});

test('the log is stored under ttsDebugLog in chrome.storage.local, written by the background', async () => {
  const bg = loadBackground({ sentences: SENTENCES });
  await startRead(bg);
  await readToEnd(bg, 3);
  await settle();
  const stored = bg.chrome.storage.local.snapshot().ttsDebugLog;
  const log = await downloadLog(bg);
  assert.ok(Array.isArray(stored));
  assert.deepEqual(stored, log.events);
  assert.equal(bg.chrome.storage.session.snapshot().ttsDebugLog, undefined);
});

test('a timeout retry is counted as two fetches', async () => {
  const fetchFn = createFakeFetch(({ call, signal, body }) =>
    call === 1 ? hangUntilAbort(signal) : okResponse(audioBytesFor(body.input)));
  const bg = loadBackground({ sentences: ['Only sentence here.'], fetch: fetchFn });
  const started = startRead(bg);
  await settle();
  await bg.timers.tick(55000); // first-chunk timeout
  await started;

  const log = await downloadLog(bg);
  const fetches = eventsOf(log, 'fetch');
  assert.deepEqual(fetches.map((e) => [e.index, e.attempt, e.outcome]), [[0, 1, 'timeout'], [0, 2, 'ok']]);
  assert.equal(log.sentences.length, 1);
  assert.equal(log.sentences[0].fetchCount, 2);
  assert.equal(log.sentences[0].playCount, 1);
  assert.equal(playChunks(bg).length, 1, 'the retry still plays once');
});

test('a stall advance (60 s, duration unknown) is logged and the next sentence plays', async () => {
  const bg = loadBackground({ sentences: SENTENCES });
  await startRead(bg);
  assert.equal(playChunks(bg).length, 1);
  await bg.timers.tick(20000);
  assert.equal(playChunks(bg).length, 1, 'the old fixed 20 s watchdog is gone');
  await bg.timers.tick(40000);

  const log = await downloadLog(bg);
  const stalls = eventsOf(log, 'stall');
  assert.equal(stalls.length, 1);
  assert.equal(stalls[0].index, 0);
  assert.equal(stalls[0].playNumber, 1);
  assert.equal(stalls[0].ms, 60000);
  assert.equal(stalls[0].sessionId, playChunks(bg)[0].sessionId);
  assert.deepEqual(playChunks(bg).map((m) => m.index), [0, 1]);
});

test('an HTTP error is logged with its status and stops the session', async () => {
  const fetchFn = createFakeFetch(() => ({ ok: false, status: 500 }));
  const bg = loadBackground({ sentences: SENTENCES, fetch: fetchFn });
  await startRead(bg);
  const log = await downloadLog(bg);
  const fetches = eventsOf(log, 'fetch');
  assert.equal(fetches.length, 1);
  assert.equal(fetches[0].outcome, 'http-error');
  assert.equal(fetches[0].status, 500);
  assert.equal(eventsOf(log, 'session-end')[0].reason, 'error');
  assert.equal(playChunks(bg).length, 0);
});

// --- Session ids ----------------------------------------------------------------

test('a new session never reuses the id of the live session it replaces', async () => {
  const bg = loadBackground({
    sentences: SENTENCES,
    random: rngForIds('abc123', 'abc123', 'xyz789')
  });
  await startRead(bg);
  assert.equal(playChunks(bg)[0].sessionId, 'abc123');
  await startRead(bg);
  const second = playChunks(bg).filter((m) => m.sessionId !== 'abc123');
  assert.equal(second.length, 1, 'the second session plays under a new id');
  assert.equal(second[0].sessionId, 'xyz789');
});

// --- Restart, clear and flush races -------------------------------------------------

test('the log survives a worker restart (hydrated on first use)', async () => {
  const first = loadBackground({ sentences: SENTENCES });
  await startRead(first);
  await readToEnd(first, 3);
  await settle();
  const before = await downloadLog(first);

  // A new worker over the same storage.
  const second = loadBackground({
    sentences: SENTENCES,
    localStorage: first.chrome.storage.local.snapshot()
  });
  const afterRestart = await downloadLog(second);
  assert.deepEqual(afterRestart.events, before.events);

  await startRead(second);
  const grown = await downloadLog(second);
  assert.ok(grown.events.length > before.events.length);
  assert.deepEqual(grown.events.slice(0, before.events.length), before.events, 'old events first, new ones appended');
  assert.notEqual(playChunks(second)[0].sessionId, playChunks(first)[0].sessionId);
});

test('Clear empties the log, in memory and in storage', async () => {
  const bg = loadBackground({ sentences: SENTENCES });
  await startRead(bg);
  await readToEnd(bg, 3);
  assert.ok((await downloadLog(bg)).events.length > 0);

  assert.deepEqual(await bg.send({ type: 'clearDebugLog' }, { wait: true }), { success: true });
  await settle();
  assert.deepEqual(bg.chrome.storage.local.snapshot().ttsDebugLog, []);
  const log = await downloadLog(bg);
  assert.equal(log.events.length, 0);
  assert.deepEqual(log.sentences, []);
});

test('Clear while a flush is in flight does not bring events back', async () => {
  const bg = loadBackground({ sentences: SENTENCES });
  await startRead(bg);
  await settle();
  const release = bg.chrome.storage.local.holdNextSet();
  // A new event triggers a flush that is now stuck in flight.
  await bg.send({ type: 'chunkEnded', index: 0, sessionId: playChunks(bg)[0].sessionId, playNumber: 1 });
  await settle();
  const cleared = bg.send({ type: 'clearDebugLog' }, { wait: true });
  release();
  assert.deepEqual(await cleared, { success: true });
  await settle();
  assert.deepEqual(bg.chrome.storage.local.snapshot().ttsDebugLog, []);
  assert.equal((await downloadLog(bg)).events.length, 0);
});

test('a failed storage write keeps events and the next flush stores them', async () => {
  const bg = loadBackground({ sentences: SENTENCES });
  bg.chrome.storage.local.failNextSets(1);
  await startRead(bg);
  await settle();
  const log = await downloadLog(bg);
  assert.ok(log.events.length > 0, 'events kept in memory');
  assert.ok(bg.consoleCalls.warn.some((c) => String(c[0]).includes('Debug log write failed')));

  await bg.send({ type: 'chunkEnded', index: 0, sessionId: playChunks(bg)[0].sessionId, playNumber: 1 });
  await settle();
  const stored = bg.chrome.storage.local.snapshot().ttsDebugLog;
  assert.ok(stored.length >= log.events.length, 'everything, including the earlier events, was stored');
  assert.equal(stored[0].type, 'session-start');
});

test('a corrupt ttsDebugLog in storage is treated as empty by the background', async () => {
  const bg = loadBackground({ sentences: SENTENCES, localStorage: { ttsDebugLog: 'not an array' } });
  const log = await downloadLog(bg);
  assert.deepEqual(log.events, []);
  await startRead(bg);
  assert.ok((await downloadLog(bg)).events.length > 0);
});

test('Download works when the offscreen document is not up', async () => {
  const bg = loadBackground({ sentences: SENTENCES, offscreenUp: false });
  await startRead(bg); // creates the offscreen document...
  bg.closeOffscreen(); // ...which Chrome then closes
  const created = bg.createdOffscreen.length;
  const response = await bg.send({ type: 'getDebugLog' }, { wait: true });
  assert.equal(response.success, true);
  assert.ok(response.log.events.length > 0);
  assert.equal(bg.createdOffscreen.length, created, 'Download does not need or create the offscreen document');
});

test('Download and Clear work with no session ever started', async () => {
  const bg = loadBackground({ sentences: SENTENCES });
  const response = await bg.send({ type: 'getDebugLog' }, { wait: true });
  assert.equal(response.success, true);
  assert.deepEqual(response.log.events, []);
  assert.deepEqual(await bg.send({ type: 'clearDebugLog' }, { wait: true }), { success: true });
});

// --- F4: privacy and noise -----------------------------------------------------------

test('F4: no sentence text and no URLs reach the log or the downloaded file', async () => {
  const secret = 'SECRET-SENTENCE-TEXT';
  const tabUrl = 'https://example.test/private?q=1';
  const bg = loadBackground({
    sentences: [`${secret} comes first.`, `${secret} comes second.`],
    tabUrl
  });
  await startRead(bg);
  await finishChunk(bg, playChunks(bg)[0]);

  // Then a failure whose message carries both a URL and the sentence text.
  const failing = loadBackground({
    sentences: [`${secret} comes first.`],
    tabUrl,
    fetch: createFakeFetch(() => {
      throw new TypeError(`Failed to fetch ${tabUrl}`);
    })
  });
  await startRead(failing);

  for (const run of [bg, failing]) {
    await settle();
    const file = JSON.stringify(await downloadLog(run));
    const stored = JSON.stringify(run.chrome.storage.local.snapshot());
    for (const text of [file, stored]) {
      assert.ok(!text.includes(secret), 'no sentence text');
      assert.ok(!text.includes('example.test'), 'no page URL');
      assert.ok(!text.includes('q=1'), 'no query string');
      assert.ok(!text.includes('://'), 'no URL of any kind (not even the TTS server)');
    }
  }
  const failedLog = await downloadLog(failing);
  assert.equal(eventsOf(failedLog, 'fetch')[0].outcome, 'error');
  assert.equal(eventsOf(failedLog, 'fetch')[0].error, 'Failed to fetch [url]');
});

test('F4: 500 timeUpdate messages (and seek / time queries) add zero events', async () => {
  const bg = loadBackground({ sentences: SENTENCES });
  await startRead(bg);
  await settle();
  const before = (await downloadLog(bg)).events.length;
  for (let i = 0; i < 500; i++) {
    await bg.send({ type: 'timeUpdate', timeInfo: { currentTime: i / 10, duration: 50 } });
  }
  await bg.send({ type: 'seek', time: 3 });
  await bg.send({ type: 'getTimeInfo' });
  await settle();
  const after = (await downloadLog(bg)).events.length;
  assert.equal(after, before);
  assert.deepEqual(bg.chrome.storage.local.snapshot().ttsDebugLog.length, before);
});

test('F4: the only URL ever fetched is the configured server URL', async () => {
  const serverUrl = 'http://tts.example.invalid:9999/v1/audio/speech';
  const bg = loadBackground({ sentences: SENTENCES });
  await startRead(bg, { ...SETTINGS, serverUrl });
  await readToEnd(bg, 3);
  await bg.send({ type: 'getDebugLog' }, { wait: true });
  await bg.send({ type: 'clearDebugLog' }, { wait: true });
  assert.equal(bg.fetch.calls.length, 3);
  for (const call of bg.fetch.calls) assert.equal(call.url, serverUrl);
});

test('the log is appended to by the background only: offscreen and popup messages cannot add events', async () => {
  const bg = loadBackground({ sentences: SENTENCES });
  // There is no message type that appends an arbitrary event.
  const before = (await downloadLog(bg)).events.length;
  await bg.send({ type: 'appendDebugLog', event: { type: 'forged' } });
  await bg.send({ type: 'logEvent', event: { type: 'forged' } });
  await settle();
  const log = await downloadLog(bg);
  assert.equal(log.events.length, before);
  assert.ok(!JSON.stringify(log).includes('forged'));
});

test('forged ids in an echoed message cannot smuggle text into the log', async () => {
  const bg = loadBackground({ sentences: SENTENCES });
  await startRead(bg);
  await bg.send({
    type: 'audioReady',
    sessionId: 'SECRET-SENTENCE-TEXT',
    index: 'https://example.test/x',
    playNumber: 1.5,
    audioElements: 'many'
  });
  await settle();
  const log = await downloadLog(bg);
  const ready = eventsOf(log, 'audio-ready')[0];
  assert.deepEqual(Object.keys(ready).sort(), ['t', 'type']);
});
