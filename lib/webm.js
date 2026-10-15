// MediaRecorder writes "live" WebM: the Segment has an unknown size and Info has no Duration,
// so players can't show a length or seek. This inserts a Duration element into the Info header.
// Only the first megabyte is rewritten; the rest of the blob is reused untouched.

const ID_EBML = 0x1a45dfa3;
const ID_SEGMENT = 0x18538067;
const ID_SEEK_HEAD = 0x114d9b74;
const ID_INFO = 0x1549a966;
const ID_CLUSTER = 0x1f43b675;
const ID_TIMECODE_SCALE = 0x2ad7b1;
const ID_DURATION = 0x4489;

const HEAD_BYTES = 1 << 20;

// EBML variable-length integer. IDs keep their length marker; sizes drop it.
function readVint(bytes, pos, keepMarker) {
  const first = bytes[pos];
  if (first === undefined || first === 0) return null;
  let length = 1;
  let mask = 0x80;
  while (!(first & mask)) {
    length++;
    mask >>= 1;
  }
  if (pos + length > bytes.length) return null;
  let value = keepMarker ? first : first & (mask - 1);
  let allOnes = (first & (mask - 1)) === mask - 1;
  for (let i = 1; i < length; i++) {
    value = value * 256 + bytes[pos + i];
    if (bytes[pos + i] !== 0xff) allOnes = false;
  }
  return { value, length, allOnes };
}

function readElement(bytes, start) {
  const id = readVint(bytes, start, true);
  if (!id) return null;
  const size = readVint(bytes, start + id.length, false);
  if (!size) return null;
  const dataStart = start + id.length + size.length;
  const unknownSize = size.allOnes;
  return { id: id.value, start, idLength: id.length, dataStart, size: size.value, unknownSize, end: unknownSize ? Infinity : dataStart + size.value };
}

function readUint(bytes, start, length) {
  let value = 0;
  for (let i = 0; i < length; i++) value = value * 256 + bytes[start + i];
  return value;
}

/** 8-byte EBML size field. */
function encodeSize(n) {
  const out = new Uint8Array(8);
  out[0] = 0x01;
  for (let i = 7; i >= 1; i--) {
    out[i] = n % 256;
    n = Math.floor(n / 256);
  }
  return out;
}

/** Returns a copy of `blob` whose WebM header carries `durationMs`, or `blob` itself if it can't be patched safely. */
export async function fixWebmDuration(blob, durationMs) {
  if (!(durationMs > 0) || !blob?.size) return blob;
  try {
    const bytes = new Uint8Array(await blob.slice(0, HEAD_BYTES).arrayBuffer());
    const ebml = readElement(bytes, 0);
    if (ebml?.id !== ID_EBML || ebml.unknownSize) return blob;
    const segment = readElement(bytes, ebml.end);
    // A known Segment size means this isn't a live MediaRecorder file; leave it alone.
    if (segment?.id !== ID_SEGMENT || !segment.unknownSize) return blob;

    for (let pos = segment.dataStart; pos < bytes.length; ) {
      const el = readElement(bytes, pos);
      if (!el || el.unknownSize || el.id === ID_CLUSTER || el.id === ID_SEEK_HEAD) return blob;
      if (el.id === ID_INFO) return patchInfo(blob, bytes, el, durationMs);
      pos = el.end;
    }
  } catch {
    // Fall through: an unpatched file still plays.
  }
  return blob;
}

function patchInfo(blob, bytes, info, durationMs) {
  if (info.end > bytes.length) return blob;
  let timecodeScale = 1_000_000;
  let existing = null;
  for (let pos = info.dataStart; pos < info.end; ) {
    const el = readElement(bytes, pos);
    if (!el || el.end > info.end) return blob;
    if (el.id === ID_TIMECODE_SCALE) timecodeScale = readUint(bytes, el.dataStart, el.size) || timecodeScale;
    if (el.id === ID_DURATION) existing = el;
    pos = el.end;
  }
  const duration = (durationMs * 1_000_000) / timecodeScale;

  if (existing) {
    const head = bytes.slice(0, info.end);
    const view = new DataView(head.buffer);
    if (existing.size === 8) view.setFloat64(existing.dataStart, duration);
    else if (existing.size === 4) view.setFloat32(existing.dataStart, duration);
    else return blob;
    return new Blob([head, blob.slice(info.end)], { type: blob.type });
  }

  const durationEl = new Uint8Array(11);
  durationEl.set([0x44, 0x89, 0x88]);
  new DataView(durationEl.buffer).setFloat64(3, duration);
  const body = bytes.subarray(info.dataStart, info.end);
  const newInfo = new Blob([
    bytes.subarray(info.start, info.start + info.idLength),
    encodeSize(body.length + durationEl.length),
    body,
    durationEl,
  ]);
  return new Blob([bytes.subarray(0, info.start), newInfo, blob.slice(info.end)], { type: blob.type });
}
