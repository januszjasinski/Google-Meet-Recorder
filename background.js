// Service worker: starts/stops recordings, owns the offscreen recorder document and
// relays between the Meet tab's content script and the recorder.

import * as db from './lib/db.js';
import { getSettings } from './lib/settings.js';
import { isMeetCallUrl, meetCode, meetingTitle } from './lib/meet.js';

const OFFSCREEN_URL = 'offscreen.html';

// ---- State (survives service-worker restarts, cleared when the browser closes) ----

async function getState() {
  return (await chrome.storage.session.get('recording')).recording || null;
}

async function setState(recording) {
  if (recording) await chrome.storage.session.set({ recording });
  else await chrome.storage.session.remove('recording');
}

// Start/stop run one at a time, so a "meeting ended" signal can't race a click on Stop.
let queue = Promise.resolve();
function serialize(fn) {
  const result = queue.then(fn);
  queue = result.catch(() => {});
  return result;
}

// ---- Offscreen document ----

let creatingOffscreen = null;

async function hasOffscreen() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  return contexts.length > 0;
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  creatingOffscreen ??= chrome.offscreen
    .createDocument({
      url: OFFSCREEN_URL,
      reasons: ['USER_MEDIA'],
      justification: 'Records the Google Meet tab and microphone with MediaRecorder.',
    })
    .finally(() => {
      creatingOffscreen = null;
    });
  await creatingOffscreen;
}

async function closeOffscreen() {
  if (await hasOffscreen()) await chrome.offscreen.closeDocument().catch(() => {});
}

function sendToOffscreen(message) {
  return chrome.runtime.sendMessage({ target: 'offscreen', ...message });
}

function sendToTab(tabId, message) {
  return chrome.tabs.sendMessage(tabId, { target: 'content', ...message }).catch(() => null);
}

function notifyUi(type) {
  chrome.runtime.sendMessage({ target: 'ui', type }).catch(() => {});
}

async function setBadge(recording) {
  await chrome.action.setBadgeBackgroundColor({ color: '#d93025' });
  await chrome.action.setBadgeText({ text: recording ? 'REC' : '' });
  await chrome.action.setTitle({ title: recording ? 'Meet Recorder: recording' : 'Meet Recorder' });
}

/** Pings the Meet tab's content script, injecting it first if the tab predates the extension. */
async function ensureContentScript(tabId) {
  const ping = () => chrome.tabs.sendMessage(tabId, { target: 'content', type: 'ping' });
  try {
    const res = await ping();
    if (res?.ok) return res;
  } catch {
    // Not injected yet.
  }
  await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
  return ping().catch(() => null);
}

// ---- Recording lifecycle ----

async function startRecording(tabId) {
  if (await getState()) throw new Error('Already recording. Stop the current recording first.');
  const tab = await chrome.tabs.get(tabId);
  if (!isMeetCallUrl(tab.url)) throw new Error('Open a Google Meet call in this tab, then try again.');
  const settings = await getSettings();
  const page = await ensureContentScript(tabId);

  await closeOffscreen(); // Leftover from a crashed session would still hold the tab capture.
  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
  await ensureOffscreen();

  const recordingId = crypto.randomUUID();
  const title = meetingTitle(page?.title, tab.title, tab.url);
  await db.putRecording({
    id: recordingId,
    title,
    meetCode: meetCode(tab.url),
    url: tab.url,
    startedAt: Date.now(),
    status: 'recording',
    hasVideo: settings.recordVideo,
    size: 0,
    durationMs: 0,
  });

  const res = await sendToOffscreen({
    type: 'start',
    streamId,
    recordingId,
    micMuted: page?.micMuted === true,
    settings: {
      includeMic: settings.includeMic,
      micDeviceId: settings.micDeviceId,
      recordVideo: settings.recordVideo,
      videoQuality: settings.videoQuality,
    },
  }).catch((err) => ({ ok: false, error: err.message }));
  if (!res?.ok) {
    await db.deleteRecording(recordingId);
    await closeOffscreen();
    throw new Error(res?.error || 'The recorder did not start.');
  }

  await db.updateRecording(recordingId, { startedAt: res.startedAt, mimeType: res.mimeType, hasMic: res.hasMic });
  const state = { recordingId, tabId, title, startedAt: res.startedAt, hasMic: res.hasMic, warnings: res.warnings || [] };
  await setState(state);
  await setBadge(true);
  await sendToTab(tabId, {
    type: 'captions-start',
    recordingId,
    startedAt: res.startedAt,
    autoEnableCaptions: settings.autoEnableCaptions,
  });
  notifyUi('state-changed');
  return { state };
}

