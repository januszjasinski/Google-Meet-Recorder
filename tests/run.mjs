#!/usr/bin/env node
// Tests in headless Chrome:
//   media      recording files: WebM duration fix, MP4 playback and seeking
//   captions   the caption reader against a mock Meet page
//   extension  the real extension loaded into Chrome: recorder, stop flow, library,
//              error reporting and the speech-to-text client
//
//   npm test                                  all suites
//   node tests/run.mjs captions extension     selected suites
//
// Needs Node 18+ and Chrome or Chromium 126+. CHROME_PATH picks the browser; CHROME_FLAGS adds
// flags (for example "--no-sandbox" in a Linux container).

import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import { platform, tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '');
const PAGES = fileURLToPath(new URL('./pages/', import.meta.url));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let failures = 0;
function check(label, ok, detail) {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}`);
  if (!ok) {
    failures++;
    console.log(`       got: ${JSON.stringify(detail)}`);
  }
}

// ---- Chrome over the DevTools protocol (pipe transport, no dependencies) ----

function which(command) {
  try {
    return execFileSync('which', [command], { encoding: 'utf8' }).trim() || null;
  } catch {
    return null;
  }
}

function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const candidates = {
    win32: [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA]
      .filter(Boolean)
      .map((dir) => join(dir, 'Google', 'Chrome', 'Application', 'chrome.exe')),
    darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium'],
    linux: ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'].map(which).filter(Boolean),
  }[platform()] || [];
  const found = candidates.find((path) => existsSync(path));
  if (!found) throw new Error('Chrome not found. Set CHROME_PATH to the Chrome or Chromium executable.');
  return found;
}

class Browser {
  static async launch() {
    const profile = await mkdtemp(join(tmpdir(), 'meet-recorder-test-'));
    const args = [
      '--headless',
      '--remote-debugging-pipe',
      '--enable-unsafe-extension-debugging',
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--autoplay-policy=no-user-gesture-required',
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      ...(process.env.CHROME_FLAGS || '').split(' ').filter(Boolean),
      'about:blank',
    ];
    const proc = spawn(findChrome(), args, { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
    return new Browser(proc, profile);
  }

  constructor(proc, profile) {
    this.proc = proc;
    this.profile = profile;
    this.nextId = 0;
    this.pending = new Map();
    this.listeners = new Set();
    this.errors = [];
    let buffer = '';
    proc.stdio[4].on('data', (data) => {
      buffer += data.toString();
      for (let end; (end = buffer.indexOf('\0')) >= 0; ) {
        const message = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        this.dispatch(message);
      }
    });
  }

  dispatch(msg) {
    if (msg.id) {
      const pending = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) pending?.reject(new Error(`${pending.method}: ${msg.error.message}`));
      else pending?.resolve(msg.result);
      return;
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      const details = msg.params.exceptionDetails;
      this.errors.push(details.exception?.description || details.text);
    } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      this.errors.push(msg.params.args.map((arg) => arg.value ?? arg.description).join(' '));
    }
    for (const listener of this.listeners) listener(msg);
  }

  send(method, params = {}, sessionId) {
    const id = ++this.nextId;
    this.proc.stdio[3].write(`${JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\0`);
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject, method }));
  }

  async attach(targetId) {
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
    const session = new Session(this, sessionId, targetId);
    await session.send('Runtime.enable');
    return session;
  }

  async open(url) {
    const { targetId } = await this.send('Target.createTarget', { url: 'about:blank' });
    const page = await this.attach(targetId);
    await page.goto(url);
    return page;
  }

  async waitForTarget(predicate, timeout = 10_000) {
    for (const end = Date.now() + timeout; Date.now() < end; await sleep(100)) {
      const { targetInfos } = await this.send('Target.getTargets');
      const target = targetInfos.find(predicate);
      if (target) return target;
    }
    throw new Error('Timed out waiting for a browser target');
  }

  async close() {
    const exited = new Promise((resolve) => this.proc.once('exit', resolve));
    this.proc.kill();
    await Promise.race([exited, sleep(5000)]);
    await rm(this.profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
  }
}

class Session {
  constructor(browser, id, targetId) {
    this.browser = browser;
    this.id = id;
    this.targetId = targetId;
  }

  send(method, params) {
    return this.browser.send(method, params, this.id);
  }

  async eval(expression) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    }
    return result.result.value;
  }

  async waitFor(expression, timeout = 10_000) {
    for (const end = Date.now() + timeout; Date.now() < end; await sleep(100)) {
      if (await this.eval(`(async () => !!(await (${expression})))()`).catch(() => false)) return true;
    }
    return false;
  }

  async goto(url) {
    await this.send('Page.enable');
    const loaded = new Promise((resolve) => {
      const listener = (msg) => {
        if (msg.sessionId !== this.id || msg.method !== 'Page.loadEventFired') return;
        this.browser.listeners.delete(listener);
        resolve();
      };
      this.browser.listeners.add(listener);
    });
    await this.send('Page.navigate', { url });
    await loaded;
  }

  close() {
    return this.browser.send('Target.closeTarget', { targetId: this.targetId });
  }
}

// ---- Local server: extension files, test pages and a mock speech-to-text API ----

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json' };
const sttRequests = [];

function mockTranscription(req, res) {
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors);
    return res.end();
  }
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('latin1');
    const field = (name) => body.match(new RegExp(`name="${name}"\\r\\n\\r\\n([^\\r]*)`))?.[1];
    const request = {
      auth: req.headers.authorization,
      model: field('model'),
      format: field('response_format'),
      language: field('language'),
      hasFile: /name="file"; filename="part-1\.webm"/.test(body),
    };
    sttRequests.push(request);
    res.writeHead(200, { ...cors, 'content-type': 'application/json' });
    res.end(JSON.stringify(
      request.format === 'verbose_json'
        ? {
            text: 'Hello there. Thank you.',
            segments: [
              { start: 0, end: 1.5, text: ' Hello there.', no_speech_prob: 0.01, avg_logprob: -0.2 },
              { start: 1.5, end: 3, text: ' Thank you.', no_speech_prob: 0.9, avg_logprob: -1.5 },
            ],
          }
        : { text: 'First sentence here. And a second, longer sentence follows it!' },
    ));
  });
}

function startServer() {
  const server = http.createServer(async (req, res) => {
    const { pathname } = new URL(req.url, 'http://localhost');
    if (pathname === '/v1/audio/transcriptions') return mockTranscription(req, res);
    const file = pathname.startsWith('/ext/')
      ? join(ROOT, pathname.slice(5))
      : pathname.startsWith('/pages/')
        ? join(PAGES, pathname.slice(7))
        : null;
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

// ---- Suites ----

async function mediaSuite(browser, base) {
  const page = await browser.open(`${base}/pages/media.html`);
  await page.waitFor('window.ready');
  for (const [kind, type, video] of [['video', 'video/webm;codecs=vp8,opus', true], ['audio', 'audio/webm;codecs=opus', false]]) {
    const r = await page.eval(`checkWebm(${JSON.stringify(type)}, ${video})`);
    const seconds = r.durationMs / 1000;
    check(`WebM ${kind}: MediaRecorder output has no duration`, r.raw === 'Infinity', r);
    check(`WebM ${kind}: the fix adds the recorded length`, Math.abs(r.fixed - seconds) < 0.3, r);
    check(`WebM ${kind}: fixing again updates it in place`, r.refixedSize === r.fixedSize && Math.abs(r.refixed - seconds - 1) < 0.3, r);
    check(`WebM ${kind}: fixed file seeks to the end`, typeof r.seekedTo === 'number' && r.seekedTo > seconds - 1, r);
  }
  const mp4 = await page.eval('checkMp4()');
  if (!mp4.supported) {
    console.log('  skip MP4: this Chrome cannot record MP4');
  } else {
    const seconds = mp4.durationMs / 1000;
    check('MP4: data is written during recording, not only at the end', mp4.chunks >= 3, mp4);
    check('MP4: plays with the recorded length and seeks', Math.abs(mp4.duration - seconds) < 0.5 && mp4.seekedTo > seconds - 1, mp4);
    check('MP4: left alone by the WebM duration fix', mp4.untouchedByWebmFix, mp4);
  }
  await page.close();
}

async function captionsSuite(browser, base) {
  const url = `${base}/pages/captions.html`;
  const page = await browser.open(url);
  const W = "document.getElementById('wrap')";

  const ping = await page.eval(`ask({ type: 'ping' })`);
  check('reads call state: in call, unmuted, captions off, meeting title',
    ping.inCall && ping.micMuted === false && ping.captionsOn === false && ping.title === 'Weekly product sync', ping);

  await page.eval(`ask({ type: 'captions-start', recordingId: 'r1', startedAt: Date.now(), autoEnableCaptions: true })`);
  await sleep(600);
  check('turns captions on automatically, with one click', (await page.eval('ccClicks')) === 1, await page.eval('ccClicks'));

  await page.eval(`window.a = addBlock(${W}, 'Alice', 'Hello every')`); await sleep(450);
  await page.eval(`setText(a, 'Hello everyone, welcome')`); await sleep(450);
  await page.eval(`setText(a, 'Hello everyone, welcome to the meeting.')`); await sleep(450);
  await page.eval(`window.b = addBlock(${W}, 'Bob', 'Thanks Alice.')`); await sleep(450);
  // Meet re-renders Bob's block as a new element, then Alice's block scrolls away.
  await page.eval(`b.remove(); addBlock(${W}, 'Bob', "Thanks Alice. Let's start with the roadmap.")`); await sleep(450);
  await page.eval(`a.remove()`); await sleep(450);
  // A long block whose oldest words drop out of view.
  await page.eval(`window.c = addBlock(${W}, 'Chen', 'one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen')`); await sleep(450);
  await page.eval(`setText(c, 'nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen')`); await sleep(450);
  await page.eval(`document.getElementById('mic').setAttribute('data-is-muted', 'true')`);
  await sleep(2400);

  const sent = await page.eval('sent');
  const mic = sent.filter((m) => m.type === 'mic-state').map((m) => m.muted);
  check('reports the mic state: unmuted, then muted', JSON.stringify(mic) === '[false,true]', mic);
  const flushed = sent.filter((m) => m.type === 'captions');
  check('sends captions to the background as it goes', flushed.length >= 2 && flushed.every((m) => m.recordingId === 'r1'), flushed.length);
  const status = await page.eval(`ask({ type: 'status' })`);
  check('status gives the popup live lines and caption health', status.recording?.count === 3 && status.recording.captionHealth === 'ok', status.recording);

  await page.eval(`document.querySelector('.controls').remove(); document.getElementById('tiles').remove()`);
  await sleep(4000);
  const ended = (await page.eval('sent')).filter((m) => m.type === 'meeting-ended');
  check('notices when you leave the call, once', ended.length === 1, ended);

  const final = await page.eval(`ask({ type: 'captions-stop', recordingId: 'r1' })`);
  const lines = final.entries.map((e) => [e.speaker, e.text]);
  check('final transcript: three merged, de-duplicated turns', JSON.stringify(lines) === JSON.stringify([
    ['Alice', 'Hello everyone, welcome to the meeting.'],
    ['Bob', "Thanks Alice. Let's start with the roadmap."],
    ['Chen', 'one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen'],
  ]), lines);
  check('timestamps are relative to the start and in order',
    final.entries.every((e, i, all) => e.startMs >= 0 && e.endMs >= e.startMs && (!i || e.startMs >= all[i - 1].startMs)), final.entries);

  // Caption blocks directly inside the captions area, and Meet's known class names.
  await page.goto(url);
  await page.eval(`${W}.remove(); ask({ type: 'captions-start', recordingId: 'r2', startedAt: Date.now(), autoEnableCaptions: false })`);
  await page.eval(`addBlock(document.getElementById('captions'), 'Dana', 'Single block case works.')`); await sleep(500);
  await page.eval(`addBlock(document.getElementById('captions'), 'Eve', 'And a second one.')`); await sleep(500);
  const flat = (await page.eval(`ask({ type: 'captions-stop', recordingId: 'r2' })`)).entries.map((e) => [e.speaker, e.text]);
  check('reads blocks placed directly in the captions area', JSON.stringify(flat) === JSON.stringify([['Dana', 'Single block case works.'], ['Eve', 'And a second one.']]), flat);
  check("doesn't touch captions when auto-enable is off", (await page.eval('ccClicks')) === 0, await page.eval('ccClicks'));

  await page.goto(url);
  await page.eval(`ask({ type: 'captions-start', recordingId: 'r3', startedAt: Date.now(), autoEnableCaptions: false })`);
  await page.eval(`${W}.innerHTML = '<div class="nMcdL"><div><img><span class="NWpY1d">Frank</span></div><div class="ygicle">Known  class   names.</div></div>'`);
  await sleep(500);
  const known = (await page.eval(`ask({ type: 'captions-stop', recordingId: 'r3' })`)).entries.map((e) => [e.speaker, e.text]);
  check("reads Meet's known class names", JSON.stringify(known) === JSON.stringify([['Frank', 'Known class names.']]), known);

  // Captions on, but the captions area can't be found: flagged after 20 s (simulated clock).
  await page.goto(url);
  await page.eval(`ask({ type: 'captions-start', recordingId: 'r4', startedAt: Date.now(), autoEnableCaptions: false })`);
  await page.eval(`setCaptionsButton(true); document.getElementById('captions').remove()`);
  await sleep(600);
  const early = (await page.eval(`ask({ type: 'status' })`)).recording.captionHealth;
  check('missing captions area is not flagged straight away', early === 'waiting', early);
  await page.eval('clockOffset += 21000');
  await sleep(600);
  await page.eval('clockOffset += 21000');
  await sleep(600);
  const blind = (await page.eval(`ask({ type: 'status' })`)).recording.captionHealth;
  const flags = (await page.eval('sent')).filter((m) => m.type === 'captions-unreadable');
  check('after 20 s it is flagged as unreadable, and reported once', blind === 'unreadable' && flags.length === 1 && flags[0].recordingId === 'r4', { blind, flags });
  await page.eval(`(() => {
    const region = document.createElement('div');
    region.setAttribute('role', 'region');
    region.setAttribute('aria-label', 'Captions');
    document.body.append(region);
    addBlock(region, 'Gus', 'Back again.');
  })()`);
  await sleep(600);
  const back = (await page.eval(`ask({ type: 'status' })`)).recording.captionHealth;
  check('recovers when captions can be read again', back === 'ok', back);

  await page.goto(url);
  await page.eval(`ask({ type: 'captions-start', recordingId: 'r5', startedAt: Date.now(), autoEnableCaptions: false })`);
  await page.eval(`document.getElementById('captions').remove()`);
  await sleep(600);
  await page.eval('clockOffset += 30000');
  await sleep(600);
  const off = (await page.eval(`ask({ type: 'status' })`)).recording.captionHealth;
  const falseAlarm = (await page.eval('sent')).some((m) => m.type === 'captions-unreadable');
  check('captions switched off reads as "off", not unreadable', off === 'off' && !falseAlarm, { off, falseAlarm });
  await page.close();
}

// tabCapture needs a real click on the toolbar button, so the recorder gets a synthetic "tab" stream.
const FAKE_TAB_STREAM = `(() => {
  const real = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = async (constraints) => {
    if (constraints?.audio?.mandatory?.chromeMediaSource !== 'tab') return real(constraints);
    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 360;
    const g = canvas.getContext('2d');
    let frame = 0;
    setInterval(() => { g.fillStyle = 'hsl(' + ((frame++ * 7) % 360) + ' 60% 50%)'; g.fillRect(0, 0, 640, 360); }, 50);
    const audio = new AudioContext();
    const tone = audio.createOscillator();
    const out = audio.createMediaStreamDestination();
    tone.connect(out);
    tone.start();
    return new MediaStream([...(constraints.video ? canvas.captureStream(20).getVideoTracks() : []), ...out.stream.getAudioTracks()]);
  };
})()`;

// Every write of a recording chunk fails the way it does when the disk is full.
const DISK_FULL = `(() => {
  const put = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function (...args) {
    if (this.name === 'chunks') throw new DOMException('Simulated disk full', 'QuotaExceededError');
    return put.apply(this, args);
  };
})()`;

const db = (body) => `(async () => { const db = await import('/lib/db.js'); ${body} })()`;
const toBackground = (message) => `chrome.runtime.sendMessage(${JSON.stringify({ target: 'background', ...message })})`;

async function startTestRecording(ctx, { id, fileFormat = 'mp4', offscreenSetup = '' }) {
  const { browser, sw, page, origin } = ctx;
  await page.eval(db(`await db.putRecording({ id: '${id}', title: 'Test call', startedAt: Date.now(), status: 'recording', hasVideo: true, size: 0, durationMs: 0 });`));
  await sw.eval(`chrome.offscreen.createDocument({ url: 'offscreen.html', reasons: ['USER_MEDIA'], justification: 'test' })`);
  const offscreen = await browser.attach((await browser.waitForTarget((t) => t.url === `${origin}/offscreen.html`)).targetId);
  await offscreen.eval(`${FAKE_TAB_STREAM}; ${offscreenSetup}`);
  const started = await page.eval(`chrome.runtime.sendMessage(${JSON.stringify({
    target: 'offscreen',
    type: 'start',
    streamId: 'test',
    recordingId: id,
    micMuted: false,
    settings: { includeMic: true, micDeviceId: '', recordVideo: true, videoQuality: '720p', fileFormat },
  })})`);
  // What the background stores when it starts a recording itself.
  await sw.eval(`chrome.storage.session.set({ recording: ${JSON.stringify({ recordingId: id, tabId: 987654, title: 'Test call', startedAt: started.startedAt, hasMic: true, warnings: [], problems: [] })} })`);
  return started;
}

async function openedLibrary(ctx, id) {
  const target = await ctx.browser.waitForTarget((t) => t.url === `${ctx.origin}/recordings.html#${id}`).catch(() => null);
  return target && ctx.browser.attach(target.targetId);
}

