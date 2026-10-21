import { goalPosts, homePosition, type Layout } from '../shared/geometry';
import { PALETTE, type Phase, type PublicPlayer } from '../shared/protocol';
import type { Settings } from '../shared/settings';
import { rotate, type Vec } from '../shared/vec';
import type { Fx } from './fx';
import { SLOW_MS } from './ping';

const SAMPLES = 180;
const MORPH_S = 0.7;
const LABEL_GAP = 0.06;
const LABEL_PAD_X = 0.34;
const LABEL_PAD_Y = 0.16;
const TRAIL_S = 0.32;
const LAG_COLOR = '#ff4d6a';

export interface Frame {
  layout: Layout;
  settings: Settings;
  phase: Phase;
  mySeat: number;
  seatPlayers: (PublicPlayer | undefined)[];
  puck: Vec | null;
  puckSpeed: number;
  hitter: number;
  mallets: (Vec | null)[];
  myMallet: Vec | null;
  countdown: number;
  /** Home screen demo: no goals, mallets or labels. */
  attract?: boolean;
  /** Box (CSS px) the table should fit inside. */
  fit: { x: number; y: number; w: number; h: number };
}

interface View {
  cx: number;
  cy: number;
  scale: number;
  rot: number;
}

const colorOf = (p: PublicPlayer | undefined): string => (p ? PALETTE[p.color] : '#5a6488');

function radialProfile(verts: Vec[]): Float32Array {
  const out = new Float32Array(SAMPLES);
  const n = verts.length;
  for (let i = 0; i < SAMPLES; i++) {
    const a = (i / SAMPLES) * Math.PI * 2;
    const dx = Math.cos(a);
    const dy = Math.sin(a);
    let best = Infinity;
    for (let j = 0; j < n; j++) {
      const p = verts[j];
      const q = verts[(j + 1) % n];
      const ex = q.x - p.x;
      const ey = q.y - p.y;
      let nx = ey;
      let ny = -ex;
      if (nx * (p.x + q.x) + ny * (p.y + q.y) < 0) {
        nx = -nx;
        ny = -ny;
      }
      const denom = dx * nx + dy * ny;
      if (denom <= 1e-9) continue;
      const r = (p.x * nx + p.y * ny) / denom;
      if (r < best) best = r;
    }
    out[i] = best;
  }
  return out;
}

