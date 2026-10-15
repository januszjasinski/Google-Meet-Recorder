// Offscreen document: captures the Meet tab, mixes in the microphone and records with MediaRecorder.
// Chunks go straight to IndexedDB so long meetings don't build up in memory and survive a crash.

import * as db from './lib/db.js';
import { VIDEO_QUALITY } from './lib/settings.js';

const CHUNK_MS = 4000;
// Speech-to-text APIs cap uploads at 25 MB; 10 minutes of 32 kbps Opus is about 2.4 MB.
const SEGMENT_MS = 10 * 60 * 1000;
const SEGMENT_TYPE = 'audio/webm;codecs=opus';
const MIC_TIMEOUT_MS = 5000;

let session = null;

const handlers = { start, stop, 'set-mic-muted': setMicMuted };

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const handler = msg?.target === 'offscreen' && handlers[msg.type];
  if (!handler) return false;
  handler(msg).then(
    (result) => sendResponse({ ok: true, ...result }),
    (err) => sendResponse({ ok: false, error: err?.message || String(err) }),
  );
  return true;
});

function notify(type, extra = {}) {
  chrome.runtime.sendMessage({ target: 'background', type, ...extra }).catch(() => {});
}

function fail(err) {
  console.error(err);
  notify('recorder-error', { detail: err?.message || String(err) });
}

function pickMimeType(video) {
  const types = video
    ? ['video/webm;codecs=vp8,opus', 'video/webm;codecs=vp9,opus', 'video/webm']
    : ['audio/webm;codecs=opus', 'audio/webm'];
  return types.find((type) => MediaRecorder.isTypeSupported(type)) || '';
}