async function recordingFlow(ctx, { id, fileFormat, expectType }) {
  const { page } = ctx;
  const label = fileFormat.toUpperCase();
  const started = await startTestRecording(ctx, { id, fileFormat });
  check(`${label}: recorder starts with your mic mixed in`, started?.ok && started.hasMic && started.mimeType.startsWith(expectType) && !started.warnings.length, started);
  await sleep(2500);
  const muted = await page.eval(`chrome.runtime.sendMessage({ target: 'offscreen', type: 'set-mic-muted', muted: true })`);
  check(`${label}: mic can be muted mid-call`, muted?.ok, muted);
  await sleep(3000);
  const midway = await page.eval(db(`return db.getRecording('${id}');`));
  check(`${label}: data reaches disk while recording`, midway.size > 0 && midway.durationMs > 2000, midway);

  const stopped = await page.eval(toBackground({ type: 'stop' }));
  check(`${label}: stopping completes`, stopped?.ok && stopped.stopped && stopped.recordingId === id, stopped);
  const after = await page.eval(db(`
    const rec = await db.getRecording('${id}');
    const chunks = await db.getChunks('${id}');
    const audio = await db.getAudio('${id}');
    const { state } = await chrome.runtime.sendMessage({ target: 'background', type: 'get-state' });
    const offscreen = (await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] })).length;
    return { status: rec.status, durationMs: rec.durationMs, size: rec.size, mimeType: rec.mimeType, problems: rec.problems || [],
      chunks: chunks.length, chunkBytes: chunks.reduce((n, b) => n + b.size, 0),
      audio: audio.map((a) => ({ size: a.blob.size, type: a.blob.type })), state, offscreen };`));
  check(`${label}: saved as complete, with its length`, after.status === 'complete' && after.durationMs > 5000 && after.durationMs < 9000 && !after.problems.length, after);
  check(`${label}: every chunk saved`, after.chunks >= 2 && after.chunkBytes === after.size, after);
  check(`${label}: audio for speech-to-text saved`, after.audio.length === 1 && after.audio[0].size > 5000 && after.audio[0].type.startsWith('audio/webm'), after.audio);
  check(`${label}: recording state cleared and recorder closed`, after.state === null && after.offscreen === 0, after);

  const library = await openedLibrary(ctx, id);
  check(`${label}: library opens on the new recording`, Boolean(library));
  if (!library) return;
  await library.waitFor(`document.getElementById('player').readyState >= 1`);
  const view = await library.eval(`({
    duration: document.getElementById('player').duration,
    width: document.getElementById('player').videoWidth,
    notices: document.getElementById('rec-notices').children.length,
    canDownload: !document.getElementById('download-media').disabled,
  })`);
  check(`${label}: library plays it back with the right length`,
    Math.abs(view.duration * 1000 - after.durationMs) < 500 && view.width === 640 && view.notices === 0 && view.canDownload, view);
  await library.close();
}

