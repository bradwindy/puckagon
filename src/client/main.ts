import '@fontsource/chakra-petch/500.css';
import '@fontsource/chakra-petch/700.css';
import './style.css';
import { clampToConvex, homePosition, makeLayout, MAX_SEATS, MIN_SEATS, zoneFor } from '../shared/geometry';
import { createWorld, serve, step, type World } from '../shared/physics';
import { CODE_ALPHABET, CODE_LENGTH, normalizeCode, PALETTE, sanitizeName, type Phase, type ServerMsg } from '../shared/protocol';
import { DEFAULT_SETTINGS } from '../shared/settings';
import type { Vec } from '../shared/vec';
import { Sfx } from './audio';
import { Fx } from './fx';
import { InputSampler } from './input';
import { Net, type NetStatus } from './net';
import { SLOW_MS, UNSTABLE_RATE } from './ping';
import { Renderer, type Frame } from './render';
import { GameState, type Due } from './state';
import { UI } from './ui';

const NAME_KEY = 'puckagon:name';
const PID_KEY = 'puckagon:pid';
const MATCH: Phase[] = ['countdown', 'playing', 'scored'];
/** Playback stays marked unstable this long after its last late frame, so stutters a second apart count as one spell. */
const UNSTABLE_HOLD_MS = 2000;
/** How long the connection must stay slow or unstable before we say so. */
const WARN_AFTER_MS = 3000;

function storageGet(store: () => Storage, key: string): string {
  try {
    return store().getItem(key) ?? '';
  } catch {
    return '';
  }
}

function storageSet(store: () => Storage, key: string, value: string): void {
  try {
    store().setItem(key, value);
  } catch {
    // private mode or storage disabled; the value lasts for this page only
  }
}

function randomCode(): string {
  const bytes = crypto.getRandomValues(new Uint32Array(CODE_LENGTH));
  return Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}

let memoryPid = '';
function playerId(): string {
  let pid = storageGet(() => sessionStorage, PID_KEY) || memoryPid;
  if (!pid) {
    const bytes = crypto.getRandomValues(new Uint8Array(18));
    pid = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    memoryPid = pid;
    storageSet(() => sessionStorage, PID_KEY, pid);
  }
  return pid;
}

const savedName = () => sanitizeName(storageGet(() => localStorage, NAME_KEY));
const saveName = (name: string) => storageSet(() => localStorage, NAME_KEY, sanitizeName(name));

const canvas = document.getElementById('stage') as HTMLCanvasElement;
const renderer = new Renderer(canvas);
const fx = new Fx();
const sfx = new Sfx();

/** The home-screen demo: a puck bouncing around a table that keeps changing shape. */
class Attract {
  private seats = 3;
  private world!: World;
  private clock = 0;

  constructor() {
    this.reset();
  }

  private reset(): void {
    const layout = makeLayout(this.seats, DEFAULT_SETTINGS);
    this.world = createWorld(layout, { ...DEFAULT_SETTINGS, speed: 'chaos' });
    this.world.open = this.world.open.map(() => false);
    serve(this.world, -1);
    this.world.puck.vx *= 1.6;
    this.world.puck.vy *= 1.6;
    this.world.speed = { ...this.world.speed, friction: 0 };
  }

  frame(dt: number, fit: Frame['fit']): Frame {
    this.clock += dt;
    if (this.clock > 3) {
      this.clock = 0;
      this.seats = this.seats >= MAX_SEATS ? MIN_SEATS : this.seats + 1;
      this.reset();
    }
    for (const e of step(this.world, dt)) if (e.k === 'wall') fx.wall(e.x, e.y, e.s * 0.6);
    const { puck } = this.world;
    return {
      layout: this.world.layout,
      settings: { ...DEFAULT_SETTINGS, zone: 'free' },
      phase: 'lobby',
      mySeat: -1,
      seatPlayers: [],
      puck: { x: puck.x, y: puck.y },
      puckSpeed: Math.hypot(puck.vx, puck.vy),
      hitter: -1,
      mallets: [],
      myMallet: null,
      countdown: 0,
      attract: true,
      fit,
    };
  }
}

class PartySession {
  readonly state = new GameState();
  readonly net: Net;
  status: NetStatus = 'connecting';
  pointer: Vec | null = null;
  private myMallet: Vec | null = null;
  private input = new InputSampler();
  private unstableUntil = 0;
  private badSince = Infinity;
  private warned = false;
  private roomAt = 0;
  private lastCount = 0;
  private celebrateTimer = 0;

  constructor(
    readonly code: string,
    name: string,
  ) {
    const pid = playerId();
    this.net = new Net(
      code,
      () => ({ t: 'hello', pid, name }),
      (msg) => this.onMessage(msg),
      (status) => {
        this.status = status;
        ui.update(this.state, status);
      },
    );
    this.net.connect();
  }

