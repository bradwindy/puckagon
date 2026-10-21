import type { Settings } from './settings';

/** Bump when client and server messages change shape, so stale tabs are told to reload. */
export const PROTOCOL_VERSION = 4;
export const TICK_HZ = 60;
export const SNAP_EVERY = 1;
export const INPUT_HZ = 60;
/** Clients sample the pointer once per tick and send the samples in batches at INPUT_HZ, so the server can move the mallet every tick. */
export const SAMPLE_HZ = TICK_HZ;
/** The most samples one input message may carry. */
export const MAX_SAMPLES = 4;
/** How often clients time a 'ping' against the server's automatic 'pong'. */
export const PING_MS = 2000;
export const COUNTDOWN_MS = 3000;
export const SCORED_MS = 1600;
export const RECONNECT_GRACE_MS = 15000;
export const LOBBY_GRACE_MS = 8000;
export const NAME_MAX = 16;
export const MAX_MESSAGE_BYTES = 2048;

/** Application WebSocket close codes. */
export const CLOSE = {
  replaced: 4000,
  outdated: 4001,
  full: 4002,
  left: 4003,
} as const;

export const PALETTE = [
  '#ff2e63',
  '#08d9d6',
  '#ffd23f',
  '#7cfc00',
  '#a259ff',
  '#ff7f11',
  '#00f5a0',
  '#ff4ecd',
  '#3d7bff',
  '#f4f4ff',
  '#ffa8a8',
  '#b8f2ff',
];

export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const CODE_LENGTH = 5;
const CODE_RE = new RegExp(`^[${CODE_ALPHABET}]{${CODE_LENGTH}}$`);

export function normalizeCode(raw: string): string | null {
  const code = raw.trim().toUpperCase();
  return CODE_RE.test(code) ? code : null;
}

export function sanitizeName(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const cleaned = raw
    .normalize('NFC')
    // Strip control and format characters (bidi overrides, zero-width spaces), but keep the joiners emoji need.
    .replace(/(?![\u200d\u{e0020}-\u{e007f}])[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  return Array.from(cleaned).slice(0, NAME_MAX).join('').trim();
}

export type Phase = 'lobby' | 'countdown' | 'playing' | 'scored' | 'over';

export const BOT_LEVELS = ['easy', 'medium', 'hard'] as const;
export type BotLevel = (typeof BOT_LEVELS)[number];

export interface PublicPlayer {
  id: string;
  name: string;
  color: number;
  /** Seat in the current match, or -1 when watching. */
  seat: number;
  score: number;
  lives: number;
  out: boolean;
  connected: boolean;
  /** Difficulty for computer players, null for people. */
  bot: BotLevel | null;
  /** Round-trip time to the server in ms as the player last reported it, or -1 when unknown. */
  ping: number;
}

export type GoalKind = 'score' | 'own' | 'none' | 'life';

export interface GoalInfo {
  /** Seat whose goal the puck went into. */
  seat: number;
  /** Seat credited with the point, or -1. */
  scorer: number;
  kind: GoalKind;
  x: number;
  y: number;
}

export interface RoomMsg {
  t: 'room';
  phase: Phase;
  host: string;
  settings: Settings;
  players: PublicPlayer[];
  /** Seat count of the table in play (or that would be in play, in the lobby). */
  seats: number;
  /** ms left in a countdown or goal pause. */
  timer: number;
  winner: string | null;
}

/** [kind, x, y, strength, seat] where kind 0 is a mallet hit and 1 is a wall bounce. */
export type WireEvent = [0 | 1, number, number, number, number];

export interface SnapMsg {
  t: 's';
  /** Server tick number. */
  k: number;
  /** puck x, y, vx, vy */
  p: [number, number, number, number];
  /** mallet position by seat, or 0 when the seat has no mallet */
  m: ([number, number] | 0)[];
  /** last hitter seat */
  h: number;
  e: WireEvent[];
  /** By seat, the sequence number of the last pointer sample the server applied, or -1 (bots, or none yet). */
  a: number[];
}

export type ServerMsg =
  | { t: 'welcome'; id: string }
  | RoomMsg
  | SnapMsg
  | ({ t: 'goal'; k: number } & GoalInfo)
  | { t: 'error'; reason: string };

export type ClientMsg =
  | { t: 'hello'; pid: string; name: string }
  /** Pointer samples in table units, oldest first, flattened as [x0, y0, x1, y1, ...]. `s` numbers the first sample. */
  | { t: 'p'; s: number; q: number[] }
  | { t: 'rtt'; ms: number }
  | { t: 'settings'; s: Partial<Settings> }
  | { t: 'start' }
  | { t: 'again' }
  | { t: 'addBot'; level: BotLevel }
  | { t: 'removeBot'; id: string };

export const round = (n: number): number => Math.round(n * 10000) / 10000;
