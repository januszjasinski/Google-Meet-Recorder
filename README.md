# Meet Recorder & Transcriber

A Chrome extension that records Google Meet calls (video + audio, including your own microphone) and captures a transcript with speaker names. Optionally, it can transcribe the recorded audio with OpenAI Whisper or any OpenAI-compatible speech-to-text server.

Recordings stay on your computer, inside Chrome's own storage. Nothing is uploaded unless you run AI transcription. See [Where files are saved](#where-files-are-saved).

## Install

1. Open `chrome://extensions` and switch on **Developer mode**.
2. Click **Load unpacked** and select this folder.
3. A setup page opens. Click **Allow microphone** so your own voice is recorded too.
4. Pin the extension from the puzzle-piece menu.

Requires Chrome 116 or later.

## Use

1. Join a call on meet.google.com.
2. Click the extension icon and press **Start recording**. The toolbar icon shows `REC`.
3. Meet's captions are switched on automatically and become the transcript. The popup shows the live transcript, mic state and elapsed time.
4. Press **Stop & save**, or just leave the call or close the tab. The recording then opens in the library.

If something goes wrong while recording, for example the disk fills up, the toolbar icon shows `!` and the popup says what happened. The library keeps that note with the recording.

In the library you can:

- play the recording; click any timestamp to jump there
- download the recording (`.mp4`, or `.m4a` for audio-only) and the transcript (`.txt`, or `.srt` subtitles)
- rename or delete recordings
- transcribe the audio with AI (**AI transcript** tab)

## AI transcription (optional)

In **Settings**, add an OpenAI API key, then press **Transcribe audio with AI** on a recording.

- `whisper-1` (default) returns exact timestamps. `gpt-4o-transcribe` / `gpt-4o-mini-transcribe` are often more accurate; their timestamps are estimated per sentence.
- Change **API address** to use another OpenAI-compatible server, such as a self-hosted Whisper (speaches / faster-whisper-server) or Groq. Chrome asks for permission to contact that host when you save.
- Audio is uploaded in 10-minute parts (about 2.4 MB each), so long meetings stay under the 25 MB upload limit.

## Where files are saved

| What | Where |
| --- | --- |
| Recordings: video/audio, transcripts, and the audio kept for AI transcription | Chrome's storage for this extension (IndexedDB), inside your Chrome profile folder. Saved in 4-second pieces while you record. |
| Downloads (`.mp4`/`.m4a` or `.webm`, `.txt`, `.srt`) | Your normal Chrome downloads folder, or wherever Chrome asks you to save. Files are only written there when you click a download button in the library. |
| Settings, including the API key | Chrome's extension storage, in the same profile folder under `Local Extension Settings/<extension ID>`. |

The recordings folder on disk is:

- Windows: `%LOCALAPPDATA%\Google\Chrome\User Data\Default\IndexedDB\chrome-extension_<extension ID>_0.indexeddb.*`
- macOS: `~/Library/Application Support/Google/Chrome/Default/IndexedDB/chrome-extension_<extension ID>_0.indexeddb.*`
- Linux: `~/.config/google-chrome/Default/IndexedDB/chrome-extension_<extension ID>_0.indexeddb.*`

`Default` is your first Chrome profile; other profiles are `Profile 1`, `Profile 2`, and so on. The extension ID is shown on `chrome://extensions`. These are Chrome's internal database files, not playable videos. To get real files, use the download buttons in the library.

Good to know:

- **Removing the extension deletes all its recordings.** Download anything you want to keep first. Deleting a recording in the library removes it from disk straight away.
- **Keep the extension in the same folder.** Chrome gives an unpacked extension an ID based on its folder path. Loaded from a different folder, it counts as a new extension with an empty library.
- **Disk space:** up to about 1.2 GB per hour at 720p, about 70 MB per hour audio-only. The library sidebar shows how much space recordings use.

**What gets uploaded:** only when you run AI transcription, by clicking the button or turning on *Transcribe automatically*. The extension then sends the recording's audio, in 10-minute parts, to the API address in Settings (OpenAI by default). Video and captions are never uploaded by the extension. Meet's captions are produced by Google as part of the call; the extension only reads the text from the page.

## How it works