async function diskFullFlow(ctx) {
  const { page, sw } = ctx;
  const id = 'disk-full-call';
  await startTestRecording(ctx, { id, offscreenSetup: DISK_FULL });
  const reported = await page.waitFor(`chrome.runtime.sendMessage({ target: 'background', type: 'get-state' }).then((r) => r.state?.problems?.length)`, 12_000);
  await sleep(4500); // let more writes fail; it should still be reported only once
  const { state } = await page.eval(toBackground({ type: 'get-state' }));
  check('disk full: shown in the popup state, once', reported && state.problems.length === 1 && state.problems[0].level === 'error' && /disk is full/.test(state.problems[0].text), state?.problems);
  check('disk full: toolbar icon shows "!"', (await sw.eval('chrome.action.getBadgeText({})')) === '!');

  await page.eval(toBackground({ type: 'stop' }));
  const rec = await page.eval(db(`return db.getRecording('${id}');`));
  check('disk full: problem kept with the recording', rec.problems?.length === 1 && /disk is full/.test(rec.problems[0].text), rec.problems);
  check('disk full: toolbar icon cleared after stopping', (await sw.eval('chrome.action.getBadgeText({})')) === '');
  const library = await openedLibrary(ctx, id);
  const banner = library && (await library.waitFor(`document.querySelector('#rec-notices .banner-error')`))
    ? await library.eval(`document.querySelector('#rec-notices .banner-error').textContent`)
    : null;
  check('disk full: library shows the problem', /disk is full/.test(banner || ''), banner);
  await library?.close();
}

