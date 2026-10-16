/**
 * Names, hover and click targets for every live object in the flat world, plus the info card of
 * the selected one — the flat-world counterpart of the globe's labels and tracked readout.
 *
 * Every drawn aircraft, ship and satellite is projected to the screen each frame, so any dot can be
 * hovered or clicked however small it is drawn. Names are placed on a 2D canvas with collision
 * avoidance (most important and nearest first) so they never pile on top of each other.
 */
import * as THREE from 'three';
import { formatFlightLevel } from '../../data/detectionDraw.js';

const KIND_STYLE = {
  flights: { color: '#39e1ff', base: 4 },
  military: { color: '#ffb020', base: 5 },
  vessels: { color: '#5dff8f', base: 4 },
  satellites: { color: '#ff5ad7', base: 3 },
};
const FONT = '600 11px "SF Mono", ui-monospace, Menlo, Consolas, monospace';
const LAYOUT_INTERVAL_MS = 160;
const LABEL_H = 15;
const CELL = 64;

function escapeHtml(s) {
  return String(s ?? '').replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ],
  );
}

/** Point-in-time screen position of each drawn record (rebuilt every frame). */
class ScreenIndex {
  constructor() {
    this.recs = [];
    this.xs = new Float64Array(0);
    this.ys = new Float64Array(0);
    this.ds = new Float64Array(0);
    this.n = 0;
  }

  reset(capacity) {
    if (this.xs.length < capacity) {
      const size = Math.max(capacity, this.xs.length * 2, 1024);
      this.xs = new Float64Array(size);
      this.ys = new Float64Array(size);
      this.ds = new Float64Array(size);
    }
    this.recs.length = 0;
    this.n = 0;
  }

  push(rec, x, y, d) {
    const i = this.n++;
    this.recs[i] = rec;
    this.xs[i] = x;
    this.ys[i] = y;
    this.ds[i] = d;
  }

  /** Nearest record within `radius` CSS px of (x, y); ties go to the one nearer the camera. */
  nearest(x, y, radius) {
    let best = -1;
    let bestScore = Infinity;
    const r2 = radius * radius;
    for (let i = 0; i < this.n; i++) {
      const dx = this.xs[i] - x;
      const dy = this.ys[i] - y;
      const d2 = dx * dx + dy * dy;
      if (d2 > r2) continue;
      // Screen distance first; a 1e-12 depth term only breaks exact ties.
      const score = d2 + this.ds[i] * 1e-12;
      if (score < bestScore) {
        bestScore = score;
        best = i;
      }
    }
    return best < 0 ? null : this.recs[best];
  }
}

export class LiveLabels {
  /**
   * @param {object} options
   * @param {import('./liveOverlay.js').LiveOverlay} options.live Live overlay (records, tracking).
   * @param {(rec: object) => {title: string, lines: string[], accent?: string}} options.describe
   *   Card text for a record (the globe's own readout text where available).
   * @param {() => void} options.onClose Called when the card's close button is pressed.
   * @param {(rec: object) => Array<{label: string, title?: string, onClick: () => void}>} [options.actions]
   *   Extra card buttons for a record (fly to, cockpit, flight path).
   */
  constructor({ live, describe, onClose, actions = () => [] }) {
    this.live = live;
    this.describe = describe;
    this.onClose = onClose;
    this.actions = actions;
    this.note = '';
    this.enabled = true;
    this.hovered = null;
    this.index = new ScreenIndex();
    this.placed = [];
    this.lastLayout = 0;
    this.widths = new Map();
    this.matrix = new THREE.Matrix4();
    this.cardRec = null;
    this.cardTextAt = 0;
  }

  attach(view) {
    this.view = view;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'fw-live-labels';
    this.ctx = this.canvas.getContext('2d');
    view.host.appendChild(this.canvas);
    this.card = document.createElement('div');
    this.card.className = 'fw-card';
    this.card.hidden = true;
    this.card.innerHTML =
      '<div class="fw-card-head"><span class="fw-card-title"></span>' +
      '<button type="button" class="fw-card-x" aria-label="Close">✕</button></div>' +
      '<div class="fw-card-body"></div>' +
      '<div class="fw-card-actions"><button type="button" class="fw-card-follow"></button></div>' +
      '<div class="fw-card-note" hidden></div>';
    view.host.appendChild(this.card);
    this.card
      .querySelector('.fw-card-x')
      .addEventListener('click', () => this.onClose?.());
    this.followBtn = this.card.querySelector('.fw-card-follow');
    this.actionsEl = this.card.querySelector('.fw-card-actions');
    this.noteEl = this.card.querySelector('.fw-card-note');
    this.extraSignature = '';
    this.followBtn.addEventListener('click', () => {
      if (this.live.following) this.live.releaseFollow();
      else this.live.follow();
      this._renderCardText(true);
    });
    // Clicks on the card must not reach the canvas (deselect / route points).
    for (const type of ['pointerdown', 'pointerup', 'click', 'dblclick'])
      this.card.addEventListener(type, (e) => e.stopPropagation());
  }

