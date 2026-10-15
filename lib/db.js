// IndexedDB storage shared by the service worker, offscreen recorder and extension pages.
//
// recordings  { id, title, meetCode, url, startedAt, endedAt, durationMs, size, mimeType, hasVideo, hasMic, status, cloud }
// chunks      { recordingId, seq, blob }                      main audio/video recording, in order
// audio       { recordingId, seq, startMs, endMs, blob }      ~10 min Opus segments for speech-to-text
// captions    { recordingId, id, speaker, text, startMs, endMs }

const DB_NAME = 'meet-recorder';
const DB_VERSION = 1;

let dbPromise;

function openDb() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore('recordings', { keyPath: 'id' });
      db.createObjectStore('chunks', { keyPath: ['recordingId', 'seq'] });
      db.createObjectStore('audio', { keyPath: ['recordingId', 'seq'] });
      db.createObjectStore('captions', { keyPath: ['recordingId', 'id'] });
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => {
        db.close();
        dbPromise = undefined;
      };
      resolve(db);
    };
    req.onerror = () => {
      dbPromise = undefined;
      reject(req.error);
    };
  });
  return dbPromise;
}

// Runs `fn` inside one transaction. `fn` issues requests synchronously and may return an
// IDBRequest (its result is returned) or a function that produces the result after commit.
async function run(storeNames, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeNames, mode);
    const out = fn(tx);
    tx.oncomplete = () => resolve(typeof out === 'function' ? out() : out instanceof IDBRequest ? out.result : undefined);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
  });
}

// All [recordingId, *] keys of a compound-key store (arrays sort after every other key type).
const ofRecording = (id) => IDBKeyRange.bound([id], [id, []]);

function patchRecord(store, id, patch) {
  let next;
  store.get(id).onsuccess = (event) => {
    const current = event.target.result;
    if (!current) return;
    next = { ...current, ...patch };
    store.put(next);
  };
  return () => next;
}

export function putRecording(rec) {
  return run('recordings', 'readwrite', (tx) => {
    tx.objectStore('recordings').put(rec);
  });
}

export function getRecording(id) {
  return run('recordings', 'readonly', (tx) => tx.objectStore('recordings').get(id));
}

export function updateRecording(id, patch) {
  return run('recordings', 'readwrite', (tx) => patchRecord(tx.objectStore('recordings'), id, patch));
}

export async function listRecordings() {
  const all = await run('recordings', 'readonly', (tx) => tx.objectStore('recordings').getAll());
  return all.sort((a, b) => b.startedAt - a.startedAt);
}

export function deleteRecording(id) {
  return run(['recordings', 'chunks', 'audio', 'captions'], 'readwrite', (tx) => {
    tx.objectStore('recordings').delete(id);
    for (const name of ['chunks', 'audio', 'captions']) tx.objectStore(name).delete(ofRecording(id));
  });
}

/** Stores one MediaRecorder chunk and updates the recording's running totals in the same transaction. */
export function putChunk(recordingId, seq, blob, patch) {
  return run(['chunks', 'recordings'], 'readwrite', (tx) => {
    tx.objectStore('chunks').put({ recordingId, seq, blob });
    if (patch) patchRecord(tx.objectStore('recordings'), recordingId, patch);
  });
}

export async function getChunks(recordingId) {
  const rows = await run('chunks', 'readonly', (tx) => tx.objectStore('chunks').getAll(ofRecording(recordingId)));
  return rows.map((row) => row.blob);
}

export function putAudio(segment) {
  return run('audio', 'readwrite', (tx) => {
    tx.objectStore('audio').put(segment);
  });
}

export function getAudio(recordingId) {
  return run('audio', 'readonly', (tx) => tx.objectStore('audio').getAll(ofRecording(recordingId)));
}

export function putCaptions(recordingId, entries) {
  return run('captions', 'readwrite', (tx) => {
    const store = tx.objectStore('captions');
    for (const entry of entries) store.put({ ...entry, recordingId });
  });
}

export async function getCaptions(recordingId) {
  const rows = await run('captions', 'readonly', (tx) => tx.objectStore('captions').getAll(ofRecording(recordingId)));
  return rows.filter((row) => row.text).sort((a, b) => a.startMs - b.startMs);
}
