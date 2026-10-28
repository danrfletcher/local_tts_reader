'use strict';
/**
 * The fake TTS server's /v1/audio/voices modes (200, 200 empty, 404, 405, 500,
 * hang, close), switched at run time through /__voices. It listens on an
 * ephemeral port (0) chosen by the OS, on loopback only.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { server, state, VOICES } = require('./fixtures/fake-tts-server.js');

let base = '';

test.before(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
  server.closeAllConnections();
  server.close();
});

test.beforeEach(() => {
  state.mode = 'ok';
  state.voicesRequests = 0;
});

const setMode = async (mode) => (await fetch(`${base}/__voices?mode=${mode}`)).json();

test('ok: 200 with the 28 voice files in server order', async () => {
  const response = await fetch(`${base}/v1/audio/voices?model=tts-1`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.status, 'ok');
  assert.deepEqual(body.voices, VOICES);
  assert.equal(body.voices.length, 28);
});

test('empty: 200 with an empty voices array', async () => {
  await setMode('empty');
  const response = await fetch(`${base}/v1/audio/voices`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'ok', voices: [] });
});

test('404, 405 and 500 answer with that status', async () => {
  for (const mode of ['404', '405', '500']) {
    await setMode(mode);
    const response = await fetch(`${base}/v1/audio/voices`);
    assert.equal(response.status, Number(mode), mode);
  }
});

test('hang: no answer until the client aborts', async () => {
  await setMode('hang');
  const controller = new AbortController();
  const pending = fetch(`${base}/v1/audio/voices`, { signal: controller.signal });
  const outcome = await Promise.race([
    pending.then(() => 'answered', () => 'rejected'),
    new Promise((resolve) => setTimeout(() => resolve('still waiting'), 150))
  ]);
  assert.equal(outcome, 'still waiting');
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
});

test('close: the connection is dropped without an answer', async () => {
  await setMode('close');
  await assert.rejects(fetch(`${base}/v1/audio/voices`));
});

test('/__voices reports the mode and counts voices requests; the speech route is not counted; a bad mode is 400', async () => {
  assert.deepEqual(await setMode('404'), { mode: '404', requests: 0 });
  await fetch(`${base}/v1/audio/voices`);
  await fetch(`${base}/v1/audio/voices`);
  await fetch(`${base}/v1/audio/speech`, { method: 'POST', body: '{}' });
  assert.deepEqual(await (await fetch(`${base}/__voices`)).json(), { mode: '404', requests: 2 });
  assert.equal((await fetch(`${base}/__voices?mode=nope`)).status, 400);
  assert.equal(state.mode, '404', 'a bad mode changes nothing');
});
