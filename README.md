# Local TTS Reader - Chrome Extension

A sleek Chrome extension that converts webpage text to speech using a local OpenAI-compatible TTS server. Features include voice selection, speed control, and the ability to save audio files.


## Features

- 🎯 Read selected text or entire webpage
- 📚 Sentence-by-sentence chunking with prefetch, so playback flows from
  one sentence to the next without waiting on the network mid-read
- 🖍️ The sentence currently being read is highlighted live on the page
  (works even when a sentence spans bold text, links, or other inline
  formatting)
- 🥶 Cold-start aware: shows a distinct "Starting voice engine…" state
  and uses a longer timeout for the first request of a session, since
  some local TTS backends (e.g. a sleeping llama-swap/Chatterbox
  process) can take up to ~30s to wake up
- 🎭 Voices come from the server you connect to: the popup asks its voices
  endpoint and lists what it offers, with a traffic light showing whether the
  server is reachable
- ⚡ Adjustable playback speed (0.25x to 4.0x)
- 💾 Option to save audio for download
- ⏯️ Play/Pause/Stop/Seek controls
- 🎨 Clean, modern interface
- 🔧 Configurable server URL
- 🌐 Works with Tailscale/local network TTS servers

## Installation

1. Clone this repository:
```bash
git clone https://github.com/phildougherty/local_tts_reader.git
```

2. Load the extension in Chrome:
   - Open Chrome and navigate to `chrome://extensions/`
   - Enable "Developer mode" in the top right
   - Click "Load unpacked"
   - Select the cloned repository folder

## Usage

1. Click the extension icon in your Chrome toolbar
2. Configure your settings:
   - Enter your local TTS server URL (it opens on
     `http://localhost:8090/v1/audio/speech`) and wait for the light beside it
     to turn green
   - Select your preferred voice (the Voice box appears once the light is
     green; see "Connection light and voices" below)
   - Adjust the playback speed using the slider
   - Check "Save audio for download" if you want to download the audio

3. On any webpage:
   - Select specific text to read just that portion
   - Or don't select anything to read the entire page
   - Click play to start TTS
   - Use pause/stop controls as needed
   - Download the audio if recording was enabled

## Connection light and voices

The extension has no built-in voice list. Next to the Server URL a small light
shows what the server answered, and the Voice box is filled from that answer.

The check is one plain `GET /v1/audio/voices?model=tts-1` against the server,
at the address derived from the Server URL by replacing the trailing
`/audio/speech` with `/audio/voices` and adding `?model=tts-1`. For the default
URL that is `http://localhost:8090/v1/audio/voices?model=tts-1`. It runs when the popup
opens, 500 ms after you stop editing the Server URL, and when you click the
light. There is no polling, and the voice list is never stored.

Two response shapes are accepted: `{"voices": [...]}` (what llama-swap in front
of Chatterbox returns, e.g. `{"status":"ok","voices":["Olivia.wav", ...]}`) and a
bare array `[...]`. Entries are strings, or objects read by `id`, then `name`,
then `voice`. Empty and duplicate entries are dropped and the server's order is
kept. A trailing `.wav`, `.mp3`, `.flac` or `.ogg` is left off the label
(`Olivia.wav` shows as Olivia), but the raw name is what is sent to the server.
A server that answers 404 or 405 has no voices endpoint, which counts as
"connected, no voice list".

The light's states:

- Grey, "Checking...": a check is running.
- Grey, "Starting voice engine...": the check has been running for more than
  3 seconds. A sleeping backend (e.g. llama-swap unloading the model after idle)
  can take about 30 s to wake, and the check waits up to 90 s before it turns red.
- Green, "Connected": the server answered with at least one voice. The Voice box
  shows the list and Play is enabled.
