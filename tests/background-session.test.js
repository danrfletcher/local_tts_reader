'use strict';
/**
 * background.js (loaded in a vm context, importScripts loading lib/playback.js
 * and textProcessor.js) under overlapping starts, duplicate and stale
 * messages, and the stall timer. Timers are the manual clock from
 * helpers/fake-chrome.js, so nothing waits in real time. Fake
 * chrome.scripting.executeScript, chrome.tabs.query and fetch resolve on
 * promises the test controls, so the order of resolution is explicit.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');

const {
  loadBackground, settle, createFakeFetch, okResponse, audioBytesFor, hangUntilAbort
} = require('./helpers/fake-chrome.js');
const { SETTINGS, startRead, playChunks, finishChunk, readToEnd, downloadLog } = require('./helpers/session.js');
const { loadOffscreen } = require('./helpers/offscreen.js');

const SENTENCES = ['First sentence here.', 'Second sentence here.', 'Third sentence here.'];
const ALARM = 'tts-reader-keepalive';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** The session object inside the worker (a top-level `let`, so read it through the context). */
function liveSession(bg) {
  return vm.runInContext('session', bg.context);
}

function eventsOf(log, type) {
  return log.events.filter((e) => e.type === type);
}

/**
 * Replace chrome.scripting.executeScript with calls that wait for the test.
 * Every call is recorded as { kind: 'probe' | 'inject' | 'prepare', ... }; the
 * test answers each with answer(call), in whatever order it likes.
 */
function controlScripting(bg, { sentences = SENTENCES } = {}) {
  const calls = [];
  let contentSessionId = 0;
  bg.chrome.scripting.executeScript = (opts) => {
    const kind = opts.target.allFrames ? 'probe' : opts.files ? 'inject' : 'prepare';
    const d = deferred();
    const call = { kind, opts, ...d };
    calls.push(call);
    return d.promise;
  };
  return {
    calls: (kind) => calls.filter((c) => c.kind === kind),
    answer(call) {
      contentSessionId += 1;
      const value = {
        probe: [{ frameId: 0, result: { hasSelection: false, textLength: 5000 } }],
        inject: [{ frameId: 0 }],
        prepare: [{ frameId: 0, result: { sentences: sentences.slice(), sessionId: contentSessionId } }]
      }[call.kind];
      call.resolve(value);
    }
  };
}

/** Press Play through the real message route without waiting for the first sentence. */
function pressPlay(bg) {
  return bg.send({ type: 'startStreaming', settings: SETTINGS, record: false, mode: 'selection' }, { wait: true });
}

function rightClickReadAloud(bg, frameId = 0) {
  bg.listeners.menuClicked[0]({ menuItemId: 'readAloud', frameId }, { id: 7 });
}

function ended(chunk, overrides = {}) {
  return {
    type: 'chunkEnded',
    index: chunk.index,
    sessionId: chunk.sessionId,
    playNumber: chunk.playNumber,
    ...overrides
  };
}

// --- E8: overlapping starts ----------------------------------------------------------------------

for (const order of ['earlier-first', 'later-first']) {
  test(`E8: two beginSession calls back to back leave one session; the stale one is stopped (${order})`, async () => {
    const bg = loadBackground({ sentences: SENTENCES });
    const ctl = controlScripting(bg);
    const earlier = bg.context.beginSession(7, SETTINGS, false, 'selection', 0);
    const later = bg.context.beginSession(7, SETTINGS, false, 'selection', 0);
    await settle();

    assert.equal(ctl.calls('inject').length, 2, 'both starts reached their injection');
    assert.equal(bg.sentOfType('stop').length, 1, 'the later start tore the earlier one down with a stop broadcast');
    const [earlierInject, laterInject] = ctl.calls('inject');
    const earlierId = (await downloadLog(bg)).events.find((e) => e.type === 'session-end').sessionId;

    if (order === 'earlier-first') {
      ctl.answer(earlierInject);
      await settle();
      assert.equal(ctl.calls('prepare').length, 0, 'the earlier start stopped at its next checkpoint');
      ctl.answer(laterInject);
    } else {
      ctl.answer(laterInject);
      await settle();
      ctl.answer(ctl.calls('prepare')[0]);
      await later;
      assert.equal(playChunks(bg).length, 1, 'the later start has already begun reading');
      ctl.answer(earlierInject); // the earlier start's injection finishes last
    }
    await settle();
    assert.equal(ctl.calls('prepare').length, 1, 'only the later start ever asked the page for its sentences');
    if (order === 'earlier-first') ctl.answer(ctl.calls('prepare')[0]);
    await Promise.all([earlier, later]);

    const chunks = playChunks(bg);
    assert.equal(chunks.length, 1, 'exactly one playChunk');
    assert.notEqual(chunks[0].sessionId, earlierId, 'and it is not the earlier session');
    assert.equal(liveSession(bg).sessionId, chunks[0].sessionId, 'the one active session is the later one');
    assert.equal(liveSession(bg).stopped, false);

    const log = await downloadLog(bg);
    assert.equal(eventsOf(log, 'session-start').length, 2);
    assert.equal(eventsOf(log, 'session-end').length, 1);
    assert.deepEqual(
      [eventsOf(log, 'session-end')[0].sessionId, eventsOf(log, 'session-end')[0].reason],
      [earlierId, 'replaced']
    );
    const superseded = eventsOf(log, 'start-superseded');
    assert.equal(superseded.length, 1, 'the dropped start is logged');
    assert.deepEqual([superseded[0].sessionId, superseded[0].outcome], [earlierId, 'inject']);
  });
}