  /** Record under a screen point (client coordinates), or null. */
  nearest(clientX, clientY, radiusPx = 14) {
    if (!this.view) return null;
    const rect = this.view.canvas.getBoundingClientRect();
    return this.index.nearest(
      clientX - rect.left,
      clientY - rect.top,
      radiusPx,
    );
  }

  setHover(rec) {
    this.hovered = rec;
  }

  _labelText(rec) {
    const name = String(rec.label || rec.id || '').slice(0, 28);
    // Aircraft read as on the globe: callsign and flight level ("AAL299 FL390").
    // The globe's fleet-label wording (detection labels): formatFlightLevel at every altitude
    // above 0 m, nothing on the ground. Feet are only on the selected plane's card.
    if (rec.kind === 'flights' || rec.kind === 'military') {
      // As the globe: no flight level only at or below 0 m (formatFlightLevel), whatever onGround says.
      const fl = formatFlightLevel(rec.reportedAltitudeM ?? null);
      // Military labels carry the type first, as the globe's do ("H60 · FL006"; 'MIL' if unknown).
      const second =
        rec.kind === 'military'
          ? [rec.typeLabel || 'MIL', fl].filter(Boolean).join(' · ')
          : fl;
      return second ? `${name} ${second}` : name;
    }
    return name;
  }

  _width(text) {
    let w = this.widths.get(text);
    if (w === undefined) {
      w = Math.ceil(this.ctx.measureText(text).width);
      if (this.widths.size > 50000) this.widths.clear();
      this.widths.set(text, w);
    }
    return w;
  }

  _project(view) {
    const cam = view.camera;
    cam.updateMatrixWorld();
    this.matrix.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    const e = this.matrix.elements;
    const w = this.cssW;
    const h = this.cssH;
    let total = 0;
    for (const recs of Object.values(this.live.records)) total += recs.length;
    this.index.reset(total);
    for (const [kind, recs] of Object.entries(this.live.records)) {
      if (!this.live.enabled[kind]) continue;
      for (const r of recs) {
        const p = r.drawn;
        if (!p) continue;
        const cw = e[3] * p.x + e[7] * p.y + e[11] * p.z + e[15];
        if (cw <= 0) continue;
        const nx = (e[0] * p.x + e[4] * p.y + e[8] * p.z + e[12]) / cw;
        const ny = (e[1] * p.x + e[5] * p.y + e[9] * p.z + e[13]) / cw;
        if (nx < -1.05 || nx > 1.05 || ny < -1.05 || ny > 1.05) continue;
        this.index.push(r, ((nx + 1) / 2) * w, ((1 - ny) / 2) * h, cw);
      }
    }
  }

  _priority(rec) {
    const style = KIND_STYLE[rec.kind] ?? KIND_STYLE.flights;
    let base = style.base;
    if (rec.kind === 'satellites') {
      if (rec.group === 'dense') base = 1;
      else if (rec.group === 'stations') base = 6;
    }
    return base;
  }

