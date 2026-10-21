import { homePosition, makeLayout, MAX_SEATS, MIN_SEATS } from '../shared/geometry';
import { createWorld, placeMallet, resetPuck, serve, setTarget, step, type World } from '../shared/physics';
import {
  COUNTDOWN_MS,
  PALETTE,
  LOBBY_GRACE_MS,
  RECONNECT_GRACE_MS,
  round,
  SCORED_MS,
  SNAP_EVERY,
  TICK_HZ,
  type Phase,
  type PublicPlayer,
  type RoomMsg,
  type ServerMsg,
  type WireEvent,
} from '../shared/protocol';
import { resolveGoal } from '../shared/rules';
import { DEFAULT_SETTINGS, sanitizeSettings, type Settings } from '../shared/settings';

export interface RoomIO {
  send(pid: string, msg: ServerMsg): void;
  broadcast(msg: ServerMsg): void;
  random(): number;
  newId(): string;
}

export interface Player {
  pid: string;
  id: string;
  name: string;
  color: number;
  seat: number;
  score: number;
  lives: number;
  out: boolean;
  connected: boolean;
  /** When the player's socket dropped (ms), or -1 while connected or once their grace has been spent. */
  goneAt: number;
}

export interface RoomSnapshot {
  phase: Phase;
  settings: Settings;
  host: string;
  winner: string | null;
  seats: number;
  players: Player[];
}

const STEP_MS = 1000 / TICK_HZ;
const ticks = (ms: number) => Math.round(ms / STEP_MS);
const COUNTDOWN_TICKS = ticks(COUNTDOWN_MS);
const SCORED_TICKS = ticks(SCORED_MS);
const MATCH_PHASES: Phase[] = ['countdown', 'playing', 'scored'];

/**
 * One party's game rules, independent of Durable Object plumbing.
 * Time only moves through tick(), one fixed physics step per call.
 */
export class Room {
  phase: Phase = 'lobby';
  settings: Settings = { ...DEFAULT_SETTINGS };
  players: Player[] = [];
  host = '';
  winner: string | null = null;
  seats = MIN_SEATS;
  world: World | null = null;

  private timer = 0;
  private lastConceded = -1;
  private tickCount = 0;
  private pending: WireEvent[] = [];

  constructor(private io: RoomIO) {}

  get inMatch(): boolean {
    return MATCH_PHASES.includes(this.phase);
  }

  snapshot(): RoomSnapshot {
    return {
      phase: this.phase,
      settings: this.settings,
      host: this.host,
      winner: this.winner,
      seats: this.seats,
      players: this.players,
    };
  }

  /** Rebuilds after the Durable Object wakes. A match can't survive a restart, so it falls back to the lobby. */
  restore(snap: RoomSnapshot, connectedPids: Set<string>): void {
    this.settings = sanitizeSettings(snap.settings);
    this.players = snap.players.filter((p) => connectedPids.has(p.pid)).map((p) => ({ ...p, connected: true, goneAt: -1 }));
    this.host = snap.host;
    this.winner = snap.winner;
    this.seats = snap.seats;
    this.phase = snap.phase === 'over' ? 'over' : 'lobby';
    if (this.phase === 'lobby') this.resetForLobby();
    this.ensureHost();
  }

  private find(pid: string): Player | undefined {
    return this.players.find((p) => p.pid === pid);
  }

  private publicPlayer(p: Player): PublicPlayer {
    return {
      id: p.id,
      name: p.name,
      color: p.color,
      seat: p.seat,
      score: p.score,
      lives: p.lives,
      out: p.out,
      connected: p.connected,
    };
  }

  roomMsg(): RoomMsg {
    return {
      t: 'room',
      phase: this.phase,
      host: this.find(this.host)?.id ?? '',
      settings: this.settings,
      players: this.players.map((p) => this.publicPlayer(p)),
      seats: this.seats,
      timer: this.phase === 'countdown' || this.phase === 'scored' ? Math.round(this.timer * STEP_MS) : 0,
      winner: this.winner ? (this.find(this.winner)?.id ?? null) : null,
    };
  }

  private broadcastRoom(): void {
    this.io.broadcast(this.roomMsg());
  }

