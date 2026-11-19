// Spielbildschirm: Waben-Abdeckung, Gesten, Start- und Abschlussbild.
import { loadImage, drawCropped } from './imaging.js';

const PAPER = '#f2efe6';
const INK = '#26282e';
const COLS = 6;                 // Wabenspalten über die Bildschirmbreite
const LOGO_RATIO = 0.78;        // Logohöhe im Verhältnis zum Wabenradius
const LOGO_ALPHA = 0.8;
const LONG_PRESS_MS = 900;
const TWO_FINGER_MS = 2000;
const TAP_SLOP = 18;            // px Bewegung, die noch als Tippen gilt
const SWIPE_MIN = 70;           // px für Wischen
const FADE_MS = 280;

const reduceMotion = () => window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;

let logoWabe = null;
function getLogo() {
  if (!logoWabe) logoWabe = loadImageUrl('assets/logo-wabe.png');
  return logoWabe;
}
function loadImageUrl(src) {
  return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
}

/* ---------- Wabengitter ---------- */
function hexPoints(cx, cy, r) {
  const a = [];
  for (let k = 0; k < 6; k++) { const t = Math.PI / 3 * k; a.push([cx + r * Math.cos(t), cy + r * Math.sin(t)]); }
  return a;
}
function clippedArea(poly, W, H) {
  const planes = [
    [p => p[0] >= 0, (a, b) => { const t = (0 - a[0]) / (b[0] - a[0]); return [0, a[1] + t * (b[1] - a[1])]; }],
    [p => p[0] <= W, (a, b) => { const t = (W - a[0]) / (b[0] - a[0]); return [W, a[1] + t * (b[1] - a[1])]; }],
    [p => p[1] >= 0, (a, b) => { const t = (0 - a[1]) / (b[1] - a[1]); return [a[0] + t * (b[0] - a[0]), 0]; }],
    [p => p[1] <= H, (a, b) => { const t = (H - a[1]) / (b[1] - a[1]); return [a[0] + t * (b[0] - a[0]), H]; }],
  ];
  let out = poly;
  for (const [inside, cut] of planes) {
    const inp = out; out = [];
    if (!inp.length) break;
    for (let i = 0; i < inp.length; i++) {
      const cur = inp[i], prev = inp[(i + inp.length - 1) % inp.length];
      if (inside(cur)) { if (!inside(prev)) out.push(cut(prev, cur)); out.push(cur); }
      else if (inside(prev)) out.push(cut(prev, cur));
    }
  }
  let A = 0;
  for (let i = 0; i < out.length; i++) { const a = out[i], b = out[(i + 1) % out.length]; A += a[0] * b[1] - b[0] * a[1]; }
  return Math.abs(A) / 2;
}
export function buildGrid(W, H) {
  const r = W / (1.5 * COLS), h = Math.sqrt(3) * r, full = 1.5 * Math.sqrt(3) * r * r;
  const rows = Math.ceil(H / h) + 1;
  const cells = [];
  for (let i = -1; i <= COLS + 1; i++) {
    for (let j = -1; j <= rows; j++) {
      const cx = i * 1.5 * r, cy = j * h + (i % 2 ? h / 2 : 0);
      const pts = hexPoints(cx, cy, r);
      if (clippedArea(pts, W, H) > full * 0.03) {
        const p = new Path2D();
        pts.forEach((q, k) => (k ? p.lineTo(q[0], q[1]) : p.moveTo(q[0], q[1])));
        p.closePath();
        cells.push({ cx, cy, r, path: p });
      }
    }
  }
  return cells;
}

