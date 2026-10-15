import * as db from './lib/db.js';
import { getSettings } from './lib/settings.js';
import { fixWebmDuration } from './lib/webm.js';
import { clock, humanDuration, formatBytes, formatDate, fileBaseName, transcriptText, transcriptSrt } from './lib/format.js';
import { transcribeRecording, ensureApiPermission, needsApiKey } from './lib/transcribe.js';

const $ = (id) => document.getElementById(id);
const player = $('player');

let recordings = [];
let activeId = null; // recording still in progress, per the background
let current = null; // { rec, captions, live, source, blob, url, activeLine }
let transcribing = null; // id of the recording being transcribed
let livePoll = 0;
let toastTimer = 0;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function toast(message) {
  const node = $('toast');
  node.textContent = message;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (node.hidden = true), 2400);
}

function hue(name) {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)) % 360;
  return h;
}

// ---- List ----

async function refreshList() {
  const [list, res] = await Promise.all([
    db.listRecordings(),
    chrome.runtime.sendMessage({ target: 'background', type: 'get-state' }).catch(() => null),
  ]);
  activeId = res?.state?.recordingId || null;
  recordings = list;
  renderList();
  renderStorage();
  if (!current) return;
  const fresh = list.find((rec) => rec.id === current.rec.id);
  if (!fresh) await select(list[0]?.id);
  else if (fresh.status !== current.rec.status || (fresh.id === activeId) !== current.live) await select(fresh.id, true);
}

function statusOf(rec) {
  if (rec.id === activeId) return 'recording';
  return rec.status === 'complete' ? '' : 'interrupted';
}

function renderList() {
  $('list-empty').hidden = recordings.length > 0;
  $('list').replaceChildren(
    ...recordings.map((rec) => {
      const button = el('button', 'rec-item');
      button.dataset.id = rec.id;
      if (current?.rec.id === rec.id) button.setAttribute('aria-current', 'true');
      const meta = el('span', 'rec-item-meta');
      const status = statusOf(rec);
      if (status) meta.append(el('span', `status status-${status}`, status === 'recording' ? 'REC' : 'Partial'));
      meta.append(`${formatDate(rec.startedAt)} · ${humanDuration(rec.durationMs)}`);
      button.append(el('span', 'rec-item-title', rec.title), meta);
      const item = el('li');
      item.append(button);
      return item;
    }),
  );
}

async function renderStorage() {
  try {
    const { usage } = await navigator.storage.estimate();
    $('storage').textContent = `${formatBytes(usage)} stored on this computer`;
  } catch {
    $('storage').textContent = '';
  }
}

// ---- Selected recording ----

function releaseMedia() {
  clearInterval(livePoll);
  player.pause();
  player.removeAttribute('src');
  player.load();
  if (current?.url) URL.revokeObjectURL(current.url);
}

function showEmpty() {
  releaseMedia();
  current = null;
  $('recording').hidden = true;
  $('detail-empty').hidden = false;
  history.replaceState(null, '', location.pathname);
  renderList();
}

async function select(id, force = false) {
  if (!id) return showEmpty();
  if (!force && current?.rec.id === id) return;
  const rec = await db.getRecording(id);
  if (!rec) return showEmpty();
  if (location.hash.slice(1) !== id) history.replaceState(null, '', `#${id}`);
  const keepSource = current?.rec.id === id ? current.source : null;
  releaseMedia();
  const captions = await db.getCaptions(id);
  current = {
    rec,
    captions,
    live: id === activeId,
    source: keepSource || (captions.length || !rec.cloud?.lines?.length ? 'captions' : 'cloud'),
    blob: null,
    url: null,
    activeLine: -1,
  };
  $('transcript-error').hidden = true;
  renderList();
  renderDetail();
  if (current.live) livePoll = setInterval(reloadLiveCaptions, 3000);
  else loadMedia(current);
}

function setPlayerMessage(message) {
  $('player-empty').textContent = message;
  $('player-empty').hidden = !message;
  player.hidden = Boolean(message);
}

async function loadMedia(target) {
  const { rec } = target;
  setPlayerMessage('Loading…');
  const chunks = await db.getChunks(rec.id);
  if (current !== target) return;
  if (!chunks.length) return setPlayerMessage('No audio or video was saved for this recording.');
  const type = rec.mimeType || chunks[0].type || 'video/webm';
  const blob = await fixWebmDuration(new Blob(chunks, { type }), rec.durationMs);
  if (current !== target) return;
  target.blob = blob;
  target.url = URL.createObjectURL(blob);
  player.classList.toggle('audio-only', !rec.hasVideo);
  player.src = target.url;
  setPlayerMessage('');
  $('download-media').disabled = false;
}

async function reloadLiveCaptions() {
  const target = current;
  if (!target?.live) return;
  const captions = await db.getCaptions(target.rec.id);
  const signature = (lines) => lines.reduce((n, line) => n + line.text.length, lines.length);
  if (current !== target || signature(captions) === signature(target.captions)) return;
  target.captions = captions;
  renderTranscript();
}