| Piece | File |
| --- | --- |
| Popup: start/stop, live status | `popup.*` |
| Service worker: recording lifecycle, auto-stop when you leave the call or close the tab | `background.js` |
| Offscreen document: `tabCapture` stream + microphone, mixed with Web Audio, recorded with `MediaRecorder`, streamed to IndexedDB in 4-second chunks | `offscreen.js` |
| Content script: reads Meet's live captions (speaker + text), follows your Meet mute button, notices when the call ends | `content.js` |
| Library: playback, transcript, downloads, AI transcription | `recordings.*` |
| Storage, WebM duration fix, transcript formats, speech-to-text client | `lib/` |
| Automated tests (see [Tests](#tests)) | `tests/` |

Details:

- **Your microphone.** Tab capture only hears the other participants, so the extension also records your mic and mixes it in. While you're muted in Meet, the mic is silenced in the recording too. If Meet uses a microphone other than the system default, pick the same one in Settings.
- **Hearing the call.** Capturing a tab mutes it, so the recorder plays the meeting audio back to you.
- **File format.** Recordings are MP4 (H.264 video, AAC audio) wherever Chrome can encode it, which opens in any player, QuickTime included. Otherwise, or if you choose WebM in Settings, they're WebM. `MediaRecorder` writes WebM with no duration, so it can't be seeked; the library adds the duration before playback and download.
- **Crash safety.** Recordings are written to IndexedDB every few seconds as they're recorded. If the browser closes mid-call, everything up to that point is kept and marked *Partial*.
- **Problems are shown, not hidden.** A failed save (such as a full disk) or a recorder crash shows in the popup and as `!` on the toolbar icon. Low disk space (under 1 GB free) shows as a warning in the popup. Both are kept with the recording.
- **Caption check.** If you're in the call, captions aren't switched off, and the extension still can't find Meet's captions after 20 seconds, the popup says so, and the library suggests AI transcription for that recording.

## Limitations

- **Caption scraping depends on Meet's page structure.** Google changes it from time to time. The scraper uses stable hooks first (ARIA labels, icon names) and falls back to page structure, but a Meet redesign can break it. When that happens, the popup tells you within about 20 seconds, so you know to use AI transcription for that call.
- Captions are in the language set in Meet. Speaker names are what Meet shows (your own lines appear as "You").
- Captions are visible in the call while recording, so they also appear in the video.
- The *Video quality* setting caps the resolution; the tab is captured at its actual size, up to that cap. A 720p hour is up to about 1.2 GB. Turn video off for audio-only recordings.
- One recording at a time.

## Tests

`npm test` runs the checks in headless Chrome. It needs Node 18+ and Chrome or Chromium 126+; there's nothing to install.

- **media**: recording files: the WebM duration fix, MP4 playback and seeking.
- **captions**: the caption reader against a mock Meet page: merging and de-duplicating lines, speaker names, mute state, leaving the call, captions that can't be read.
- **extension**: loads the real extension and records from a simulated tab: saving, stopping, library playback in both formats, error reporting with a simulated full disk, and the speech-to-text client against a mock server.

Run some suites only with, for example, `node tests/run.mjs captions`. Set `CHROME_PATH` if Chrome isn't in its usual place, and `CHROME_FLAGS=--no-sandbox` inside a Linux container.

The tests can't click Chrome's toolbar button or join a real call, so tab capture and the live Meet page still need a manual check. When Meet changes its layout, first update `tests/pages/captions.html` to match the new page, then fix `content.js` until the tests pass.

## Privacy and consent

Recording laws differ by country and state, and many require everyone's consent. Always tell participants before you record. Your API key is stored unencrypted in this Chrome profile's extension storage.

## Troubleshooting

- **"Captions off: press CC in Meet"**: the captions button wasn't found, which can happen when it's in the *More options* menu on narrow windows. Turn captions on manually.
- **"Can't read Meet's captions"**: captions seem to be on, but the extension can't find them on the page, most likely because Meet changed its layout. The recording itself is fine; transcribe its audio with AI afterwards.
- **`!` on the toolbar icon**: something failed while recording. Open the popup to see what; the same note appears with the recording in the library.
- **"Your own voice isn't being recorded"**: microphone access is blocked. Open the setup page again (`welcome.html`) or allow the microphone for this extension in Chrome's site settings.
- **Nothing happens on Start**: reload the Meet tab and try again. After reloading the extension, already-open Meet tabs need a reload.
