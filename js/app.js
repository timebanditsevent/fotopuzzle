// Foto Puzzle – Spielleiter-Oberfläche
import * as db from './db.js';
import * as store from './store.js';
import { Game, requestFullscreen, buildGrid, paintWaben, loadImageUrl, defaultStageLogo, defaultWabenLogo } from './game.js';
import { TARGET_ASPECT, cropRect, defaultCrop, loadImage, processLogo } from './imaging.js';

export const APP_VERSION = '1.3.0';

const $view = document.getElementById('view');
const $modalRoot = document.getElementById('modal-root');
const $game = document.getElementById('game');
const $toast = document.getElementById('toast');
const $fileImages = document.getElementById('file-images');
const $fileBackup = document.getElementById('file-backup');
const $fileLogo = document.getElementById('file-logo');

let objectUrls = [];
let route = { name: 'home' };
let game = null;
let selecting = false;          // Auswahlmodus in der Sammlung
let sorting = false;            // Sortiermodus in der Sammlung
const selected = new Set();

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
  if (false && report.unnumbered.length) parts.push(`<p><b>${plural(report.unnumbered.length, 'Bild hat', 'Bilder haben')} keine Nummer</b> am Anfang des Dateinamens und ${report.unnumbered.length === 1 ? 'steht' : 'stehen'} deshalb am Ende:</p><ul class="list-small">${report.unnumbered.map(n => `<li>${esc(n)}</li>`).join('')}</ul>`);
  if (report.lowRes.length) parts.push(`<p><b>${plural(report.lowRes.length, 'Bild hat', 'Bilder haben')} eine geringe Auflösung</b> und ${report.lowRes.length === 1 ? 'wirkt' : 'wirken'} auf der Leinwand eventuell unscharf:</p><ul class="list-small">${report.lowRes.map(n => `<li>${esc(n)}</li>`).join('')}</ul>`);
  if (!parts.length) return;
  await modal({ title: 'Hinweise zum Import', body: `<div style="display:flex;flex-direction:column;gap:12px">${parts.join('')}</div>`, actions: [{ label: 'Verstanden', kind: 'primary' }] });
}

