// Sammlungen anlegen, ersetzen, löschen, sichern, wiederherstellen.
import * as db from './db.js';
import { processFile, sortFiles, orderKey, cleanName, loadImage, makeThumb, isLowRes } from './imaging.js';
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
        id: db.uid(), collectionId, order: i, name: cleanName(f.name),
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
  const col = { id: db.uid(), name: name.trim() || 'Neue Sammlung', created: Date.now(), updated: Date.now(), outroText: 'Danke fürs Mitraten!' };
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

async function renumber(collectionId) {
  const imgs = await db.imagesOf(collectionId);
  imgs.forEach((r, i) => { r.order = i; });
  await db.putMany('images', imgs);
}
async function touch(collectionId) {
  const col = await db.get('collections', collectionId);
  if (col) { col.updated = Date.now(); await db.put('collections', col); }
}

/** Mehrere ausgewählte Bilder löschen */
export async function deleteImages(collectionId, ids) {
  for (const id of ids) await db.del('images', id);
  await renumber(collectionId);
  await touch(collectionId);
}

/** Ein Bild ersetzen – das neue Bild kommt an dieselbe Stelle */
export async function replaceOne(collectionId, imageId, file) {
  const old = await db.get('images', imageId);
  const p = await processFile(file);
  await db.put('images', {
    ...old, name: cleanName(file.name),
    blob: p.blob, thumb: p.thumb, w: p.w, h: p.h, cx: p.cx, cy: p.cy, zoom: p.zoom, lowRes: p.lowRes,
  });
  await touch(collectionId);
  return { lowRes: p.lowRes };
}

/** Bilder hinzufügen – neue Bilder kommen ans Ende */
export async function addImages(collectionId, files, onProgress) {
  const tmpId = collectionId + ':neu';
  const report = await importInto(tmpId, files, onProgress);
  const merged = [...await db.imagesOf(collectionId), ...await db.imagesOf(tmpId)];
  merged.forEach((r, i) => { r.order = i; r.collectionId = collectionId; });
  await db.putMany('images', merged);
  await touch(collectionId);
  return report;
}

/** Neue Reihenfolge nach dem Sortieren speichern */
export async function reorder(collectionId, ids) {
  const imgs = await db.imagesOf(collectionId);
  const pos = new Map(ids.map((id, i) => [id, i]));
  imgs.forEach(r => { r.order = pos.has(r.id) ? pos.get(r.id) : 1e6 + r.order; });
  imgs.sort((a, b) => a.order - b.order).forEach((r, i) => { r.order = i; });
  await db.putMany('images', imgs);
  await touch(collectionId);
}

export async function renameImage(imageId, name) {
  const r = await db.get('images', imageId);
  r.name = name.trim() || r.name;
  await db.put('images', r);
}

/** Sammlung duplizieren – mit Bildern, Ausschnitten, Reihenfolge und Logos */
export async function duplicateCollection(id) {
  const col = await db.get('collections', id);
  const copy = { ...col, id: db.uid(), name: `${col.name} (Kopie)`, created: Date.now(), updated: Date.now() };
  await db.put('collections', copy);
  const imgs = await db.imagesOf(id);
  for (const r of imgs) await db.put('images', { ...r, id: db.uid(), collectionId: copy.id });
  return copy;
}

/** Einmalig: Nummern vorne aus bestehenden Bildnamen entfernen (Reihenfolge bleibt) */
export async function migrateNames() {
  const s = await db.getSettings();
  if (s.namesCleaned) return;
  const all = await db.getAll('images');
  const changed = all.filter(r => cleanName(r.name) !== r.name);
  for (const r of changed) { r.name = cleanName(r.name); await db.put('images', r); }
  await db.saveSettings({ namesCleaned: true });
}

/** Einmalig (1.3): Standard wird das weiße Logo auf dunklem Hintergrund */
export async function migrateDefaultDark() {
  const s = await db.getSettings();
  if (s.defaultDark13) return;
  await db.saveSettings({ defaultDark13: true, ...(s.logo ? {} : { logoBg: 'dark' }) });
}

