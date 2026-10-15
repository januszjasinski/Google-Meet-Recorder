const pad = (n, width = 2) => String(n).padStart(width, '0');

/** 83000 -> "01:23", 3723000 -> "1:02:03" */
export function clock(ms) {
  const t = Math.max(0, Math.floor((ms || 0) / 1000));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

/** SRT timestamp: "00:01:23,456" */
export function srtTime(ms) {
  const t = Math.max(0, Math.round(ms || 0));
  const h = Math.floor(t / 3_600_000);
  const m = Math.floor((t % 3_600_000) / 60_000);
  const s = Math.floor((t % 60_000) / 1000);
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(t % 1000, 3)}`;
}

export function humanDuration(ms) {
  const t = Math.round((ms || 0) / 1000);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  if (h) return `${h} h ${pad(m)} min`;
  if (m) return `${m} min`;
  return `${t % 60} s`;
}

export function formatBytes(n) {
  if (!n) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const value = n / 1024 ** i;
  return `${value >= 10 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}

export function formatDate(ts) {
  return new Date(ts).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/** Filesystem-safe base name, e.g. "Weekly sync 2026-10-15 14-30". */
export function fileBaseName(rec) {
  const d = new Date(rec.startedAt);
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}-${pad(d.getMinutes())}`;
  const title = (rec.title || 'Meeting')
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return `${title} ${stamp}`;
}

export function mediaExtension(mimeType = '') {
  if (mimeType.startsWith('video/mp4')) return 'mp4';
  if (mimeType.startsWith('audio/mp4')) return 'm4a';
  return 'webm';
}

const lineLabel =(line) => (line.speaker ? `${line.speaker}: ${line.text}` : line.text);

export function transcriptText(rec, lines) {
  const body = lines.map((line) => `[${clock(line.startMs)}] ${lineLabel(line)}`);
  return [rec.title, formatDate(rec.startedAt), '', ...body, ''].join('\n');
}

export function transcriptSrt(lines) {
  return lines
    .map((line, i) => {
      const end = Math.max(line.endMs || 0, line.startMs + 1500);
      return `${i + 1}\n${srtTime(line.startMs)} --> ${srtTime(end)}\n${lineLabel(line)}\n`;
    })
    .join('\n');
}