for (const order of ['earlier-first', 'later-first']) {
  test(`E8: the earlier start's pickBestFrame resolves ${order === 'earlier-first' ? 'first' : 'after the later start finished'}: it returns without touching session`, async () => {
    const bg = loadBackground({ sentences: SENTENCES });
    const ctl = controlScripting(bg);
    const earlier = bg.context.beginSession(7, SETTINGS, false, 'selection');
    const later = bg.context.beginSession(7, SETTINGS, false, 'selection');
    await settle();
    const [earlierProbe, laterProbe] = ctl.calls('probe');
    assert.ok(earlierProbe && laterProbe, 'both starts are waiting on pickBestFrame');
    assert.equal(liveSession(bg), null, 'neither has created a session yet');

    if (order === 'earlier-first') {
      ctl.answer(earlierProbe);
      await settle();
      assert.equal(liveSession(bg), null, 'the superseded start did not create a session');
      assert.equal(ctl.calls('inject').length, 0);
      ctl.answer(laterProbe);
    } else {
      ctl.answer(laterProbe);
    }
    await settle();
    ctl.answer(ctl.calls('inject')[0]);
    await settle();
    ctl.answer(ctl.calls('prepare')[0]);
    await settle();
    assert.equal(playChunks(bg).length, 1, 'the later start is reading');
    const laterSession = liveSession(bg);

    if (order === 'later-first') {
      ctl.answer(earlierProbe); // resolves after the later start finished setting up
      await settle();
    }
    await Promise.all([earlier, later]);

    assert.equal(liveSession(bg), laterSession, 'session is the later start\'s, untouched');
    assert.equal(laterSession.stopped, false);
    assert.equal(ctl.calls('inject').length, 1, 'the earlier start never injected');
    assert.equal(ctl.calls('prepare').length, 1);
    assert.equal(playChunks(bg).length, 1);
    const log = await downloadLog(bg);
    assert.equal(eventsOf(log, 'session-start').length, 1, 'the earlier start never became a session');
    assert.equal(eventsOf(log, 'start-superseded').length, 1);
    assert.equal(eventsOf(log, 'start-superseded')[0].outcome, 'frame-probe');
  });
}

for (const order of ['popup-then-menu', 'menu-then-popup']) {
  test(`E8: popup startStreaming and context-menu startReadingFromTab in the same tick (${order}): one session, the later token wins`, async () => {
    const bg = loadBackground({ sentences: SENTENCES });
    const query = deferred();
    if (order === 'popup-then-menu') bg.chrome.tabs.query = () => query.promise; // the popup's tab lookup is slow

    let popup;
    if (order === 'popup-then-menu') {
      popup = pressPlay(bg);
      rightClickReadAloud(bg);
      await settle();
      assert.equal(playChunks(bg).length, 1, 'the menu start (later) is already reading');
      query.resolve([{ id: 7 }]);
    } else {
      rightClickReadAloud(bg);
      popup = pressPlay(bg);
    }
    const response = await popup;
    await settle();

    assert.equal(playChunks(bg).length, 1, 'one playChunk in total');
    const log = await downloadLog(bg);
    assert.equal(eventsOf(log, 'session-start').length, 1, 'one session');
    const superseded = eventsOf(log, 'start-superseded');
    assert.equal(superseded.length, 1);
    assert.equal(superseded[0].outcome, 'queued');
    if (order === 'popup-then-menu') {
      assert.deepEqual(response, { success: true, superseded: true }, 'the popup\'s start was the loser');
      assert.equal(eventsOf(log, 'session-start')[0].frameId, 0);
    } else {
      assert.deepEqual(response, { success: true });
    }
    assert.equal(liveSession(bg).sessionId, playChunks(bg)[0].sessionId);
    assert.equal(liveSession(bg).stopped, false);
  });
}

test('E8: a superseded start whose successor never got going stops its own half-built session', async () => {
  const bg = loadBackground({ sentences: SENTENCES });
  const ctl = controlScripting(bg);
  const earlier = bg.context.beginSession(7, SETTINGS, false, 'selection', 0);
  await settle();
  const sessionA = liveSession(bg);
  // A newer request arrives (it took a token) but has not reached beginSession.
  vm.runInContext('startTokens.next()', bg.context);
  ctl.answer(ctl.calls('inject')[0]);
  await earlier;

  assert.equal(sessionA.stopped, true, 'not left half-started');
  assert.equal(ctl.calls('prepare').length, 0);
  assert.equal(playChunks(bg).length, 0);
  const log = await downloadLog(bg);
  assert.deepEqual(eventsOf(log, 'session-end').map((e) => e.reason), ['superseded']);
});

for (const stage of ['first-fetch', 'first-offscreen']) {
  test(`E8: a start superseded while its first sentence waits on ${stage === 'first-fetch' ? 'the TTS fetch' : 'the offscreen re-check'} never calls playChunk`, async () => {
    const gate = deferred();
    const fetchFn = createFakeFetch(({ body }) => (stage === 'first-fetch' ? gate.promise.then(() => okResponse(audioBytesFor(body.input))) : okResponse(audioBytesFor(body.input))));
    const bg = loadBackground({ sentences: SENTENCES, fetch: fetchFn });
    const contexts = bg.chrome.runtime.getContexts;
    let contextCalls = 0;
    if (stage === 'first-offscreen') {
      // beginSession's own setup is call 1; playFromIndex's re-check is call 2.
      bg.chrome.runtime.getContexts = async (...args) => {
        contextCalls += 1;
        if (contextCalls === 2) await gate.promise;
        return contexts(...args);
      };
    }
    const earlier = bg.context.beginSession(7, SETTINGS, false, 'selection', 0);
    await settle();
    const sessionA = liveSession(bg);
    if (stage === 'first-offscreen') assert.equal(contextCalls, 2, 'the first sentence is waiting on the offscreen re-check');
    assert.equal(playChunks(bg).length, 0);
    // A newer request arrives (it took a token) but has not reached beginSession.
    vm.runInContext('startTokens.next()', bg.context);
    gate.resolve();
    await earlier;
    await settle();

    assert.equal(playChunks(bg).length, 0, 'the earlier start never calls playChunk');
    assert.equal(bg.sentOfType('sentenceProgress').length, 0);
    assert.equal(bg.tabMessages.filter((m) => m.message.type === 'ttsHighlightSentence').length, 0, 'no highlight');
    assert.equal(sessionA.stopped, true);
    assert.equal(sessionA.stallTimer, null, 'no stall timer was armed');
    const log = await downloadLog(bg);
    assert.deepEqual(eventsOf(log, 'session-end').map((e) => e.reason), ['superseded']);
    assert.deepEqual(eventsOf(log, 'start-superseded').map((e) => e.outcome), [stage]);
    assert.equal(eventsOf(log, 'play').length, 0);
  });
}

