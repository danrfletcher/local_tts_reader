'use strict';
/**
 * PR-2: the connection light's re-checks (open, debounced edit, click), the two
 * amber screens (no voices endpoint, empty list), the "Voice name" box, stale
 * and aborted checks, and when `voice` is written to storage. popup.js runs
 * for real against the DOM stub in helpers/popup.js, with a fake voices fetch
 * and fake timers.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { ROOT, settle, loadBackground, jsonResponse, hangUntilAbort } = require('./helpers/fake-chrome.js');
const { VOICES: SERVER_VOICES } = require('./fixtures/fake-tts-server.js');
const { SENTENCES, createGatedFetch } = require('./helpers/pause.js');
const { loadPopup, voicesBody, controlledVoices, abortError } = require('./helpers/popup.js');

const hanging = ({ signal }) => hangUntilAbort(signal);
const SPEECH = (port) => `http://localhost:${port}/v1/audio/speech`;

async function typeUrl(popup, url) {
  popup.getEl('serverUrl').value = url;
  await popup.getEl('serverUrl').fire('input');
}

async function typeVoiceName(popup, text) {
  popup.getEl('voiceName').value = text;
  await popup.getEl('voiceName').fire('input');
}

/** Everything the popup shows for the connection, in one comparable object. */
function ui(popup) {
  const el = (id) => popup.getEl(id);
  return {
    light: el('connLight').className,
    title: el('connLight').title,
    label: el('connLabel').textContent,
    labelHidden: el('connLabel').hidden,
    voiceBox: !el('voiceGroup').hidden,
    nameBox: !el('voiceNameGroup').hidden,
    options: el('voice').children.map((o) => o.value),
    selected: el('voice').value,
    note: el('voiceNote').hidden ? '' : el('voiceNote').textContent,
    play: !el('playBtn').disabled
  };
}

const abortedCount = (popup) => popup.voicesRequests.calls.filter((c) => c.init.signal.aborted).length;

// --- G6: when a check runs ------------------------------------------------------------------------

const TRIGGERS = [
  {
    name: 'open: one fetch',
    run: async () => {},
    fetches: 1,
    aborted: 0
  },
  {
    name: 'open, then one edit: one more fetch after 500 ms, the open check (still running) is aborted',
    run: async (popup) => {
      await typeUrl(popup, SPEECH(9001));
      await popup.timers.tick(500);
    },
    fetches: 2,
    aborted: 1
  },
  {
    name: 'typing a 10-keystroke burst, 50 ms apart: one fetch for the whole burst',
    run: async (popup) => {
      for (let i = 0; i < 10; i++) {
        await typeUrl(popup, `http://localhost:900${i}/v1/audio/speech`);
        await popup.timers.tick(50);
      }
      assert.equal(popup.voicesRequests.calls.length, 1, 'nothing is fetched while the typing continues');
      await popup.timers.tick(450);
    },
    fetches: 2,
    aborted: 1,
    lastUrl: 'http://localhost:9009/v1/audio/voices?model=tts-1'
  },
  {
    name: 'one click on the light: one fetch, at once',
    run: async (popup) => {
      await popup.getEl('connLight').click();
    },
    fetches: 2,
    aborted: 1
  },
  {
    name: 'one click after the open check finished: one fetch and nothing to abort',
    voicesFetch: () => voicesBody(),
    run: async (popup) => {
      await popup.getEl('connLight').click();
      await settle();
    },
    fetches: 2,
    aborted: 0
  },
  {
    name: 'click mid-check: the running check is aborted and replaced by one new fetch',
    run: async (popup) => {
      await popup.timers.tick(1000);
      await popup.getEl('connLight').click();
    },
    fetches: 2,
    aborted: 1
  },
  {
    name: 'two clicks in a row: each is one trigger, each restarts the one before',
    run: async (popup) => {
      await popup.getEl('connLight').click();
      await popup.getEl('connLight').click();
    },
    fetches: 3,
    aborted: 2
  },
  {
    name: 'edit then click before the 500 ms: the click checks now and the pending debounce is dropped',
    run: async (popup) => {
      await typeUrl(popup, SPEECH(9002));
      await popup.getEl('connLight').click();
      await popup.timers.tick(2000);
    },
    fetches: 2,
    aborted: 1,
    lastUrl: 'http://localhost:9002/v1/audio/voices?model=tts-1'
  },
  {
    name: 'click, then an edit: the edit adds one more fetch',
    run: async (popup) => {
      await popup.getEl('connLight').click();
      await typeUrl(popup, SPEECH(9003));
      await popup.timers.tick(500);
    },
    fetches: 3,
    aborted: 2
  }
];