/* ---------- Spiel ---------- */
export class Game {
  constructor(root, { images, mode, outroText, onExit }) {
    this.root = root;
    this.images = images;
    this.mode = mode;               // 'rand' | 'tap'
    this.onExit = onExit;
    this.phase = 'start';           // 'start' | 'play' | 'outro'
    this.idx = 0;
    this.states = new Map();        // Bildindex → Uint8Array (aufgedeckte Waben)
    this.decoded = new Map();       // Bildindex → Image
    this.fading = new Map();        // Wabenindex → Startzeit
    this.pointers = new Map();
    this.anim = 0;

    root.innerHTML = `
      <div class="g-board" data-el="board">
        <canvas class="g-photo" data-el="photo"></canvas>
        <canvas class="g-cover" data-el="cover"></canvas>
      </div>
      <div class="g-stage is-on" data-el="stage">
        <img class="g-logo" src="assets/logo-hoch.png" alt="Time Bandits">
        <p class="g-outro" data-el="outro"></p>
      </div>`;
    this.el = {};
    root.querySelectorAll('[data-el]').forEach(n => (this.el[n.dataset.el] = n));
    this.el.outro.textContent = outroText || '';
    this.pc = this.el.photo.getContext('2d');
    this.cc = this.el.cover.getContext('2d');
    this.coverFull = document.createElement('canvas');

    this._onResize = () => this.layout();
    this._onVis = () => { if (document.visibilityState === 'visible') this.lockScreen(); };
    this._onKey = e => this.onKey(e);
    window.addEventListener('resize', this._onResize);
    document.addEventListener('visibilitychange', this._onVis);
    window.addEventListener('keydown', this._onKey);
    this.bindPointer();
    root.hidden = false;
    document.documentElement.classList.add('in-game');
  }

  async start() {
    this.logo = await getLogo().catch(() => null);
    this.layout();
    this.lockScreen();
    await this.prepare(0);
  }

