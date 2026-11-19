// Foto Puzzle – Spielleiter-Oberfläche
import * as db from './db.js';
import * as store from './store.js';
import { Game, requestFullscreen } from './game.js';
import { TARGET_ASPECT, cropRect, defaultCrop, loadImage } from './imaging.js';

export const APP_VERSION = '1.0.1';

const $view = document.getElementById('view');
const $modalRoot = document.getElementById('modal-root');
const $game = document.getElementById('game');
const $toast = document.getElementById('toast');
const $fileImages = document.getElementById('file-images');
const $fileBackup = document.getElementById('file-backup');

let objectUrls = [];
let route = { name: 'home' };
let game = null;

/* ---------- Hilfen ---------- */
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function url(blob) { const u = URL.createObjectURL(blob); objectUrls.push(u); return u; }
function freeUrls() { objectUrls.forEach(u => URL.revokeObjectURL(u)); objectUrls = []; }
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
function fmtDate(t) { return t ? new Date(t).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' }) : ''; }
function fmtMB(bytes) { return bytes >= 1e9 ? (bytes / 1e9).toFixed(1).replace('.', ',') + ' GB' : Math.max(1, Math.round(bytes / 1e6)) + ' MB'; }

let toastTimer = 0;
function toast(msg) {
  $toast.textContent = msg;
  $toast.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $toast.classList.remove('on'), 2600);
}

/** Dateiauswahl – muss direkt aus einem Tipp heraus aufgerufen werden */
function pickFiles(input) {
  return new Promise(resolve => {
    input.value = '';
    const done = () => { input.removeEventListener('change', onChange); input.removeEventListener('cancel', onCancel); };
    const onChange = () => { done(); resolve([...input.files]); };
    const onCancel = () => { done(); resolve([]); };
    input.addEventListener('change', onChange);
    input.addEventListener('cancel', onCancel);
    input.click();
  });
}

/* ---------- Dialoge ---------- */
function modal({ title, body = '', actions = [], wide = false, onMount }) {
  return new Promise(resolve => {
    const wrap = document.createElement('div');
    wrap.className = 'modal-wrap';
    wrap.innerHTML = `
      <div class="modal${wide ? ' wide' : ''}" role="dialog" aria-modal="true" aria-labelledby="m-title">
        <h2 id="m-title">${esc(title)}</h2>
        <div class="m-body">${body}</div>
        ${actions.length ? `<div class="actions">${actions.map((a, i) =>
          `<button type="button" class="btn ${a.kind || ''}" data-i="${i}">${esc(a.label)}</button>`).join('')}</div>` : ''}
      </div>`;
    const close = v => { wrap.remove(); resolve(v); };
    wrap.querySelectorAll('.actions button').forEach(b => {
      b.addEventListener('click', () => {
        const a = actions[+b.dataset.i];
        const v = a.onClick ? a.onClick(wrap) : a.value;
        if (v === false) return;            // Dialog offen lassen
        close(v);
      });
    });
    wrap.addEventListener('keydown', e => { if (e.key === 'Escape') close(undefined); });
    $modalRoot.appendChild(wrap);
    const m = wrap.querySelector('.modal');
    onMount && onMount(wrap, close);
    const f = wrap.querySelector('input, .actions .primary, .actions button');
    (f || m).focus({ preventScroll: true });
  });
}