  close(): void {
    clearTimeout(this.celebrateTimer);
    this.net.close();
  }

  private onMessage(msg: ServerMsg): void {
    const now = performance.now();
    switch (msg.t) {
      case 'welcome':
        this.state.myId = msg.id;
        break;
      case 'room': {
        const prev = this.state.room;
        this.state.onRoom(msg);
        this.roomAt = now;
        this.onPhase(prev?.phase, msg.phase, (prev?.players.length ?? 0) < msg.players.length);
        ui.update(this.state, this.status);
        break;
      }
      case 's':
        this.state.onSnap(msg, now);
        break;
      case 'goal':
        this.state.onGoal(msg.k, msg);
        break;
      case 'error':
        ui.flash(msg.reason, 4000);
        break;
    }
  }

  private onPhase(prev: Phase | undefined, next: Phase, joined: boolean): void {
    if (prev === next) {
      if (next === 'lobby' && joined) sfx.join();
      return;
    }
    if (next === 'countdown' || next === 'lobby') {
      fx.clear();
      renderer.resetTrail();
      this.lastCount = 0;
    }
    if (next === 'lobby' && prev === undefined) sfx.join();
    if (next === 'playing') {
      if (prev === 'countdown') {
        sfx.tick(true);
        fx.banner = { title: 'GO!', sub: '', color: '#7aa8ff', life: 0.7, max: 0.7 };
      }
    }
    if (next === 'over') {
      const room = this.state.room!;
      const winner = room.players.find((p) => p.id === room.winner);
      this.celebrateTimer = window.setTimeout(() => {
        const { width, height } = renderer.size;
        const colors = winner ? [PALETTE[winner.color], '#ffffff', PALETTE[winner.color]] : PALETTE;
        fx.celebrate(width, height, colors);
        sfx.win();
      }, 500);
    }
  }

  private handleDue(due: Due): void {
    const st = this.state;
    if (due.kind === 'event') {
      const [kind, x, y, s, seat] = due.e;
      if (kind === 0) {
        const p = st.bySeat(seat);
        fx.hit(x, y, p ? PALETTE[p.color] : '#ffffff', s);
        sfx.hit(s);
      } else {
        fx.wall(x, y, s);
        sfx.wall(s);
      }
      return;
    }
    const g = due.goal;
    const conceder = st.bySeat(g.seat);
    const scorer = st.bySeat(g.scorer);
    const who = conceder?.name ?? 'Someone';
    let title = 'GOAL!';
    let sub: string;
    let color = scorer ? PALETTE[scorer.color] : conceder ? PALETTE[conceder.color] : '#ffffff';
    if (g.kind === 'score') sub = `+1 ${scorer?.name ?? ''}`;
    else if (g.kind === 'own') {
      title = 'OWN GOAL!';
      sub = `${who} scored on themselves`;
    } else if (g.kind === 'none') sub = 'Nobody touched it';
    else {
      sub = conceder?.out ? `${who} is OUT` : `${who} loses a life`;
      if (!scorer && conceder) color = PALETTE[conceder.color];
    }
    fx.goal(g.x, g.y, color, { title, sub, color });
    sfx.goal(conceder?.id !== st.myId);
    renderer.resetTrail();
  }

  frame(now: number, fit: Frame['fit']): Frame | null {
    const st = this.state;
    const room = st.room;
    const layout = st.layout;
    if (!room || !layout) return null;

    for (const due of st.takeDue(now)) this.handleDue(due);
    const sample = st.sample(now);
    if (st.takeServe() && sample?.puck) fx.serve(sample.puck.x, sample.puck.y);
    const me = st.me;
    const viewSeat = me && me.seat < layout.seats ? me.seat : -1;
    const active = me && me.seat >= 0 && me.seat < layout.seats && !me.out && room.phase !== 'over' ? me.seat : -1;

    if (active >= 0 && this.pointer) {
      const w = renderer.toWorld(this.pointer.x, this.pointer.y);
      this.myMallet = clampToConvex(w, zoneFor(layout, active, room.settings.zone));
    } else if (active < 0) {
      this.myMallet = null;
    }

    const inMatch = MATCH.includes(room.phase);
    // Players who haven't touched the table yet still send heartbeats, from where the server parked their mallet.
    if (inMatch && active >= 0 && !this.myMallet) this.myMallet = homePosition(layout, active, room.settings.zone);
    if (inMatch && active >= 0 && this.myMallet) {
      const q = this.input.sample(now, this.myMallet);
      if (q) this.net.send({ t: 'p', q });
    }
    document.body.classList.toggle('aiming', active >= 0);

    const live = this.status === 'open' && inMatch;
    if (live && st.lateRate > UNSTABLE_RATE) this.unstableUntil = now + UNSTABLE_HOLD_MS;
    const unstable = live && now < this.unstableUntil;
    ui.setPing(this.net.rtt, unstable);
    this.watchConnection(now, this.net.rtt, unstable);

    const countdown = room.phase === 'countdown' ? Math.max(0, room.timer - (now - this.roomAt)) : 0;
    const count = Math.ceil(countdown / 1000);
    if (room.phase === 'countdown' && count > 0 && count !== this.lastCount) {
      this.lastCount = count;
      sfx.tick(false);
    }

    return {
      layout,
      settings: room.settings,
      phase: room.phase,
      mySeat: viewSeat,
      seatPlayers: Array.from({ length: layout.seats }, (_, i) => st.bySeat(i)),
      puck: inMatch || room.phase === 'over' ? (sample?.puck ?? null) : null,
      puckSpeed: sample?.speed ?? 0,
      hitter: sample?.hitter ?? -1,
      mallets: sample?.mallets ?? [],
      myMallet: this.myMallet,
      countdown,
      fit,
    };
  }