  /** Choose which names to show: most important and nearest first, no overlaps. */
  _layout() {
    const n = this.index.n;
    const order = new Array(n);
    for (let i = 0; i < n; i++) order[i] = i;
    const pri = new Float64Array(n);
    for (let i = 0; i < n; i++) pri[i] = this._priority(this.index.recs[i]);
    order.sort(
      (a, b) => pri[b] - pri[a] || this.index.ds[a] - this.index.ds[b],
    );
    const maxLabels = Math.min(
      260,
      Math.max(40, Math.round((this.cssW * this.cssH) / 7000)),
    );
    const grid = new Map();
    const boxes = [];
    const collides = (x, y, w, h) => {
      const x0 = Math.floor(x / CELL);
      const x1 = Math.floor((x + w) / CELL);
      const y0 = Math.floor(y / CELL);
      const y1 = Math.floor((y + h) / CELL);
      for (let cx = x0; cx <= x1; cx++)
        for (let cy = y0; cy <= y1; cy++) {
          const list = grid.get(cx * 100003 + cy);
          if (!list) continue;
          for (const b of list)
            if (
              x < b[0] + b[2] &&
              x + w > b[0] &&
              y < b[1] + b[3] &&
              y + h > b[1]
            )
              return true;
        }
      return false;
    };
    const insert = (b) => {
      boxes.push(b);
      const x0 = Math.floor(b[0] / CELL);
      const x1 = Math.floor((b[0] + b[2]) / CELL);
      const y0 = Math.floor(b[1] / CELL);
      const y1 = Math.floor((b[1] + b[3]) / CELL);
      for (let cx = x0; cx <= x1; cx++)
        for (let cy = y0; cy <= y1; cy++) {
          const key = cx * 100003 + cy;
          let list = grid.get(key);
          if (!list) grid.set(key, (list = []));
          list.push(b);
        }
    };
    const placed = [];
    const tracked = this.live.tracked;
    const forced = new Set();
    for (const i of order) {
      const r = this.index.recs[i];
      if (
        r === this.hovered ||
        (tracked && r.kind === tracked.kind && r.id === tracked.id)
      )
        forced.add(i);
    }
    const tryPlace = (i, force) => {
      const r = this.index.recs[i];
      const text = this._labelText(r);
      if (!text) return;
      const w = this._width(text) + 8;
      const x = this.index.xs[i];
      const y = this.index.ys[i];
      // Right, left, above, below the dot.
      const options = [
        [8, -LABEL_H / 2],
        [-8 - w, -LABEL_H / 2],
        [-w / 2, -LABEL_H - 7],
        [-w / 2, 7],
      ];
      for (const [ox, oy] of options) {
        if (force || !collides(x + ox, y + oy, w, LABEL_H)) {
          insert([x + ox, y + oy, w, LABEL_H]);
          placed.push({ rec: r, text, ox, oy, w });
          return;
        }
      }
    };
    for (const i of forced) tryPlace(i, true);
    for (const i of order) {
      if (placed.length >= maxLabels) break;
      if (forced.has(i)) continue;
      tryPlace(i, false);
    }
    this.placed = placed;
  }

