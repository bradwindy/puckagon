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
  BOT_LEVELS,
  type BotLevel,
  type Phase,
  type PublicPlayer,
  type RoomMsg,
  type ServerMsg,
  type WireEvent,
} from '../shared/protocol';
import { resolveGoal } from '../shared/rules';
import { DEFAULT_SETTINGS, sanitizeSettings, type Settings } from '../shared/settings';
import { BOT_NAMES, botTarget, newBrain, type BotBrain } from './bot';

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
  /** Difficulty for computer players, null for people. Bots have no socket and are always connected. */
  bot: BotLevel | null;
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
/** Twelve seats plus a bench. Joins past this are turned away. */
export const MAX_PLAYERS = 24;

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
  private brains = new Map<string, BotBrain>();

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

  /**
   * Rebuilds after the Durable Object wakes. Players whose socket is gone get a fresh reconnect grace,
   * so a close that woke the object, or a deploy restart, still runs through the normal leave path.
   * A match can't survive a restart, so it falls back to the lobby.
   */
  restore(snap: RoomSnapshot, livePids: Set<string>, now: number): void {
    this.settings = sanitizeSettings(snap.settings);
    this.players = snap.players.map((p) => {
      const bot = p.bot ?? null;
      const connected = bot !== null || livePids.has(p.pid);
      return { ...p, bot, connected, goneAt: connected ? -1 : now };
    });
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
      bot: p.bot,
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
    if (host && !host.bot && (host.connected || host.goneAt >= 0)) return;
    this.host = this.players.find((p) => p.connected && !p.bot)?.pid ?? '';
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

  private newPlayer(pid: string, name: string, bot: BotLevel | null): Player {
    const used = new Set(this.players.map((q) => q.color));
    const color = PALETTE.findIndex((_, i) => !used.has(i));
    const p: Player = {
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
      bot,
    };
    this.players.push(p);
    if (this.phase === 'lobby') this.reseatLobby();
    return p;
  }

  join(pid: string, name: string): Player {
    let p = this.find(pid);
    if (p) {
      p.connected = true;
      p.goneAt = -1;
      p.name = name;
    } else {
      p = this.newPlayer(pid, name, null);
    }
    this.ensureHost();
    this.io.send(pid, { t: 'welcome', id: p.id });
    this.broadcastRoom();
    return p;
  }

  addBot(pid: string, level: unknown): void {
    if (pid !== this.host || this.phase !== 'lobby' || !BOT_LEVELS.includes(level as BotLevel)) return;
    if (this.players.filter((p) => p.seat >= 0).length >= MAX_SEATS || this.players.length >= MAX_PLAYERS) return;
    const taken = new Set(this.players.map((p) => p.name));
    const name = BOT_NAMES.find((n) => !taken.has(n)) ?? `Bot ${this.players.length + 1}`;
    const id = this.io.newId();
    this.newPlayer(`bot:${id}`, name, level as BotLevel);
    this.broadcastRoom();
  }

  removeBot(pid: string, id: unknown): void {
    if (pid !== this.host || this.phase !== 'lobby') return;
    const bot = this.players.find((p) => p.bot && p.id === id);
    if (!bot) return;
    this.players = this.players.filter((p) => p !== bot);
    this.brains.delete(bot.pid);
    this.reseatLobby();
    this.broadcastRoom();
  }

  /**
   * A socket closed. After a dropped connection the player keeps their place for a short grace period
   * in case they are reloading. After pressing Leave (`quit`) they are gone at once.
   */
  leave(pid: string, now: number, quit = false): void {
    const p = this.find(pid);
    if (!p) return;
    p.connected = false;
    p.goneAt = now;
    if (quit || (this.inMatch && p.seat < 0)) this.drop(p);
    this.ensureHost();
    if (this.wipeIfEmpty()) return;
    if (this.phase === 'lobby') this.reseatLobby();
    if (!this.inMatch || !this.checkWinner()) this.broadcastRoom();
  }

  /** Removes a player whose grace is spent. Seated players stay listed so their score is still shown. */
  private drop(p: Player): void {
    p.goneAt = -1;
    if (this.inMatch && p.seat >= 0) this.knockOut(p);
    else if (!(this.phase === 'over' && p.seat >= 0)) this.players = this.players.filter((q) => q !== p);
  }

  /** Forgets the whole party once no person is connected or about to come back. */
  private wipeIfEmpty(): boolean {
    if (this.players.some((q) => !q.bot && (q.connected || q.goneAt >= 0))) return false;
    this.players = [];
    this.brains.clear();
    this.phase = 'lobby';
    this.resetForLobby();
    return true;
  }

  /** Spends the grace of players who have not come back. Returns true if anything changed. */
  purge(now: number): boolean {
    let changed = false;
    for (const p of [...this.players]) {
      if (p.connected || p.goneAt < 0) continue;
      if (now - p.goneAt < (this.inMatch ? RECONNECT_GRACE_MS : LOBBY_GRACE_MS)) continue;
      this.drop(p);
      changed = true;
    }
    if (!changed) return false;
    if (this.wipeIfEmpty()) return true;
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
    if (this.players.filter((p) => p.connected).length < MIN_SEATS) {
      this.broadcastRoom();
      return;
    }
    this.players = this.players.filter((p) => p.connected);
    this.reseatLobby();
    const seated = this.players.filter((p) => p.seat >= 0);
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
    const people = this.players.filter((p) => p.connected && !p.bot);
    const bots = this.players.filter((p) => p.bot);
    this.players = [...people.filter((p) => p.seat < 0), ...people.filter((p) => p.seat >= 0), ...bots];
    this.players = this.players.filter((p, i) => !p.bot || i < MAX_SEATS);
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
    this.driveBots(world);

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

  private driveBots(world: World): void {
    for (const p of this.players) {
      if (!p.bot || p.seat < 0 || p.out) continue;
      let brain = this.brains.get(p.pid);
      if (!brain) this.brains.set(p.pid, (brain = newBrain()));
      const target = botTarget(world, p.seat, p.bot, brain, this.io.random, 1 / TICK_HZ);
      if (target) setTarget(world, p.seat, target);
    }
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
    const { scorer, kind } = resolveGoal(this.settings.mode, seat, world.touches);
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
    this.world.touches = this.world.touches.filter((s) => s !== p.seat);
    if (this.world.lastHitter === p.seat) this.world.lastHitter = -1;
  }

  private checkWinner(): boolean {
    const seated = this.players.filter((p) => p.seat >= 0);
    const alive = seated.filter((p) => !p.out);
    let winner: Player | undefined;
    if (alive.length <= 1) winner = alive[0];
    else if (this.settings.mode === 'points') winner = alive.find((p) => p.score >= this.settings.target);
    if (!winner && alive.length > 1) return false;
    this.winner = winner?.pid ?? null;
    this.phase = 'over';
    this.world = null;
    this.broadcastRoom();
    return true;
  }
}