  private watchConnection(now: number, rtt: number, unstable: boolean): void {
    const slow = rtt >= SLOW_MS;
    this.badSince = slow || unstable ? Math.min(this.badSince, now) : Infinity;
    if (this.warned || now - this.badSince < WARN_AFTER_MS) return;
    this.warned = true;
    ui.flash(slow ? `Slow connection (${rtt} ms). A VPN can add lag.` : 'Unstable connection. The puck may stutter.', 5000);
  }
}

let party: PartySession | null = null;
let attract: Attract | null = null;
let pendingCode = '';

const ui = new UI(
  document.getElementById('ui')!,
  {
    create(name) {
      saveName(name);
      const code = randomCode();
      history.pushState(null, '', `/p/${code}`);
      enterParty(code, sanitizeName(name));
    },
    join(raw, name) {
      const code = normalizeCode(raw);
      if (!code) {
        ui.showHome(name, `Party codes are ${CODE_LENGTH} letters and numbers.`);
        return;
      }
      saveName(name);
      history.pushState(null, '', `/p/${code}`);
      enterParty(code, sanitizeName(name));
    },
    enter(name) {
      saveName(name);
      enterParty(pendingCode, sanitizeName(name));
    },
    settings: (s) => party?.net.send({ t: 'settings', s }),
    start: () => party?.net.send({ t: 'start' }),
    again: () => party?.net.send({ t: 'again' }),
    addBot: (level) => party?.net.send({ t: 'addBot', level }),
    removeBot: (id) => party?.net.send({ t: 'removeBot', id }),
    leave() {
      history.pushState(null, '', '/');
      route();
    },
    mute: () => sfx.toggleMute(),
    unlockAudio: () => sfx.unlock(),
  },
  sfx.muted,
);

function showHome(error = ''): void {
  party?.close();
  party = null;
  attract = new Attract();
  fx.clear();
  document.body.classList.remove('aiming');
  ui.showHome(savedName(), error);
}

function enterParty(code: string, name: string): void {
  party?.close();
  attract = null;
  fx.clear();
  renderer.resetTrail();
  ui.showParty(code);
  party = new PartySession(code, name || 'Player');
}

function route(): void {
  const match = location.pathname.match(/^\/p\/([^/]+)\/?$/);
  if (!match) {
    showHome();
    return;
  }
  const code = normalizeCode(match[1]);
  if (!code) {
    history.replaceState(null, '', '/');
    showHome('That party link is not valid.');
    return;
  }
  if (party?.code === code) return;
  const name = savedName();
  if (name) {
    enterParty(code, name);
    return;
  }
  party?.close();
  party = null;
  pendingCode = code;
  attract = new Attract();
  ui.showNamePrompt(code, '');
}

canvas.addEventListener('pointerdown', (e) => {
  sfx.unlock();
  if (party) party.pointer = { x: e.clientX, y: e.clientY };
  if (e.pointerType === 'mouse') return;
  try {
    canvas.setPointerCapture(e.pointerId);
  } catch {
    // the pointer was already released; the next move still updates the mallet
  }
});
canvas.addEventListener('pointermove', (e) => {
  if (party) party.pointer = { x: e.clientX, y: e.clientY };
});
window.addEventListener('resize', () => renderer.resize());
window.addEventListener('popstate', route);

let last = performance.now();
function loop(now: number): void {
  const dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
  last = now;
  fx.update(dt, renderer.size.height);
  const fit = ui.fitRect();
  const frame = party ? party.frame(now, fit) : attract ? attract.frame(dt, fit) : null;
  if (frame) renderer.draw(frame, fx, dt);
  requestAnimationFrame(loop);
}

route();
void document.fonts?.load('700 16px "Chakra Petch"');
requestAnimationFrame(loop);
