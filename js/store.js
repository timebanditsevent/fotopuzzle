// Sammlungen anlegen, ersetzen, löschen, sichern, wiederherstellen.
import * as db from './db.js';
import { processFile, sortFiles, orderKey, baseName, loadImage, makeThumb, isLowRes } from './imaging.js';
import { createZip, readZip } from './zip.js';

export async function listCollections() {
  const cols = await db.getAll('collections');
  cols.sort((a, b) => (b.updated || 0) - (a.updated || 0));
  return cols;
}

async function importInto(collectionId, files, onProgress) {
  const sorted = sortFiles(files);
  const report = { added: [], unnumbered: [], lowRes: [], failed: [] };
  for (let i = 0; i < sorted.length; i++) {
    const f = sorted[i];
    onProgress && onProgress(i, sorted.length, f.name);
    try {
      const p = await processFile(f);
      const rec = {
        id: db.uid(), collectionId, order: i, name: baseName(f.name),
        blob: p.blob, thumb: p.thumb, w: p.w, h: p.h,
        cx: p.cx, cy: p.cy, zoom: p.zoom, lowRes: p.lowRes,
      };
      await db.put('images', rec);
      report.added.push(rec.id);
      if (orderKey(f.name) === null) report.unnumbered.push(f.name);
      if (p.lowRes) report.lowRes.push(f.name);
    } catch (e) {
      report.failed.push(f.name);
    }
  }
  onProgress && onProgress(sorted.length, sorted.length, '');
  // Reihenfolge lückenlos neu durchzählen (falls Dateien übersprungen wurden)
  const imgs = await db.imagesOf(collectionId);
  imgs.forEach((r, i) => { r.order = i; });
  await db.putMany('images', imgs);
  return report;
}

export async function createCollection(name, files, onProgress) {
  try { await navigator.storage?.persist?.(); } catch (e) { /* optional */ }
  const col = { id: db.uid(), name: name.trim() || 'Neue Sammlung', created: Date.now(), updated: Date.now() };
  await db.put('collections', col);
  const report = await importInto(col.id, files, onProgress);
  if (!report.added.length) { await db.deleteCollection(col.id); }
  return { col, report };
}

/** Bilder ersetzen: neue Bilder zuerst sicher speichern, dann alte entfernen */
export async function replaceImages(collectionId, files, onProgress) {
  const old = await db.imagesOf(collectionId);
  const tmpId = collectionId + ':neu';
  const report = await importInto(tmpId, files, onProgress);
  if (!report.added.length) { await db.deleteImagesOf(tmpId); return report; }
  for (const r of old) await db.del('images', r.id);
  const fresh = await db.imagesOf(tmpId);
  fresh.forEach(r => { r.collectionId = collectionId; });
  await db.putMany('images', fresh);
  const col = await db.get('collections', collectionId);
  col.updated = Date.now();
  await db.put('collections', col);
  return report;
}

export async function renameCollection(id, name) {
  const col = await db.get('collections', id);
  col.name = name.trim() || col.name;
  col.updated = Date.now();
  await db.put('collections', col);
  return col;
}

export async function saveCrop(image, crop) {
  const img = await loadImage(image.blob);
  const next = { ...image, ...crop };
  next.thumb = await makeThumb(img, next);
  next.lowRes = isLowRes(next.w, next.h, next);
  await db.put('images', next);
  return next;
}

/* ---------- Sicherung ---------- */
export async function createBackup(onProgress) {
  const settings = await db.getSettings();
  const cols = await listCollections();
  const entries = [];
  const manifest = { app: 'foto-puzzle', format: 1, created: new Date().toISOString(), settings: { revealMode: settings.revealMode, outroText: settings.outroText }, collections: [] };
  let total = 0, n = 0;
  const all = [];
  for (const c of cols) { const imgs = await db.imagesOf(c.id); all.push([c, imgs]); total += imgs.length; }
  for (const [c, imgs] of all) {
    const mc = { id: c.id, name: c.name, created: c.created, updated: c.updated, images: [] };
    for (const r of imgs) {
      onProgress && onProgress(n++, total);
      entries.push({ name: `bilder/${r.id}.jpg`, data: r.blob });
      entries.push({ name: `vorschau/${r.id}.jpg`, data: r.thumb });
      mc.images.push({ id: r.id, name: r.name, order: r.order, w: r.w, h: r.h, cx: r.cx, cy: r.cy, zoom: r.zoom, lowRes: r.lowRes });
    }
    manifest.collections.push(mc);
  }
  entries.unshift({ name: 'foto-puzzle.json', data: JSON.stringify(manifest, null, 1) });
  const blob = await createZip(entries);
  const d = new Date();
  const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return { blob, filename: `Foto-Puzzle-Sicherung-${stamp}.zip`, collections: cols.length, images: total };
}

export async function readBackup(file) {
  const files = await readZip(file);
  const mf = files.get('foto-puzzle.json');
  if (!mf) throw new Error('Diese Datei ist keine Foto-Puzzle-Sicherung');
  const manifest = JSON.parse(new TextDecoder().decode(mf));
  if (manifest.app !== 'foto-puzzle') throw new Error('Diese Datei ist keine Foto-Puzzle-Sicherung');
  return { manifest, files };
}

export async function restoreBackup({ manifest, files }, onProgress) {
  await db.clearAll();
  let n = 0;
  const total = manifest.collections.reduce((s, c) => s + c.images.length, 0);
  for (const c of manifest.collections) {
    await db.put('collections', { id: c.id, name: c.name, created: c.created, updated: c.updated });
    for (const r of c.images) {
      onProgress && onProgress(n++, total);
      const blob = new Blob([files.get(`bilder/${r.id}.jpg`)], { type: 'image/jpeg' });
      const thumb = new Blob([files.get(`vorschau/${r.id}.jpg`)], { type: 'image/jpeg' });
      await db.put('images', { ...r, collectionId: c.id, blob, thumb });
    }
  }
  if (manifest.settings) await db.saveSettings(manifest.settings);
}