for (const scenario of TRIGGERS) {
  test(`G6 trigger table: ${scenario.name}`, async () => {
    const popup = loadPopup({ voicesFetch: scenario.voicesFetch || hanging });
    await popup.ready;
    assert.equal(popup.voicesRequests.calls.length, 1, 'one popup open = one fetch');
    await scenario.run(popup);
    await popup.timers.tick(1000);
    assert.equal(popup.voicesRequests.calls.length, scenario.fetches, 'fetch count');
    assert.equal(abortedCount(popup), scenario.aborted, 'aborted fetches');
    if (scenario.lastUrl) assert.equal(popup.voicesRequests.calls.at(-1).url, scenario.lastUrl);
    // Only the newest request is left running: every earlier one was aborted or answered.
    const last = popup.voicesRequests.calls.at(-1);
    assert.equal(last.init.signal.aborted, false, 'the latest check is the live one');
  });
}

test('G6: a click during a running check restarts the 3 s "Starting voice engine..." timer', async () => {
  const controlled = controlledVoices();
  const popup = loadPopup({ voicesFetch: controlled.handler });
  await popup.ready;
  await popup.timers.tick(2000);
  assert.equal(popup.getEl('connLabel').textContent, 'Checking...');

  await popup.getEl('connLight').click(); // t = 2 s
  assert.equal(controlled.requests.length, 2);
  assert.equal(controlled.requests[0].signal.aborted, true, 'the old fetch is aborted');
  assert.equal(controlled.requests[1].signal.aborted, false);
  await popup.timers.tick(2999); // 4.999 s: the first check would have turned at 3 s
  assert.equal(popup.getEl('connLabel').textContent, 'Checking...');
  await popup.timers.tick(1);
  assert.equal(popup.getEl('connLabel').textContent, 'Starting voice engine...');
  assert.equal(popup.getEl('connLight').className, 'conn-light connStarting');
});

test('Added: Enter on the focused light re-checks, the same as a click; other keys do not', async () => {
  const popup = loadPopup({ voicesFetch: () => voicesBody() });
  await popup.ready;
  const light = popup.getEl('connLight');

  let prevented = false;
  await light.fire('keydown', { key: 'Enter', preventDefault: () => { prevented = true; } });
  await settle();
  assert.equal(popup.voicesRequests.calls.length, 2, 'Enter checks once');
  assert.equal(prevented, true, 'the browser\'s own Enter-click is suppressed, so it does not check twice');

  for (const key of ['Tab', 'Escape', 'a']) {
    await light.fire('keydown', { key, preventDefault() { throw new Error(`${key} must not be handled`); } });
  }
  assert.equal(popup.voicesRequests.calls.length, 2, 'other keys do nothing');

  await light.click();
  assert.equal(popup.voicesRequests.calls.length, 3, 'a click checks once');
});

test('F3: no polling. After a check finishes no timer is left, and a long wait makes no further fetch', async () => {
  const popup = loadPopup();
  await popup.ready;
  assert.equal(popup.timers.pending, 0, 'the 3 s label timer and the 90 s timeout are cleared');
  await popup.timers.tick(60 * 60 * 1000);
  assert.equal(popup.voicesRequests.calls.length, 1);

  const failed = loadPopup({ voicesFetch: () => { throw new TypeError('Failed to fetch'); } });
  await failed.ready;
  assert.equal(failed.timers.pending, 0);
  await failed.timers.tick(60 * 60 * 1000);
  assert.equal(failed.voicesRequests.calls.length, 1, 'a red light does not retry by itself');
});