  /* ----- Bildschirm ----- */
  layout() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const W = Math.round(this.root.clientWidth * dpr), H = Math.round(this.root.clientHeight * dpr);
    if (!W || !H || (W === this.W && H === this.H)) return;
    const prevCount = this.cells ? this.cells.length : 0;
    this.W = W; this.H = H; this.dpr = dpr;
    for (const c of [this.el.photo, this.el.cover, this.coverFull]) { c.width = W; c.height = H; }
    this.cells = buildGrid(W, H);
    if (prevCount && prevCount !== this.cells.length) {
      for (const [k, s] of this.states) {
        const all = s.every(v => v);
        const n = new Uint8Array(this.cells.length);
        if (all) n.fill(1); else s.forEach((v, i) => { if (v && i < n.length) n[i] = 1; });
        this.states.set(k, n);
      }
    }
    this.paintCoverFull();
    if (this.phase === 'play') { this.drawPhoto(); this.composeCover(); }
  }

  paintCoverFull() {
    const x = this.coverFull.getContext('2d');
    x.fillStyle = PAPER;
    x.fillRect(0, 0, this.W, this.H);
    if (this.logo) {
      const r = this.cells[0].r, lh = r * LOGO_RATIO, lw = lh * this.logo.width / this.logo.height;
      x.globalAlpha = LOGO_ALPHA;
      for (const c of this.cells) x.drawImage(this.logo, c.cx - lw / 2, c.cy - lh / 2, lw, lh);
      x.globalAlpha = 1;
    }
    x.strokeStyle = INK;
    x.lineWidth = Math.max(2, this.W / 900);
    for (const c of this.cells) x.stroke(c.path);
  }

  state(i = this.idx) {
    let s = this.states.get(i);
    if (!s || s.length !== this.cells.length) { s = new Uint8Array(this.cells.length); this.states.set(i, s); }
    return s;
  }

  async decode(i) {
    if (i < 0 || i >= this.images.length) return null;
    if (!this.decoded.has(i)) this.decoded.set(i, loadImage(this.images[i].blob));
    try { return await this.decoded.get(i); } catch (e) { return null; }
  }

  async prepare(i) {
    this.current = await this.decode(i);
    // nur das aktuelle, vorige und nächste Bild im Speicher halten
    for (const k of [...this.decoded.keys()]) if (Math.abs(k - i) > 1) this.decoded.delete(k);
    this.decode(i + 1);
  }

  drawPhoto() {
    const ctx = this.pc;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, this.W, this.H);
    if (this.current) {
      ctx.imageSmoothingQuality = 'high';
      drawCropped(ctx, this.current, this.W, this.H, this.images[this.idx]);
    }
  }

  /** Abdeckung neu zusammensetzen: aufgedeckte Waben als Ganzes ausschneiden (keine Restlinien) */
  composeCover(now = performance.now()) {
    const ctx = this.cc, s = this.state();
    ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, this.W, this.H);
    ctx.drawImage(this.coverFull, 0, 0);
    const holes = new Path2D();
    let any = false;
    s.forEach((v, i) => { if (v) { holes.addPath(this.cells[i].path); any = true; } });
    if (any) { ctx.save(); ctx.clip(holes); ctx.clearRect(0, 0, this.W, this.H); ctx.restore(); }
    let busy = false;
    for (const [i, t0] of this.fading) {
      const a = 1 - (now - t0) / FADE_MS;
      if (a <= 0) { this.fading.delete(i); continue; }
      busy = true;
      const c = this.cells[i];
      ctx.save(); ctx.clip(c.path); ctx.globalAlpha = a;
      const b = c.r + 4;
      ctx.drawImage(this.coverFull, c.cx - b, c.cy - b, 2 * b, 2 * b, c.cx - b, c.cy - b, 2 * b, 2 * b);
      ctx.restore();
    }
    return busy;
  }

  animate() {
    if (this.anim) return;
    const step = now => {
      this.anim = 0;
      if (this.composeCover(now)) this.anim = requestAnimationFrame(step);
    };
    this.anim = requestAnimationFrame(step);
  }

  reveal(indices) {
    const s = this.state(), now = performance.now(), fade = !reduceMotion();
    indices.forEach(i => { if (!s[i]) { s[i] = 1; if (fade) this.fading.set(i, now); } });
    if (fade) this.animate(); else this.composeCover();
  }
  revealRandom() {
    const s = this.state(), open = [];
    s.forEach((v, i) => { if (!v) open.push(i); });
    if (open.length) this.reveal([open[Math.floor(Math.random() * open.length)]]);
  }
  revealAt(clientX, clientY) {
    const rect = this.el.cover.getBoundingClientRect();
    const x = (clientX - rect.left) / rect.width * this.W, y = (clientY - rect.top) / rect.height * this.H;
    const s = this.state();
    const hit = this.cells.findIndex((c, i) => !s[i] && this.cc.isPointInPath(c.path, x, y));
    if (hit >= 0) this.reveal([hit]);
  }
  revealAll() {
    const s = this.state(), open = [];
    s.forEach((v, i) => { if (!v) open.push(i); });
    if (open.length) this.reveal(open);
  }
  allRevealed() { return this.state().every(v => v); }

  /* ----- Ablauf ----- */
  async show(i) {
    const board = this.el.board;
    board.classList.add('is-dim');
    await wait(reduceMotion() ? 0 : 140);
    this.idx = i;
    this.fading.clear();
    this.state(i);
    await this.prepare(i);
    this.composeCover();           // erst abdecken …
    this.drawPhoto();              // … dann das Foto darunter zeichnen
    board.classList.remove('is-dim');
  }

  async beginPlay() {
    this.phase = 'play';
    this.idx = 0;
    this.state(0);
    this.composeCover();
    this.drawPhoto();
    this.el.stage.classList.remove('is-on', 'is-outro');
  }

  showOutro() {
    this.phase = 'outro';
    this.el.stage.classList.add('is-on', 'is-outro');
  }

  next() {
    if (!this.allRevealed()) return;
    if (this.idx + 1 < this.images.length) this.show(this.idx + 1);
    else this.showOutro();
  }
  prev() {
    if (this.idx > 0) this.show(this.idx - 1);
  }

  /* ----- Gesten ----- */
  bindPointer() {
    const r = this.root;
    const g = this.gesture = { mode: null, long: null, two: null, fired: false };
    const reset = () => {
      clearTimeout(g.long); clearTimeout(g.two);
      g.mode = null; g.fired = false;
    };
    this._down = e => {
      e.preventDefault();
      this.pointers.set(e.pointerId, { x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, t0: performance.now() });
      if (this.pointers.size === 1) {
        g.mode = 'one'; g.fired = false;
        clearTimeout(g.long);
        g.long = setTimeout(() => {
          const p = [...this.pointers.values()][0];
          if (g.mode === 'one' && p && Math.hypot(p.x - p.x0, p.y - p.y0) < TAP_SLOP) {
            g.fired = true;
            if (this.phase === 'play') this.revealAll();
          }
        }, LONG_PRESS_MS);
      } else if (this.pointers.size === 2) {
        clearTimeout(g.long);
        g.mode = 'two'; g.fired = false;
        clearTimeout(g.two);
        g.two = setTimeout(() => {
          if (g.mode !== 'two' || this.pointers.size !== 2) return;
          g.fired = true;
          if (this.phase === 'outro') this.exit(); else this.showOutro();
        }, TWO_FINGER_MS);
      } else {
        clearTimeout(g.long); clearTimeout(g.two); g.mode = 'cancel';
      }
    };
    this._move = e => {
      const p = this.pointers.get(e.pointerId);
      if (!p) return;
      p.x = e.clientX; p.y = e.clientY;
      const d = Math.hypot(p.x - p.x0, p.y - p.y0);
      if (g.mode === 'one' && d > TAP_SLOP) clearTimeout(g.long);
      if (g.mode === 'two' && d > 40) { clearTimeout(g.two); g.mode = 'cancel'; }
    };
    this._up = e => {
      const p = this.pointers.get(e.pointerId);
      this.pointers.delete(e.pointerId);
      if (!p) return;
      if (g.mode === 'one' && !g.fired) {
        clearTimeout(g.long);
        const dx = p.x - p.x0, dy = p.y - p.y0, dt = performance.now() - p.t0;
        if (Math.abs(dx) > SWIPE_MIN && Math.abs(dx) > 1.5 * Math.abs(dy) && dt < 900) {
          if (this.phase === 'play') (dx < 0 ? this.next() : this.prev());
        } else if (Math.hypot(dx, dy) < TAP_SLOP && dt < LONG_PRESS_MS) {
          this.tap(p.x, p.y);
        }
      }
      if (g.mode === 'two') { clearTimeout(g.two); g.mode = 'cancel'; }
      if (this.pointers.size === 0) reset();
    };
    this._cancel = e => { this.pointers.delete(e.pointerId); if (this.pointers.size === 0) reset(); else g.mode = 'cancel'; };
    r.addEventListener('pointerdown', this._down);
    r.addEventListener('pointermove', this._move);
    r.addEventListener('pointerup', this._up);
    r.addEventListener('pointercancel', this._cancel);
    this._noop = e => e.preventDefault();
    r.addEventListener('contextmenu', this._noop);
    r.addEventListener('gesturestart', this._noop);
    r.addEventListener('touchmove', this._noop, { passive: false });
  }

  tap(x, y) {
    if (this.phase === 'start') this.beginPlay();
    else if (this.phase === 'play') (this.mode === 'tap' ? this.revealAt(x, y) : this.revealRandom());
  }

  // Tastatur (z. B. am Mac): Leertaste = Teil, A = alles, Pfeile = weiter/zurück, E = Ende
  onKey(e) {
    if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); this.tap(innerWidth / 2, innerHeight / 2); }
    else if ((e.key === 'a' || e.key === 'A') && this.phase === 'play') this.revealAll();
    else if (e.key === 'ArrowRight' && this.phase === 'play') this.next();
    else if (e.key === 'ArrowLeft' && this.phase === 'play') this.prev();
    else if (e.key === 'e' || e.key === 'E' || e.key === 'Escape') (this.phase === 'outro' ? this.exit() : this.showOutro());
  }

  async lockScreen() {
    try {
      if ('wakeLock' in navigator && document.visibilityState === 'visible') this.wake = await navigator.wakeLock.request('screen');
    } catch (e) { /* nicht verfügbar */ }
  }

  exit() {
    cancelAnimationFrame(this.anim);
    try { this.wake && this.wake.release(); } catch (e) { /* egal */ }
    try { if (document.fullscreenElement) document.exitFullscreen(); else if (document.webkitFullscreenElement) document.webkitExitFullscreen(); } catch (e) { /* egal */ }
    window.removeEventListener('resize', this._onResize);
    document.removeEventListener('visibilitychange', this._onVis);
    window.removeEventListener('keydown', this._onKey);
    const r = this.root;
    ['pointerdown', 'pointermove', 'pointerup', 'pointercancel'].forEach((t, k) =>
      r.removeEventListener(t, [this._down, this._move, this._up, this._cancel][k]));
    r.removeEventListener('contextmenu', this._noop);
    r.removeEventListener('gesturestart', this._noop);
    r.removeEventListener('touchmove', this._noop);
    this.decoded.clear();
    r.hidden = true;
    r.innerHTML = '';
    document.documentElement.classList.remove('in-game');
    this.onExit && this.onExit();
  }
}

function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

export function requestFullscreen() {
  const el = document.documentElement;
  try {
    const p = el.requestFullscreen ? el.requestFullscreen({ navigationUI: 'hide' }) : el.webkitRequestFullscreen && el.webkitRequestFullscreen();
    if (p && p.catch) p.catch(() => {});
  } catch (e) { /* nicht verfügbar, z. B. als Home-Bildschirm-App ohnehin Vollbild */ }
}
