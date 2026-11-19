// Bilder vorbereiten: einlesen, verkleinern, Ausschnitt berechnen, Vorschaubild erzeugen.
export const TARGET_ASPECT = 1.44;   // Seitenverhältnis eines iPad-Bildschirms im Querformat
const MAX_SIDE = 2400;               // reicht für scharfe Darstellung auf allen iPads
const LOW_RES_WIDTH = 1000;          // darunter: Warnhinweis „geringe Auflösung“
const THUMB_W = 360;

export function loadImage(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => { resolve(img); setTimeout(() => URL.revokeObjectURL(url), 0); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Bild nicht lesbar')); };
    img.src = url;
  });
}

function toBlob(canvas, quality) {
  return new Promise((resolve, reject) =>
    canvas.toBlob(b => (b ? resolve(b) : reject(new Error('Bild konnte nicht gespeichert werden'))), 'image/jpeg', quality));
}

/** Ausschnitt im Bild (in Bildpixeln), der den Bildschirm ganz füllt */
export function cropRect(w, h, aspect, crop) {
  let cw, ch;
  if (w / h > aspect) { ch = h; cw = h * aspect; } else { cw = w; ch = w / aspect; }
  const z = Math.max(1, (crop && crop.zoom) || 1);
  cw /= z; ch /= z;
  const cx = crop ? crop.cx : 0.5, cy = crop ? crop.cy : 0.5;
  let x = cx * w - cw / 2, y = cy * h - ch / 2;
  x = Math.min(Math.max(0, x), w - cw);
  y = Math.min(Math.max(0, y), h - ch);
  return { x, y, w: cw, h: ch };
}

/** Standard-Ausschnitt: Querformat mittig, Hochformat im oberen Bereich (Gesicht) */
export function defaultCrop(w, h, aspect = TARGET_ASPECT) {
  if (w / h >= aspect) return { cx: 0.5, cy: 0.5, zoom: 1 };
  const ch = w / aspect;
  const top = Math.min(h * 0.06, h - ch);
  return { cx: 0.5, cy: (top + ch / 2) / h, zoom: 1 };
}

export function isLowRes(w, h, crop) {
  return cropRect(w, h, TARGET_ASPECT, crop).w < LOW_RES_WIDTH;
}

export function drawCropped(ctx, img, dw, dh, crop) {
  const r = cropRect(img.naturalWidth || img.width, img.naturalHeight || img.height, dw / dh, crop);
  ctx.drawImage(img, r.x, r.y, r.w, r.h, 0, 0, dw, dh);
}

export async function makeThumb(img, crop) {
  const c = document.createElement('canvas');
  c.width = THUMB_W; c.height = Math.round(THUMB_W / TARGET_ASPECT);
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  drawCropped(ctx, img, c.width, c.height, crop);
  return toBlob(c, 0.82);
}

/** Datei aus OneDrive/Dateien → gespeichertes Bild */
export async function processFile(file) {
  const src = await loadImage(file);
  const w0 = src.naturalWidth, h0 = src.naturalHeight;
  if (!w0 || !h0) throw new Error('Bild nicht lesbar');
  const s = Math.min(1, MAX_SIDE / Math.max(w0, h0));
  const w = Math.round(w0 * s), h = Math.round(h0 * s);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, w, h);
  const blob = await toBlob(c, 0.9);
  c.width = c.height = 1; // Speicher freigeben
  const crop = defaultCrop(w, h);
  const img = await loadImage(blob);
  const thumb = await makeThumb(img, crop);
  return { blob, thumb, w, h, ...crop, lowRes: isLowRes(w, h, crop) };
}

/** Reihenfolge aus dem Dateinamen: führende Zahl, sonst ans Ende */
export function orderKey(name) {
  const m = /^\s*(\d+)/.exec(name);
  return m ? parseInt(m[1], 10) : null;
}
export function sortFiles(files) {
  const collator = new Intl.Collator('de', { numeric: true, sensitivity: 'base' });
  return [...files].sort((a, b) => {
    const ka = orderKey(a.name), kb = orderKey(b.name);
    if (ka !== null && kb !== null && ka !== kb) return ka - kb;
    if (ka === null && kb !== null) return 1;
    if (ka !== null && kb === null) return -1;
    return collator.compare(a.name, b.name);
  });
}
export function baseName(name) {
  return name.replace(/\.[^.]+$/, '');
}

/** Eigenes Logo vorbereiten: PNG (Transparenz bleibt erhalten), höchstens 1600 px */
export async function processLogo(file) {
  const img = await loadImage(file);
  const w0 = img.naturalWidth, h0 = img.naturalHeight;
  if (!w0 || !h0) throw new Error('Logo nicht lesbar');
  const s = Math.min(1, 1600 / Math.max(w0, h0));
  const c = document.createElement('canvas');
  c.width = Math.round(w0 * s); c.height = Math.round(h0 * s);
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, c.width, c.height);
  return new Promise((resolve, reject) =>
    c.toBlob(b => (b ? resolve(b) : reject(new Error('Logo konnte nicht gespeichert werden'))), 'image/png'));
}

/** Anzeigename: Dateiendung weg, führende Nummer weg („1 Obama.jpg“ → „Obama“) */
export function cleanName(name) {
  const base = baseName(name);
  const stripped = base.replace(/^\s*\d+[\s._\-–)]*/, '').trim();
  return stripped || base.trim();
}