function renderDetail() {
  const { rec, live } = current;
  $('detail-empty').hidden = true;
  $('recording').hidden = false;
  $('rec-title').textContent = rec.title;
  const meta = [formatDate(rec.startedAt), humanDuration(rec.durationMs)];
  if (rec.size) meta.push(formatBytes(rec.size));
  meta.push(rec.hasVideo ? 'Video' : 'Audio only');
  if (rec.hasMic === false) meta.push('your mic not included');
  $('rec-meta').textContent = meta.join(' · ');
  $('download-media').lastElementChild.textContent = rec.hasVideo ? 'Download video' : 'Download audio';
  $('download-media').disabled = true;
  $('delete').disabled = live;

  const notice = $('rec-notice');
  notice.hidden = false;
  if (live) {
    notice.className = 'banner banner-info';
    notice.textContent = 'This meeting is still being recorded. The video will be here once you stop recording.';
    setPlayerMessage('Recording in progress…');
  } else if (rec.status !== 'complete') {
    notice.className = 'banner banner-warn';
    notice.textContent = 'This recording was cut short (the browser or tab closed unexpectedly). Everything saved up to that point is here.';
  } else {
    notice.hidden = true;
  }
  renderTranscript();
}

function linesFor(source) {
  return source === 'cloud' ? current.rec.cloud?.lines || [] : current.captions;
}

function renderTranscript() {
  const { rec, source, live } = current;
  const lines = linesFor(source);
  const busy = transcribing === rec.id;

  for (const tab of [$('tab-captions'), $('tab-cloud')]) {
    const count = linesFor(tab.dataset.source).length;
    tab.setAttribute('aria-selected', String(tab.dataset.source === source));
    tab.replaceChildren(tab.dataset.source === 'cloud' ? 'AI transcript' : 'Meet captions');
    if (count) tab.append(el('span', 'count', String(count)));
  }
  for (const id of ['copy', 'download-txt', 'download-srt']) $(id).disabled = !lines.length;

  const empty = !lines.length && !(busy && source === 'cloud');
  $('transcript-empty').hidden = !empty;
  $('transcribe-empty').hidden = live || busy;
  if (empty) {
    $('transcript-empty-text').textContent =
      source === 'cloud'
        ? live
          ? 'Once the recording stops, you can turn its audio into text with OpenAI Whisper or another speech-to-text service.'
          : 'Turn the recorded audio into text with OpenAI Whisper or another OpenAI-compatible speech-to-text service. Useful if captions were off, or for a second, more accurate pass.'
        : live
          ? 'Waiting for captions… Make sure captions (CC) are turned on in Meet.'
          : "No captions were captured. Meet's captions have to be on during the call (the extension turns them on unless that's disabled in settings). You can still transcribe the recorded audio with AI.";
  }

  $('transcript-foot').hidden = !lines.length || live;
  $('cloud-meta').textContent =
    source === 'cloud' && rec.cloud
      ? `Transcribed with ${rec.cloud.model} · ${formatDate(rec.cloud.createdAt)}`
      : "From Meet's live captions";
  $('transcribe').textContent = rec.cloud ? 'Transcribe again with AI' : 'Transcribe audio with AI';
  $('transcribe').disabled = busy;

  $('lines').replaceChildren(
    ...lines.map((line) => {
      const ts = el('button', 'ts', clock(line.startMs));
      ts.dataset.ms = line.startMs;
      ts.title = 'Play from here';
      const body = el('div', 'line-body');
      if (line.speaker) {
        const speaker = el('span', 'speaker', line.speaker);
        speaker.style.setProperty('--hue', hue(line.speaker));
        body.append(speaker);
      }
      body.append(el('span', 'line-text', line.text));
      const item = el('li', 'line');
      item.append(ts, body);
      return item;
    }),
  );
  current.activeLine = -1;
  followPlayback();
}

function setSource(source) {
  if (!current || current.source === source) return;
  current.source = source;
  renderTranscript();
}