/* ---------- Ansichten ---------- */
async function render() {
  freeUrls();
  $view.classList.remove('is-selecting', 'is-sorting');
  if (route.name === 'collection') await renderCollection(route.id);
  else await renderHome();
  $view.focus({ preventScroll: true });
}
function go(r) { route = r; selecting = false; sorting = false; selected.clear(); window.scrollTo(0, 0); render(); }

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
          <li>Optional: Bilder vorne nummerieren, z.&nbsp;B. <code>1 Obama.jpg</code>. Dann stimmt die Reihenfolge gleich beim Import. Die Nummer wird im Namen weggelassen.</li>
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
  for (const sid of [...selected]) if (!imgs.some(r => r.id === sid)) selected.delete(sid);
  $view.classList.toggle('is-selecting', selecting);
  $view.classList.toggle('is-sorting', sorting);
  const logoInfo = { standard: 'Standard-Logo', all: 'eigenes Logo', each: 'eigene Logos' }[(col.logoMode || (col.logo ? 'all' : 'standard'))];
  $view.innerHTML = `
    <div><button type="button" class="link" data-act="home">‹ Alle Sammlungen</button></div>
    <div class="col-head">
      <div>
        <h1>${esc(col.name)}</h1>
        <p class="meta">${plural(imgs.length, 'Bild', 'Bilder')} · ${logoInfo}</p>
      </div>
      <button type="button" class="btn primary big" data-act="play" ${imgs.length ? '' : 'disabled'}>Spiel starten</button>
    </div>
    <div class="tools">
      <button type="button" class="btn" data-act="add">+ Bilder hinzufügen</button>
      <button type="button" class="btn" data-act="sort" ${imgs.length > 1 ? '' : 'disabled'}>${sorting ? 'Sortieren beenden' : 'Sortieren'}</button>
      <button type="button" class="btn" data-act="select" ${imgs.length ? '' : 'disabled'}>${selecting ? 'Auswahl beenden' : 'Auswählen'}</button>
      <button type="button" class="btn" data-act="logo">Logo</button>
      <button type="button" class="btn" data-act="rename">Umbenennen</button>
      <button type="button" class="btn danger-ghost" data-act="delete">Sammlung löschen</button>
    </div>
    ${low ? `<div class="notice"><span><b>${plural(low, 'Bild hat', 'Bilder haben')} eine geringe Auflösung.</b> ${low === 1 ? 'Es ist' : 'Sie sind'} markiert und ${low === 1 ? 'kann' : 'können'} auf der Leinwand unscharf wirken.</span></div>` : ''}
    <ol class="grid">
      ${imgs.map((r, i) => `
        <li><button type="button" class="thumb${selected.has(r.id) ? ' is-selected' : ''}" data-act="crop" data-id="${esc(r.id)}" aria-pressed="${selected.has(r.id)}" aria-label="${esc(r.name)}">
          <span class="thumb-img"><img src="${url(r.thumb)}" alt="" loading="lazy"><span class="num">${i + 1}</span><span class="check" aria-hidden="true"></span>${r.lowRes ? '<span class="warn-chip">Geringe Auflösung</span>' : ''}</span>
          <span class="thumb-name">${esc(r.name)}</span>
        </button></li>`).join('')}
    </ol>
    <p class="hint">${selecting ? 'Bilder antippen, um sie auszuwählen.' : sorting ? 'Bild mit dem Finger an die gewünschte Stelle ziehen.' : 'Bild antippen, um Namen oder Ausschnitt zu ändern. Neue Bilder kommen ans Ende.'}</p>
    ${selecting ? `<div class="selectbar" role="toolbar" aria-label="Auswahl">
      <span><b data-sel-count>0</b> ausgewählt</span>
      <div class="row">
        <button type="button" class="btn" data-act="sel-all">Alle</button>
        <button type="button" class="btn" data-act="sel-replace">Ersetzen</button>
        <button type="button" class="btn danger" data-act="sel-delete">Löschen</button>
        <button type="button" class="btn primary" data-act="select">Fertig</button>
      </div></div>` : ''}
    ${sorting ? `<div class="selectbar" role="toolbar" aria-label="Sortieren">
      <span>Bilder ziehen zum Sortieren</span>
      <div class="row"><button type="button" class="btn primary" data-act="sort">Fertig</button></div></div>` : ''}`;
  updateSelectBar();
  if (sorting) bindSorting(id);
}

function updateSelectBar() {
  const c = $view.querySelector('[data-sel-count]');
  if (!c) return;
  c.textContent = selected.size;
  $view.querySelector('[data-act="sel-replace"]').disabled = selected.size !== 1;
  $view.querySelector('[data-act="sel-delete"]').disabled = selected.size === 0;
  const all = $view.querySelectorAll('.thumb').length;
  $view.querySelector('[data-act="sel-all"]').textContent = selected.size === all && all ? 'Keine' : 'Alle';
}

/** Sortieren: Bild festhalten und ziehen. Gespeichert wird beim Loslassen. */
function bindSorting(collectionId) {
  const grid = $view.querySelector('.grid');
  if (!grid) return;
  let drag = null, timer = 0;
  const renumber = () => grid.querySelectorAll('.num').forEach((n, i) => { n.textContent = i + 1; });
  const place = () => {
    if (!drag) return;
    drag.ghost.style.left = (drag.x - drag.dx) + 'px';
    drag.ghost.style.top = (drag.y - drag.dy) + 'px';
    for (const n of grid.children) {
      if (n === drag.li) continue;
      const b = n.getBoundingClientRect();
      if (drag.x >= b.left && drag.x <= b.right && drag.y >= b.top && drag.y <= b.bottom) {
        const after = drag.x > b.left + b.width / 2;
        const ref = after ? n.nextSibling : n;
        if (ref !== drag.li && ref !== drag.li.nextSibling) { grid.insertBefore(drag.li, ref); renumber(); }
        break;
      }
    }
  };
  grid.addEventListener('pointerdown', e => {
    const li = e.target.closest('li');
    if (!li || drag) return;
    e.preventDefault();
    const b = li.getBoundingClientRect();
    const ghost = li.cloneNode(true);
    ghost.className = 'drag-ghost';
    ghost.style.width = b.width + 'px';
    document.body.appendChild(ghost);
    li.classList.add('drag-src');
    drag = { li, ghost, id: e.pointerId, dx: e.clientX - b.left, dy: e.clientY - b.top, x: e.clientX, y: e.clientY, from: [...grid.children].indexOf(li) };
    try { grid.setPointerCapture(e.pointerId); } catch (err) { /* egal */ }
    place();
    timer = setInterval(() => {          // automatisch scrollen am oberen/unteren Rand
      if (!drag) return;
      if (drag.y < 110) { window.scrollBy(0, -14); place(); }
      else if (drag.y > innerHeight - 130) { window.scrollBy(0, 14); place(); }
    }, 30);
  });
  grid.addEventListener('pointermove', e => {
    if (!drag || e.pointerId !== drag.id) return;
    drag.x = e.clientX; drag.y = e.clientY;
    place();
  });
  const end = async e => {
    if (!drag || e.pointerId !== drag.id) return;
    clearInterval(timer);
    drag.ghost.remove();
    drag.li.classList.remove('drag-src');
    const moved = [...grid.children].indexOf(drag.li) !== drag.from;
    drag = null;
    if (moved) {
      await store.reorder(collectionId, [...grid.querySelectorAll('.thumb')].map(t => t.dataset.id));
      toast('Reihenfolge gespeichert');
    }
  };
  grid.addEventListener('pointerup', end);
  grid.addEventListener('pointercancel', end);
}