async function getMic(deviceId) {
  const request = navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: deviceId ? { ideal: deviceId } : undefined,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('no answer to the permission request')), MIC_TIMEOUT_MS);
  });
  try {
    return await Promise.race([request, timeout]);
  } catch (err) {
    request.then((stream) => stream.getTracks().forEach((t) => t.stop())).catch(() => {});
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function start({ streamId, recordingId, settings, micMuted }) {
  if (session) await stop();
  const quality = VIDEO_QUALITY[settings.videoQuality] || VIDEO_QUALITY['720p'];
  const source = { chromeMediaSource: 'tab', chromeMediaSourceId: streamId };
  const tabStream = await navigator.mediaDevices.getUserMedia({
    audio: { mandatory: source },
    video: settings.recordVideo
      ? { mandatory: { ...source, maxWidth: quality.width, maxHeight: quality.height, maxFrameRate: 30 } }
      : false,
  });

  const warnings = [];
  const ctx = new AudioContext();
  if (ctx.state !== 'running') await ctx.resume().catch(() => {});

  let audioTrack;
  let micStream = null;
  let micGain = null;
  if (ctx.state === 'running') {
    // Capturing a tab silences it for the user, so play the meeting back out loud.
    const meeting = ctx.createMediaStreamSource(tabStream);
    meeting.connect(ctx.destination);
    const mix = ctx.createMediaStreamDestination();
    meeting.connect(mix);
    if (settings.includeMic) {
      try {
        micStream = await getMic(settings.micDeviceId);
        micGain = ctx.createGain();
        micGain.gain.value = micMuted ? 0 : 1;
        ctx.createMediaStreamSource(micStream).connect(micGain).connect(mix);
      } catch (err) {
        const why = err?.name === 'NotAllowedError' ? 'microphone permission is blocked' : err.message;
        warnings.push(`Your own voice isn't being recorded (${why}). Other participants are.`);
      }
    }
    audioTrack = mix.stream.getAudioTracks()[0];
  } else {
    warnings.push("Chrome blocked audio mixing, so only the meeting audio is recorded, not your microphone.");
    audioTrack = tabStream.getAudioTracks()[0];
    const playback = new Audio();
    playback.srcObject = new MediaStream([audioTrack]);
    playback.play().catch(() => {});
  }

  const mimeType = pickMimeType(settings.recordVideo);
  const recorder = new MediaRecorder(new MediaStream([...tabStream.getVideoTracks(), audioTrack]), {
    mimeType,
    videoBitsPerSecond: quality.bitrate,
    audioBitsPerSecond: 128_000,
  });
  const s = {
    recordingId,
    ctx,
    tabStream,
    micStream,
    micGain,
    recorder,
    audioTrack,
    mimeType: recorder.mimeType || mimeType,
    startedAt: 0,
    size: 0,
    seq: 0,
    writes: [],
    segment: null,
    segmentSeq: 0,
    segmentTimer: 0,
    stopping: null,
  };

  recorder.ondataavailable = (event) => {
    if (!event.data.size) return;
    s.size += event.data.size;
    const totals = { size: s.size, durationMs: Date.now() - s.startedAt };
    s.writes.push(db.putChunk(recordingId, s.seq++, event.data, totals).catch(fail));
  };
  recorder.onerror = (event) => fail(event.error || new Error('MediaRecorder failed'));
  for (const track of tabStream.getTracks()) {
    track.addEventListener('ended', () => {
      if (session === s && !s.stopping) notify('capture-ended');
    });
  }

  s.startedAt = Date.now();
  recorder.start(CHUNK_MS);
  if (MediaRecorder.isTypeSupported(SEGMENT_TYPE)) {
    startSegment(s);
    s.segmentTimer = setInterval(() => rotateSegment(s), SEGMENT_MS);
  }
  session = s;
  return { startedAt: s.startedAt, mimeType: s.mimeType, hasMic: Boolean(micGain), warnings };
}

// Separate small audio-only files, each independently decodable, for speech-to-text.
function startSegment(s) {
  const recorder = new MediaRecorder(new MediaStream([s.audioTrack]), { mimeType: SEGMENT_TYPE, audioBitsPerSecond: 32_000 });
  const parts = [];
  const segment = { recorder, seq: s.segmentSeq++, startMs: Date.now() - s.startedAt };
  recorder.ondataavailable = (event) => {
    if (event.data.size) parts.push(event.data);
  };
  segment.saved = new Promise((resolve) => {
    recorder.onstop = () => {
      const blob = new Blob(parts, { type: SEGMENT_TYPE });
      if (!blob.size) return resolve();
      db.putAudio({ recordingId: s.recordingId, seq: segment.seq, startMs: segment.startMs, endMs: Date.now() - s.startedAt, blob })
        .catch(fail)
        .finally(resolve);
    };
  });
  recorder.start();
  s.segment = segment;
}

function rotateSegment(s) {
  const previous = s.segment;
  startSegment(s); // Start the next one first so no audio falls between them.
  previous.recorder.stop();
  s.writes.push(previous.saved);
}

function stopRecorder(recorder) {
  return new Promise((resolve) => {
    if (recorder.state === 'inactive') return resolve();
    recorder.addEventListener('stop', () => resolve(), { once: true });
    recorder.stop();
  });
}

async function stop() {
  const s = session;
  if (!s) return { stopped: false };
  s.stopping ??= finish(s);
  return s.stopping;
}

async function finish(s) {
  const durationMs = Date.now() - s.startedAt;
  clearInterval(s.segmentTimer);
  await Promise.all([stopRecorder(s.recorder), s.segment && stopRecorder(s.segment.recorder)]);
  if (s.segment) s.writes.push(s.segment.saved);
  await Promise.allSettled(s.writes);
  for (const track of s.tabStream.getTracks()) track.stop();
  s.micStream?.getTracks().forEach((track) => track.stop());
  await s.ctx.close().catch(() => {});
  if (session === s) session = null;
  return { stopped: true, durationMs, size: s.size, mimeType: s.mimeType };
}

async function setMicMuted({ muted }) {
  const s = session;
  if (s?.micGain) s.micGain.gain.setTargetAtTime(muted ? 0 : 1, s.ctx.currentTime, 0.02);
  return {};
}