function followPlayback() {
  if (!current?.url) return;
  const lines = linesFor(current.source);
  const t = player.currentTime * 1000;
  let index = -1;
  for (let i = 0; i < lines.length && lines[i].startMs <= t; i++) index = i;
  if (index === current.activeLine) return;
  const items = $('lines').children;
  items[current.activeLine]?.classList.remove('active');
  items[index]?.classList.add('active');
  current.activeLine = index;
  if (!player.paused) items[index]?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function seek(ms) {
  if (!current?.url) return;
  player.currentTime = ms / 1000;
  player.play().catch(() => {});
}

// ---- Actions ----

function saveFile(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function downloadMedia() {
  if (current?.blob) saveFile(current.blob, `${fileBaseName(current.rec)}.webm`);
}

function downloadTranscript(kind) {
  const lines = linesFor(current.source);
  const suffix = current.source === 'cloud' ? ' (AI transcript)' : '';
  const text = kind === 'srt' ? transcriptSrt(lines) : transcriptText(current.rec, lines);
  const type = kind === 'srt' ? 'application/x-subrip' : 'text/plain;charset=utf-8';
  saveFile(new Blob([text], { type }), `${fileBaseName(current.rec)}${suffix}.${kind}`);
}

async function copyTranscript() {
  await navigator.clipboard.writeText(transcriptText(current.rec, linesFor(current.source)));
  toast('Transcript copied');
}

async function deleteCurrent() {
  if (!current || current.live) return;
  const { id, title } = current.rec;
  if (!confirm(`Delete "${title}"?\n\nThe recording and its transcript will be removed from this computer.`)) return;
  releaseMedia();
  current = null;
  await db.deleteRecording(id);
  await refreshList();
  await select(recordings[0]?.id);
  toast('Recording deleted');
}

function bindTitleEditing() {
  const title = $('rec-title');
  title.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      title.blur();
    } else if (event.key === 'Escape') {
      title.textContent = current.rec.title;
      title.blur();
    }
  });
  title.addEventListener('blur', async () => {
    if (!current) return;
    const value = title.textContent.replace(/\s+/g, ' ').trim();
    if (!value) title.textContent = current.rec.title;
    if (!value || value === current.rec.title) return;
    current.rec.title = value;
    await db.updateRecording(current.rec.id, { title: value });
    const listed = recordings.find((rec) => rec.id === current.rec.id);
    if (listed) listed.title = value;
    renderList();
  });
}

function setProgress(done, total) {
  $('progress').hidden = false;
  $('progress-label').textContent =
    total > 1 ? `Transcribing audio… part ${Math.min(done + 1, total)} of ${total}` : 'Transcribing audio…';
  $('progress-fill').style.width = `${Math.round((done / total) * 100)}%`;
}

function showTranscriptError(message) {
  $('transcript-error').textContent = message;
  $('transcript-error').hidden = !message;
}

async function transcribe({ automatic = false } = {}) {
  if (!current || current.live || transcribing) return;
  const target = current;
  const { id } = target.rec;
  showTranscriptError('');
  const settings = await getSettings();

  let host = '';
  try {
    host = new URL(settings.apiBaseUrl).host;
  } catch {
    return showTranscriptError('The speech-to-text API address in Settings is not a valid URL.');
  }
  if (needsApiKey(settings)) {
    if (automatic) return;
    toast('Add an API key in Settings first');
    chrome.runtime.openOptionsPage();
    return;
  }
  const allowed = await ensureApiPermission(settings.apiBaseUrl).catch(() => false);
  if (!allowed) {
    return showTranscriptError(`Chrome needs your OK to send audio to ${host}. Click "Transcribe audio with AI" to allow it.`);
  }

  transcribing = id;
  target.source = 'cloud';
  renderTranscript();
  setProgress(0, 1);
  try {
    const lines = await transcribeRecording(id, settings, (done, total) => {
      if (current?.rec.id === id) setProgress(done, total);
    });
    const cloud = { model: settings.model, createdAt: Date.now(), lines };
    await db.updateRecording(id, { cloud });
    target.rec.cloud = cloud;
    toast(lines.length ? 'AI transcript ready' : 'No speech found in the audio');
  } catch (err) {
    if (current?.rec.id === id) showTranscriptError(err.message);
  } finally {
    transcribing = null;
    $('progress').hidden = true;
    if (current?.rec.id === id) {
      current.rec.cloud = target.rec.cloud;
      renderTranscript();
    }
  }
}

// ---- Init ----

async function init() {
  $('list').addEventListener('click', (event) => {
    const item = event.target.closest('[data-id]');
    if (item) select(item.dataset.id);
  });
  window.addEventListener('hashchange', () => select(location.hash.slice(1)));
  for (const tab of [$('tab-captions'), $('tab-cloud')]) tab.onclick = () => setSource(tab.dataset.source);
  $('copy').onclick = copyTranscript;
  $('download-txt').onclick = () => downloadTranscript('txt');
  $('download-srt').onclick = () => downloadTranscript('srt');
  $('download-media').onclick = downloadMedia;
  $('delete').onclick = deleteCurrent;
  $('transcribe').onclick = $('transcribe-empty').onclick = () => transcribe();
  $('lines').addEventListener('click', (event) => {
    const ts = event.target.closest('.ts');
    if (ts) seek(Number(ts.dataset.ms));
  });
  player.addEventListener('timeupdate', followPlayback);
  bindTitleEditing();
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.target === 'ui' && msg.type === 'state-changed') refreshList();
    return false;
  });

  await refreshList();
  const wanted = location.hash.slice(1);
  await select(recordings.some((rec) => rec.id === wanted) ? wanted : recordings[0]?.id);

  if (new URLSearchParams(location.search).has('transcribe')) {
    history.replaceState(null, '', location.pathname + location.hash);
    if (current?.rec.id === wanted && !current.rec.cloud) transcribe({ automatic: true });
  }
}

init();