function easeInOut(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function angleLerp(a: number, b: number, t: number): number {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

export class Renderer {
  readonly ctx: CanvasRenderingContext2D;
  private dpr = 1;
  private width = 0;
  private height = 0;
  private view: View = { cx: 0, cy: 0, scale: 100, rot: 0 };
  private hasView = false;
  private shapeKey = '';
  private profileFrom: Float32Array | null = null;
  private profileTo: Float32Array | null = null;
  private morph = 1;
  private trail: { x: number; y: number; age: number }[] = [];
  private glows = new Map<string, HTMLCanvasElement>();
  private dots: CanvasPattern | null = null;
  private time = 0;

  constructor(private canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D is not available');
    this.ctx = ctx;
    this.resize();
  }

  get size(): { width: number; height: number } {
    return { width: this.width, height: this.height };
  }

  resize(): void {
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.width = this.canvas.clientWidth;
    this.height = this.canvas.clientHeight;
    this.canvas.width = Math.round(this.width * this.dpr);
    this.canvas.height = Math.round(this.height * this.dpr);
    this.dots = null;
  }

  /** Screen (CSS px) to world coordinates using the current view. */
  toWorld(sx: number, sy: number): Vec {
    const v = this.view;
    return rotate({ x: (sx - v.cx) / v.scale, y: (sy - v.cy) / v.scale }, -v.rot);
  }

  toScreen(p: Vec): Vec {
    const v = this.view;
    const r = rotate(p, v.rot);
    return { x: v.cx + r.x * v.scale, y: v.cy + r.y * v.scale };
  }

  resetTrail(): void {
    this.trail = [];
  }

  private glow(color: string): HTMLCanvasElement {
    let c = this.glows.get(color);
    if (c) return c;
    c = document.createElement('canvas');
    c.width = c.height = 128;
    const g = c.getContext('2d')!;
    const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    grad.addColorStop(0, color);
    grad.addColorStop(0.25, `${color}88`);
    grad.addColorStop(1, `${color}00`);
    g.fillStyle = grad;
    g.fillRect(0, 0, 128, 128);
    this.glows.set(color, c);
    return c;
  }

  private dotPattern(): CanvasPattern | null {
    if (this.dots) return this.dots;
    const tile = document.createElement('canvas');
    const s = Math.round(18 * this.dpr);
    tile.width = tile.height = s;
    const g = tile.getContext('2d')!;
    g.fillStyle = 'rgba(160, 190, 255, 0.11)';
    g.beginPath();
    g.arc(s / 2, s / 2, Math.max(1, this.dpr * 1.1), 0, Math.PI * 2);
    g.fill();
    this.dots = this.ctx.createPattern(tile, 'repeat');
    this.dots?.setTransform(new DOMMatrix().scale(1 / this.dpr));
    return this.dots;
  }

  private targetView(f: Frame): View {
    const rot = f.mySeat >= 0 ? Math.PI / 2 - f.layout.facing[f.mySeat] : 0;
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const p of f.layout.verts) {
      const r = rotate(p, rot);
      minX = Math.min(minX, r.x);
      maxX = Math.max(maxX, r.x);
      minY = Math.min(minY, r.y);
      maxY = Math.max(maxY, r.y);
    }
    const bw = maxX - minX + LABEL_PAD_X * 2;
    const bh = maxY - minY + LABEL_PAD_Y * 2;
    const scale = Math.max(10, Math.min(f.fit.w / bw, f.fit.h / bh));
    return {
      cx: f.fit.x + f.fit.w / 2 - ((minX + maxX) / 2) * scale,
      cy: f.fit.y + f.fit.h / 2 - ((minY + maxY) / 2) * scale,
      scale,
      rot,
    };
  }

  draw(f: Frame, fx: Fx, dt: number): void {
    this.time += dt;
    const ctx = this.ctx;
    const target = this.targetView(f);

    const key = `${f.layout.verts.map((p) => `${p.x.toFixed(3)},${p.y.toFixed(3)}`).join(';')}|${target.rot.toFixed(3)}`;
    if (key !== this.shapeKey) {
      const viewVerts = f.layout.verts.map((p) => rotate(p, target.rot));
      const next = radialProfile(viewVerts);
      this.profileFrom = this.hasView ? this.currentProfile() : next;
      this.profileTo = next;
      this.morph = this.hasView ? 0 : 1;
      this.shapeKey = key;
      this.view.rot = target.rot;
    }
    this.morph = Math.min(1, this.morph + dt / MORPH_S);

    if (!this.hasView) {
      this.view = { ...target };
      this.hasView = true;
    } else {
      const k = 1 - Math.exp(-dt * 7);
      this.view.cx += (target.cx - this.view.cx) * k;
      this.view.cy += (target.cy - this.view.cy) * k;
      this.view.scale += (target.scale - this.view.scale) * k;
      this.view.rot = angleLerp(this.view.rot, target.rot, k);
    }

    const shakeX = (Math.random() - 0.5) * fx.shake;
    const shakeY = (Math.random() - 0.5) * fx.shake;

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.drawBackground(f);

    ctx.save();
    ctx.translate(shakeX, shakeY);
    const morphing = this.morph < 1;
    this.drawTable(f, morphing);
    if (!morphing) {
      this.withWorld(() => {
        this.drawMarkings(f);
        if (!f.attract) this.drawGoals(f);
        this.drawTrail(f, dt);
        fx.drawWorld(ctx);
        if (!f.attract) this.drawMallets(f);
        this.drawPuck(f, fx);
      });
      if (!f.attract) this.drawLabels(f);
    }
    ctx.restore();

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    if (fx.flash > 0.01) {
      ctx.globalAlpha = fx.flash;
      ctx.fillStyle = fx.flashColor;
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillRect(0, 0, this.width, this.height);
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
    }
    fx.drawScreen(ctx);
    this.drawBanner(fx);
    if (f.phase === 'countdown') this.drawCountdown(f.countdown);
  }

  private currentProfile(): Float32Array {
    const out = new Float32Array(SAMPLES);
    if (!this.profileFrom || !this.profileTo) return out;
    const t = easeInOut(this.morph);
    for (let i = 0; i < SAMPLES; i++) out[i] = this.profileFrom[i] + (this.profileTo[i] - this.profileFrom[i]) * t;
    return out;
  }

  private withWorld(fn: () => void): void {
    const v = this.view;
    const c = Math.cos(v.rot) * v.scale;
    const s = Math.sin(v.rot) * v.scale;
    const m = this.ctx.getTransform();
    this.ctx.save();
    this.ctx.setTransform(m.multiply(new DOMMatrix([c, s, -s, c, v.cx, v.cy])));
    fn();
    this.ctx.restore();
  }

  private tablePath(f: Frame, morphing: boolean): Path2D {
    const path = new Path2D();
    const v = this.view;
    if (morphing) {
      const prof = this.currentProfile();
      for (let i = 0; i < SAMPLES; i++) {
        const a = (i / SAMPLES) * Math.PI * 2;
        const x = v.cx + Math.cos(a) * prof[i] * v.scale;
        const y = v.cy + Math.sin(a) * prof[i] * v.scale;
        if (i === 0) path.moveTo(x, y);
        else path.lineTo(x, y);
      }
    } else {
      f.layout.verts.forEach((p, i) => {
        const s = this.toScreen(p);
        if (i === 0) path.moveTo(s.x, s.y);
        else path.lineTo(s.x, s.y);
      });
    }
    path.closePath();
    return path;
  }

  private drawBackground(f: Frame): void {
    const ctx = this.ctx;
    ctx.fillStyle = '#04050d';
    ctx.fillRect(0, 0, this.width, this.height);
    const hitter = f.seatPlayers[f.hitter];
    const tint = hitter ? PALETTE[hitter.color] : '#3d7bff';
    const r = Math.max(this.width, this.height) * 0.75;
    const g = ctx.createRadialGradient(this.view.cx, this.view.cy, 0, this.view.cx, this.view.cy, r);
    g.addColorStop(0, `${tint}26`);
    g.addColorStop(0.5, '#0a0f2a14');
    g.addColorStop(1, '#00000000');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, this.width, this.height);
  }

  private drawTable(f: Frame, morphing: boolean): void {
    const ctx = this.ctx;
    const path = this.tablePath(f, morphing);
    const v = this.view;

    const fill = ctx.createRadialGradient(v.cx, v.cy, 0, v.cx, v.cy, v.scale * 1.2);
    fill.addColorStop(0, '#111a44');
    fill.addColorStop(1, '#070b22');
    ctx.fillStyle = fill;
    ctx.fill(path);
    const dots = this.dotPattern();
    if (dots) {
      ctx.fillStyle = dots;
      ctx.fill(path);
    }

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineJoin = 'round';
    const pulse = 0.85 + Math.sin(this.time * 2) * 0.15;
    for (const [w, a] of [
      [16, 0.06],
      [8, 0.14],
      [3, 0.5],
      [1.5, 0.9],
    ] as const) {
      ctx.strokeStyle = `rgba(120, 170, 255, ${a * pulse})`;
      ctx.lineWidth = w;
      ctx.stroke(path);
    }
    ctx.restore();
  }

  private drawMarkings(f: Frame): void {
    const ctx = this.ctx;
    const { layout } = f;
    const lw = 1.5 / this.view.scale;
    ctx.save();
    ctx.strokeStyle = 'rgba(140, 170, 255, 0.18)';
    ctx.lineWidth = lw;
    ctx.beginPath();
    ctx.arc(0, 0, layout.puckR * 4, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = 'rgba(140, 170, 255, 0.3)';
    ctx.beginPath();
    ctx.arc(0, 0, layout.puckR * 0.35, 0, Math.PI * 2);
    ctx.fill();

    if (f.settings.zone === 'wedge') {
      ctx.setLineDash([lw * 6, lw * 6]);
      ctx.beginPath();
      if (layout.seats === 2) {
        const w = layout.verts[0].x;
        ctx.moveTo(-w, 0);
        ctx.lineTo(w, 0);
      } else {
        for (const p of layout.verts) {
          ctx.moveTo(0, 0);
          ctx.lineTo(p.x, p.y);
        }
      }
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.restore();
  }

  private drawGoals(f: Frame): void {
    const ctx = this.ctx;
    const { layout } = f;
    const lw = 1 / this.view.scale;
    for (let seat = 0; seat < layout.seats; seat++) {
      const p = f.seatPlayers[seat];
      const side = layout.sides[layout.goalSide[seat]];
      const color = colorOf(p);
      const closed = p?.out || (f.phase !== 'lobby' && !p);
      const [a, b] = goalPosts(layout, seat);

      if (closed) {
        ctx.save();
        ctx.strokeStyle = 'rgba(120, 140, 200, 0.5)';
        ctx.lineWidth = lw * 4;
        ctx.setLineDash([lw * 5, lw * 5]);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
        ctx.restore();
        continue;
      }

      const away = p && !p.connected;
      const pulse = away ? 0.35 + 0.25 * Math.sin(this.time * 6) : 1;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const crease = layout.goalHalf * 0.8;
      const ang = Math.atan2(side.normal.y, side.normal.x);
      ctx.globalAlpha = 0.14 * pulse;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(side.mid.x, side.mid.y, crease, ang - Math.PI / 2, ang + Math.PI / 2);
      ctx.closePath();
      ctx.fill();
      ctx.globalAlpha = 0.5 * pulse;
      ctx.strokeStyle = color;
      ctx.lineWidth = lw * 1.5;
      ctx.stroke();

      ctx.lineCap = 'round';
      for (const [w, alpha] of [
        [14, 0.12],
        [7, 0.3],
        [3.5, 1],
      ] as const) {
        ctx.globalAlpha = alpha * pulse;
        ctx.lineWidth = lw * w;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
      ctx.globalAlpha = pulse;
      ctx.fillStyle = '#ffffff';
      for (const post of [a, b]) {
        ctx.beginPath();
        ctx.arc(post.x, post.y, lw * 3, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }
  }

  private drawTrail(f: Frame, dt: number): void {
    for (const t of this.trail) t.age += dt;
    this.trail = this.trail.filter((t) => t.age < TRAIL_S);
    if (f.puck) {
      const last = this.trail.at(-1);
      if (last && Math.hypot(last.x - f.puck.x, last.y - f.puck.y) > 0.3) this.trail = [];
      this.trail.push({ x: f.puck.x, y: f.puck.y, age: 0 });
    } else {
      this.trail = [];
    }
    if (this.trail.length < 2) return;

    const ctx = this.ctx;
    const color = colorOf(f.seatPlayers[f.hitter]);
    const r = f.layout.puckR;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    for (let i = 1; i < this.trail.length; i++) {
      const a = this.trail[i - 1];
      const b = this.trail[i];
      const life = 1 - b.age / TRAIL_S;
      ctx.strokeStyle = color;
      ctx.globalAlpha = life * 0.55;
      ctx.lineWidth = r * 1.8 * life;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      ctx.strokeStyle = '#ffffff';
      ctx.globalAlpha = life * 0.5;
      ctx.lineWidth = r * 0.5 * life;
      ctx.stroke();
    }
    ctx.restore();
  }

  private sprite(color: string, x: number, y: number, radius: number, alpha: number): void {
    const ctx = this.ctx;
    ctx.globalAlpha = alpha;
    ctx.drawImage(this.glow(color), x - radius, y - radius, radius * 2, radius * 2);
    ctx.globalAlpha = 1;
  }

  private drawMallets(f: Frame): void {
    const ctx = this.ctx;
    const { layout } = f;
    const rm = layout.malletR;
    for (let seat = 0; seat < layout.seats; seat++) {
      const p = f.seatPlayers[seat];
      if (!p || p.out) continue;
      let pos = seat === f.mySeat && f.myMallet ? f.myMallet : f.mallets[seat];
      if (!pos && f.phase === 'lobby') pos = homePosition(layout, seat, f.settings.zone);
      if (!pos) continue;
      const color = PALETTE[p.color];
      const mine = seat === f.mySeat;
      const alpha = p.connected ? 1 : 0.35;

      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      this.sprite(color, pos.x, pos.y, rm * 2.6, 0.55 * alpha);
      ctx.restore();

      ctx.save();
      ctx.globalAlpha = alpha;
      const body = ctx.createRadialGradient(pos.x - rm * 0.3, pos.y - rm * 0.3, rm * 0.1, pos.x, pos.y, rm);
      body.addColorStop(0, '#26305e');
      body.addColorStop(1, '#0a0e26');
      ctx.fillStyle = body;
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, rm, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = color;
      ctx.lineWidth = rm * 0.22;
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, rm * 0.86, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, rm * 0.36, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.75)';
      ctx.beginPath();
      ctx.arc(pos.x - rm * 0.1, pos.y - rm * 0.1, rm * 0.12, 0, Math.PI * 2);
      ctx.fill();
      if (mine) {
        const pulse = (this.time * 1.2) % 1;
        ctx.globalAlpha = (1 - pulse) * 0.6;
        ctx.lineWidth = rm * 0.08;
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, rm * (1.05 + pulse * 0.6), 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  private drawPuck(f: Frame, fx: Fx): void {
    if (!f.puck) return;
    const ctx = this.ctx;
    const { x, y } = f.puck;
    const r = f.layout.puckR;
    const color = colorOf(f.seatPlayers[f.hitter]);
    const hot = Math.min(1, f.puckSpeed / 2.5);
    if (hot > 0.55 && Math.random() < hot) fx.trailSpark(x, y, color);

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    this.sprite(color, x, y, r * (3.2 + hot * 1.5), 0.7);
    this.sprite('#ffffff', x, y, r * 1.8, 0.5);
    ctx.restore();

    ctx.save();
    const g = ctx.createRadialGradient(x - r * 0.3, y - r * 0.3, r * 0.1, x, y, r);
    g.addColorStop(0, '#ffffff');
    g.addColorStop(0.7, '#dfe8ff');
    g.addColorStop(1, color);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = r * 0.18;
    ctx.stroke();
    ctx.restore();
  }

  private drawLabels(f: Frame): void {
    const ctx = this.ctx;
    const { layout } = f;
    ctx.save();
    for (let seat = 0; seat < layout.seats; seat++) {
      const p = f.seatPlayers[seat];
      const side = layout.sides[layout.goalSide[seat]];
      const s = this.toScreen({ x: side.mid.x - side.normal.x * LABEL_GAP, y: side.mid.y - side.normal.y * LABEL_GAP });
      const away = rotate({ x: -side.normal.x, y: -side.normal.y }, this.view.rot);
      ctx.textAlign = away.x > 0.45 ? 'left' : away.x < -0.45 ? 'right' : 'center';
      ctx.textBaseline = away.y > 0.45 ? 'top' : away.y < -0.45 ? 'bottom' : 'middle';
      const size = Math.max(11, Math.min(18, this.view.scale * 0.055));

      if (!p) {
        ctx.font = `600 ${size}px "Chakra Petch", system-ui, sans-serif`;
        ctx.fillStyle = 'rgba(150, 165, 220, 0.5)';
        ctx.fillText(f.phase === 'lobby' ? 'waiting…' : '', s.x, s.y);
        continue;
      }
      const color = PALETTE[p.color];
      let text = p.name;
      if (f.phase !== 'lobby') {
        text = f.settings.mode === 'lives' ? `${p.name}  ${p.out ? 'OUT' : `♥${p.lives}`}` : `${p.name}  ${p.score}`;
      }
      const font = `700 ${size}px "Chakra Petch", system-ui, sans-serif`;
      ctx.font = font;
      ctx.shadowColor = color;
      ctx.shadowBlur = 10;
      ctx.fillStyle = p.out ? 'rgba(160,170,200,0.5)' : color;
      ctx.globalAlpha = p.connected ? 1 : 0.5;
      const room = ctx.textAlign === 'left' ? this.width - s.x - 6 : ctx.textAlign === 'right' ? s.x - 6 : Math.min(s.x, this.width - s.x) * 2 - 12;
      const maxW = Math.max(40, room);
      if (p.connected && p.ping >= SLOW_MS) {
        const lagFont = `700 ${Math.round(size * 0.7)}px "Chakra Petch", system-ui, sans-serif`;
        const gap = size * 0.35;
        ctx.font = lagFont;
        const lagW = ctx.measureText('LAG').width;
        ctx.font = font;
        const nameW = Math.min(ctx.measureText(text).width, Math.max(20, maxW - gap - lagW));
        const w = nameW + gap + lagW;
        const x = ctx.textAlign === 'left' ? s.x : ctx.textAlign === 'right' ? s.x - w : s.x - w / 2;
        ctx.textAlign = 'left';
        ctx.fillText(text, x, s.y, nameW);
        ctx.font = lagFont;
        ctx.fillStyle = ctx.shadowColor = LAG_COLOR;
        ctx.fillText('LAG', x + nameW + gap, s.y);
      } else {
        ctx.fillText(text, s.x, s.y, maxW);
      }
      ctx.globalAlpha = 1;
    }
    ctx.restore();
  }

  private drawBanner(fx: Fx): void {
    const b = fx.banner;
    if (!b) return;
    const ctx = this.ctx;
    const t = 1 - b.life / b.max;
    const pop = t < 0.15 ? 0.6 + (t / 0.15) * 0.5 : t < 0.25 ? 1.1 - ((t - 0.15) / 0.1) * 0.1 : 1;
    const alpha = b.life < 0.4 ? b.life / 0.4 : 1;
    const size = Math.min(this.width * 0.13, 110) * pop;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `800 ${size}px "Chakra Petch", system-ui, sans-serif`;
    ctx.shadowColor = b.color;
    ctx.shadowBlur = 30;
    ctx.fillStyle = '#ffffff';
    ctx.fillText(b.title, this.view.cx, this.view.cy - size * 0.2);
    ctx.font = `700 ${size * 0.32}px "Chakra Petch", system-ui, sans-serif`;
    ctx.fillStyle = b.color;
    ctx.fillText(b.sub, this.view.cx, this.view.cy + size * 0.55);
    ctx.restore();
  }

  private drawCountdown(ms: number): void {
    const n = Math.ceil(ms / 1000);
    if (n <= 0) return;
    const frac = (ms % 1000) / 1000;
    const ctx = this.ctx;
    const size = Math.min(this.width * 0.2, 160) * (0.8 + frac * 0.4);
    ctx.save();
    ctx.globalAlpha = 0.3 + frac * 0.7;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `800 ${size}px "Chakra Petch", system-ui, sans-serif`;
    ctx.shadowColor = '#7aa8ff';
    ctx.shadowBlur = 40;
    ctx.fillStyle = '#ffffff';
    ctx.fillText(String(n), this.view.cx, this.view.cy);
    ctx.restore();
  }
}
