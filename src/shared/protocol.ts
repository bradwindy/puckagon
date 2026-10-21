import type { Settings } from './settings';

/** Bump when page, host or server messages change shape, so stale tabs are told to reload. */
export const PROTOCOL_VERSION = 5;
export const TICK_HZ = 60;
export const SNAP_EVERY = 1;
export const INPUT_HZ = 60;
/** Players sample the pointer once per tick and send each sample as it is taken, so the host can move the mallet every tick. */
export const SAMPLE_HZ = TICK_HZ;
/**
 * The most samples one input message may carry. Each message repeats every sample the host hasn't acknowledged yet,
 * about a quarter of a second at most, so a lost message costs nothing.
 */
export const MAX_SAMPLES = 15;
/** How often guests time a ping to the host over the game link. */
export const PING_MS = 1000;
/** How often every page pings the party server, to keep its socket alive and show the server the page still runs. */
export const KEEPALIVE_MS = 5000;
export const COUNTDOWN_MS = 3000;
export const SCORED_MS = 1600;
/** How long a seated player whose game link dropped keeps their seat before their goal becomes a wall. */
export const RECONNECT_GRACE_MS = 15000;
/** How long the party keeps a player whose socket dropped. */
export const LOBBY_GRACE_MS = 8000;
/** How long the party waits for a host whose socket dropped mid-match before it ends the match and picks a new host. */
export const HOST_GRACE_MS = 5000;
/** A host page whose keepalive pings stop for this long mid-match (a locked phone, a frozen tab) counts as gone. */
export const HOST_SILENT_MS = 4 * KEEPALIVE_MS;
export const NAME_MAX = 16;
/** The largest message the party server accepts. WebRTC session descriptions are the biggest. */
export const MAX_MESSAGE_BYTES = 8192;

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
export const MATCH_PHASES: readonly Phase[] = ['countdown', 'playing', 'scored'];

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
  /** Round-trip time to the host in ms as the player last reported it, or -1 when unknown. */
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
  /** Public id of the party host, whose browser runs the match. */
  host: string;
  settings: Settings;
  players: PublicPlayer[];
  /** Seat count of the table in play (or that would be in play, in the lobby). */
  seats: number;
  /** ms left in a countdown or goal pause, as of the host's last report. */
  timer: number;
  winner: string | null;
  /** Number of the match in play or last played, counting from 1. 0 before the first start. */
  match: number;
  /** Version of the match state this message carries, as in MatchMsg. 0 until the host first reports. */
  v: number;
  /** Host tick at which the current match phase began. */
  k: number;
}

/** [kind, x, y, strength, seat] where kind 0 is a mallet hit and 1 is a wall bounce. */
export type WireEvent = [0 | 1, number, number, number, number];

export interface SnapMsg {
  t: 's';
  /** Match number, so a snapshot from an earlier match is never mistaken for one from this match. */
  n: number;
  /** Host tick number, counting from 0 at the start of the match. */
  k: number;
  /** puck x, y, vx, vy */
  p: [number, number, number, number];
  /** mallet position by seat, or 0 when the seat has no mallet */
  m: ([number, number] | 0)[];
  /** last hitter seat */
  h: number;
  /** By seat, the sequence number of the last pointer sample the host applied, or -1 (bots, or none yet). */
  a: number[];
}

/** The hits and wall bounces of one host tick. Sent reliably, so a lost snapshot never loses a sound. */
export interface EventMsg {
  t: 'e';
  n: number;
  k: number;
  e: WireEvent[];
}

export interface SeatState {
  score: number;
  lives: number;
  out: boolean;
  /** Whether the seat's player has a working game link to the host. Always true for the host and bots. */
  linked: boolean;
}

/**
 * The host's match state. The host sends it to guests over the game link whenever it changes, and reports the same
 * message to the party server, which mirrors it into RoomMsg. Whichever copy has the higher `v` wins.
 */
export interface MatchMsg {
  t: 'match';
  match: number;
  /** Counts up from 1 with every change during a match. */
  v: number;
  phase: Exclude<Phase, 'lobby'>;
  /** Host tick at which this phase began. The serve that starts play happens on this tick. */
  k: number;
  /** ms left in a countdown or goal pause, as of tick k. */
  timer: number;
  seats: SeatState[];
  /** Public id of the winner once the phase is 'over', else null. */
  winner: string | null;
}

export type GoalMsg = { t: 'goal'; n: number; k: number } & GoalInfo;

export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export type IceCandidate = {
  candidate: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  usernameFragment?: string | null;
};

/**
 * WebRTC signalling relayed through the party server. Guests always offer and the host always answers. A null
 * candidate marks the end of the candidates.
 */
export type SignalData = { sdp: { type: 'offer' | 'answer'; sdp: string } } | { candidate: IceCandidate | null };

/** Party server to page, over the WebSocket. */
export type ServerMsg =
  | { t: 'welcome'; id: string }
  /** STUN and TURN servers for this page's game links. Follows every welcome. */
  | { t: 'ice'; servers: IceServer[] }
  | RoomMsg
  /**
   * `from` is the sender's public id, filled in by the party server. `l` numbers the guest's link attempt, so signals
   * for an attempt that has since been replaced are dropped.
   */
  | { t: 'signal'; from: string; l: number; d: SignalData }
  /** To the host: a seated player pressed Leave mid-match. Their 'bye' can't reach the host while their link is down. */
  | { t: 'left'; id: string };

/** Page to party server, over the WebSocket. */
export type ClientMsg =
  | { t: 'hello'; pid: string; name: string }
  /** Round trip to the host over the game link, in ms. The host reports 0. */
  | { t: 'rtt'; ms: number }
  | { t: 'settings'; s: Partial<Settings> }
  | { t: 'start' }
  | { t: 'again' }
  | { t: 'addBot'; level: BotLevel }
  | { t: 'removeBot'; id: string }
  /** `to` is the public id of the player the signal is for. */
  | { t: 'signal'; to: string; l: number; d: SignalData }
  /** From the host only: the match state changed. */
  | MatchMsg
  /** From the host only: this page can't run the match the party thinks is in play (it reloaded), so end it. */
  | { t: 'abort'; match: number };

/**
 * Host to guest over the game link. Snapshots and pongs go on the unreliable channel. Events, goals and match state go
 * on the reliable one.
 */
export type HostMsg = SnapMsg | EventMsg | GoalMsg | MatchMsg | { t: 'pong'; i: number };

/** Guest to host over the game link. Inputs and pings go on the unreliable channel, 'bye' on the reliable one. */
export type GuestMsg =
  /** Pointer samples in table units, oldest first, flattened as [x0, y0, x1, y1, ...]. `s` numbers the first sample. */
  | { t: 'p'; s: number; q: number[] }
  | { t: 'ping'; i: number }
  /** The guest pressed Leave, so the host closes their goal at once. */
  | { t: 'bye' };

export const round = (n: number): number => Math.round(n * 10000) / 10000;
