// Lokale Datenhaltung auf dem iPad (IndexedDB). Alles bleibt offline verfügbar.
const DB_NAME = 'fotopuzzle';
const DB_VERSION = 1;
let dbPromise = null;

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains('collections')) d.createObjectStore('collections', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('images')) {
          const s = d.createObjectStore('images', { keyPath: 'id' });
          s.createIndex('collectionId', 'collectionId');
        }
        if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta', { keyPath: 'key' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

function done(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Speichern abgebrochen'));
  });
}
function result(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// Bilddaten als ArrayBuffer speichern statt als Blob: Safari auf dem iPad liest
// gespeicherte Blobs nicht in jeder Situation zuverlässig zurück.
const BINARY_FIELDS = ['blob', 'thumb', 'logo'];
async function pack(value) {
  if (!value) return value;
  const out = { ...value };
  for (const f of BINARY_FIELDS) {
    if (out[f] instanceof Blob) out[f] = { __ab: await out[f].arrayBuffer(), type: out[f].type || 'image/jpeg' };
  }
  return out;
}
function unpack(value) {
  if (!value) return value;
  for (const f of BINARY_FIELDS) {
    const v = value[f];
    if (v && v.__ab) value[f] = new Blob([v.__ab], { type: v.type || 'image/jpeg' });
  }
  return value;
}

export async function get(store, key) {
  const d = await openDb();
  return unpack(await result(d.transaction(store).objectStore(store).get(key)));
}
export async function getAll(store) {
  const d = await openDb();
  return (await result(d.transaction(store).objectStore(store).getAll())).map(unpack);
}
export async function put(store, value) {
  const packed = await pack(value);
  const d = await openDb();
  const tx = d.transaction(store, 'readwrite');
  tx.objectStore(store).put(packed);
  return done(tx);
}
export async function putMany(store, values) {
  const packed = [];
  for (const v of values) packed.push(await pack(v));
  const d = await openDb();
  const tx = d.transaction(store, 'readwrite');
  const s = tx.objectStore(store);
  packed.forEach(v => s.put(v));
  return done(tx);
}
export async function del(store, key) {
  const d = await openDb();
  const tx = d.transaction(store, 'readwrite');
  tx.objectStore(store).delete(key);
  return done(tx);
}

/** Bilder einer Sammlung in Spielreihenfolge */
export async function imagesOf(collectionId) {
  const d = await openDb();
  const list = await result(d.transaction('images').objectStore('images').index('collectionId').getAll(collectionId));
  return list.map(unpack).sort((a, b) => a.order - b.order);
}
/** Nur die Kennungen und Vorschaubilder (für Listen) */
export async function countOf(collectionId) {
  const d = await openDb();
  return result(d.transaction('images').objectStore('images').index('collectionId').count(collectionId));
}

export async function deleteImagesOf(collectionId) {
  const d = await openDb();
  const tx = d.transaction('images', 'readwrite');
  const idx = tx.objectStore('images').index('collectionId');
  const keys = await result(idx.getAllKeys(collectionId));
  const s = tx.objectStore('images');
  keys.forEach(k => s.delete(k));
  return done(tx);
}

export async function deleteCollection(id) {
  await deleteImagesOf(id);
  await del('collections', id);
}

export async function clearAll() {
  const d = await openDb();
  const tx = d.transaction(['collections', 'images'], 'readwrite');
  tx.objectStore('collections').clear();
  tx.objectStore('images').clear();
  return done(tx);
}

const DEFAULT_SETTINGS = { key: 'settings', revealMode: 'rand', outroText: 'Danke fürs Mitraten!', logo: null, logoBg: 'light' };
export async function getSettings() {
  const s = await get('meta', 'settings');
  return { ...DEFAULT_SETTINGS, ...(s || {}) };
}
export async function saveSettings(patch) {
  const s = await getSettings();
  const next = { ...s, ...patch, key: 'settings' };
  await put('meta', next);
  return next;
}

export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
