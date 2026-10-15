// Speech-to-text for recorded audio via an OpenAI-compatible /audio/transcriptions endpoint
// (OpenAI, Groq, or a self-hosted Whisper server such as speaches / faster-whisper-server).

import * as db from './db.js';

export function apiOriginPattern(baseUrl) {
  return `${new URL(baseUrl).origin}/*`;
}

/** Asks for host permission to call the API. Needs a user gesture unless already granted. */
export async function ensureApiPermission(baseUrl) {
  const origins = [apiOriginPattern(baseUrl)];
  if (await chrome.permissions.contains({ origins })) return true;
  return chrome.permissions.request({ origins });
}

export function needsApiKey(settings) {
  return !settings.apiKey.trim() && /(^|\.)openai\.com$/i.test(new URL(settings.apiBaseUrl).hostname);
}

/**
 * Transcribes every saved audio segment of a recording, in order.
 * Returns transcript lines: { startMs, endMs, speaker, text }.
 */
export async function transcribeRecording(recordingId, settings, onProgress = () => {}) {
  const segments = (await db.getAudio(recordingId)).filter((seg) => seg.blob?.size);
  if (!segments.length) throw new Error('No audio was saved for this recording, so there is nothing to transcribe.');
  const base = settings.apiBaseUrl.trim().replace(/\/+$/, '');
  const lines = [];
  for (const [i, segment] of segments.entries()) {
    onProgress(i, segments.length);
    // Passing the tail of the previous text keeps names and spelling consistent across segments.
    const prompt = lines.slice(-3).map((line) => line.text).join(' ').slice(-400);
    lines.push(...(await transcribeSegment(base, settings, segment, prompt)));
  }
  onProgress(segments.length, segments.length);
  return lines;
}

async function transcribeSegment(base, settings, segment, prompt) {
  const model = settings.model.trim() || 'whisper-1';
  // Whisper models return per-segment timestamps; gpt-4o-*-transcribe only returns plain text.
  const timestamps = /whisper/i.test(model);
  const form = new FormData();
  form.append('file', segment.blob, `part-${segment.seq + 1}.webm`);
  form.append('model', model);
  form.append('response_format', timestamps ? 'verbose_json' : 'json');
  if (settings.language.trim()) form.append('language', settings.language.trim());
  if (prompt) form.append('prompt', prompt);
  const headers = settings.apiKey.trim() ? { Authorization: `Bearer ${settings.apiKey.trim()}` } : {};

  let res;
  try {
    res = await fetch(`${base}/audio/transcriptions`, { method: 'POST', headers, body: form });
  } catch (err) {
    throw new Error(`Could not reach ${base} (${err.message}).`);
  }
  if (!res.ok) throw new Error(`Transcription failed (HTTP ${res.status}): ${await errorDetail(res)}`);
  const data = await res.json();

  if (Array.isArray(data.segments) && data.segments.length) {
    return data.segments
      // Whisper tends to invent text ("Thank you.") over silence; drop segments it isn't confident contain speech.
      .filter((s) => !(s.no_speech_prob > 0.6 && s.avg_logprob < -1))
      .map((s) => ({
        startMs: Math.round(segment.startMs + s.start * 1000),
        endMs: Math.round(segment.startMs + s.end * 1000),
        speaker: '',
        text: (s.text || '').trim(),
      }))
      .filter((line) => line.text);
  }
  return spreadSentences((data.text || '').trim(), segment.startMs, segment.endMs - segment.startMs);
}

/** Splits plain text into sentences with timestamps estimated from their share of the text. */
function spreadSentences(text, startMs, durationMs) {
  if (!text) return [];
  const sentences = (text.match(/[^.!?。！？]+(?:[.!?。！？]+["')\]]*|$)/g) || [text]).map((s) => s.trim()).filter(Boolean);
  const total = sentences.reduce((n, s) => n + s.length, 0);
  let offset = 0;
  return sentences.map((sentence) => {
    const from = startMs + (durationMs * offset) / total;
    offset += sentence.length;
    return { startMs: Math.round(from), endMs: Math.round(startMs + (durationMs * offset) / total), speaker: '', text: sentence };
  });
}

async function errorDetail(res) {
  const body = await res.text().catch(() => '');
  try {
    return JSON.parse(body).error?.message || body.slice(0, 300);
  } catch {
    return body.slice(0, 300) || res.statusText;
  }
}
