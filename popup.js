import { getSettings, saveSettings, micPermission } from './lib/settings.js';
import { isMeetCallUrl, meetingTitle } from './lib/meet.js';
import { clock } from './lib/format.js';

const $ = (id) => document.getElementById(id);

let activeTab = null;
let state = null;
let timers = [];
const live = new Map();

const background = (message) =>
  chrome.runtime.sendMessage({ target: 'background', ...message }).catch((err) => ({ ok: false, error: err.message }));
const askTab = (tabId, message) => chrome.tabs.sendMessage(tabId, { target: 'content', ...message }).catch(() => null);

function show(view) {
  for (const name of ['idle', 'ready', 'recording']) $(`view-${name}`).hidden = name !== view;
}

function showError(message) {
  $('error').textContent = message || '';
  $('error').hidden = !message;
}

function openPage(path) {
  chrome.tabs.create({ url: path });
  window.close();
}

async function init() {
  [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  $('open-library').onclick = $('idle-library').onclick = () => openPage('recordings.html');
  $('open-settings').onclick = () => chrome.runtime.openOptionsPage();
  $('start').onclick = start;
  $('stop').onclick = stop;
  $('goto-tab').onclick = gotoMeeting;
  await bindOptions();
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.target === 'ui' && msg.type === 'state-changed') refresh();
    return false;
  });
  await refresh();
}

async function bindOptions() {
  const settings = await getSettings();
  for (const [id, key] of [['opt-mic', 'includeMic'], ['opt-video', 'recordVideo'], ['opt-captions', 'autoEnableCaptions']]) {
    const input = $(id);
    input.checked = settings[key];
    input.onchange = () => saveSettings({ [key]: input.checked });
  }
  const permission = await micPermission();
  if (permission === 'denied') $('mic-hint').textContent = 'Blocked in Chrome site settings';
  else if (permission === 'prompt') $('mic-hint').textContent = 'Asks for permission once';
}

async function refresh() {
  const res = await background({ type: 'get-state' });
  if (!res?.ok) showError(res?.error || 'The extension is not responding. Try reloading it.');
  state = res?.state || null;
  timers.forEach(clearInterval);
  timers = [];
  if (state) renderRecording();
  else if (activeTab && isMeetCallUrl(activeTab.url)) renderReady();
  else show('idle');
}

async function renderReady() {
  show('ready');
  $('ready-title').textContent = meetingTitle('', activeTab.title, activeTab.url);
  const page = await askTab(activeTab.id, { type: 'status' });
  if (page?.title) $('ready-title').textContent = page.title;
}

function renderRecording() {
  show('recording');
  $('rec-title').textContent = state.title;
  $('goto-tab').hidden = activeTab?.id === state.tabId;
  $('warnings').replaceChildren(
    ...(state.warnings || []).map((text) => Object.assign(document.createElement('li'), { textContent: text })),
  );
  const tick = () => {
    $('rec-time').textContent = clock(Date.now() - state.startedAt);
  };
  tick();
  pollMeeting();
  timers.push(setInterval(tick, 1000), setInterval(pollMeeting, 1500));
}

function setChip(id, text, tone = '') {
  const chip = $(id);
  chip.textContent = text;
  chip.className = `chip ${tone}`;
}

async function pollMeeting() {
  if (!state) return;
  const page = await askTab(state.tabId, { type: 'status' });
  if (!state) return;

  if (!state.hasMic) setChip('chip-mic', 'Mic not recorded');
  else if (page?.micMuted) setChip('chip-mic', 'Mic muted', 'warn');
  else setChip('chip-mic', 'Mic on', 'ok');

  const count = page?.recording?.count || 0;
  if (!page) setChip('chip-captions', 'Meeting tab not responding', 'warn');
  else if (count) setChip('chip-captions', `Transcript · ${count} ${count === 1 ? 'line' : 'lines'}`, 'ok');
  else if (page.captionsOn === false) setChip('chip-captions', 'Captions off: press CC in Meet', 'warn');
  else setChip('chip-captions', 'Waiting for speech…');

  for (const entry of page?.recording?.recent || []) live.set(entry.id, entry);
  renderLive();
}

function renderLive() {
  const box = $('live');
  const lines = [...live.values()].sort((a, b) => a.startMs - b.startMs).slice(-8);
  if (!lines.length) {
    box.replaceChildren(Object.assign(document.createElement('p'), {
      className: 'live-empty',
      textContent: 'The transcript appears here as people speak.',
    }));
    return;
  }
  const pinned = box.scrollHeight - box.scrollTop - box.clientHeight < 24;
  box.replaceChildren(
    ...lines.map((line) => {
      const row = document.createElement('div');
      row.className = 'live-line';
      if (line.speaker) row.append(Object.assign(document.createElement('span'), { className: 'who', textContent: line.speaker }));
      row.append(line.text);
      return row;
    }),
  );
  if (pinned) box.scrollTop = box.scrollHeight;
}

async function start() {
  showError('');
  const button = $('start');
  button.disabled = true;
  try {
    const settings = await getSettings();
    if (settings.includeMic && (await micPermission()) === 'prompt') {
      // Popups can't show Chrome's permission prompt, so ask once from a normal tab.
      openPage(`welcome.html?reason=mic&tab=${activeTab.id}`);
      return;
    }
    button.lastElementChild.textContent = 'Starting…';
    const res = await background({ type: 'start', tabId: activeTab.id });
    if (!res?.ok) throw new Error(res?.error || 'Could not start recording.');
    state = res.state;
    renderRecording();
  } catch (err) {
    showError(err.message);
  } finally {
    button.disabled = false;
    button.lastElementChild.textContent = 'Start recording';
  }
}

async function stop() {
  showError('');
  const button = $('stop');
  button.disabled = true;
  button.lastElementChild.textContent = 'Saving…';
  const res = await background({ type: 'stop' });
  button.disabled = false;
  button.lastElementChild.textContent = 'Stop & save';
  if (!res?.ok) return showError(res?.error || 'Could not stop the recording.');
  live.clear();
  await refresh();
}

async function gotoMeeting() {
  const tab = await chrome.tabs.update(state.tabId, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
  window.close();
}

init().catch((err) => showError(err.message));