async function extensionSuite(browser, base) {
  const { id: extensionId } = await browser.send('Extensions.loadUnpacked', { path: ROOT });
  const origin = `chrome-extension://${extensionId}`;
  check('extension loads (manifest accepted)', Boolean(extensionId), extensionId);
  const workerTarget = await browser.waitForTarget((t) => t.type === 'service_worker' && t.url.startsWith(origin));
  const sw = await browser.attach(workerTarget.targetId);
  check('service worker starts', (await sw.eval('chrome.runtime.getManifest().short_name')) === 'Meet Recorder');
  check('welcome page opens on install', Boolean(await browser.waitForTarget((t) => t.url === `${origin}/welcome.html`).catch(() => null)));

  // Any extension page works as a place to drive the extension from.
  const page = await browser.open(`${origin}/options.html`);
  const ctx = { browser, sw, page, origin };
  const initial = await page.eval(toBackground({ type: 'get-state' }));
  check('background answers', initial?.ok === true && initial.state === null, initial);
  await browser.send('Browser.grantPermissions', { origin, permissions: ['audioCapture'] });

  const canMp4 = await page.eval(`MediaRecorder.isTypeSupported('video/mp4;codecs=avc1,mp4a.40.2')`);
  if (!canMp4) console.log('  note: this Chrome cannot record MP4, so the MP4 setting falls back to WebM');
  await recordingFlow(ctx, { id: 'mp4-call', fileFormat: 'mp4', expectType: canMp4 ? 'video/mp4' : 'video/webm' });
  await recordingFlow(ctx, { id: 'webm-call', fileFormat: 'webm', expectType: 'video/webm' });
  const extensions = await page.eval(`(async () => {
    const { mediaExtension } = await import('/lib/format.js');
    return [mediaExtension('video/mp4;codecs=avc1,mp4a.40.2'), mediaExtension('audio/mp4;codecs=mp4a.40.2'), mediaExtension('video/webm;codecs=vp8,opus')];
  })()`);
  check('downloads get the right file extension', extensions.join() === 'mp4,m4a,webm', extensions);

  await diskFullFlow(ctx);

  await page.eval(db(`await db.putRecording({ id: 'unreadable-call', title: 'Unreadable', startedAt: Date.now(), status: 'complete', hasVideo: true, durationMs: 1000, size: 0, captionsUnreadable: true });`));
  const library = await browser.open(`${origin}/recordings.html#unreadable-call`);
  await library.waitFor(`document.getElementById('transcript-empty-text').textContent`);
  const emptyText = await library.eval(`document.getElementById('transcript-empty-text').textContent`);
  check("library explains when Meet's captions couldn't be read", /couldn't be read/.test(emptyText), emptyText);
  await library.close();

  const stt = await page.eval(`(async () => {
    const { transcribeRecording } = await import('/lib/transcribe.js');
    const settings = { apiBaseUrl: '${base}/v1/', apiKey: 'sk-test', language: 'en' };
    const progress = [];
    const whisper = await transcribeRecording('mp4-call', { ...settings, model: 'whisper-1' }, (done, total) => progress.push(done + '/' + total));
    const plain = await transcribeRecording('mp4-call', { ...settings, model: 'gpt-4o-transcribe', language: '' });
    const [segment] = await (await import('/lib/db.js')).getAudio('mp4-call');
    return { whisper, plain, progress, segment: { startMs: segment.startMs, endMs: segment.endMs } };
  })()`);
  const { segment } = stt;
  check('speech-to-text: Whisper segments kept, likely hallucination over silence dropped',
    stt.whisper.length === 1 && stt.whisper[0].text === 'Hello there.' &&
      stt.whisper[0].startMs === segment.startMs && stt.whisper[0].endMs === segment.startMs + 1500, { whisper: stt.whisper, segment });
  check('speech-to-text: plain-text results split into timed sentences',
    stt.plain.length === 2 && stt.plain[0].startMs === segment.startMs && stt.plain[1].endMs === segment.endMs, { plain: stt.plain, segment });
  check('speech-to-text: request carries key, model, format, language and audio',
    sttRequests[0]?.auth === 'Bearer sk-test' && sttRequests[0].format === 'verbose_json' && sttRequests[0].language === 'en' &&
      sttRequests[0].hasFile && sttRequests[1]?.format === 'json' && sttRequests[1].language === undefined, sttRequests);
  check('speech-to-text: progress reported', stt.progress.join() === '0/1,1/1', stt.progress);

  const gone = await page.eval(db(`
    await db.deleteRecording('mp4-call');
    return { rec: await db.getRecording('mp4-call'), chunks: (await db.getChunks('mp4-call')).length, audio: (await db.getAudio('mp4-call')).length };`));
  check('delete removes the recording, its video and its audio', gone.rec === undefined && gone.chunks === 0 && gone.audio === 0, gone);
}

// ---- Main ----

const SUITES = { media: mediaSuite, captions: captionsSuite, extension: extensionSuite };
const selected = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(SUITES);
for (const name of selected) {
  if (!SUITES[name]) {
    console.error(`Unknown suite "${name}". Choose from: ${Object.keys(SUITES).join(', ')}`);
    process.exit(2);
  }
}

const server = await startServer();
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await Browser.launch();
try {
  for (const name of selected) {
    console.log(`\n${name}`);
    await SUITES[name](browser, base);
  }
  const unexpected = browser.errors.filter((error) => !/Simulated disk full/.test(error));
  check('no unexpected errors in any page', unexpected.length === 0, unexpected);
} catch (err) {
  failures++;
  console.error(err);
} finally {
  await browser.close();
  server.close();
}
console.log(failures ? `\n${failures} failed` : '\nAll tests passed');
process.exit(failures ? 1 : 0);