function progressDialog(title) {
  const wrap = document.createElement('div');
  wrap.className = 'modal-wrap';
  wrap.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true" aria-live="polite">
      <h2>${esc(title)}</h2>
      <div class="progress"><i></i></div>
      <p class="muted small" data-label>Wird vorbereitet …</p>
    </div>`;
  $modalRoot.appendChild(wrap);
  const bar = wrap.querySelector('.progress > i'), label = wrap.querySelector('[data-label]');
  return {
    update(i, n, text) {
      bar.style.width = n ? Math.round(i / n * 100) + '%' : '0';
      label.textContent = text || (n ? `${i} von ${n}` : '');
    },
    close() { wrap.remove(); },
  };
}

async function importReport(report) {
  const parts = [];
  if (report.failed.length) parts.push(`<p><b>${plural(report.failed.length, 'Datei konnte', 'Dateien konnten')} nicht gelesen werden</b> und ${report.failed.length === 1 ? 'wurde' : 'wurden'} übersprungen:</p><ul class="list-small">${report.failed.map(n => `<li>${esc(n)}</li>`).join('')}</ul>`);
  if (report.unnumbered.length) parts.push(`<p><b>${plural(report.unnumbered.length, 'Bild hat', 'Bilder haben')} keine Nummer</b> am Anfang des Dateinamens und ${report.unnumbered.length === 1 ? 'steht' : 'stehen'} deshalb am Ende:</p><ul class="list-small">${report.unnumbered.map(n => `<li>${esc(n)}</li>`).join('')}</ul>`);
  if (report.lowRes.length) parts.push(`<p><b>${plural(report.lowRes.length, 'Bild hat', 'Bilder haben')} eine geringe Auflösung</b> und ${report.lowRes.length === 1 ? 'wirkt' : 'wirken'} auf der Leinwand eventuell unscharf:</p><ul class="list-small">${report.lowRes.map(n => `<li>${esc(n)}</li>`).join('')}</ul>`);
  if (!parts.length) return;
  await modal({ title: 'Hinweise zum Import', body: `<div style="display:flex;flex-direction:column;gap:12px">${parts.join('')}</div>`, actions: [{ label: 'Verstanden', kind: 'primary' }] });
}

/* ---------- Ansichten ---------- */
async function render() {
  freeUrls();
  if (route.name === 'collection') await renderCollection(route.id);
  else await renderHome();
  $view.focus({ preventScroll: true });
}
function go(r) { route = r; window.scrollTo(0, 0); render(); }

async function renderHome() {
  const cols = await store.listCollections();
  const cards = [];
  for (const c of cols) {
    const imgs = await db.imagesOf(c.id);
    const strip = imgs.slice(0, 4).map(r => `<img src="${url(r.thumb)}" alt="">`).join('');
    cards.push(`
      <button type="button" class="card" data-act="open" data-id="${esc(c.id)}">
        <div class="strip">${strip}</div>
        <div class="card-name">${esc(c.name)}</div>
        <p class="meta">${plural(imgs.length, 'Bild', 'Bilder')} · aktualisiert ${fmtDate(c.updated)}</p>
      </button>`);
  }
  $view.innerHTML = `
    <div class="row-head">
      <h1>Sammlungen</h1>
      <button type="button" class="btn primary" data-act="new">+ Neue Sammlung</button>
    </div>
    ${cols.length ? `<div class="cards">${cards.join('')}</div>` : `
      <div class="empty">
        <h2>Noch keine Sammlung</h2>
        <ol>
          <li>In OneDrive einen Ordner pro Sammlung anlegen.</li>
          <li>Bilder mit einer Nummer vorne benennen, z.&nbsp;B. <code>1 Obama.jpg</code>, <code>2 Fischer.jpg</code>. Die Nummer bestimmt die Reihenfolge im Spiel.</li>
          <li>Hier auf „Neue Sammlung“ tippen und alle Bilder aus dem Ordner auswählen.</li>
        </ol>
        <button type="button" class="btn primary" data-act="new">+ Neue Sammlung</button>
      </div>`}`;
}

async function renderCollection(id) {
  const col = await db.get('collections', id);
  if (!col) return go({ name: 'home' });
  const imgs = await db.imagesOf(id);
  const low = imgs.filter(r => r.lowRes).length;
  $view.innerHTML = `
    <div><button type="button" class="link" data-act="home">‹ Alle Sammlungen</button></div>
    <div class="col-head">
      <div>
        <h1>${esc(col.name)}</h1>
        <p class="meta">${plural(imgs.length, 'Bild', 'Bilder')} · Reihenfolge aus den Dateinamen</p>
      </div>
      <button type="button" class="btn primary big" data-act="play" ${imgs.length ? '' : 'disabled'}>Spiel starten</button>
    </div>
    <div class="tools">
      <button type="button" class="btn" data-act="replace">Bilder ersetzen</button>
      <button type="button" class="btn" data-act="rename">Umbenennen</button>
      <button type="button" class="btn danger-ghost" data-act="delete">Sammlung löschen</button>
    </div>
    ${low ? `<div class="notice"><span><b>${plural(low, 'Bild hat', 'Bilder haben')} eine geringe Auflösung.</b> ${low === 1 ? 'Es ist' : 'Sie sind'} markiert und ${low === 1 ? 'kann' : 'können'} auf der Leinwand unscharf wirken.</span></div>` : ''}
    <ol class="grid">
      ${imgs.map((r, i) => `
        <li><button type="button" class="thumb" data-act="crop" data-id="${esc(r.id)}" aria-label="Ausschnitt von ${esc(r.name)} anpassen">
          <span class="thumb-img"><img src="${url(r.thumb)}" alt="" loading="lazy"><span class="num">${i + 1}</span>${r.lowRes ? '<span class="warn-chip">Geringe Auflösung</span>' : ''}</span>
          <span class="thumb-name">${esc(r.name)}</span>
        </button></li>`).join('')}
    </ol>
    <p class="hint">Auf ein Bild tippen, um den sichtbaren Ausschnitt zu verschieben. Die Reihenfolge ändert ihr in OneDrive und importiert dann mit „Bilder ersetzen“ neu.</p>`;
}

/* ---------- Aktionen ---------- */
async function newCollection() {
  let files = null;
  const name = await modal({
    title: 'Neue Sammlung',
    body: `<div style="display:flex;flex-direction:column;gap:14px">
      <div class="field"><label for="col-name">Name der Sammlung</label><input type="text" id="col-name" placeholder="z. B. Weihnachten 2026" autocomplete="off"></div>
      <p class="muted small">Im nächsten Schritt öffnet sich die Dateien-App. Wählt dort im OneDrive-Ordner alle Bilder dieser Sammlung aus.</p></div>`,
    actions: [
      { label: 'Abbrechen' },
      { label: 'Bilder auswählen', kind: 'primary', onClick: w => { files = pickFiles($fileImages); return w.querySelector('#col-name').value || 'Neue Sammlung'; } },
    ],
    onMount: (w, close) => w.querySelector('#col-name').addEventListener('keydown', e => { if (e.key === 'Enter') w.querySelector('.actions .primary').click(); }),
  });
  if (name === undefined || !files) return;
  const list = await files;
  if (!list.length) return;
  const pd = progressDialog('Bilder werden importiert');
  try {
    const { col, report } = await store.createCollection(name, list, (i, n) => pd.update(i, n, `Bild ${Math.min(i + 1, n)} von ${n} wird vorbereitet …`));
    pd.close();
    if (!report.added.length) { await importReport(report); return toast('Es konnte kein Bild importiert werden'); }
    toast(`„${col.name}“ mit ${plural(report.added.length, 'Bild', 'Bildern')} angelegt`);
    go({ name: 'collection', id: col.id });
    await importReport(report);
  } catch (e) {
    pd.close();
    modal({ title: 'Import fehlgeschlagen', body: `<p>${esc(e.message || e)}</p><p class="muted small">Prüft, ob genug Speicher auf dem iPad frei ist, und versucht es erneut.</p>`, actions: [{ label: 'OK', kind: 'primary' }] });
  }
}

async function replaceImages(id) {
  const col = await db.get('collections', id);
  let files = null;
  const ok = await modal({
    title: 'Bilder ersetzen',
    body: `<p>Alle Bilder von <b>„${esc(col.name)}“</b> werden durch die neu ausgewählten ersetzt. Die Reihenfolge kommt wieder aus den Nummern in den Dateinamen.</p>`,
    actions: [{ label: 'Abbrechen' }, { label: 'Bilder auswählen', kind: 'primary', onClick: () => { files = pickFiles($fileImages); return true; } }],
  });
  if (!ok || !files) return;
  const list = await files;
  if (!list.length) return;
  const pd = progressDialog('Bilder werden ersetzt');
  try {
    const report = await store.replaceImages(id, list, (i, n) => pd.update(i, n, `Bild ${Math.min(i + 1, n)} von ${n} wird vorbereitet …`));
    pd.close();
    if (!report.added.length) { await importReport(report); return toast('Keine Bilder ersetzt, die alte Sammlung bleibt erhalten'); }
    toast(`${plural(report.added.length, 'Bild', 'Bilder')} übernommen`);
    await render();
    await importReport(report);
  } catch (e) {
    pd.close();
    modal({ title: 'Ersetzen fehlgeschlagen', body: `<p>${esc(e.message || e)}</p>`, actions: [{ label: 'OK', kind: 'primary' }] });
  }
}

async function renameCollection(id) {
  const col = await db.get('collections', id);
  const name = await modal({
    title: 'Sammlung umbenennen',
    body: `<div class="field"><label for="col-rename">Name</label><input type="text" id="col-rename" value="${esc(col.name)}" autocomplete="off"></div>`,
    actions: [{ label: 'Abbrechen' }, { label: 'Speichern', kind: 'primary', onClick: w => w.querySelector('#col-rename').value }],
    onMount: w => { const i = w.querySelector('#col-rename'); i.select(); i.addEventListener('keydown', e => { if (e.key === 'Enter') w.querySelector('.actions .primary').click(); }); },
  });
  if (name === undefined || !name.trim()) return;
  await store.renameCollection(id, name);
  toast('Name gespeichert');
  render();
}

async function deleteCollection(id) {
  const col = await db.get('collections', id);
  const n = await db.countOf(id);
  const ok = await modal({
    title: 'Sammlung löschen?',
    body: `<p><b>„${esc(col.name)}“</b> mit ${plural(n, 'Bild', 'Bildern')} wird von diesem iPad gelöscht. Die Bilder in OneDrive bleiben erhalten.</p>`,
    actions: [{ label: 'Abbrechen' }, { label: 'Löschen', kind: 'danger', value: true }],
  });
  if (!ok) return;
  await db.deleteCollection(id);
  toast('Sammlung gelöscht');
  go({ name: 'home' });
}

/* ---------- Spiel starten ---------- */
async function startDialog(id) {
  const col = await db.get('collections', id);
  const settings = await db.getSettings();
  let mode = settings.revealMode;
  const ok = await modal({
    title: 'Spiel starten',
    wide: true,
    body: `<div style="display:flex;flex-direction:column;gap:18px">
      <p class="muted">${esc(col.name)} · ${plural(await db.countOf(id), 'Bild', 'Bilder')}</p>
      <div class="field"><label id="mode-label">Aufdecken</label>
        <div class="seg" role="radiogroup" aria-labelledby="mode-label">
          <button type="button" role="radio" data-mode="rand" aria-checked="${mode === 'rand'}"><b>Zufällig</b><span>Jeder Tipp deckt irgendeine Wabe auf.</span></button>
          <button type="button" role="radio" data-mode="tap" aria-checked="${mode === 'tap'}"><b>Gezielt</b><span>Es verschwindet genau die Wabe, die ihr antippt.</span></button>
        </div>
      </div>
      <dl class="gestures">
        <dt>Tippen</dt><dd>Startbild → erstes Bild, danach eine Wabe aufdecken</dd>
        <dt>1 Sek. halten</dt><dd>ganzes Bild aufdecken</dd>
        <dt>Nach links wischen</dt><dd>nächstes Bild (wenn ganz aufgedeckt)</dd>
        <dt>Nach rechts wischen</dt><dd>vorheriges Bild</dd>
        <dt>2 Finger 2 Sek. halten</dt><dd>Spiel beenden → Abschlussbild, dort nochmal → zurück ins Menü</dd>
      </dl></div>`,
    actions: [{ label: 'Abbrechen' }, { label: 'Los geht’s', kind: 'primary big', onClick: () => { requestFullscreen(); return true; } }],
    onMount: w => w.querySelectorAll('[data-mode]').forEach(b => b.addEventListener('click', () => {
      mode = b.dataset.mode;
      w.querySelectorAll('[data-mode]').forEach(x => x.setAttribute('aria-checked', x === b));
    })),
  });
  if (!ok) return;
  await db.saveSettings({ revealMode: mode });
  const images = await db.imagesOf(id);
  game = new Game($game, {
    images, mode, outroText: settings.outroText,
    onExit: () => { game = null; render(); },
  });
  await game.start();
}

/* ---------- Ausschnitt ---------- */
async function cropEditor(imageId) {
  const rec = await db.get('images', imageId);
  const img = await loadImage(rec.blob);
  let crop = { cx: rec.cx, cy: rec.cy, zoom: rec.zoom || 1 };
  const wrap = document.createElement('div');
  wrap.className = 'crop-wrap';
  wrap.innerHTML = `
    <div class="crop-top"><h2>${esc(rec.name)}</h2><span class="muted small">Ausschnitt mit dem Finger verschieben</span></div>
    <div class="crop-area"><canvas aria-label="Bildausschnitt"></canvas></div>
    <div class="crop-bottom">
      <label class="zoom" for="crop-zoom">Zoom <input type="range" id="crop-zoom" min="1" max="3" step="0.01" value="${crop.zoom}"></label>
      <div class="actions" style="display:flex;gap:10px;flex-wrap:wrap">
        <button type="button" class="btn" data-a="reset">Zurücksetzen</button>
        <button type="button" class="btn" data-a="cancel">Abbrechen</button>
        <button type="button" class="btn primary" data-a="save">Speichern</button>
      </div>
    </div>`;
  document.body.appendChild(wrap);
  const area = wrap.querySelector('.crop-area'), cv = area.querySelector('canvas'), ctx = cv.getContext('2d');
  const zoom = wrap.querySelector('#crop-zoom');
  let geo = null;
  const W = rec.w, H = rec.h;
  function clamp() {
    const r = cropRect(W, H, TARGET_ASPECT, crop);
    crop.cx = (r.x + r.w / 2) / W; crop.cy = (r.y + r.h / 2) / H;
    return r;
  }
  function draw() {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const cw = area.clientWidth, ch = area.clientHeight;
    cv.width = cw * dpr; cv.height = ch * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const pad = 24, s = Math.min((cw - 2 * pad) / W, (ch - 2 * pad) / H);
    const ox = (cw - W * s) / 2, oy = (ch - H * s) / 2;
    geo = { s, ox, oy };
    ctx.clearRect(0, 0, cw, ch);
    ctx.drawImage(img, ox, oy, W * s, H * s);
    const r = clamp();
    const rx = ox + r.x * s, ry = oy + r.y * s, rw = r.w * s, rh = r.h * s;
    ctx.fillStyle = 'rgba(0,0,0,.62)';
    ctx.beginPath(); ctx.rect(ox, oy, W * s, H * s); ctx.rect(rx, ry, rw, rh); ctx.fill('evenodd');
    ctx.strokeStyle = '#e9a23b'; ctx.lineWidth = 2; ctx.strokeRect(rx, ry, rw, rh);
  }
  let drag = null;
  cv.addEventListener('pointerdown', e => { cv.setPointerCapture(e.pointerId); drag = { x: e.clientX, y: e.clientY, cx: crop.cx, cy: crop.cy }; });
  cv.addEventListener('pointermove', e => {
    if (!drag) return;
    crop.cx = drag.cx + (e.clientX - drag.x) / geo.s / W;
    crop.cy = drag.cy + (e.clientY - drag.y) / geo.s / H;
    draw();
  });
  const end = () => { drag = null; };
  cv.addEventListener('pointerup', end); cv.addEventListener('pointercancel', end);
  zoom.addEventListener('input', () => { crop.zoom = +zoom.value; draw(); });
  const onResize = () => draw();
  window.addEventListener('resize', onResize);
  const close = () => { window.removeEventListener('resize', onResize); wrap.remove(); };
  wrap.querySelector('[data-a="reset"]').addEventListener('click', () => { crop = defaultCrop(W, H); zoom.value = 1; draw(); });
  wrap.querySelector('[data-a="cancel"]').addEventListener('click', close);
  wrap.querySelector('[data-a="save"]').addEventListener('click', async () => {
    clamp();
    await store.saveCrop(rec, crop);
    close();
    toast('Ausschnitt gespeichert');
    render();
  });
  requestAnimationFrame(draw);
}

/* ---------- Einstellungen & Sicherung ---------- */
async function settingsDialog() {
  const s = await db.getSettings();
  let used = '';
  try { const est = await navigator.storage.estimate(); used = fmtMB(est.usage || 0); } catch (e) { used = 'unbekannt'; }
  const offline = !!(navigator.serviceWorker && navigator.serviceWorker.controller);
  await modal({
    title: 'Einstellungen',
    wide: true,
    body: `<div style="display:flex;flex-direction:column;gap:18px">
      <div class="section">
        <div class="field"><label for="outro-text">Text auf dem Abschlussbild</label>
          <input type="text" id="outro-text" value="${esc(s.outroText)}" placeholder="leer lassen = nur Logo" autocomplete="off"></div>
      </div>
      <div class="section">
        <h2>Sicherung</h2>
        <p class="muted small">Speichert alle Sammlungen mit Reihenfolge und Ausschnitten als eine Datei, z. B. in OneDrive. Damit lässt sich alles auf einem anderen iPad wiederherstellen.</p>
        <div style="display:flex;gap:10px;flex-wrap:wrap">
          <button type="button" class="btn" data-a="backup">Sicherung erstellen</button>
          <button type="button" class="btn" data-a="restore">Sicherung laden</button>
        </div>
      </div>
      <div class="section">
        <h2>Bedienung im Spiel</h2>
        <dl class="gestures">
          <dt>Tippen</dt><dd>Startbild → erstes Bild, danach eine Wabe aufdecken</dd>
          <dt>1 Sek. halten</dt><dd>ganzes Bild aufdecken</dd>
          <dt>Nach links wischen</dt><dd>nächstes Bild (wenn ganz aufgedeckt)</dd>
          <dt>Nach rechts wischen</dt><dd>vorheriges Bild</dd>
          <dt>2 Finger 2 Sek. halten</dt><dd>Abschlussbild, dort nochmal → Menü</dd>
          <dt>Am Computer</dt><dd>Leertaste = Wabe, A = alles, Pfeiltasten = weiter/zurück, E = Ende</dd>
        </dl>
      </div>
      <div class="section">
        <p class="small">Offline-Betrieb: <b>${offline ? 'bereit' : 'noch nicht bereit'}</b>${offline ? '' : ' <span class="muted">(App einmal mit Internet vom Home-Bildschirm öffnen)</span>'}</p>
        <p class="small muted">Belegter Speicher: ${used} · Version ${APP_VERSION}</p>
      </div></div>`,
    actions: [{ label: 'Fertig', kind: 'primary', onClick: w => w.querySelector('#outro-text').value }],
    onMount: (w, close) => {
      const input = w.querySelector('#outro-text');
      const save = async () => { await db.saveSettings({ outroText: input.value.trim() }); };
      input.addEventListener('change', save);
      w.querySelector('[data-a="backup"]').addEventListener('click', async () => { await save(); close(); makeBackup(); });
      w.querySelector('[data-a="restore"]').addEventListener('click', async () => {
        await save();
        const files = pickFiles($fileBackup);
        close();
        const [file] = await files;
        if (file) loadBackup(file);
      });
    },
  }).then(async v => { if (typeof v === 'string') { await db.saveSettings({ outroText: v.trim() }); } });
}

async function makeBackup() {
  const pd = progressDialog('Sicherung wird erstellt');
  let res;
  try {
    res = await store.createBackup((i, n) => pd.update(i, n, `Bild ${i + 1} von ${n}`));
  } catch (e) {
    pd.close();
    return modal({ title: 'Sicherung fehlgeschlagen', body: `<p>${esc(e.message || e)}</p>`, actions: [{ label: 'OK', kind: 'primary' }] });
  }
  pd.close();
  const file = new File([res.blob], res.filename, { type: 'application/zip' });
  await modal({
    title: 'Sicherung ist bereit',
    body: `<p>${plural(res.collections, 'Sammlung', 'Sammlungen')} · ${plural(res.images, 'Bild', 'Bilder')} · ${fmtMB(res.blob.size)}</p>
           <p class="muted small">Tippt auf „Sichern“ und wählt dann „In Dateien sichern“ → OneDrive.</p>`,
    actions: [
      { label: 'Schließen' },
      { label: 'Sichern', kind: 'primary', onClick: () => {
        if (navigator.canShare && navigator.canShare({ files: [file] })) {
          navigator.share({ files: [file], title: res.filename }).catch(() => {});
        } else {
          const a = document.createElement('a');
          a.href = URL.createObjectURL(file); a.download = res.filename;
          document.body.appendChild(a); a.click(); a.remove();
          setTimeout(() => URL.revokeObjectURL(a.href), 60000);
        }
        return false;
      } },
    ],
  });
}

async function loadBackup(file) {
  const pd = progressDialog('Sicherung wird gelesen');
  let data;
  try { data = await store.readBackup(file); }
  catch (e) {
    pd.close();
    return modal({ title: 'Sicherung nicht lesbar', body: `<p>${esc(e.message || e)}</p>`, actions: [{ label: 'OK', kind: 'primary' }] });
  }
  pd.close();
  const m = data.manifest, n = m.collections.reduce((s, c) => s + c.images.length, 0);
  const ok = await modal({
    title: 'Sicherung laden?',
    body: `<p>Sicherung vom ${fmtDate(Date.parse(m.created))} mit ${plural(m.collections.length, 'Sammlung', 'Sammlungen')} und ${plural(n, 'Bild', 'Bildern')}.</p>
           <p><b>Alle Sammlungen, die jetzt auf diesem iPad sind, werden dadurch ersetzt.</b></p>`,
    actions: [{ label: 'Abbrechen' }, { label: 'Laden und ersetzen', kind: 'danger', value: true }],
  });
  if (!ok) return;
  const pd2 = progressDialog('Sicherung wird geladen');
  try {
    await store.restoreBackup(data, (i, k) => pd2.update(i, k, `Bild ${i + 1} von ${k}`));
    pd2.close();
    toast('Sicherung geladen');
    go({ name: 'home' });
  } catch (e) {
    pd2.close();
    modal({ title: 'Laden fehlgeschlagen', body: `<p>${esc(e.message || e)}</p>`, actions: [{ label: 'OK', kind: 'primary' }] });
  }
}

/* ---------- Ereignisse ---------- */
document.addEventListener('click', e => {
  const b = e.target.closest('[data-act]');
  if (!b || game) return;
  const id = b.dataset.id;
  switch (b.dataset.act) {
    case 'home': go({ name: 'home' }); break;
    case 'settings': settingsDialog(); break;
    case 'new': newCollection(); break;
    case 'open': go({ name: 'collection', id }); break;
    case 'play': startDialog(route.id); break;
    case 'replace': replaceImages(route.id); break;
    case 'rename': renameCollection(route.id); break;
    case 'delete': deleteCollection(route.id); break;
    case 'crop': cropEditor(id); break;
  }
});

/* ---------- Offline (Service Worker) ---------- */
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.register('sw.js').catch(() => {});
  let pending = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController) return;           // erste Installation: nichts neu laden
    pending = true;
    if (!game) location.reload();         // Update nie mitten im Spiel einspielen
  });
  setInterval(() => { if (pending && !game) location.reload(); }, 5000);
}

render();