// A session that is already playing is superseded the same way: a later start has taken its
// token but has not yet reached beginSession's stopSession('replaced').
for (const stage of ['next-fetch', 'next-offscreen']) {
  test(`E8: a playing session superseded while its next sentence waits on ${stage === 'next-fetch' ? 'the prefetch' : 'the offscreen re-check'} never calls playChunk for it`, async () => {
    const gate = deferred();
    // Fetch call 1 is sentence 0; call 2 is the prefetch of sentence 1.
    const fetchFn = createFakeFetch(({ call, body }) => (
      stage === 'next-fetch' && call === 2 ? gate.promise.then(() => okResponse(audioBytesFor(body.input))) : okResponse(audioBytesFor(body.input))
    ));
    const bg = loadBackground({ sentences: SENTENCES, fetch: fetchFn });
    const contexts = bg.chrome.runtime.getContexts;
    let contextCalls = 0;
    if (stage === 'next-offscreen') {
      // beginSession's setup is call 1, sentence 0's re-check is call 2, sentence 1's re-check is call 3.
      bg.chrome.runtime.getContexts = async (...args) => {
        contextCalls += 1;
        if (contextCalls === 3) await gate.promise;
        return contexts(...args);
      };
    }
    await startRead(bg);
    const first = playChunks(bg)[0];
    const sessionA = liveSession(bg);
    await bg.send(ended(first)); // playFromIndex(1) now waits on the gate
    await settle();
    if (stage === 'next-offscreen') assert.equal(contextCalls, 3, 'sentence 1 is waiting on the offscreen re-check');
    assert.equal(playChunks(bg).length, 1);
    const progressBefore = bg.sentOfType('sentenceProgress').length;
    const highlightsBefore = bg.tabMessages.filter((m) => m.message.type === 'ttsHighlightSentence').length;

    vm.runInContext('startTokens.next()', bg.context); // a later start arrived, not yet at beginSession
    gate.resolve();
    await settle();

    assert.equal(playChunks(bg).length, 1, 'the superseded session never sends playChunk for sentence 1');
    assert.equal(bg.sentOfType('sentenceProgress').length, progressBefore, 'no sentenceProgress');
    assert.equal(bg.tabMessages.filter((m) => m.message.type === 'ttsHighlightSentence').length, highlightsBefore, 'no highlight');
    assert.equal(sessionA.stopped, true);
    assert.equal(sessionA.stallTimer, null, 'no stall timer was left armed');
    const log = await downloadLog(bg);
    assert.deepEqual(eventsOf(log, 'session-end').map((e) => e.reason), ['superseded']);
    assert.deepEqual(eventsOf(log, 'start-superseded').map((e) => e.outcome), [stage]);
    assert.equal(eventsOf(log, 'play').length, 1);
  });
}

test('E8: a playing session superseded before its last sentence ends does not report finished', async () => {
  const bg = loadBackground({ sentences: SENTENCES });
  await startRead(bg);
  await finishChunk(bg, playChunks(bg)[0]);
  await finishChunk(bg, playChunks(bg)[1]);
  const last = playChunks(bg)[2];
  const sessionA = liveSession(bg);
  vm.runInContext('startTokens.next()', bg.context);
  await finishChunk(bg, last);

  assert.equal(sessionA.stopped, true);
  const log = await downloadLog(bg);
  assert.deepEqual(eventsOf(log, 'session-end').map((e) => e.reason), ['superseded']);
  assert.equal(playChunks(bg).length, 3);
});

test('E8: a stall timer firing on a superseded playing session does not send the next playChunk', async () => {
  const bg = loadBackground({ sentences: SENTENCES });
  await startRead(bg);
  const sessionA = liveSession(bg);
  assert.ok(sessionA.stallTimer, 'the stall timer is armed for sentence 0');
  vm.runInContext('startTokens.next()', bg.context);
  await bg.timers.tick(60 * 1000);
  await settle();

  assert.equal(playChunks(bg).length, 1, 'no playChunk for sentence 1');
  assert.equal(sessionA.stopped, true);
  const log = await downloadLog(bg);
  assert.deepEqual(eventsOf(log, 'session-end').map((e) => e.reason), ['superseded']);
  assert.deepEqual(eventsOf(log, 'start-superseded').map((e) => e.outcome), ['next-advance']);
});

// A session that is replaced or stopped in the ordinary way while its next
// sentence waits is not a start that lost a race: the debug log must say
// session-end + play-skipped only, never start-superseded.
for (const stage of ['fetch', 'offscreen']) {
  for (const how of ['right-click replace', 'Stop then Play']) {
    test(`E8: a playing session ended by ${how} while its next sentence waits on ${stage} logs play-skipped, not start-superseded`, async () => {
      const gate = deferred();
      const fetchFn = createFakeFetch(({ call, signal, body }) => (
        stage === 'fetch' && call === 2 ? hangUntilAbort(signal) : okResponse(audioBytesFor(body.input))
      ));
      const bg = loadBackground({ sentences: SENTENCES, fetch: fetchFn });
      const contexts = bg.chrome.runtime.getContexts;
      let contextCalls = 0;
      if (stage === 'offscreen') {
        // beginSession's setup is call 1, sentence 0's re-check is call 2, sentence 1's re-check is call 3.
        bg.chrome.runtime.getContexts = async (...args) => {
          contextCalls += 1;
          if (contextCalls === 3) await gate.promise;
          return contexts(...args);
        };
      }
      await startRead(bg);
      const first = playChunks(bg)[0];
      await bg.send(ended(first)); // playFromIndex(1) now waits on the fetch or the re-check
      await settle();
      if (stage === 'offscreen') assert.equal(contextCalls, 3, 'sentence 1 is waiting on the offscreen re-check');

      if (how === 'right-click replace') {
        rightClickReadAloud(bg);
      } else {
        await bg.send({ type: 'stopSession' }, { wait: true });
      }
      await settle();
      gate.resolve();
      await settle();

      assert.equal(playChunks(bg).filter((m) => m.sessionId === first.sessionId).length, 1, 'no second sentence for the ended session');
      const log = await downloadLog(bg);
      assert.deepEqual(eventsOf(log, 'start-superseded'), [], 'it never lost a start race');
      const skipped = eventsOf(log, 'play-skipped').filter((e) => e.sessionId === first.sessionId);
      assert.equal(skipped.length, 1);
      assert.equal(skipped[0].index, 1);
      const ended0 = eventsOf(log, 'session-end').filter((e) => e.sessionId === first.sessionId);
      assert.equal(ended0.length, 1);
      assert.equal(ended0[0].reason, how === 'right-click replace' ? 'replaced' : 'user');
    });
  }
}