  /** Keeps the host while they are connected or still inside their reconnect grace. */
  private ensureHost(): void {
    const host = this.find(this.host);
    if (host && (host.connected || host.goneAt >= 0)) return;
    this.host = this.players.find((p) => p.connected)?.pid ?? '';
  }

  private reseatLobby(): void {
    let seat = 0;
    for (const p of this.players) p.seat = seat < MAX_SEATS ? seat++ : -1;
    this.seats = Math.max(MIN_SEATS, seat);
  }

  private resetForLobby(): void {
    this.world = null;
    for (const p of this.players) {
      p.score = 0;
      p.lives = this.settings.target;
      p.out = false;
    }
    this.reseatLobby();
  }

  join(pid: string, name: string): Player {
    let p = this.find(pid);
    if (p) {
      p.connected = true;
      p.goneAt = -1;
      p.name = name;
    } else {
      const used = new Set(this.players.map((q) => q.color));
      const color = PALETTE.findIndex((_, i) => !used.has(i));
      p = {
        pid,
        id: this.io.newId(),
        name,
        color: color < 0 ? this.players.length % PALETTE.length : color,
        seat: -1,
        score: 0,
        lives: this.settings.target,
        out: false,
        connected: true,
        goneAt: -1,
      };
      this.players.push(p);
      if (this.phase === 'lobby') this.reseatLobby();
    }
    this.ensureHost();
    this.io.send(pid, { t: 'welcome', id: p.id });
    this.broadcastRoom();
    return p;
  }

  /** A socket dropped. The player keeps their place for a short grace period in case they are reloading. */
  leave(pid: string, now: number): void {
    const p = this.find(pid);
    if (!p) return;
    if (this.inMatch && p.seat < 0) {
      this.players = this.players.filter((q) => q !== p);
    } else {
      p.connected = false;
      p.goneAt = now;
    }
    this.ensureHost();
    if (!this.players.some((q) => q.connected)) {
      this.players = [];
      this.phase = 'lobby';
      this.resetForLobby();
      return;
    }
    this.broadcastRoom();
  }

  /** Spends the grace of players who have not come back. Returns true if anything changed. */
  purge(now: number): boolean {
    let changed = false;
    for (const p of [...this.players]) {
      if (p.connected || p.goneAt < 0) continue;
      if (now - p.goneAt < (this.inMatch ? RECONNECT_GRACE_MS : LOBBY_GRACE_MS)) continue;
      p.goneAt = -1;
      changed = true;
      if (this.inMatch && p.seat >= 0) this.knockOut(p);
      else if (!(this.phase === 'over' && p.seat >= 0)) this.players = this.players.filter((q) => q !== p);
    }
    if (!changed) return false;
    if (this.phase === 'lobby') this.reseatLobby();
    this.ensureHost();
    if (!this.inMatch || !this.checkWinner()) this.broadcastRoom();
    return true;
  }

  /** The earliest time purge() could change something, or null. */
  nextPurgeAt(): number | null {
    const grace = this.inMatch ? RECONNECT_GRACE_MS : LOBBY_GRACE_MS;
    const times = this.players.filter((p) => !p.connected && p.goneAt >= 0).map((p) => p.goneAt + grace);
    return times.length ? Math.min(...times) : null;
  }

  input(pid: string, x: number, y: number): void {
    const p = this.find(pid);
    if (!this.world || !p || p.seat < 0 || p.out) return;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    setTarget(this.world, p.seat, { x: Math.max(-2, Math.min(2, x)), y: Math.max(-2, Math.min(2, y)) });
  }

  updateSettings(pid: string, partial: unknown): void {
    if (pid !== this.host || this.phase !== 'lobby') return;
    const merged = { ...this.settings, ...(typeof partial === 'object' && partial ? partial : {}) };
    this.settings = sanitizeSettings(merged, this.settings);
    for (const p of this.players) p.lives = this.settings.target;
    this.broadcastRoom();
  }