  _resize(view) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = view.canvas.clientWidth;
    const h = view.canvas.clientHeight;
    if (w !== this.cssW || h !== this.cssH || dpr !== this.dpr) {
      this.cssW = w;
      this.cssH = h;
      this.dpr = dpr;
      this.canvas.width = Math.max(1, Math.round(w * dpr));
      this.canvas.height = Math.max(1, Math.round(h * dpr));
      this.canvas.style.width = `${w}px`;
      this.canvas.style.height = `${h}px`;
    }
  }

  _color(rec) {
    if (
      rec.kind === 'satellites' &&
      rec.classColor &&
      this.live.satelliteClassColours
    )
      return rec.classColor;
    return (KIND_STYLE[rec.kind] ?? KIND_STYLE.flights).color;
  }

  update(dt, view) {
    if (!this.canvas) return;
    this._resize(view);
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.cssW, this.cssH);
    ctx.font = FONT;
    this._project(view);
    if (this.hovered && !this.live._find(this.hovered.kind, this.hovered.id))
      this.hovered = null;
    const now = performance.now();
    if (this.enabled && now - this.lastLayout > LAYOUT_INTERVAL_MS) {
      this.lastLayout = now;
      this._layout();
    }
    // Screen position of each placed label's record this frame.
    const pos = new Map();
    for (let i = 0; i < this.index.n; i++)
      pos.set(this.index.recs[i], [this.index.xs[i], this.index.ys[i]]);
    if (this.enabled) {
      ctx.textBaseline = 'middle';
      for (const l of this.placed) {
        const p = pos.get(l.rec);
        if (!p) continue;
        const x = p[0] + l.ox;
        const y = p[1] + l.oy;
        const hot = l.rec === this.hovered;
        ctx.fillStyle = hot ? 'rgba(6, 20, 28, 0.92)' : 'rgba(4, 14, 20, 0.62)';
        ctx.fillRect(x, y, l.w, LABEL_H);
        // Colour stripe on the side nearest the dot.
        const leftOfDot = l.ox < 0 && l.oy === -LABEL_H / 2;
        ctx.fillStyle = this._color(l.rec);
        ctx.fillRect(leftOfDot ? x + l.w - 2 : x, y, 2, LABEL_H);
        ctx.fillStyle = hot ? '#ffffff' : '#d6f3fb';
        ctx.fillText(l.text, x + 5, y + LABEL_H / 2 + 0.5);
      }
    }
    // Hover ring: shows exactly which dot a click will pick.
    const hp = this.hovered && pos.get(this.hovered);
    if (hp) {
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(hp[0], hp[1], 9, 0, Math.PI * 2);
      ctx.stroke();
    }
    // Selected object: cyan corner brackets, as on the globe.
    const tr = this._trackedRec();
    const tp = tr && pos.get(tr);
    if (tp) {
      const r = 17;
      const l = 6;
      ctx.strokeStyle = '#00dcff';
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      for (const [sx, sy] of [
        [-1, -1],
        [1, -1],
        [1, 1],
        [-1, 1],
      ]) {
        const cx = tp[0] + sx * r;
        const cy = tp[1] + sy * r;
        ctx.moveTo(cx, cy - sy * l);
        ctx.lineTo(cx, cy);
        ctx.lineTo(cx - sx * l, cy);
      }
      ctx.stroke();
    }
    this._updateCard(pos);
    // Callout connector from the selected object up to its card.
    if (tp && this.cardAnchor) {
      ctx.strokeStyle = 'rgba(0, 220, 255, 0.85)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(tp[0], tp[1] - 19);
      ctx.lineTo(this.cardAnchor[0], this.cardAnchor[1]);
      ctx.stroke();
    }
  }

  _trackedRec() {
    const t = this.live.tracked;
    return t ? this.live._find(t.kind, t.id) : null;
  }

  _renderCardText(force = false) {
    const rec = this._trackedRec();
    if (!rec) return;
    const now = Date.now();
    if (!force && rec === this.cardRec && now - this.cardTextAt < 500) return;
    this.cardRec = rec;
    this.cardTextAt = now;
    const d = this.describe(rec) || { title: rec.label, lines: [] };
    this.card.style.setProperty('--fw-accent', d.accent || this._color(rec));
    this.card.querySelector('.fw-card-title').textContent =
      d.title || rec.label;
    const fix = rec.fixes?.[rec.fixes.length - 1];
    const ageS = rec.lastFixMs
      ? Math.round((now - rec.lastFixMs) / 1000)
      : null;
    const lat = rec.lat;
    const lon = rec.lon;
    const position = `${Math.abs(lat).toFixed(4)}°${lat >= 0 ? 'N' : 'S'} ${Math.abs(lon).toFixed(4)}°${lon >= 0 ? 'E' : 'W'}`;
    const lines = [
      ...(d.lines || []),
      position,
      `${rec.source || 'live feed'}${ageS === null || !fix ? '' : ` · fix ${ageS} s ago`}`,
    ];
    this.card.querySelector('.fw-card-body').innerHTML = lines
      .map(
        (l, i) =>
          `<div class="fw-card-line${i >= lines.length - 2 ? ' dim' : ''}">${escapeHtml(l)}</div>`,
      )
      .join('');
    this.followBtn.textContent = this.live.following
      ? 'STOP FOLLOWING'
      : 'FOLLOW';
    this._renderActions(rec);
  }

  /** A short status line under the buttons (e.g. why the cockpit could not open). */
  setNote(text) {
    this.note = text || '';
    this.noteFor = this._trackedRec()?.id ?? null;
    this._renderCardText(true);
  }

  _renderActions(rec) {
    let extra = [];
    try {
      extra = this.actions(rec) || [];
    } catch {
      extra = [];
    }
    const signature = extra.map((a) => a.label).join('|');
    if (signature !== this.extraSignature) {
      this.extraSignature = signature;
      for (const b of [...this.actionsEl.querySelectorAll('.fw-card-extra')])
        b.remove();
      this.extraHandlers = extra.map((a) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'fw-card-follow fw-card-extra';
        b.textContent = a.label;
        if (a.title) b.title = a.title;
        this.actionsEl.append(b);
        const entry = { button: b, action: a };
        b.addEventListener('click', () => {
          entry.action.onClick();
          this._renderCardText(true);
        });
        return entry;
      });
    } else {
      this.extraHandlers?.forEach((h, i) => (h.action = extra[i]));
    }
    const note = rec.id === this.noteFor ? this.note : '';
    this.noteEl.hidden = !note;
    this.noteEl.textContent = note;
  }

  _updateCard(pos) {
    const rec = this._trackedRec();
    if (!rec) {
      this.card.hidden = true;
      this.cardRec = null;
      return;
    }
    this._renderCardText();
    this.card.hidden = false;
    const p = pos.get(rec);
    const cw = this.card.offsetWidth || 220;
    const ch = this.card.offsetHeight || 90;
    let x;
    let y;
    this.cardAnchor = null;
    if (p) {
      // Callout above the object, as on the globe; beside it when there is no room above.
      x = p[0] - cw / 2;
      y = p[1] - ch - 48;
      if (y < 60) {
        x = p[0] + 26;
        y = p[1] - ch / 2;
        if (x + cw > this.cssW - 8) x = p[0] - 26 - cw;
      }
    } else {
      // Off screen: dock the card at the bottom centre instead of losing it.
      x = (this.cssW - cw) / 2;
      y = this.cssH - ch - 120;
    }
    x = Math.min(Math.max(x, 8), Math.max(8, this.cssW - cw - 8));
    y = Math.min(Math.max(y, 60), Math.max(60, this.cssH - ch - 100));
    this.card.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    if (p && y + ch <= p[1] - 19) this.cardAnchor = [p[0], y + ch];
  }

  destroy() {
    this.canvas?.remove();
    this.card?.remove();
  }
}