// --- E8: stale messages ---------------------------------------------------------------------------

test('E8: playChunk or chunkEnded carrying a replaced session id is dropped and logged', async () => {
  const bg = loadBackground({ sentences: SENTENCES });
  await startRead(bg);
  const oldChunk = playChunks(bg)[0];
  await startRead(bg); // replaces it
  assert.equal(playChunks(bg).length, 2);
  const newChunk = playChunks(bg)[1];
  assert.notEqual(newChunk.sessionId, oldChunk.sessionId);

  await bg.send(ended(oldChunk));
  await settle();
  assert.equal(playChunks(bg).length, 2, 'the old session\'s chunkEnded did not advance anything');

  const log = await downloadLog(bg);
  const dropped = eventsOf(log, 'dropped-chunk-ended');
  assert.equal(dropped.length, 1);
  assert.deepEqual(
    [dropped[0].sessionId, dropped[0].index, dropped[0].playNumber, dropped[0].reason],
    [oldChunk.sessionId, 0, 1, 'stale-session']
  );
  // The new session still advances normally.
  await finishChunk(bg, newChunk);
  assert.deepEqual(playChunks(bg).map((m) => [m.sessionId, m.index]), [
    [oldChunk.sessionId, 0], [newChunk.sessionId, 0], [newChunk.sessionId, 1]
  ]);
});

test('E8: a play that was waiting on the prefetch when its session was replaced never reaches playChunk, and is logged', async () => {
  const slow = deferred();
  const fetchFn = createFakeFetch(({ call, body }) => (call === 2 ? slow.promise : okResponse(audioBytesFor(body.input))));
  const bg = loadBackground({ sentences: SENTENCES, fetch: fetchFn });
  await startRead(bg);
  const oldChunk = playChunks(bg)[0];
  await bg.send(ended(oldChunk)); // playFromIndex(1) is now awaiting the slow prefetch
  await settle();
  rightClickReadAloud(bg); // replace the session
  await settle();
  assert.equal(playChunks(bg).length, 2);

  slow.resolve(okResponse(audioBytesFor('late audio')));
  await settle();
  assert.equal(playChunks(bg).filter((m) => m.sessionId === oldChunk.sessionId).length, 1, 'no second sentence for the replaced session');
  const log = await downloadLog(bg);
  const skipped = eventsOf(log, 'play-skipped');
  assert.equal(skipped.length, 1);
  assert.deepEqual([skipped[0].sessionId, skipped[0].index, skipped[0].reason], [oldChunk.sessionId, 1, 'replaced']);
});

// --- GP5: right-click Read Aloud while a session is playing -----------------------------------------------

test('GP5: Read Aloud on a selection while playing stops the old session, aborts its fetches, reads the selection once, and ignores the old session\'s late messages', async () => {
  const fetchFn = createFakeFetch(({ call, signal, body }) =>
    (call === 2 ? hangUntilAbort(signal) : okResponse(audioBytesFor(body.input))));
  const bg = loadBackground({ sentences: SENTENCES, fetch: fetchFn });
  const original = bg.chrome.scripting.executeScript;
  let selecting = false;
  bg.chrome.scripting.executeScript = async (opts) => {
    if (selecting && opts.func) {
      return [{ frameId: 0, result: { sentences: ['Selected paragraph here.'], sessionId: 2 } }];
    }
    return original(opts);
  };

  await startRead(bg);
  await settle();
  const oldChunk = playChunks(bg)[0];
  assert.equal(fetchFn.calls.length, 2, 'the old session is prefetching sentence 1');
  assert.equal(fetchFn.calls[1].init.signal.aborted, false);
  const stopsBefore = bg.sentOfType('stop').length;

  selecting = true;
  rightClickReadAloud(bg);
  await settle();

  assert.equal(bg.sentOfType('stop').length, stopsBefore + 1, 'the old session got a stop');
  assert.equal(fetchFn.calls[1].init.signal.aborted, true, 'its abortControllers were aborted');
  const chunks = playChunks(bg);
  assert.equal(chunks.length, 2, 'old chunk plus exactly one for the selection');
  const selectionChunk = chunks[1];
  assert.notEqual(selectionChunk.sessionId, oldChunk.sessionId);
  assert.equal(selectionChunk.index, 0);
  assert.ok(fetchFn.calls[2].body.input.includes('Selected paragraph'), 'the selection was fetched');
  const sentTypes = bg.sent.map((m) => m.type);
  assert.ok(
    sentTypes.indexOf('stop') < sentTypes.lastIndexOf('playChunk'),
    'stop for the old session precedes the new session\'s playChunk'
  );
  const progress = bg.sentOfType('sentenceProgress');
  assert.deepEqual(progress.map((m) => [m.sessionId, m.index, m.total]), [
    [oldChunk.sessionId, 0, 3], [selectionChunk.sessionId, 0, 1]
  ]);

  // Late messages from the old session id.
  await bg.send(ended(oldChunk));
  await bg.send({ type: 'audioDuration', sessionId: oldChunk.sessionId, index: 0, playNumber: 1, duration: 500 });
  await bg.send({ type: 'audioReady', sessionId: oldChunk.sessionId, index: 0, playNumber: 1, audioElements: 1 });
  await settle();
  assert.equal(playChunks(bg).length, 2);
  assert.equal(liveSession(bg).sessionId, selectionChunk.sessionId);
  const log = await downloadLog(bg);
  assert.deepEqual(eventsOf(log, 'dropped-chunk-ended').map((e) => e.reason), ['stale-session']);
  assert.deepEqual(eventsOf(log, 'dropped-audio-duration').map((e) => e.reason), ['stale-session']);

  // The selection reads once and the session ends.
  await finishChunk(bg, selectionChunk);
  assert.equal(playChunks(bg).length, 2);
  assert.equal(bg.sentOfType('playerStateUpdate').pop().state, 'stopped');
});