function toggleSelect(btn) {
  const id = btn.dataset.id;
  if (selected.has(id)) selected.delete(id); else selected.add(id);
  btn.classList.toggle('is-selected', selected.has(id));
  btn.setAttribute('aria-pressed', selected.has(id));
  updateSelectBar();
}
function selectAll() {
  const btns = [...$view.querySelectorAll('.thumb')];
  const all = selected.size === btns.length;
  selected.clear();
  btns.forEach(b => { if (!all) selected.add(b.dataset.id); b.classList.toggle('is-selected', !all); b.setAttribute('aria-pressed', !all); });
  updateSelectBar();
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

async function addImagesFlow(id) {
  const files = pickFiles($fileImages);   // direkt aus dem Tipp heraus öffnen
  const list = await files;
  if (!list.length) return;
  const pd = progressDialog('Bilder werden hinzugefügt');
  try {
    const report = await store.addImages(id, list, (i, n) => pd.update(i, n, `Bild ${Math.min(i + 1, n)} von ${n} wird vorbereitet …`));
    pd.close();
    if (report.added.length) toast(`${plural(report.added.length, 'Bild', 'Bilder')} hinzugefügt`);
    await render();
    await importReport(report);
  } catch (e) {
    pd.close();
    modal({ title: 'Hinzufügen fehlgeschlagen', body: `<p>${esc(e.message || e)}</p>`, actions: [{ label: 'OK', kind: 'primary' }] });
  }
}

async function deleteSelected(id) {
  const n = selected.size;
  if (!n) return;
  const ok = await modal({
    title: n === 1 ? 'Bild löschen?' : `${n} Bilder löschen?`,
    body: `<p>${n === 1 ? 'Das ausgewählte Bild wird' : `Die ${n} ausgewählten Bilder werden`} aus dieser Sammlung gelöscht. In OneDrive bleiben sie erhalten.</p>`,
    actions: [{ label: 'Abbrechen' }, { label: 'Löschen', kind: 'danger', value: true }],
  });
  if (!ok) return;
  await store.deleteImages(id, [...selected]);
  selected.clear();
  toast(n === 1 ? 'Bild gelöscht' : `${n} Bilder gelöscht`);
  render();
}

async function replaceSelected(id) {
  if (selected.size !== 1) return;
  const imageId = [...selected][0];
  const files = pickFiles($fileImages);   // direkt aus dem Tipp heraus öffnen
  const [file] = await files;
  if (!file) return;
  const pd = progressDialog('Bild wird ersetzt');
  try {
    const res = await store.replaceOne(id, imageId, file);
    pd.close();
    selected.clear();
    toast('Bild ersetzt');
    await render();
    if (res.lowRes) await importReport({ failed: [], unnumbered: [], lowRes: [file.name] });
  } catch (e) {
    pd.close();
    modal({ title: 'Ersetzen fehlgeschlagen', body: `<p>Die Datei „${esc(file.name)}“ konnte nicht gelesen werden.</p>`, actions: [{ label: 'OK', kind: 'primary' }] });
  }
}

/* ---------- Duplizieren ---------- */
async function duplicateCollection(id) {
  const pd = progressDialog('Sammlung wird dupliziert');
  try {
    const copy = await store.duplicateCollection(id);
    pd.close();
    toast(`„${copy.name}“ angelegt`);
    render();
  } catch (e) {
    pd.close();
    modal({ title: 'Duplizieren fehlgeschlagen', body: `<p>${esc(e.message || e)}</p><p class="muted small">Prüft, ob genug Speicher auf dem iPad frei ist.</p>`, actions: [{ label: 'OK', kind: 'primary' }] });
  }
}

/* ---------- Logo ---------- */
const SLOT_LABEL = { Start: 'Startbild', End: 'Abschlussbild', Waben: 'Waben' };

function slotHtml(key, title, resetLabel) {
  const stage = key !== 'Waben', hex = key === 'Waben' || key === 'all';
  return `
    <div class="slot" data-slot="${key}">
      <div class="slot-prev">
        ${stage ? '<div class="logo-preview" data-stage><img alt=""><span data-text></span></div>' : ''}
        ${hex ? '<canvas class="hex-preview" width="432" height="300" aria-label="Vorschau Waben"></canvas>' : ''}
      </div>
      <div class="slot-ctl">
        ${title ? `<h3>${title}</h3>` : ''}
        <p class="muted small" data-std hidden>Standard-Logo</p>
        <div class="row">
          <button type="button" class="btn" data-pick>Logo wählen …</button>
          <button type="button" class="btn" data-clear>${resetLabel}</button>
        </div>
        <div class="seg small" role="radiogroup" aria-label="Hintergrund" data-bgseg>
          <button type="button" role="radio" data-bg="light"><b>Hell</b><span>für dunkle Logos</span></button>
          <button type="button" role="radio" data-bg="dark"><b>Dunkel</b><span>für helle Logos</span></button>
        </div>
      </div>
    </div>`;
}

/** scope 'settings': Standard-Logo für alles · scope 'collection': Logos einer Sammlung */
async function logoDialog(scope, col) {
  const s = await db.getSettings();
  const std = { logo: s.logo || null, bg: s.logoBg || 'dark' };
  let mode = 'all';
  const slots = { all: { ...std } };
  if (scope === 'collection') {
    mode = col.logoMode || (col.logo ? 'all' : 'standard');
    slots.all = { logo: col.logo || null, bg: col.logoBg || 'light' };
    for (const k of store.LOGO_SLOTS) slots[k] = { logo: col['logo' + k] || null, bg: col['logo' + k + 'Bg'] || 'light' };
  }
  const resetLabel = scope === 'settings' ? 'Time-Bandits-Logo' : 'Standard verwenden';
  const result = await modal({
    title: scope === 'settings' ? 'Standard-Logo' : `Logo für „${col.name}“`,
    wide: true,
    body: `<div class="logo-dialog">
      ${scope === 'collection' ? `
        <div class="seg three" role="radiogroup" aria-label="Logo">
          <button type="button" role="radio" data-mode="standard"><b>Standard</b><span>Logo aus den Einstellungen</span></button>
          <button type="button" role="radio" data-mode="all"><b>Ein Logo für alles</b><span>Startbild, Abschluss, Waben</span></button>
          <button type="button" role="radio" data-mode="each"><b>Einzeln</b><span>pro Bereich festlegen</span></button>
        </div>
        <p class="muted small" data-pane="standard">Diese Sammlung nutzt das Standard-Logo aus den Einstellungen, auf Startbild, Abschlussbild und Waben.</p>` : `
        <p class="muted small">Gilt für Startbild, Abschlussbild und Waben aller Sammlungen ohne eigenes Logo.</p>`}
      <div data-pane="all">${slotHtml('all', '', resetLabel)}</div>
      ${scope === 'collection' ? `<div data-pane="each" class="slots">${store.LOGO_SLOTS.map(k => slotHtml(k, SLOT_LABEL[k], resetLabel)).join('')}</div>` : ''}
      <p class="muted small">Am besten eignet sich ein PNG mit transparentem Hintergrund. Alles funktioniert offline, sobald das Logo auf dem iPad liegt.</p>
    </div>`,
    actions: [{ label: 'Abbrechen' }, { label: 'Speichern', kind: 'primary', onClick: () => true }],
    onMount: w => {
      const imgCache = new Map();
      const shown = key => {
        const sl = slots[key];
        if (sl.logo) return { logo: sl.logo, bg: sl.bg, std: false };
        if (scope === 'settings') return { logo: null, bg: sl.bg, std: false };
        return { logo: std.logo, bg: std.bg, std: true };
      };
      const srcOf = b => { if (!b) return null; if (!imgCache.has(b)) imgCache.set(b, url(b)); return imgCache.get(b); };
      const paintSlot = async el => {
        const key = el.dataset.slot, v = shown(key);
        const st = el.querySelector('[data-stage]');
        if (st) {
          st.querySelector('img').src = srcOf(v.logo) || defaultStageLogo(v.bg === 'dark');
          st.classList.toggle('is-dark', v.bg === 'dark');
          st.querySelector('[data-text]').textContent = key === 'Start' ? '' : (s.outroText || '');
        }
        el.querySelector('[data-std]').hidden = !v.std;
        el.querySelector('[data-bgseg]').hidden = v.std;
        el.querySelector('[data-clear]').hidden = !slots[key].logo;
        el.querySelectorAll('[data-bg]').forEach(b => b.setAttribute('aria-checked', b.dataset.bg === slots[key].bg));
        const cv = el.querySelector('.hex-preview');
        if (cv) {
          const img = await loadImageUrl(srcOf(v.logo) || defaultWabenLogo(v.bg === 'dark')).catch(() => null);
          paintWaben(cv.getContext('2d'), buildGrid(cv.width, cv.height), cv.width, cv.height, img, v.bg === 'dark');
        }
      };
      const paintAll = () => {
        w.querySelectorAll('[data-mode]').forEach(b => b.setAttribute('aria-checked', b.dataset.mode === mode));
        w.querySelectorAll('[data-pane]').forEach(p => { p.hidden = p.dataset.pane !== mode; });
        w.querySelectorAll('.slot').forEach(paintSlot);
      };
      w.querySelectorAll('[data-mode]').forEach(b => b.addEventListener('click', () => { mode = b.dataset.mode; paintAll(); }));
      w.querySelectorAll('.slot').forEach(el => {
        const key = el.dataset.slot;
        el.querySelectorAll('[data-bg]').forEach(b => b.addEventListener('click', () => { slots[key].bg = b.dataset.bg; paintSlot(el); }));
        el.querySelector('[data-clear]').addEventListener('click', () => { slots[key].logo = null; if (scope === 'settings') slots[key].bg = 'dark'; paintSlot(el); });
        el.querySelector('[data-pick]').addEventListener('click', async () => {
          const [file] = await pickFiles($fileLogo);
          if (!file) return;
          try { slots[key].logo = await processLogo(file); paintSlot(el); }
          catch (e) { toast('Diese Datei ist kein lesbares Bild'); }
        });
      });
      paintAll();
    },
  });
  if (!result) return false;
  if (scope === 'settings') {
    await db.saveSettings({ logo: slots.all.logo, logoBg: slots.all.bg });
  } else {
    if (mode === 'all' && !slots.all.logo) mode = 'standard';
    if (mode === 'each' && !store.LOGO_SLOTS.some(k => slots[k].logo)) mode = 'standard';
    const patch = { logoMode: mode, logo: slots.all.logo, logoBg: slots.all.bg };
    for (const k of store.LOGO_SLOTS) { patch['logo' + k] = slots[k].logo; patch['logo' + k + 'Bg'] = slots[k].bg; }
    await store.setCollectionLogos(col.id, patch);
  }
  toast('Logo gespeichert');
  return true;
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
        <dt>2 Finger 1 Sek. halten</dt><dd>Spiel beenden → Abschlussbild</dd>
        <dt>Abschlussbild antippen</dt><dd>Knopf „Zurück ins Menü“ erscheint für 4 Sekunden</dd>
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
  const eff = await store.effectiveLogos(col);
  const made = [], logos = {};
  for (const k of store.LOGO_SLOTS) {
    let src = null;
    if (eff[k].logo) { src = URL.createObjectURL(eff[k].logo); made.push(src); }
    logos[k] = { src, dark: eff[k].bg === 'dark' };
  }
  game = new Game($game, {
    images, mode, outroText: settings.outroText, logos,
    onExit: () => { game = null; made.forEach(u => URL.revokeObjectURL(u)); render(); },
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
    <div class="crop-top"><div class="field name-field"><label for="img-name">Name (nur für euch sichtbar)</label><input type="text" id="img-name" value="${esc(rec.name)}" autocomplete="off"></div><span class="muted small">Ausschnitt mit dem Finger verschieben</span></div>
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
    const name = wrap.querySelector('#img-name').value.trim() || rec.name;
    await store.saveCrop({ ...rec, name }, crop);
    close();
    toast('Gespeichert');
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
        <h2>Standard-Logo</h2>
        <div class="logo-row">
          <div class="logo-preview${s.logoBg !== 'light' ? ' is-dark' : ''}"><img src="${s.logo ? url(s.logo) : defaultStageLogo(s.logoBg !== 'light')}" alt="Standard-Logo"></div>
          <div><p class="muted small">Auf Startbild, Abschlussbild und Waben aller Sammlungen ohne eigenes Logo. Jede Sammlung kann über „Logo“ eigene bekommen.</p>
          <button type="button" class="btn" data-a="logo">Ändern</button></div>
        </div>
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
          <dt>2 Finger 1 Sek. halten</dt><dd>Spiel beenden → Abschlussbild</dd>
          <dt>Abschlussbild antippen</dt><dd>„Zurück ins Menü“ erscheint für 4 Sekunden</dd>
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
      w.querySelector('[data-a="logo"]').addEventListener('click', async () => { await save(); close(); if (await logoDialog('settings')) settingsDialog(); });
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
    case 'add': addImagesFlow(route.id); break;
    case 'select': selecting = !selecting; sorting = false; selected.clear(); render(); break;
    case 'sort': sorting = !sorting; selecting = false; selected.clear(); render(); break;
    case 'sel-all': selectAll(); break;
    case 'sel-delete': deleteSelected(route.id); break;
    case 'sel-replace': replaceSelected(route.id); break;
    case 'logo': db.get('collections', route.id).then(col => logoDialog('collection', col)).then(ch => { if (ch) render(); }); break;
    case 'rename': renameCollection(route.id); break;
    case 'delete': deleteCollection(route.id); break;
    case 'crop': if (sorting) break; if (selecting) toggleSelect(b); else cropEditor(id); break;
  }
});

/* ---------- Übersicht: Sammlung lange antippen → Menü ---------- */
let pressTimer = 0, pressStart = null, suppressClick = false;
async function collectionMenu(id) {
  const col = await db.get('collections', id);
  if (!col) return;
  const act = await modal({
    title: col.name,
    body: `<p class="muted small">${plural(await db.countOf(id), 'Bild', 'Bilder')}</p>`,
    actions: [
      { label: 'Abbrechen' },
      { label: 'Löschen', kind: 'danger-ghost', value: 'delete' },
      { label: 'Duplizieren', value: 'duplicate' },
      { label: 'Umbenennen', kind: 'primary', value: 'rename' },
    ],
  });
  if (act === 'rename') renameCollection(id);
  else if (act === 'duplicate') duplicateCollection(id);
  else if (act === 'delete') deleteCollection(id);
}
$view.addEventListener('pointerdown', e => {
  const card = e.target.closest('.card');
  suppressClick = false;
  if (!card || game) return;
  pressStart = { x: e.clientX, y: e.clientY };
  clearTimeout(pressTimer);
  pressTimer = setTimeout(() => { suppressClick = true; pressStart = null; collectionMenu(card.dataset.id); }, 500);
});
$view.addEventListener('pointermove', e => {
  if (pressStart && Math.hypot(e.clientX - pressStart.x, e.clientY - pressStart.y) > 10) { clearTimeout(pressTimer); pressStart = null; }
});
['pointerup', 'pointercancel'].forEach(t => $view.addEventListener(t, () => { clearTimeout(pressTimer); pressStart = null; }));
$view.addEventListener('contextmenu', e => {           // Rechtsklick am Computer
  const card = e.target.closest('.card');
  if (!card) return;
  e.preventDefault(); clearTimeout(pressTimer);
  collectionMenu(card.dataset.id);
});
$view.addEventListener('click', e => {                 // nach langem Antippen die Sammlung nicht öffnen
  if (suppressClick) { suppressClick = false; e.stopPropagation(); e.preventDefault(); }
}, true);

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

store.migrateNames().then(store.migrateDefaultDark).catch(() => {}).then(render);
