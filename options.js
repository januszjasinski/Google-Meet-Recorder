import { DEFAULT_SETTINGS, getSettings, saveSettings, micPermission } from './lib/settings.js';
import { apiOriginPattern } from './lib/transcribe.js';

const form = document.getElementById('form');
const fields = form.elements;

async function listMicrophones(selected) {
  const select = document.getElementById('mic-device');
  const permission = await micPermission();
  if (permission !== 'granted') {
    document.getElementById('mic-help').innerHTML =
      'Allow microphone access on the <a href="welcome.html">setup page</a> to choose a specific microphone.';
  }
  const devices = await navigator.mediaDevices.enumerateDevices().catch(() => []);
  for (const device of devices) {
    if (device.kind !== 'audioinput' || !device.deviceId || device.deviceId === 'default' || !device.label) continue;
    select.append(new Option(device.label, device.deviceId));
  }
  if (selected && ![...select.options].some((o) => o.value === selected)) {
    select.append(new Option('Previously selected microphone (not connected)', selected));
  }
  select.value = selected;
}

async function load() {
  const settings = await getSettings();
  for (const [key, value] of Object.entries(settings)) {
    const field = fields.namedItem(key);
    if (!field || key === 'micDeviceId') continue;
    if (field.type === 'checkbox') field.checked = value;
    else field.value = value;
  }
  await listMicrophones(settings.micDeviceId);
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const error = document.getElementById('error');
  const saved = document.getElementById('saved');
  error.hidden = true;
  saved.hidden = true;

  const next = {};
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    const field = fields.namedItem(key);
    if (!field) continue;
    next[key] = field.type === 'checkbox' ? field.checked : field.value.trim();
  }
  next.apiBaseUrl = next.apiBaseUrl.replace(/\/+$/, '') || DEFAULT_SETTINGS.apiBaseUrl;
  next.model ||= DEFAULT_SETTINGS.model;

  try {
    // Ask for access to the API host now, while we have a click to attach the prompt to.
    if (next.apiKey || next.apiBaseUrl !== DEFAULT_SETTINGS.apiBaseUrl) {
      const granted = await chrome.permissions.request({ origins: [apiOriginPattern(next.apiBaseUrl)] });
      if (!granted) throw new Error(`Without access to ${new URL(next.apiBaseUrl).host}, AI transcription can't run.`);
    }
    await saveSettings(next);
    saved.hidden = false;
    setTimeout(() => (saved.hidden = true), 2500);
  } catch (err) {
    error.textContent = err.message;
    error.hidden = false;
  }
});

load();