// --- E9: duplicate and wrong-play messages --------------------------------------------------------------------

test('E9: chunkEnded delivered twice while playFromIndex is awaiting the prefetch starts the next sentence once', async () => {
  const slow = deferred();
  const fetchFn = createFakeFetch(({ call, body }) => (call === 2 ? slow.promise : okResponse(audioBytesFor(body.input))));
  const bg = loadBackground({ sentences: SENTENCES, fetch: fetchFn });
  await startRead(bg);
  const chunk0 = playChunks(bg)[0];

  await bg.send(ended(chunk0));
  await bg.send(ended(chunk0)); // the duplicate arrives while sentence 1's audio is still being fetched
  await settle();
  assert.equal(playChunks(bg).length, 1, 'nothing has started yet: the prefetch is pending');

  slow.resolve(okResponse(audioBytesFor('Second sentence here.')));
  await settle();
  assert.deepEqual(playChunks(bg).map((m) => m.index), [0, 1], 'sentence 1 started once');
  assert.equal(fetchFn.calls.length, 3, 'and sentence 2 was prefetched once');
  const log = await downloadLog(bg);
  assert.deepEqual(eventsOf(log, 'dropped-chunk-ended').map((e) => e.reason), ['duplicate']);
  assert.equal(eventsOf(log, 'play').filter((e) => e.index === 1).length, 1);

  // And once sentence 1 is playing, a third copy for sentence 0 is stale.
  await bg.send(ended(chunk0));
  await settle();
  assert.equal(playChunks(bg).length, 2);
  assert.deepEqual(eventsOf(await downloadLog(bg), 'dropped-chunk-ended').map((e) => e.reason), ['duplicate', 'stale-index']);
});

test('E9: chunkEnded delivered twice after the next sentence started also advances once', async () => {
  const bg = loadBackground({ sentences: SENTENCES });
  await startRead(bg);
  const chunk0 = playChunks(bg)[0];
  await bg.send(ended(chunk0));
  await settle();
  await bg.send(ended(chunk0));
  await settle();
  assert.deepEqual(playChunks(bg).map((m) => m.index), [0, 1]);
});

test('E9: chunkEnded with the right index but a wrong or missing play number is ignored', async () => {
  const bg = loadBackground({ sentences: SENTENCES });
  await startRead(bg);
  const chunk0 = playChunks(bg)[0];
  for (const playNumber of [2, 0, 99, null, undefined, '1']) {
    await bg.send(ended(chunk0, { playNumber }));
    await settle();
  }
  assert.equal(playChunks(bg).length, 1, 'no wrong play number advanced the session');
  const log = await downloadLog(bg);
  assert.equal(eventsOf(log, 'dropped-chunk-ended').length, 6);
  assert.ok(eventsOf(log, 'dropped-chunk-ended').every((e) => e.reason === 'stale-play'));

  await bg.send(ended(chunk0));
  await settle();
  assert.deepEqual(playChunks(bg).map((m) => m.index), [0, 1], 'the right play number still works');
});

test('E9: chunkEnded with the wrong session id or index is ignored', async () => {
  const bg = loadBackground({ sentences: SENTENCES });
  await startRead(bg);
  const chunk0 = playChunks(bg)[0];
  await bg.send(ended(chunk0, { sessionId: 'zzzzzz' }));
  await bg.send(ended(chunk0, { sessionId: undefined }));
  await bg.send(ended(chunk0, { index: 1 }));
  await bg.send(ended(chunk0, { index: 'x' }));
  await settle();
  assert.equal(playChunks(bg).length, 1);
  assert.deepEqual(
    eventsOf(await downloadLog(bg), 'dropped-chunk-ended').map((e) => e.reason),
    ['stale-session', 'stale-session', 'stale-index', 'stale-index']
  );
});

// --- GP2: a 10-sentence read ----------------------------------------------------------------------------------------

test('GP2: reading 10 sentences through the real offscreen script: indexes 0..9 in order, each triple reaches <audio> once', async () => {
  const ten = Array.from({ length: 10 }, (_, i) => `Sentence number ${i} is here.`);
  let bg;
  const page = loadOffscreen({ onMessageToBackground: (m) => { bg.send(m); } });
  bg = loadBackground({ sentences: ten });
  const toBackground = bg.chrome.runtime.sendMessage;
  bg.chrome.runtime.sendMessage = (message, callback) => {
    const result = toBackground(message, callback);
    page.deliver(message); // the background's broadcasts reach the offscreen document
    return result;
  };

  await startRead(bg);
  for (let i = 0; i < 10; i++) {
    await settle();
    assert.equal(page.audio.plays.length, i + 1, `sentence ${i} was handed to <audio> exactly once`);
    page.audio.duration = 3;
    page.audio.onloadedmetadata();
    await settle();
    page.audio.onended();
  }
  await settle();

  const progress = bg.sentOfType('sentenceProgress');
  assert.deepEqual(progress.map((m) => m.index), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 'in order, no repeat, none skipped');
  const sessionId = progress[0].sessionId;
  assert.match(sessionId, /^[a-z0-9]{6}$/);
  assert.ok(progress.every((m) => m.sessionId === sessionId && m.playNumber === 1 && m.total === 10));
  assert.deepEqual(
    bg.tabMessages.filter((m) => m.message.type === 'ttsHighlightSentence').map((m) => m.message.index),
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
    'the highlight follows the same sequence'
  );

  const triple = (m) => `${m.sessionId}:${m.index}:${m.playNumber}`;
  const delivered = bg.sentOfType('playChunk').map(triple);
  assert.equal(new Set(delivered).size, 10);
  assert.deepEqual(page.sent.filter((m) => m.type === 'audioReady').map(triple), delivered, 'each triple reached <audio> once');
  assert.deepEqual(page.sent.filter((m) => m.type === 'chunkEnded').map(triple), delivered, 'and was echoed back on chunkEnded');
  assert.equal(page.audio.plays.length, 10);
  assert.equal(page.sent.filter((m) => m.type === 'playDropped').length, 0);

  const log = await downloadLog(bg);
  assert.equal(eventsOf(log, 'audio-duration').length, 10);
  for (const type of ['stall', 'dropped-chunk-ended', 'dropped-audio-duration', 'play-skipped', 'start-superseded']) {
    assert.equal(eventsOf(log, type).length, 0, type);
  }
  assert.equal(log.sentences.length, 10);
  assert.ok(log.sentences.every((row) => row.playCount === 1 && row.endedCount === 1 && row.audioElements === 1));
  assert.equal(bg.sentOfType('playerStateUpdate').pop().state, 'stopped');
  assert.equal(bg.timers.pending, 0, 'no timer left after the read finished');
});

