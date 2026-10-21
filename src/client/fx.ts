interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  size: number;
  color: string;
  drag: number;
}

interface Ring {
  x: number;
  y: number;
  r: number;
  speed: number;
  life: number;
  max: number;
  color: string;
  width: number;
}

interface Confetti {
  x: number;
  y: number;
  vx: number;
  vy: number;
  rot: number;
  vr: number;
  w: number;
  h: number;
  color: string;
  life: number;
}

export interface Banner {
  title: string;
  sub: string;
  color: string;
  life: number;
  max: number;
}

const MAX_PARTICLES = 1600;

/** World-space particles and rings, plus screen-space confetti, banners, flash and shake. */
export class Fx {
  particles: Particle[] = [];
  rings: Ring[] = [];
  confetti: Confetti[] = [];
  banner: Banner | null = null;
  shake = 0;
  flash = 0;
  flashColor = '#ffffff';

  private burst(x: number, y: number, count: number, speed: number, colors: string[], life: number, size: number): void {
    for (let i = 0; i < count && this.particles.length < MAX_PARTICLES; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = speed * (0.25 + Math.random() * 0.75);
      const max = life * (0.5 + Math.random() * 0.5);
      this.particles.push({
        x,
        y,
        vx: Math.cos(a) * s,
        vy: Math.sin(a) * s,
        life: max,
        max,
        size: size * (0.6 + Math.random() * 0.8),
        color: colors[i % colors.length],
        drag: 3 + Math.random() * 3,
      });
    }
  }

  ring(x: number, y: number, color: string, speed: number, life: number, width: number): void {
    this.rings.push({ x, y, r: 0, speed, life, max: life, color, width });
  }

  hit(x: number, y: number, color: string, strength: number): void {
    this.burst(x, y, 6 + Math.round(strength * 22), 0.6 + strength * 2.2, [color, '#ffffff'], 0.45, 0.006);
    this.ring(x, y, color, 0.6 + strength * 1.2, 0.3, 0.008);
    if (strength > 0.65) this.shake = Math.max(this.shake, 4 * strength);
  }

  wall(x: number, y: number, strength: number): void {
    this.burst(x, y, 3 + Math.round(strength * 10), 0.4 + strength * 1.4, ['#9ef0ff', '#ffffff'], 0.35, 0.005);
    this.ring(x, y, '#9ef0ff', 0.5 + strength, 0.22, 0.005);
  }

  goal(x: number, y: number, color: string, banner: Omit<Banner, 'life' | 'max'>): void {
    this.burst(x, y, 140, 3.2, [color, '#ffffff', color], 1.1, 0.009);
    this.ring(x, y, color, 2.4, 0.7, 0.02);
    this.ring(x, y, '#ffffff', 1.4, 0.5, 0.008);
    this.shake = 16;
    this.flash = 0.16;
    this.flashColor = color;
    this.banner = { ...banner, life: 1.6, max: 1.6 };
  }

  serve(x: number, y: number): void {
    this.ring(x, y, '#ffffff', 0.9, 0.45, 0.01);
    this.ring(x, y, '#7aa8ff', 0.5, 0.6, 0.006);
  }

  trailSpark(x: number, y: number, color: string): void {
    if (this.particles.length >= MAX_PARTICLES) return;
    const a = Math.random() * Math.PI * 2;
    this.particles.push({
      x,
      y,
      vx: Math.cos(a) * 0.15,
      vy: Math.sin(a) * 0.15,
      life: 0.35,
      max: 0.35,
      size: 0.004,
      color,
      drag: 2,
    });
  }

  celebrate(width: number, height: number, colors: string[]): void {
    for (let i = 0; i < 260; i++) {
      this.confetti.push({
        x: Math.random() * width,
        y: -20 - Math.random() * height * 0.6,
        vx: (Math.random() - 0.5) * 120,
        vy: 80 + Math.random() * 180,
        rot: Math.random() * Math.PI,
        vr: (Math.random() - 0.5) * 12,
        w: 6 + Math.random() * 6,
        h: 3 + Math.random() * 4,
        color: colors[i % colors.length],
        life: 6,
      });
    }
  }

  clear(): void {
    this.particles = [];
    this.rings = [];
    this.confetti = [];
    this.banner = null;
  }

  update(dt: number, height: number): void {
    for (const p of this.particles) {
      const d = Math.exp(-p.drag * dt);
      p.vx *= d;
      p.vy *= d;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.life -= dt;
    }
    this.particles = this.particles.filter((p) => p.life > 0);
    for (const r of this.rings) {
      r.r += r.speed * dt;
      r.life -= dt;
    }
    this.rings = this.rings.filter((r) => r.life > 0);
    for (const c of this.confetti) {
      c.vy += 60 * dt;
      c.vx *= Math.exp(-0.8 * dt);
      c.x += c.vx * dt + Math.sin(c.rot) * 20 * dt;
      c.y += c.vy * dt;
      c.rot += c.vr * dt;
      c.life -= dt;
    }
    this.confetti = this.confetti.filter((c) => c.life > 0 && c.y < height + 30);
    if (this.banner) {
      this.banner.life -= dt;
      if (this.banner.life <= 0) this.banner = null;
    }
    this.shake *= Math.exp(-7 * dt);
    this.flash *= Math.exp(-6 * dt);
  }

  drawWorld(ctx: CanvasRenderingContext2D): void {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    for (const p of this.particles) {
      const a = p.life / p.max;
      ctx.globalAlpha = a;
      ctx.strokeStyle = p.color;
      ctx.lineWidth = p.size * (0.5 + a);
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(p.x - p.vx * 0.035, p.y - p.vy * 0.035);
      ctx.stroke();
    }
    for (const r of this.rings) {
      const a = r.life / r.max;
      ctx.globalAlpha = a * 0.9;
      ctx.strokeStyle = r.color;
      ctx.lineWidth = r.width * a;
      ctx.beginPath();
      ctx.arc(r.x, r.y, r.r, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  drawScreen(ctx: CanvasRenderingContext2D): void {
    for (const c of this.confetti) {
      ctx.save();
      ctx.globalAlpha = Math.min(1, c.life);
      ctx.translate(c.x, c.y);
      ctx.rotate(c.rot);
      ctx.fillStyle = c.color;
      ctx.fillRect(-c.w / 2, (-c.h / 2) * Math.abs(Math.cos(c.rot * 1.7)), c.w, c.h);
      ctx.restore();
    }
  }
}
