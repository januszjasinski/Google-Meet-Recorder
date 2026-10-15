export const DEFAULT_SETTINGS = Object.freeze({
  includeMic: true,
  micDeviceId: '',
  recordVideo: true,
  videoQuality: '720p',
  fileFormat: 'mp4', // 'mp4' falls back to WebM where Chrome can't encode MP4
  autoEnableCaptions: true,
  openLibraryOnStop: true,
  // Optional speech-to-text on the recorded audio (OpenAI or any OpenAI-compatible server).
  apiBaseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'whisper-1',
  language: '',
  autoTranscribe: false,
});

export const VIDEO_QUALITY = Object.freeze({
  '1080p': { width: 1920, height: 1080, bitrate: 4_000_000 },
  '720p': { width: 1280, height: 720, bitrate: 2_500_000 },
  '480p': { width: 854, height: 480, bitrate: 1_000_000 },
});

export async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...settings };
}

export async function saveSettings(patch) {
  const next = { ...(await getSettings()), ...patch };
  await chrome.storage.local.set({ settings: next });
  return next;
}

/** 'granted' | 'denied' | 'prompt' | 'unknown' for the extension's own origin. */
export async function micPermission() {
  try {
    return (await navigator.permissions.query({ name: 'microphone' })).state;
  } catch {
    return 'unknown';
  }
}
