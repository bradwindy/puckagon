import type { Settings } from './settings';

/** Bump when client and server messages change shape, so stale tabs are told to reload. */
export const PROTOCOL_VERSION = 1;
export const TICK_HZ = 60;
export const SNAP_EVERY = 2;
export const INPUT_HZ = 30;
/** During a match clients send at least this often, which keeps the room's CPU budget topped up. */
export const INPUT_HEARTBEAT_MS = 250;
export const COUNTDOWN_MS = 3000;
export const SCORED_MS = 1600;
export const RECONNECT_GRACE_MS = 15000;
export const LOBBY_GRACE_MS = 8000;
export const NAME_MAX = 16;
export const MAX_MESSAGE_BYTES = 2048;

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
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  return Array.from(cleaned).slice(0, NAME_MAX).join('').trim();
}

export type Phase = 'lobby' | 'countdown' | 'playing' | 'scored' | 'over';

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
}

export type ServerMsg =
  | { t: 'welcome'; id: string }
  | RoomMsg
  | SnapMsg
  | ({ t: 'goal'; k: number } & GoalInfo)
  | { t: 'error'; reason: string };

export type ClientMsg =
  | { t: 'hello'; pid: string; name: string }
  | { t: 'p'; x: number; y: number }
  | { t: 'settings'; s: Partial<Settings> }
  | { t: 'start' }
  | { t: 'again' };

export const round = (n: number): number => Math.round(n * 10000) / 10000;