test('F3: closing the popup clears the debounce, the 3 s label timer and the 90 s timeout, and aborts the fetch', async () => {
  const popup = loadPopup({ voicesFetch: hanging });
  await popup.ready;
  await typeUrl(popup, SPEECH(9004)); // a debounce is now pending as well
  assert.ok(popup.timers.pending >= 1);
  popup.closePopup();
  await settle();
  assert.equal(popup.timers.pending, 0);
  await popup.timers.tick(10 * 60 * 1000);
  assert.equal(popup.voicesRequests.calls.length, 1, 'the pending debounce never fires');
  assert.equal(abortedCount(popup), 1);
});

// --- Status to UI --------------------------------------------------------------------------------------

const NOT_DERIVABLE = "Can't derive a voices address";
const SCREENS = [
  {
    name: 'G4 no voices endpoint (404)',
    voicesFetch: () => jsonResponse({}, 404),
    light: 'conn-light connNoList',
    label: 'Connected, no voice list',
    voiceBox: false,
    nameBox: true,
    fetches: 1
  },
  {
    name: 'G4 no voices endpoint (405)',
    voicesFetch: () => jsonResponse({}, 405),
    light: 'conn-light connNoList',
    label: 'Connected, no voice list',
    voiceBox: false,
    nameBox: true,
    fetches: 1
  },
  {
    name: 'G5 empty list ({voices: []})',
    voicesFetch: () => voicesBody([]),
    light: 'conn-light connNoVoices',
    label: 'Server has no voices',
    voiceBox: false,
    nameBox: false,
    fetches: 1
  },
  {
    name: 'E3 empty voices array (a bare [])',
    voicesFetch: () => jsonResponse([]),
    light: 'conn-light connNoVoices',
    label: 'Server has no voices',
    voiceBox: false,
    nameBox: false,
    fetches: 1
  },
  {
    name: 'E3 a list of only blanks and duplicates is empty too',
    voicesFetch: () => jsonResponse({ voices: ['', '  ', { id: '' }] }),
    light: 'conn-light connNoVoices',
    label: 'Server has no voices',
    voiceBox: false,
    nameBox: false,
    fetches: 1
  },
  {
    name: 'E5 Server URL not ending in /audio/speech',
    serverUrl: 'http://localhost:8090/v1/models',
    voicesFetch: () => { throw new Error('no fetch may be made'); },
    light: 'conn-light connNoList',
    label: NOT_DERIVABLE,
    voiceBox: false,
    nameBox: true,
    fetches: 0
  },
  {
    name: 'E5 Server URL that is not a URL',
    serverUrl: 'not a url',
    voicesFetch: () => { throw new Error('no fetch may be made'); },
    light: 'conn-light connNoList',
    label: NOT_DERIVABLE,
    voiceBox: false,
    nameBox: true,
    fetches: 0
  }
];

for (const screen of SCREENS) {
  test(`status to UI: ${screen.name}`, async () => {
    // With a saved voice: the Voice name box is prefilled and Play follows it.
    const named = loadPopup({
      voicesFetch: screen.voicesFetch,
      stored: { voice: 'Olivia.wav', ...(screen.serverUrl ? { serverUrl: screen.serverUrl } : {}) }
    });
    await named.ready;
    const shown = ui(named);
    assert.equal(shown.light, screen.light);
    assert.equal(shown.label, screen.label);
    assert.equal(shown.title, screen.label, 'the tooltip says the same');
    assert.equal(shown.labelHidden, false);
    assert.equal(shown.voiceBox, screen.voiceBox, 'Voice box');
    assert.equal(shown.nameBox, screen.nameBox, 'Voice name box');
    assert.equal(named.voicesRequests.calls.length, screen.fetches, 'fetch count');
    assert.equal(named.getEl('playBtn').disabled, !screen.nameBox, 'Play is open only on the no-list screens, with a name');
    if (screen.nameBox) assert.equal(named.getEl('voiceName').value, 'Olivia.wav', 'prefilled with the saved voice');
    assert.deepEqual(named.storageSets, [], 'showing the screen writes nothing');

    // Without one: Play stays disabled on every screen until a name is typed.
    const blank = loadPopup({
      voicesFetch: screen.voicesFetch,
      stored: { voice: '', ...(screen.serverUrl ? { serverUrl: screen.serverUrl } : {}) }
    });
    await blank.ready;
    assert.equal(blank.getEl('playBtn').disabled, true);
    assert.equal(blank.getEl('voiceName').value, '');
  });
}