  start(pid: string): void {
    if (pid !== this.host || this.phase !== 'lobby') return;
    this.players = this.players.filter((p) => p.connected);
    this.reseatLobby();
    const seated = this.players.filter((p) => p.seat >= 0);
    if (seated.length < MIN_SEATS) return;
    this.seats = seated.length;
    const layout = makeLayout(this.seats, this.settings);
    this.world = createWorld(layout, this.settings, this.io.random);
    for (const p of seated) {
      p.score = 0;
      p.lives = this.settings.target;
      p.out = false;
      placeMallet(this.world, p.seat, homePosition(layout, p.seat, this.settings.zone));
    }
    this.winner = null;
    this.lastConceded = -1;
    this.phase = 'countdown';
    this.timer = COUNTDOWN_TICKS;
    this.broadcastRoom();
  }

  again(pid: string): void {
    if (pid !== this.host || this.phase !== 'over') return;
    this.players = this.players.filter((p) => p.connected);
    this.phase = 'lobby';
    this.winner = null;
    this.resetForLobby();
    this.ensureHost();
    this.broadcastRoom();
  }

  /** One fixed physics step of 1/TICK_HZ seconds. `now` only drives the coarse reconnect grace. */
  tick(now: number): void {
    const world = this.world;
    if (!world || !this.inMatch) return;
    this.tickCount++;
    this.purge(now);
    if (!this.inMatch) return;

    if (this.phase === 'countdown' || this.phase === 'scored') {
      this.timer--;
      if (this.timer <= 0) {
        serve(world, this.phase === 'scored' ? this.lastConceded : -1);
        this.phase = 'playing';
        this.broadcastRoom();
      }
    }

    for (const e of step(world, 1 / TICK_HZ)) {
      if (e.k === 'goal') {
        if (this.phase === 'playing') this.goal(e.seat, e.x, e.y);
      } else if (e.k === 'hit') {
        this.pending.push([0, round(e.x), round(e.y), round(e.s), e.seat]);
      } else {
        this.pending.push([1, round(e.x), round(e.y), round(e.s), -1]);
      }
    }

    if (this.inMatch && this.tickCount % SNAP_EVERY === 0) this.broadcastSnap();
  }

  private broadcastSnap(): void {
    const world = this.world;
    if (!world) return;
    const { puck } = world;
    this.io.broadcast({
      t: 's',
      k: this.tickCount,
      p: [round(puck.x), round(puck.y), round(puck.vx), round(puck.vy)],
      m: world.mallets.map((m) => (m ? [round(m.x), round(m.y)] : 0)),
      h: world.lastHitter,
      e: this.pending,
    });
    this.pending = [];
  }

  private seatPlayer(seat: number): Player | undefined {
    return this.players.find((p) => p.seat === seat);
  }

  private goal(seat: number, x: number, y: number): void {
    const world = this.world;
    if (!world) return;
    const { scorer, kind } = resolveGoal(this.settings.mode, seat, world.lastHitter);
    const conceder = this.seatPlayer(seat);
    if (kind === 'score') {
      const p = this.seatPlayer(scorer);
      if (p) p.score++;
    }
    if (kind === 'life' && conceder) {
      conceder.lives = Math.max(0, conceder.lives - 1);
      if (conceder.lives === 0) this.knockOut(conceder);
    }
    resetPuck(world);
    this.lastConceded = seat;
    this.io.broadcast({ t: 'goal', k: this.tickCount, seat, scorer, kind, x: round(x), y: round(y) });
    if (!this.checkWinner()) {
      this.phase = 'scored';
      this.timer = SCORED_TICKS;
      this.broadcastRoom();
    }
  }

  private knockOut(p: Player): void {
    p.out = true;
    if (!this.world || p.seat < 0) return;
    this.world.open[p.seat] = false;
    this.world.mallets[p.seat] = null;
  }

  private checkWinner(): boolean {
    const seated = this.players.filter((p) => p.seat >= 0);
    const alive = seated.filter((p) => !p.out);
    let winner: Player | undefined;
    if (alive.length <= 1) winner = alive[0];
    else if (this.settings.mode === 'points') winner = seated.find((p) => p.score >= this.settings.target);
    if (!winner && alive.length > 1) return false;
    this.winner = winner?.pid ?? null;
    this.phase = 'over';
    this.world = null;
    this.broadcastRoom();
    return true;
  }
}
