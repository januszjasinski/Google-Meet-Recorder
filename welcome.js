import { micPermission } from './lib/settings.js';

const params = new URLSearchParams(location.search);
const returnTabId = Number(params.get('tab')) || null;
const button = document.getElementById('allow-mic');
const status = document.getElementById('mic-status');

function setStatus(text, tone) {
  status.textContent = text;
  status.className = `mic-status ${tone || ''}`;
}

async function render() {
  const permission = await micPermission();
  if (permission === 'granted') {
    button.hidden = true;
    setStatus('✓ Microphone access is allowed', 'ok');
  } else if (permission === 'denied') {
    setStatus('Microphone access is blocked. Allow it in Chrome\'s site settings for this extension, then reload this page.', 'bad');
  }
}

async function backToMeeting() {
  setStatus('✓ Microphone allowed. Taking you back to your meeting: click Meet Recorder again and press Start recording.', 'ok');
  setTimeout(async () => {
    try {
      const tab = await chrome.tabs.update(returnTabId, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
      const self = await chrome.tabs.getCurrent();
      if (self) chrome.tabs.remove(self.id);
    } catch {
      // The meeting tab is gone; stay on this page.
    }
  }, 2500);
}

button.addEventListener('click', async () => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((track) => track.stop());
    button.hidden = true;
    if (returnTabId) await backToMeeting();
    else setStatus('✓ Microphone access is allowed', 'ok');
  } catch {
    setStatus('Microphone access was not allowed. Recordings will only include the other participants.', 'bad');
  }
});

if (params.get('reason') === 'mic') {
  document.getElementById('mic-card').classList.add('highlight');
  setStatus('Allow your microphone so your own voice is recorded too.');
}
render();
