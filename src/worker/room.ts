import { MAX_SEATS, MIN_SEATS } from '../shared/geometry';
import {
  BOT_LEVELS,
  COUNTDOWN_MS,
  HOST_GRACE_MS,
  HOST_SILENT_MS,
  LOBBY_GRACE_MS,
  MATCH_PHASES,
  PALETTE,
  type BotLevel,
  type MatchMsg,
  type Phase,
  type PublicPlayer,
  type RoomMsg,
  type SeatState,
  type ServerMsg,
} from '../shared/protocol';
import { DEFAULT_SETTINGS, sanitizeSettings, type Settings } from '../shared/settings';

export interface RoomIO {
  send(pid: string, msg: ServerMsg): void;
  broadcast(msg: ServerMsg): void;
  newId(): string;
  /** When the player's socket last showed it is alive (ms), or null when they have no socket. */
  seenAt(pid: string): number | null;
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
  /** Whether the player's socket to the party is open. */
  connected: boolean;
  /** Whether the host last reported a working game link for this seat. Shown as `connected` during a match. */
  linked: boolean;
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
  match: number;
  v: number;
  k: number;
  timer: number;
  players: Player[];
}

const REPORT_PHASES: Phase[] = [...MATCH_PHASES, 'over'];
const MAX_PING_MS = 9999;
/** Twelve seats plus a bench. Joins past this are turned away. */
export const MAX_PLAYERS = 24;
const BOT_NAMES = ['Robo', 'Bleep', 'Sparky', 'Gizmo', 'Turbo', 'Pixel', 'Widget', 'Nibbles', 'Chip', 'Zap', 'Bolt', 'Dot'];

const isSeatState = (s: unknown): s is SeatState => {
  if (typeof s !== 'object' || s === null) return false;
  const { score, lives, out, linked } = s as Record<string, unknown>;
  return Number.isFinite(score) && Number.isFinite(lives) && typeof out === 'boolean' && typeof linked === 'boolean';
};

/**
 * One party's lobby, independent of Durable Object plumbing. The host's browser runs each match and reports its state,
 * which the room mirrors so everyone, including people who join mid-match, sees the same scores.
 */
export class Room {
  phase: Phase = 'lobby';
  settings: Settings = { ...DEFAULT_SETTINGS };
  players: Player[] = [];
  host = '';
  winner: string | null = null;
  seats = MIN_SEATS;
  /** Number of the match in play or last played. */
  match = 0;
  /** Version of the host's last accepted report. */
  v = 0;
  /** Host tick at which the reported phase began. */
  k = 0;
  /** ms left in a countdown or goal pause, as of the host's last report. */
  timer = 0;