test('Existing behaviour: a 3-sentence run plays 0, 1, 2 then reports stopped, and the keepalive alarm clears when idle', async () => {
  const bg = loadBackground({ sentences: SENTENCES });
  await startRead(bg);
  assert.equal(bg.alarms.has(ALARM), true, 'keepalive runs while reading');
  await readToEnd(bg, 3);
  assert.deepEqual(playChunks(bg).map((m) => m.index), [0, 1, 2]);
  assert.equal(bg.sentOfType('playerStateUpdate').pop().state, 'stopped');
  assert.equal(bg.alarms.has(ALARM), false, 'keepalive cleared');
  assert.equal(bg.sentOfType('sentenceProgress').length, 3);
});

// --- E10: stall timer ---------------------------------------------------------------------------------------------------

test('E10: duration unknown: the fixed 60 s hang timeout applies, nothing at 20 s or 59.999 s', async () => {
  const bg = loadBackground({ sentences: SENTENCES });
  await startRead(bg);
  await bg.timers.tick(20000);
  await bg.timers.tick(39999);
  assert.equal(playChunks(bg).length, 1, 'still on sentence 0 just before 60 s');
  await bg.timers.tick(1);
  assert.deepEqual(playChunks(bg).map((m) => m.index), [0, 1]);
});

test('E10: a 40 s sentence at 0.25x speed times out at 45 s, not 20 s or 60 s', async () => {
  const bg = loadBackground({ sentences: SENTENCES });
  await startRead(bg, { ...SETTINGS, speed: '0.25' });
  assert.equal(bg.fetch.calls[0].body.speed, 0.25);
  const chunk0 = playChunks(bg)[0];
  await bg.send({ type: 'audioDuration', sessionId: chunk0.sessionId, index: 0, playNumber: 1, duration: 40 });
  await settle();
  assert.equal(bg.timers.pending, 1, 'the duration timer replaced the 60 s one');

  await bg.timers.tick(20000);
  assert.equal(playChunks(bg).length, 1, 'not cut off at 20 s');
  await bg.timers.tick(24999);
  assert.equal(playChunks(bg).length, 1, 'not cut off at 44.999 s');
  await bg.timers.tick(1);
  assert.deepEqual(playChunks(bg).map((m) => m.index), [0, 1], 'advanced at 45 s');
  const log = await downloadLog(bg);
  assert.deepEqual(eventsOf(log, 'audio-duration').map((e) => e.ms), [40000]);
  assert.deepEqual(eventsOf(log, 'stall').map((e) => [e.index, e.playNumber, e.ms]), [[0, 1, 45000]]);
});

test('E10: a short sentence\'s timeout is its duration + 5 s, so a stall is found sooner than 60 s', async () => {
  const bg = loadBackground({ sentences: SENTENCES });
  await startRead(bg);
  const chunk0 = playChunks(bg)[0];
  await bg.send({ type: 'audioDuration', sessionId: chunk0.sessionId, index: 0, playNumber: 1, duration: 1.5 });
  await bg.timers.tick(6499);
  assert.equal(playChunks(bg).length, 1);
  await bg.timers.tick(1);
  assert.equal(playChunks(bg).length, 2);
});

test('E10: a repeated duration report for the same play does not extend the timer', async () => {
  const bg = loadBackground({ sentences: SENTENCES });
  await startRead(bg);
  const chunk0 = playChunks(bg)[0];
  const report = (duration) => bg.send({ type: 'audioDuration', sessionId: chunk0.sessionId, index: 0, playNumber: 1, duration });
  await report(10); // deadline 15 s
  await bg.timers.tick(10000);
  await report(100); // ignored
  await bg.timers.tick(5000);
  assert.equal(playChunks(bg).length, 2, 'stalled at 15 s as first reported');
  assert.deepEqual(eventsOf(await downloadLog(bg), 'dropped-audio-duration').map((e) => e.reason), ['duplicate']);
});

test('E10: a loadedmetadata report that is NaN, 0, Infinity, negative, or for a stale play number keeps the 60 s timeout', async () => {
  const cases = [
    ['null (NaN after JSON)', (c) => ({ ...c, duration: null }), 'bad-duration'],
    ['0', (c) => ({ ...c, duration: 0 }), 'bad-duration'],
    ['negative', (c) => ({ ...c, duration: -4 }), 'bad-duration'],
    ['a string', (c) => ({ ...c, duration: '40' }), 'bad-duration'],
    ['missing', (c) => c, 'bad-duration'],
    ['stale play number', (c) => ({ ...c, duration: 500, playNumber: 2 }), 'stale-play'],
    ['older play number', (c) => ({ ...c, duration: 500, playNumber: 0 }), 'stale-play'],
    ['stale index', (c) => ({ ...c, duration: 500, index: 1 }), 'stale-index'],
    ['stale session', (c) => ({ ...c, duration: 500, sessionId: 'zzzzzz' }), 'stale-session']
  ];
  for (const [name, make, reason] of cases) {
    const bg = loadBackground({ sentences: SENTENCES });
    await startRead(bg);
    const chunk0 = playChunks(bg)[0];
    await bg.send(make({ type: 'audioDuration', sessionId: chunk0.sessionId, index: 0, playNumber: 1 }));
    await bg.timers.tick(59999);
    assert.equal(playChunks(bg).length, 1, `${name}: still waiting at 59.999 s`);
    await bg.timers.tick(1);
    assert.equal(playChunks(bg).length, 2, `${name}: 60 s timeout fired`);
    const log = await downloadLog(bg);
    assert.deepEqual(eventsOf(log, 'dropped-audio-duration').map((e) => e.reason), [reason], name);
    assert.deepEqual(eventsOf(log, 'stall').map((e) => e.ms), [60000], name);
  }
});