- Amber, "Connected, no voice list": the server has no voices endpoint (404 or
  405), or the Server URL does not end in `/audio/speech` ("Can't derive a voices
  address"). The Voice box is replaced by a "Voice name" text box, which is
  what is sent; Play is enabled while it is not empty.
- Amber, "Server has no voices": the server answered but its list is empty. Play
  is disabled.
- Red: the Voice box is hidden and Play is disabled. The reason is one of
  "Can't reach server - is it running?" (any network failure), "Not authorised
  (401)" or "(403)", "Server error N" for any other non-200 answer, "Unexpected
  response" for a 200 that is not a voices list, or "Timed out - click the light
  to retry" after 90 s.

A saved voice that the server no longer offers is replaced on screen by the
first voice, with a one-line note; nothing is saved until you pick a voice or
type a name.

Right-click "Read Aloud" does not open the popup, so it makes the same check
itself before each read: it stops any current reading, shows "Starting voice
engine...", asks the voices endpoint once (up to 90 s) and sends your saved
voice if the server offers it, otherwise the first voice. If the server has no
voice list the saved voice is sent as it is; if the check fails the read starts
with the saved voice and any error shows as usual. With no saved voice and no
list, no read starts and it says "No voice selected - open the popup". If the
server answers with an empty voice list, no read starts either and it says
"Server has no voices". Stop cancels a read that is still waiting on this
check. This check never changes your saved settings.

## Server Requirements

Your local TTS server should:
- Be OpenAI API compatible
- Accept POST requests to `/v1/audio/speech`
- Ideally also answer `GET /v1/audio/voices?model=tts-1` with the voices it
  offers (see "Connection light and voices"); without it the extension still
  works, with a typed voice name
- Accept JSON payload in the format:
\\```json
{
  "model": "tts-1",
  "voice": "Olivia.wav",
  "input": "text to speak",
  "speed": 1.0
}
\\```
- Return audio data (mp3/wav)

Note: the extension now sends one request **per sentence** rather than
one request for the whole selection (see "How reading works" below), so
`input` will typically be a single sentence, not a full paragraph.

Default server URL: `http://localhost:8090/v1/audio/speech` (the voice sent
in the example above, `Olivia.wav`, is one of a Chatterbox server's voice files;
use a name your own server offers)

## How reading works

When you hit play, the extension:
1. Captures the current selection, or — if nothing is selected — tries
   to extract just the article content of the page (dropping nav bars,
   ads, sidebars, related-links widgets, etc.) using a vendored copy of
   [Mozilla's Readability.js](https://github.com/mozilla/readability),
   the same extraction library behind Firefox's Reader View. When that
   succeeds, the extracted article is shown in a clean, distraction-free
   overlay (closeable, or press Esc) and read from there; if extraction
   fails or the page doesn't look like a single article, it falls back
   to reading the whole page exactly as before. Either way, the result
   is split into sentences.
2. Requests the first sentence's audio. The very first request of a
   new session uses a longer timeout (45-60s) and the popup shows
   "Starting voice engine…", since some local TTS backends need time
   to load a model on their first request after being idle. Every
   request after that uses a shorter timeout (15-20s).
3. While a sentence plays, the *next* sentence's audio is fetched in
   the background, so there's no gap waiting on the network between
   sentences.
4. The sentence currently playing is highlighted on the page itself
   (not just scrolled to) via a content script — this works even when
   a sentence spans multiple inline elements like bold text or links.
5. Stop immediately cancels any in-flight request and clears the rest
   of the queue; the highlight is cleared on Stop, when a sentence
   finishes, and on page navigation.
6. If a request times out, it's retried once before an error is shown.

A background `chrome.alarms` heartbeat runs while a session is active,
to reduce the chance Chrome terminates the extension's MV3 service
worker while waiting on a slow (cold-start) response.

While a session is active its sentences and position are also kept in
`chrome.storage.session` (browser memory only; cleared when the browser
closes, on Stop and when the read finishes). If Chrome restarts the
service worker during a long Pause, the new worker rebuilds the paused
session from that, and Play fetches the current sentence again and reads
it from its start. If only the audio document was closed, Play replays the
kept audio of the current sentence. No page URL or TTS server URL is stored.

## Development

The extension's main files:
- `manifest.json`: Extension configuration
- `background.js`: Service worker — owns the reading session (chunking,
  prefetch, timeouts/retries, cold-start state)
- `contentScript.js` / `sentenceSplitter.js`: Injected into the page to
  capture the selection (or extracted article), split it into
  sentences, and highlight the sentence currently playing
- `vendor/readability.js`: Unmodified vendored copy of Mozilla's
  Readability.js (Apache-2.0, see `vendor/LICENSE-mozilla-readability.md`)
- `offscreen.js` / `offscreen.html`: Plays each sentence's audio
- `popup.html` / `popup.js`: UI and settings
- `textProcessor.js`: Strips markdown/URLs before sending text to TTS

To modify the extension:
1. Make your changes
2. Reload the extension in `chrome://extensions/`
3. Click the refresh icon on the extension card

## Contributing

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/AmazingFeature`)
3. Commit your changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

## License

Distributed under the MIT