test('the amber light is one colour for "no voice list" and "no voices", distinct from grey, green and red', () => {
  const html = fs.readFileSync(path.join(ROOT, 'popup.html'), 'utf8');
  const colours = {};
  for (const [, selectors, body] of html.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const colour = body.match(/background-color:\s*(#[0-9a-fA-F]{3,6})/);
    if (!colour) continue;
    for (const selector of selectors.split(',')) {
      const state = selector.trim().match(/^\.conn-light\.(\w+)$/);
      if (state) colours[state[1]] = colour[1].toLowerCase();
    }
  }
  assert.ok(colours.connOk && colours.connNoList && colours.connFailed, JSON.stringify(colours));
  assert.equal(colours.connNoList, colours.connNoVoices);
  const base = html.match(/\.conn-light\s*\{[^}]*background-color:\s*(#[0-9a-fA-F]{3,6})/)[1].toLowerCase();
  assert.equal(new Set([base, colours.connOk, colours.connNoList, colours.connFailed]).size, 4, 'four different colours');
  assert.ok(/\[hidden\]\s*\{\s*display:\s*none\s*!important/.test(html), 'hidden wins over the group display rules');
});

// --- Voice name box ------------------------------------------------------------------------------------

test('G4/E11: Play is enabled only while the Voice name is non-empty; typing saves `voice` on every input', async () => {
  const popup = loadPopup({ voicesFetch: () => jsonResponse({}, 404), stored: { voice: 'Olivia.wav' } });
  await popup.ready;
  assert.equal(popup.getEl('playBtn').disabled, false);

  await typeVoiceName(popup, '');
  assert.equal(popup.getEl('playBtn').disabled, true, 'emptied: Play disabled');
  await typeVoiceName(popup, '   ');
  assert.equal(popup.getEl('playBtn').disabled, true, 'blanks only: still disabled');
  await typeVoiceName(popup, 'Thomas');
  assert.equal(popup.getEl('playBtn').disabled, false, 're-typed: enabled');
  await typeVoiceName(popup, 'Thomas.wav');

  // Saved trimmed: a blanks-only name is stored as ''.
  assert.deepEqual(popup.storageSets, [
    { voice: '' }, { voice: '' }, { voice: 'Thomas' }, { voice: 'Thomas.wav' }
  ]);
  assert.equal(popup.getEl('voiceName').listeners.input.length, 1);
});

test('G4: with no saved voice the box starts empty and Play is disabled until a name is typed', async () => {
  const popup = loadPopup({ voicesFetch: () => jsonResponse({}, 405) });
  await popup.ready;
  assert.equal(popup.getEl('voiceName').value, '');
  assert.equal(popup.getEl('playBtn').disabled, true);
  await typeVoiceName(popup, 'Olivia.wav');
  assert.equal(popup.getEl('playBtn').disabled, false);
  assert.deepEqual(popup.storageSets, [{ voice: 'Olivia.wav' }]);
});

test('G4/F1: Play on the Voice name screen starts a session that sends the typed name', async () => {
  const sentences = SENTENCES;
  const bg = loadBackground({ sentences, fetch: createGatedFetch(sentences, { auto: true }) });
  const popup = loadPopup({ bg, voicesFetch: () => jsonResponse({}, 404) });
  await popup.ready;
  await typeVoiceName(popup, 'my-custom-voice');
  await popup.getEl('playBtn').click();
  await settle();

  assert.equal(popup.sentOfType('startStreaming')[0].settings.voice, 'my-custom-voice');
  assert.equal(bg.fetch.calls[0].body.voice, 'my-custom-voice');
  assert.deepEqual(Object.keys(bg.fetch.calls[0].body).sort(), ['input', 'model', 'speed', 'voice']);
  // The Play click saves the other settings; the voice was written only by typing.
  assert.deepEqual(popup.storageSets.filter((s) => 'voice' in s), [{ voice: 'my-custom-voice' }]);
});

test('Added: a result that lands while the user is typing in the Voice name box does not move the caret, clear the text or rewrite `voice`', async () => {
  const controlled = controlledVoices();
  const popup = loadPopup({ voicesFetch: controlled.handler, stored: { voice: 'Olivia.wav' } });
  await popup.ready;
  controlled.requests[0].answer(jsonResponse({}, 404));
  await settle();
  assert.equal(ui(popup).nameBox, true);

  const box = popup.getEl('voiceName');
  box.selectionStart = box.selectionEnd = 3; // the caret
  await popup.getEl('connLight').click(); // a re-check starts; the box stays on screen, untouched
  assert.equal(ui(popup).nameBox, true, 'the box does not vanish during a re-check');
  await typeVoiceName(popup, 'Oli');
  const writesBefore = box.valueWrites.length;
  const setsBefore = popup.storageSets.length;

  controlled.requests[1].answer(jsonResponse({}, 404)); // the result lands mid-typing
  await settle();
  assert.equal(ui(popup).light, 'conn-light connNoList');
  assert.equal(box.valueWrites.length, writesBefore, 'the popup assigned nothing to the box');
  assert.equal(box.value, 'Oli');
  assert.equal(box.selectionStart, 3);
  assert.equal(popup.storageSets.length, setsBefore, 'and wrote no voice');
  assert.equal(popup.getEl('playBtn').disabled, false);

  await typeVoiceName(popup, 'Olivia');
  assert.equal(popup.storageSets.at(-1).voice, 'Olivia');
});

test('Added: switching from connNoList to connOk swaps the Voice name box for the list; the voice is read from the live element', async () => {
  let answer = () => jsonResponse({}, 404);
  const popup = loadPopup({ voicesFetch: () => answer() });
  await popup.ready;
  await typeVoiceName(popup, 'Olivia.wav');
  assert.equal(popup.sandbox.getSettings().voice, 'Olivia.wav', 'read from the text box');
  popup.getEl('voice').value = 'Stale.wav'; // the hidden select must not be read while the text box is live
  assert.equal(popup.sandbox.getSettings().voice, 'Olivia.wav');

  answer = () => voicesBody();
  await popup.getEl('connLight').click();
  await settle();
  assert.equal(ui(popup).light, 'conn-light connOk');
  assert.equal(ui(popup).nameBox, false);
  assert.equal(ui(popup).voiceBox, true);
  assert.equal(popup.getEl('voice').value, 'Olivia.wav', 'the typed name is on the list, so the list selects it');
  assert.equal(popup.sandbox.getSettings().voice, 'Olivia.wav', 'now read from the select');

  popup.getEl('voice').value = 'Thomas.wav';
  await popup.getEl('voice').fire('change');
  assert.equal(popup.sandbox.getSettings().voice, 'Thomas.wav');
  assert.equal(popup.storageSets.at(-1).voice, 'Thomas.wav');

  // And back: the box is prefilled with the voice picked in the list.
  answer = () => jsonResponse({}, 404);
  await popup.getEl('connLight').click();
  await settle();
  assert.equal(ui(popup).nameBox, true);
  assert.equal(ui(popup).voiceBox, false);
  assert.equal(popup.getEl('voiceName').value, 'Thomas.wav');
  assert.equal(popup.sandbox.getSettings().voice, 'Thomas.wav');
});

test('Added: a typed name that the new list lacks selects the first voice with the note, and keeps the typed name in storage', async () => {
  let answer = () => jsonResponse({}, 404);
  const popup = loadPopup({ voicesFetch: () => answer() });
  await popup.ready;
  await typeVoiceName(popup, 'Nobody');
  answer = () => voicesBody();
  await popup.getEl('connLight').click();
  await settle();
  assert.equal(popup.getEl('voice').value, 'Abigail.wav');
  assert.equal(ui(popup).note, 'Voice Nobody is not on this server; using Abigail');
  assert.deepEqual(popup.storageSets, [{ voice: 'Nobody' }], 'only the typing wrote');
});

// --- E4: stale and aborted checks ---------------------------------------------------------------------

test('E4/Added: a check that resolves after the popup switched to a newer URL cannot change the Voice box, the note or Play', async () => {
  const lateAnswers = [
    ['an empty list', () => voicesBody([])],
    ['a 404', () => jsonResponse({}, 404)],
    ['a server error', () => jsonResponse({}, 500)],
    ['a different list', () => voicesBody(['Other.wav'])],
    ['a failure', null]
  ];
  for (const [name, late] of lateAnswers) {
    const controlled = controlledVoices();
    const popup = loadPopup({ voicesFetch: controlled.handler, stored: { voice: 'Zed.wav' } });
    await popup.ready;
    await typeUrl(popup, SPEECH(9010));
    await popup.timers.tick(500);
    assert.equal(controlled.requests.length, 2);
    controlled.requests[1].answer(voicesBody());
    await settle();
    const before = ui(popup);
    assert.equal(before.light, 'conn-light connOk');
    assert.equal(before.note, 'Voice Zed.wav is not on this server; using Abigail');

    if (late) controlled.requests[0].answer(late());
    else controlled.requests[0].fail(new TypeError('Failed to fetch'));
    await settle();
    assert.deepEqual(ui(popup), before, name);
    assert.deepEqual(popup.consoleErrors, [], name);
    assert.deepEqual(popup.storageSets, [], name);
  }
});

test('E4: results arriving out of order: the older one is ignored whenever it lands; only the latest is applied', async () => {
  const controlled = controlledVoices();
  const popup = loadPopup({ voicesFetch: controlled.handler });
  await popup.ready;
  await typeUrl(popup, SPEECH(9011));
  await popup.timers.tick(500); // request 1
  await typeUrl(popup, SPEECH(9012));
  await popup.timers.tick(500); // request 2
  assert.equal(controlled.requests.length, 3);
  assert.deepEqual(controlled.requests.map((r) => r.signal.aborted), [true, true, false]);

  controlled.requests[1].answer(voicesBody(['Second.wav']));
  await settle();
  assert.equal(ui(popup).light, 'conn-light connChecking', 'an older answer is not shown');
  assert.equal(ui(popup).play, false);

  controlled.requests[2].answer(voicesBody(['Third.wav', 'Fourth.wav']));
  await settle();
  assert.deepEqual(ui(popup).options, ['Third.wav', 'Fourth.wav']);

  controlled.requests[0].answer(voicesBody(['First.wav']));
  await settle();
  assert.deepEqual(ui(popup).options, ['Third.wav', 'Fourth.wav']);
  assert.equal(ui(popup).selected, 'Third.wav');
});

test('E4: an aborted fetch rejecting with AbortError is silent: no red, no status text, no console error', async () => {
  const controlled = controlledVoices();
  const popup = loadPopup({ voicesFetch: controlled.handler });
  await popup.ready;
  await popup.getEl('connLight').click(); // aborts request 0
  assert.equal(controlled.requests[0].signal.aborted, true);
  controlled.requests[0].fail(abortError());
  await settle();

  assert.equal(ui(popup).light, 'conn-light connChecking');
  assert.equal(ui(popup).label, 'Checking...');
  assert.equal(popup.getEl('status').className, '', 'no status message');
  assert.equal(popup.getEl('status').textContent, '');
  assert.deepEqual(popup.consoleErrors, []);

  controlled.requests[1].answer(voicesBody());
  await settle();
  assert.equal(ui(popup).light, 'conn-light connOk');
  assert.deepEqual(popup.consoleErrors, []);
});

// --- Persistence: when `voice` is written ----------------------------------------------------------------

test('GP4/GP5: unreachable then restored: the light and Voice box follow, Olivia stays selected, and `voice` is never written', async () => {
  const popup = loadPopup({
    voicesFetch: ({ url }) => {
      if (url.includes(':9999')) throw new TypeError('Failed to fetch');
      return voicesBody();
    },
    stored: { voice: 'Olivia.wav' }
  });
  await popup.ready;
  assert.equal(ui(popup).selected, 'Olivia.wav');

  await typeUrl(popup, 'http://localhost:9999/v1/audio/speech');
  await popup.timers.tick(499);
  assert.equal(ui(popup).light, 'conn-light connOk', 'nothing changes before the 500 ms');
  await popup.timers.tick(1);
  await settle();
  assert.equal(ui(popup).light, 'conn-light connFailed');
  assert.equal(ui(popup).label, "Can't reach server - is it running?");
  assert.equal(ui(popup).voiceBox, false);
  assert.equal(ui(popup).nameBox, false);
  assert.equal(ui(popup).play, false);
  assert.deepEqual(popup.storageSets, [], 'GP4: voice is not written');

  await typeUrl(popup, SPEECH(8090));
  await popup.timers.tick(500);
  await settle();
  assert.equal(ui(popup).light, 'conn-light connOk');
  assert.equal(ui(popup).voiceBox, true);
  assert.equal(ui(popup).selected, 'Olivia.wav', 'GP5: still Olivia');
  assert.equal(ui(popup).play, true);
  assert.deepEqual(popup.storageSets, [], 'GP5: voice was never overwritten');
});

test('persistence: every state of this PR leaves `voice` alone; only a pick or typed name writes it', async () => {
  const modes = [
    ['404', () => jsonResponse({}, 404)],
    ['405', () => jsonResponse({}, 405)],
    ['empty', () => voicesBody([])],
    ['underivable', null],
    ['unreachable', () => { throw new TypeError('Failed to fetch'); }],
    ['ok', () => voicesBody()]
  ];
  let next = modes[0][1];
  const popup = loadPopup({ voicesFetch: () => next(), stored: { voice: 'Olivia.wav' } });
  await popup.ready;
  for (const [name, respond] of modes) {
    if (respond) {
      next = respond;
      await typeUrl(popup, SPEECH(8090));
    } else {
      await typeUrl(popup, 'http://localhost:8090/v1/models');
    }
    await popup.timers.tick(500);
    await settle();
    for (const id of ['serverUrl', 'speed', 'recordAudio', 'preprocessText']) await popup.getEl(id).fire('change');
    for (const saved of popup.storageSets) {
      assert.ok(!('voice' in saved), `${name}: saving other settings must not write voice (${JSON.stringify(saved)})`);
    }
  }
  assert.ok(popup.storageSets.length > 0, 'the other settings were saved');

  // The pick and the typed name are the only writers.
  popup.getEl('voice').value = 'Thomas.wav';
  await popup.getEl('voice').fire('change');
  next = () => jsonResponse({}, 404);
  await popup.getEl('connLight').click();
  await settle();
  await typeVoiceName(popup, 'Typed');
  assert.deepEqual(popup.storageSets.filter((s) => 'voice' in s), [{ voice: 'Thomas.wav' }, { voice: 'Typed' }]);
});

test('F4: no chrome.storage.local.set payload ever contains the voice list', async () => {
  const popup = loadPopup();
  await popup.ready;
  popup.getEl('voice').value = 'Olivia.wav';
  await popup.getEl('voice').fire('change');
  for (const id of ['serverUrl', 'speed', 'recordAudio', 'preprocessText']) await popup.getEl(id).fire('change');
  await popup.getEl('playBtn').click();
  assert.ok(popup.storageSets.length >= 6);
  for (const saved of popup.storageSets) {
    const text = JSON.stringify(saved);
    assert.ok(!SERVER_VOICES.some((v) => text.includes(v.replace('.wav', '')) && v !== 'Olivia.wav'), text);
    assert.ok(Object.values(saved).every((value) => !Array.isArray(value)), text);
  }
});