/* ---------- Logos ----------
   Sammlung: logoMode 'standard' | 'all' | 'each'
   'all'  → logo/logoBg für Startbild, Abschlussbild und Waben
   'each' → logoStart/logoEnd/logoWaben (+ …Bg); leere Bereiche nutzen das Standard-Logo */
export const LOGO_SLOTS = ['Start', 'End', 'Waben'];

export async function setCollectionLogos(collectionId, patch) {
  const col = await db.get('collections', collectionId);
  Object.assign(col, patch);
  await db.put('collections', col);
}

function logoMode(col) {
  if (!col) return 'standard';
  if (col.logoMode) return col.logoMode;
  return col.logo ? 'all' : 'standard';   // ältere Sammlungen
}

/** Logo und Hintergrund für Startbild, Abschlussbild und Waben (logo = null → Time-Bandits-Logo) */
export async function effectiveLogos(col) {
  const s = await db.getSettings();
  const std = { logo: s.logo || null, bg: s.logoBg || 'dark', custom: false };
  const mode = logoMode(col);
  const out = {};
  for (const k of LOGO_SLOTS) {
    if (mode === 'all' && col.logo) out[k] = { logo: col.logo, bg: col.logoBg || 'light', custom: true };
    else if (mode === 'each' && col['logo' + k]) out[k] = { logo: col['logo' + k], bg: col['logo' + k + 'Bg'] || 'light', custom: true };
    else out[k] = std;
  }
  out.mode = mode;
  return out;
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
  const manifest = { app: 'foto-puzzle', format: 2, created: new Date().toISOString(), settings: { revealMode: settings.revealMode, outroText: settings.outroText, logoBg: settings.logoBg }, collections: [] };
  if (settings.logo) { manifest.settings.logoFile = 'logos/standard.png'; entries.push({ name: 'logos/standard.png', data: settings.logo }); }
  let total = 0, n = 0;
  const all = [];
  for (const c of cols) { const imgs = await db.imagesOf(c.id); all.push([c, imgs]); total += imgs.length; }
  for (const [c, imgs] of all) {
    const mc = { id: c.id, name: c.name, created: c.created, updated: c.updated, outroText: c.outroText ?? settings.outroText, logoMode: c.logoMode, logoBg: c.logoBg, images: [] };
    for (const f of ['logo', 'logoStart', 'logoEnd', 'logoWaben']) {
      if (f !== 'logo') mc[f + 'Bg'] = c[f + 'Bg'];
      if (c[f]) { mc[f + 'File'] = `logos/${c.id}-${f}.png`; entries.push({ name: mc[f + 'File'], data: c[f] }); }
    }
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
  const png = name => (name && files.get(name) ? new Blob([files.get(name)], { type: 'image/png' }) : null);
  for (const c of manifest.collections) {
    const col = { id: c.id, name: c.name, created: c.created, updated: c.updated, outroText: c.outroText ?? manifest.settings?.outroText, logoMode: c.logoMode, logoBg: c.logoBg || 'light' };
    for (const f of ['logo', 'logoStart', 'logoEnd', 'logoWaben']) {
      col[f] = png(c[f + 'File']);
      if (f !== 'logo') col[f + 'Bg'] = c[f + 'Bg'] || 'light';
    }
    await db.put('collections', col);
    for (const r of c.images) {
      onProgress && onProgress(n++, total);
      const blob = new Blob([files.get(`bilder/${r.id}.jpg`)], { type: 'image/jpeg' });
      const thumb = new Blob([files.get(`vorschau/${r.id}.jpg`)], { type: 'image/jpeg' });
      await db.put('images', { ...r, collectionId: c.id, blob, thumb });
    }
  }
  if (manifest.settings) {
    const { logoFile, ...rest } = manifest.settings;
    await db.saveSettings({ ...rest, logo: png(logoFile), logoBg: rest.logoBg || 'light' });
  }
}
