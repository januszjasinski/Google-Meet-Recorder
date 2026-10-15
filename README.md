# Meet Recorder & Transcriber

A Chrome extension that records Google Meet calls (video + audio, including your own microphone) and captures a transcript with speaker names. Optionally, it can transcribe the recorded audio with OpenAI Whisper or any OpenAI-compatible speech-to-text server.

Recordings are stored locally in the browser (IndexedDB). Nothing leaves your computer unless you run AI transcription.

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

In the library you can:

- play the recording; click any timestamp to jump there
- download the video (`.webm`) and the transcript (`.txt`, or `.srt` subtitles)
- rename or delete recordings
- transcribe the audio with AI (**AI transcript** tab)

## AI transcription (optional)

In **Settings**, add an OpenAI API key, then press **Transcribe audio with AI** on a recording.

- `whisper-1` (default) returns exact timestamps. `gpt-4o-transcribe` / `gpt-4o-mini-transcribe` are often more accurate; their timestamps are estimated per sentence.
- Change **API address** to use another OpenAI-compatible server, such as a self-hosted Whisper (speaches / faster-whisper-server) or Groq. Chrome asks for permission to contact that host when you save.
- Audio is uploaded in 10-minute parts (about 2.4 MB each), so long meetings stay under the 25 MB upload limit.

## How it works

| Piece | File |
| --- | --- |
| Popup: start/stop, live status | `popup.*` |
| Service worker: recording lifecycle, auto-stop when you leave the call or close the tab | `background.js` |
| Offscreen document: `tabCapture` stream + microphone, mixed with Web Audio, recorded with `MediaRecorder`, streamed to IndexedDB in 4-second chunks | `offscreen.js` |
| Content script: reads Meet's live captions (speaker + text), follows your Meet mute button, notices when the call ends | `content.js` |
| Library: playback, transcript, downloads, AI transcription | `recordings.*` |
| Storage, WebM duration fix, transcript formats, speech-to-text client | `lib/` |

Details:

- **Your microphone.** Tab capture only hears the other participants, so the extension also records your mic and mixes it in. While you're muted in Meet, the mic is silenced in the recording too. If Meet uses a microphone other than the system default, pick the same one in Settings.
- **Hearing the call.** Capturing a tab mutes it, so the recorder plays the meeting audio back to you.
- **Seekable files.** `MediaRecorder` writes WebM files with no duration, which can't be seeked. The library adds the duration before playback and download.
- **Crash safety.** Chunks are written to IndexedDB as they're recorded. If the browser closes mid-call, everything up to that point is kept and marked *Partial*.

## Limitations

- **Caption scraping depends on Meet's page structure.** Google changes it from time to time. The scraper uses stable hooks first (ARIA labels, icon names) and falls back to page structure, but a Meet redesign can break it. If the *Meet captions* tab comes up empty, use AI transcription.
- Captions are in the language set in Meet. Speaker names are what Meet shows (your own lines appear as "You").
- Captions are visible in the call while recording, so they also appear in the video.
- The *Video quality* setting caps the resolution; the tab is captured at its actual size, up to that cap. A 720p hour is up to about 1.2 GB. Turn video off for audio-only recordings.
- One recording at a time.

## Privacy and consent

Recording laws differ by country and state, and many require everyone's consent. Always tell participants before you record. Your API key is stored unencrypted in this Chrome profile's extension storage.

## Troubleshooting

- **"Captions off: press CC in Meet"**: the captions button wasn't found, which can happen when it's in the *More options* menu on narrow windows. Turn captions on manually.
- **"Your own voice isn't being recorded"**: microphone access is blocked. Open the setup page again (`welcome.html`) or allow the microphone for this extension in Chrome's site settings.
- **Nothing happens on Start**: reload the Meet tab and try again. After reloading the extension, already-open Meet tabs need a reload.