async function stopRecording(reason) {
  const state = await getState();
  if (!state) return { stopped: false };
  const settings = await getSettings();

  // Final caption snapshot first, while the tab (if still open) can answer.
  const final = await sendToTab(state.tabId, { type: 'captions-stop', recordingId: state.recordingId });
  if (final?.entries?.length) await db.putCaptions(state.recordingId, final.entries).catch(console.error);

  const result = await sendToOffscreen({ type: 'stop' }).catch((err) => ({ ok: false, error: err.message }));
  await closeOffscreen();
  const finished = result?.ok && result.stopped;
  await db.updateRecording(state.recordingId, {
    status: finished ? 'complete' : 'interrupted',
    endedAt: Date.now(),
    stopReason: reason,
    ...(finished ? { durationMs: result.durationMs, size: result.size } : {}),
  });
  await setState(null);
  await setBadge(false);
  notifyUi('state-changed');

  if (settings.openLibraryOnStop) {
    const query = settings.autoTranscribe ? '?transcribe=1' : '';
    await chrome.tabs.create({ url: `recordings.html${query}#${state.recordingId}` });
  }
  return { stopped: true, recordingId: state.recordingId };
}

/** Marks recordings that never finished (browser closed or crashed mid-call) as interrupted. */
async function recoverInterrupted() {
  const state = await getState();
  if (state && (await hasOffscreen())) return;
  if (state) {
    await setState(null);
    await setBadge(false);
  }
  for (const rec of await db.listRecordings()) {
    if (rec.status === 'recording') await db.updateRecording(rec.id, { status: 'interrupted' });
  }
}

// ---- Events ----

async function isCurrent(msg, sender) {
  const state = await getState();
  return Boolean(state && state.recordingId === msg.recordingId && sender.tab?.id === state.tabId);
}

const handlers = {
  async 'get-state'() {
    let state = await getState();
    if (state && !(await hasOffscreen())) {
      await serialize(recoverInterrupted);
      state = null;
    }
    return { state };
  },
  start: (msg) => serialize(() => startRecording(msg.tabId)),
  stop: () => serialize(() => stopRecording('stopped')),
  async captions(msg, sender) {
    if (await isCurrent(msg, sender)) await db.putCaptions(msg.recordingId, msg.entries);
    return {};
  },
  async 'mic-state'(msg, sender) {
    if (await isCurrent(msg, sender)) await sendToOffscreen({ type: 'set-mic-muted', muted: msg.muted }).catch(() => {});
    return {};
  },
  async 'meeting-ended'(msg, sender) {
    if (await isCurrent(msg, sender)) serialize(() => stopRecording('meeting-ended'));
    return {};
  },
  'capture-ended'() {
    serialize(() => stopRecording('capture-ended'));
    return {};
  },
  'recorder-error'(msg) {
    console.error('Recorder error:', msg.detail);
    return {};
  },
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const handler = msg?.target === 'background' && handlers[msg.type];
  if (!handler) return false;
  Promise.resolve()
    .then(() => handler(msg, sender))
    .then(
      (result) => sendResponse({ ok: true, ...result }),
      (err) => sendResponse({ ok: false, error: err?.message || String(err) }),
    );
  return true;
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  if ((await getState())?.tabId === tabId) serialize(() => stopRecording('tab-closed'));
});

chrome.tabs.onUpdated.addListener(async (tabId, change, tab) => {
  if (!change.url && change.status !== 'complete') return;
  const state = await getState();
  if (state?.tabId !== tabId) return;
  // Without host access to the new page, tab.url is undefined: the tab has left Meet.
  if (!isMeetCallUrl(tab.url)) {
    serialize(() => stopRecording('left-meeting'));
  } else if (change.status === 'complete') {
    // The Meet tab reloaded mid-call: resume caption capture in the fresh page.
    const settings = await getSettings();
    await ensureContentScript(tabId).catch(() => null);
    await sendToTab(tabId, {
      type: 'captions-start',
      recordingId: state.recordingId,
      startedAt: state.startedAt,
      autoEnableCaptions: settings.autoEnableCaptions,
    });
  }
});

chrome.runtime.onStartup.addListener(() => {
  recoverInterrupted().catch(console.error);
});

chrome.runtime.onInstalled.addListener(({ reason }) => {
  recoverInterrupted().catch(console.error);
  if (reason === chrome.runtime.OnInstalledReason.INSTALL) chrome.tabs.create({ url: 'welcome.html' });
});