  /** Last ping shown to the room, by pid. Kept off Player so it is never written to storage. */
  private pings = new Map<string, number>();

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
      match: this.match,
      v: this.v,
      k: this.k,
      timer: this.timer,
      players: this.players,
    };
  }

  /**
   * Rebuilds after the Durable Object wakes. Players whose socket is gone get a fresh grace, so a close that woke the
   * object, or a deploy restart, still runs through the normal leave path, and a host who doesn't come back ends the
   * match after HOST_GRACE_MS. `pings` holds the last ping shown for live players.
   */
  restore(snap: RoomSnapshot, livePids: Set<string>, now: number, pings: Map<string, number>): void {
    this.settings = sanitizeSettings(snap.settings);
    this.pings = pings;
    this.players = snap.players.map((p) => {
      const bot = p.bot ?? null;
      const connected = bot !== null || livePids.has(p.pid);
      return { ...p, bot, connected, linked: p.linked ?? true, goneAt: connected ? -1 : now };
    });
    this.host = snap.host;
    this.winner = snap.winner;
    this.seats = snap.seats;
    // Snapshots from before the host ran matches have no match number, and nobody could carry those matches on.
    this.match = snap.match ?? 0;
    this.v = snap.v ?? 0;
    this.k = snap.k ?? 0;
    this.timer = snap.timer ?? 0;
    const keep = snap.phase === 'over' || (MATCH_PHASES.includes(snap.phase) && this.match > 0);
    this.phase = keep ? snap.phase : 'lobby';
    if (this.phase === 'lobby') this.resetForLobby();
    this.ensureHost();
  }

  private find(pid: string): Player | undefined {
    return this.players.find((p) => p.pid === pid);
  }

  idOf(pid: string): string | undefined {
    return this.find(pid)?.id;
  }

  /** The connected person, other than `from`, whose public id is `to`. Game links only join the host and a guest. */
  peer(from: string, to: unknown): Player | undefined {
    return this.players.find(
      (p) => p.id === to && p.pid !== from && p.connected && !p.bot && (from === this.host || p.pid === this.host),
    );
  }

  private publicPlayer(p: Player): PublicPlayer {
    const connected = this.inMatch && p.seat >= 0 ? p.linked : p.connected;
    return {
      id: p.id,
      name: p.name,
      color: p.color,
      seat: p.seat,
      score: p.score,
      lives: p.lives,
      out: p.out,
      connected,
      bot: p.bot,
      ping: p.bot || !connected ? -1 : (this.pings.get(p.pid) ?? -1),
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
      timer: this.timer,
      winner: this.winner ? (this.find(this.winner)?.id ?? null) : null,
      match: this.match,
      v: this.v,
      k: this.k,
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

  /** Hands host to the first connected person other than the current host, if there is one. */
  private passHost(): void {
    const next = this.players.find((p) => p.connected && !p.bot && p.pid !== this.host);
    if (next) this.host = next.pid;
  }

  private reseatLobby(): void {
    let seat = 0;
    for (const p of this.players) p.seat = seat < MAX_SEATS ? seat++ : -1;
    this.seats = Math.max(MIN_SEATS, seat);
  }

  private resetForLobby(): void {
    this.timer = 0;
    for (const p of this.players) {
      p.score = 0;
      p.lives = this.settings.target;
      p.out = false;
    }
    this.reseatLobby();
  }

  /** Ends a match before its result: back to a fresh lobby, without the players who left for good. */
  private endMatch(): void {
    this.players = this.players.filter((p) => p.connected || p.goneAt >= 0);
    this.phase = 'lobby';
    this.winner = null;
    this.resetForLobby();
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
      linked: true,
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
    this.reseatLobby();
    this.broadcastRoom();
  }

  /**
   * A socket closed. After a dropped connection the player keeps their place for a short grace period in case they
   * are reloading. After pressing Leave (`quit`) they are gone at once. A host who quits ends the match, and a seated
   * player who quits has their goal closed by the host.
   */
  leave(pid: string, now: number, quit = false): void {
    const p = this.find(pid);
    if (!p) return;
    const host = pid === this.host;
    p.connected = false;
    p.goneAt = now;
    this.pings.delete(pid);
    // A host whose socket dropped keeps the match for HOST_GRACE_MS, even when they were only watching it.
    if (quit || (this.inMatch && p.seat < 0 && !host)) this.drop(p);
    if (quit && host && this.inMatch) {
      this.passHost();
      this.endMatch();
    } else if (quit && this.inMatch && p.seat >= 0) {
      this.io.send(this.host, { t: 'left', id: p.id });
    }
    this.ensureHost();
    if (this.wipeIfEmpty()) return;
    if (this.phase === 'lobby') this.reseatLobby();
    this.broadcastRoom();
  }

  /** Removes a player whose grace is spent. Seated players stay listed during and after a match so their score is still shown. */
  private drop(p: Player): void {
    p.goneAt = -1;
    if (p.seat < 0 || this.phase === 'lobby') this.players = this.players.filter((q) => q !== p);
  }

  /** Forgets the whole party once no person is connected or about to come back. */
  private wipeIfEmpty(): boolean {
    if (this.players.some((q) => !q.bot && (q.connected || q.goneAt >= 0))) return false;
    this.players = [];
    this.phase = 'lobby';
    this.resetForLobby();
    return true;
  }

  /**
   * When the match's host counts as gone: HOST_GRACE_MS after their socket dropped, or HOST_SILENT_MS after an open
   * socket last showed life (a locked phone or frozen tab keeps its socket but stops running the match).
   */
  private hostGoneAt(): number {
    const host = this.find(this.host);
    if (!host || (!host.connected && host.goneAt < 0)) return -Infinity;
    if (!host.connected) return host.goneAt + HOST_GRACE_MS;
    return (this.io.seenAt(host.pid) ?? Infinity) + HOST_SILENT_MS;
  }

  /** Spends the grace of players who have not come back, and ends a match whose host is gone. Returns true if anything changed. */
  purge(now: number): boolean {
    let changed = false;
    for (const p of [...this.players]) {
      if (p.connected || p.goneAt < 0 || now - p.goneAt < LOBBY_GRACE_MS) continue;
      this.drop(p);
      changed = true;
    }
    if (this.inMatch && now >= this.hostGoneAt()) {
      this.passHost();
      this.endMatch();
      changed = true;
    }
    if (!changed) return false;
    if (this.wipeIfEmpty()) return true;
    if (this.phase === 'lobby') this.reseatLobby();
    this.ensureHost();
    this.broadcastRoom();
    return true;
  }

  /** The earliest time purge() could change something, or null. */
  nextPurgeAt(): number | null {
    const times = this.players.filter((p) => !p.connected && p.goneAt >= 0).map((p) => p.goneAt + LOBBY_GRACE_MS);
    if (this.inMatch) times.push(this.hostGoneAt());
    const at = Math.min(...times);
    return at === Infinity ? null : at;
  }

  /**
   * Stores a player's ping and tells the room when it is new or has moved enough to matter.
   * Returns the ping now shown for them, or null when the report is ignored.
   */
  reportPing(pid: string, ms: unknown): number | null {
    const p = this.find(pid);
    if (!p || p.bot || typeof ms !== 'number' || !Number.isFinite(ms)) return null;
    const ping = Math.round(Math.max(0, Math.min(MAX_PING_MS, ms)));
    const shown = this.pings.get(pid);
    if (shown !== undefined && Math.abs(ping - shown) < Math.max(20, shown * 0.2)) return shown;
    this.pings.set(pid, ping);
    this.broadcastRoom();
    return ping;
  }

  updateSettings(pid: string, partial: unknown): void {
    if (pid !== this.host || this.phase !== 'lobby') return;
    const merged = { ...this.settings, ...(typeof partial === 'object' && partial ? partial : {}) };
    this.settings = sanitizeSettings(merged, this.settings);
    for (const p of this.players) p.lives = this.settings.target;
    this.broadcastRoom();
  }

  /** Seats the connected players and opens match number `match`. The host's page runs it from here. */
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
    for (const p of seated) {
      p.score = 0;
      p.lives = this.settings.target;
      p.out = false;
      p.linked = true;
    }
    this.winner = null;
    this.match++;
    this.v = 0;
    this.k = 0;
    this.timer = COUNTDOWN_MS;
    this.phase = 'countdown';
    this.broadcastRoom();
  }

  /**
   * Mirrors the host's match state. Only the host's reports for the match in play count, and only newer ones, so the
   * repeat a host page sends each time its socket opens is ignored.
   */
  report(pid: string, msg: MatchMsg): void {
    if (pid !== this.host || !this.inMatch || msg.match !== this.match) return;
    if (!Number.isSafeInteger(msg.v) || msg.v <= this.v || !REPORT_PHASES.includes(msg.phase)) return;
    if (!Number.isFinite(msg.k) || !Number.isFinite(msg.timer)) return;
    const seats: unknown = msg.seats;
    if (!Array.isArray(seats) || seats.length !== this.seats || !seats.every(isSeatState)) return;
    const seated = this.players.filter((p) => p.seat >= 0);
    const winner = msg.winner === null ? null : seated.find((p) => p.id === msg.winner);
    if (winner === undefined) return;
    this.phase = msg.phase;
    this.v = msg.v;
    this.k = msg.k;
    this.timer = msg.timer;
    this.winner = winner?.pid ?? null;
    for (const p of seated) {
      const { score, lives, out, linked } = seats[p.seat];
      Object.assign(p, { score, lives, out, linked });
    }
    this.broadcastRoom();
  }

  /** The host's page can't run the match the room thinks is in play (it reloaded), so the match ends. */
  abort(pid: string, match: unknown): void {
    if (pid !== this.host || !this.inMatch || match !== this.match) return;
    this.endMatch();
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
}