test('E10: NaN and Infinity that never went through JSON are ignored too', async () => {
  for (const duration of [NaN, Infinity, -Infinity]) {
    const bg = loadBackground({ sentences: SENTENCES });
    await startRead(bg);
    const chunk0 = playChunks(bg)[0];
    bg.context.handleAudioDuration({ type: 'audioDuration', sessionId: chunk0.sessionId, index: 0, playNumber: 1, duration });
    await bg.timers.tick(59999);
    assert.equal(playChunks(bg).length, 1, String(duration));
    await bg.timers.tick(1);
    assert.equal(playChunks(bg).length, 2, String(duration));
  }
});

test('E10: when the timer fires the session advances once, logs a stall, and a late chunkEnded for that sentence is ignored', async () => {
  const bg = loadBackground({ sentences: SENTENCES });
  await startRead(bg);
  const chunk0 = playChunks(bg)[0];
  await bg.timers.tick(60000);
  assert.deepEqual(playChunks(bg).map((m) => m.index), [0, 1]);

  await bg.send(ended(chunk0)); // the audio finally reports ended
  await settle();
  assert.deepEqual(playChunks(bg).map((m) => m.index), [0, 1], 'the late chunkEnded did not advance a second time');
  const log = await downloadLog(bg);
  assert.equal(eventsOf(log, 'stall').length, 1);
  assert.deepEqual(eventsOf(log, 'dropped-chunk-ended').map((e) => e.reason), ['stale-index']);
});

test('E10: a late chunkEnded while the stall advance is still awaiting the prefetch is a duplicate', async () => {
  const slow = deferred();
  const fetchFn = createFakeFetch(({ call, body }) => (call === 2 ? slow.promise : okResponse(audioBytesFor(body.input))));
  const bg = loadBackground({ sentences: SENTENCES, fetch: fetchFn });
  await startRead(bg);
  const chunk0 = playChunks(bg)[0];
  await bg.timers.tick(60000); // stall: playFromIndex(1) now waits on the slow fetch
  await bg.send(ended(chunk0));
  await settle();
  slow.resolve(okResponse(audioBytesFor('Second sentence here.')));
  await settle();

  assert.deepEqual(playChunks(bg).map((m) => m.index), [0, 1], 'sentence 1 started once');
  assert.deepEqual(eventsOf(await downloadLog(bg), 'dropped-chunk-ended').map((e) => e.reason), ['duplicate']);
});

test('E10: a stall after the sentence really ended does nothing', async () => {
  const bg = loadBackground({ sentences: SENTENCES });
  await startRead(bg);
  await bg.send(ended(playChunks(bg)[0]));
  await settle();
  const first = bg.timers.pending;
  assert.equal(first, 1, 'only sentence 1\'s timer is armed');
  await bg.timers.tick(59999);
  assert.equal(eventsOf(await downloadLog(bg), 'stall').length, 0, 'sentence 0\'s timer was cleared, not left to fire');
});

test('E10: the timer is cleared on chunkEnded, stop, finish and replacement', async () => {
  // chunkEnded: the old timer is replaced by the next sentence's, never doubled.
  let bg = loadBackground({ sentences: SENTENCES });
  await startRead(bg);
  await settle();
  assert.equal(bg.timers.pending, 1, 'one stall timer while sentence 0 plays');
  await finishChunk(bg, playChunks(bg)[0]);
  assert.equal(bg.timers.pending, 1, 'one stall timer, now for sentence 1');

  // stop
  await bg.send({ type: 'stopSession' }, { wait: true });
  assert.equal(bg.timers.pending, 0, 'stop clears it');
  await bg.timers.tick(120000);
  assert.deepEqual(playChunks(bg).map((m) => m.index), [0, 1], 'and nothing advances afterwards');
  assert.equal(eventsOf(await downloadLog(bg), 'stall').length, 0);

  // finish
  bg = loadBackground({ sentences: SENTENCES });
  await startRead(bg);
  await readToEnd(bg, 3);
  assert.equal(bg.timers.pending, 0, 'finish clears it');

  // a known duration swaps the timer, not adds one
  bg = loadBackground({ sentences: SENTENCES });
  await startRead(bg);
  const chunk = playChunks(bg)[0];
  await bg.send({ type: 'audioDuration', sessionId: chunk.sessionId, index: 0, playNumber: 1, duration: 8 });
  assert.equal(bg.timers.pending, 1);
});

test('E10: chunkEnded clears the timer at once, even while the next sentence is still loading', async () => {
  const slow = deferred();
  const fetchFn = createFakeFetch(({ call, body }) => (call === 2 ? slow.promise : okResponse(audioBytesFor(body.input))));
  const bg = loadBackground({ sentences: SENTENCES, fetch: fetchFn });
  await startRead(bg);
  await settle();
  assert.equal(bg.timers.pending, 2, 'sentence 0\'s stall timer plus the prefetch\'s own fetch timeout');
  await bg.send(ended(playChunks(bg)[0]));
  await settle();
  assert.equal(bg.timers.pending, 1, 'only the fetch timeout is left: the stall timer is gone');
  slow.resolve(okResponse(audioBytesFor('Second sentence here.')));
  await settle();
  assert.equal(bg.timers.pending, 1, 'sentence 1\'s stall timer');
});

test('E10: a timer left from a replaced session never advances the new one', async () => {
  const bg = loadBackground({ sentences: SENTENCES });
  await startRead(bg); // old session's timer is due at 60 s
  await bg.timers.tick(30000);
  rightClickReadAloud(bg); // replaced at 30 s; the new timer is due at 90 s
  await settle();
  assert.equal(playChunks(bg).length, 2);
  const newChunk = playChunks(bg)[1];
  assert.equal(bg.timers.pending, 1, 'the old session\'s timer is gone');

  await bg.timers.tick(30000); // t = 60 s: where the old timer would have fired
  assert.equal(playChunks(bg).length, 2, 'the new session did not advance');
  assert.equal(liveSession(bg).currentIndex, 0);
  await bg.timers.tick(30000); // t = 90 s: the new session's own timer
  assert.deepEqual(playChunks(bg).slice(1).map((m) => [m.sessionId, m.index]), [[newChunk.sessionId, 0], [newChunk.sessionId, 1]]);
  assert.equal(eventsOf(await downloadLog(bg), 'stall').length, 1, 'one stall, belonging to the new session');
});

test('E10: the stall timer honours a paused flag (helper wiring only; Pause itself is not routed here)', async () => {
  const bg = loadBackground({ sentences: SENTENCES });
  await startRead(bg);
  const s = liveSession(bg);
  s.paused = true; // what a later change will set on Pause
  const chunk0 = playChunks(bg)[0];
  await bg.send({ type: 'audioDuration', sessionId: chunk0.sessionId, index: 0, playNumber: 1, duration: 5 });
  assert.equal(bg.timers.pending, 0, 'no deadline while paused');
  await bg.timers.tick(600000);
  assert.equal(playChunks(bg).length, 1);
});

// --- Added: playChunk before the offscreen document exists, or after stopSession ---------------------------------------

test('Added: no playChunk is sent before the offscreen document exists', async () => {
  const bg = loadBackground({ sentences: SENTENCES, offscreenUp: false });
  const gate = deferred();
  const create = bg.chrome.offscreen.createDocument;
  bg.chrome.offscreen.createDocument = async (opts) => {
    await gate.promise;
    return create(opts);
  };
  const started = startRead(bg);
  await settle();
  assert.equal(playChunks(bg).length, 0, 'nothing sent while the document is being created');
  assert.equal(bg.sentOfType('sentenceProgress').length, 0);

  gate.resolve();
  await started;
  assert.equal(playChunks(bg).length, 1);
  assert.equal(bg.createdOffscreen.length, 1);
});

test('Added: a stop while the offscreen document is being created means no playChunk ever', async () => {
  const bg = loadBackground({ sentences: SENTENCES, offscreenUp: false });
  const gate = deferred();
  const create = bg.chrome.offscreen.createDocument;
  bg.chrome.offscreen.createDocument = async (opts) => {
    await gate.promise;
    return create(opts);
  };
  const started = startRead(bg);
  await settle();
  await bg.send({ type: 'stopSession' }, { wait: true });
  gate.resolve();
  await started;
  await settle();

  assert.equal(playChunks(bg).length, 0);
  assert.equal(eventsOf(await downloadLog(bg), 'play').length, 0);
  assert.equal(bg.timers.pending, 0);
});

test('Added: a stop while the first sentence is being fetched means no playChunk, and the fetch is aborted', async () => {
  const fetchFn = createFakeFetch(({ signal }) => hangUntilAbort(signal));
  const bg = loadBackground({ sentences: SENTENCES, fetch: fetchFn });
  const started = startRead(bg);
  await settle();
  await bg.send({ type: 'stopSession' }, { wait: true });
  await started;
  await settle();
  assert.equal(fetchFn.calls[0].init.signal.aborted, true);
  assert.equal(playChunks(bg).length, 0);
  assert.equal(bg.timers.pending, 0);
});

test('Added: chunkEnded after stopSession is dropped and does not restart anything', async () => {
  const bg = loadBackground({ sentences: SENTENCES });
  await startRead(bg);
  const chunk0 = playChunks(bg)[0];
  await bg.send({ type: 'stopSession' }, { wait: true });
  await bg.send(ended(chunk0));
  await settle();
  assert.equal(playChunks(bg).length, 1);
  assert.deepEqual(eventsOf(await downloadLog(bg), 'dropped-chunk-ended').map((e) => e.reason), ['no-session']);
});

test('Added: audioReady from a replaced session does not change the new session\'s player state', async () => {
  const bg = loadBackground({ sentences: SENTENCES });
  await startRead(bg);
  const oldChunk = playChunks(bg)[0];
  const slow = deferred();
  bg.fetch.calls.length = 0;
  const original = bg.chrome.scripting.executeScript;
  bg.chrome.scripting.executeScript = (opts) => (opts.func ? slow.promise : original(opts));
  const restarted = startRead(bg); // new session is now loading
  await settle();
  const before = await bg.send({ type: 'getPlayerState' });
  assert.equal(before.state, 'loading');
  await bg.send({ type: 'audioReady', sessionId: oldChunk.sessionId, index: 0, playNumber: 1, audioElements: 1 });
  assert.equal((await bg.send({ type: 'getPlayerState' })).state, 'loading', 'a stale audioReady did not flip it to ready');
  slow.resolve([{ frameId: 0, result: { sentences: SENTENCES, sessionId: 5 } }]);
  await restarted;
});

test('E9: a playDropped report from the offscreen document is logged by the background, with only allowed fields', async () => {
  const bg = loadBackground({ sentences: SENTENCES });
  await startRead(bg);
  const chunk0 = playChunks(bg)[0];
  await bg.send({ type: 'playDropped', sessionId: chunk0.sessionId, index: 0, playNumber: 1, reason: 'duplicate' });
  await bg.send({ type: 'playDropped', sessionId: chunk0.sessionId, index: 0, playNumber: 1, reason: 'SECRET TEXT https://example.test/x' });
  await settle();
  const dropped = eventsOf(await downloadLog(bg), 'dropped-play-chunk');
  assert.equal(dropped.length, 2);
  assert.deepEqual([dropped[0].sessionId, dropped[0].index, dropped[0].playNumber, dropped[0].reason], [chunk0.sessionId, 0, 1, 'duplicate']);
  assert.equal('reason' in dropped[1], false, 'a free-text reason is not logged');
  assert.equal(playChunks(bg).length, 1, 'and it changes nothing about playback');
});
