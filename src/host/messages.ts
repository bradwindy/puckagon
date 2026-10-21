import type { BotLevel, MatchMsg } from '../shared/protocol';
import type { Settings } from '../shared/settings';

export interface MatchSeat {
  id: string;
  seat: number;
  bot: BotLevel | null;
}

export interface MatchInit {
  match: number;
  settings: Settings;
  seats: number;
  players: MatchSeat[];
  /** Public id of the host, whose own seat is always linked. */
  host: string;
  /** Ids of guests whose game links are already open. */
  linked: string[];
}

export type ToWorker =
  | { t: 'start'; init: MatchInit }
  | { t: 'input'; id: string; s: unknown; q: unknown }
  | { t: 'link'; id: string; up: boolean }
  | { t: 'quit'; id: string }
  | { t: 'stop' };

export type FromWorker =
  /** A HostMsg as JSON, made once for every guest and the host's own page. */
  | { t: 'send'; data: string; reliable: boolean }
  /** For the party server. */
  | { t: 'report'; msg: MatchMsg }
  /** Every KEEPALIVE_MS while a match runs, so the page pings the party socket even when its own timers are slowed. */
  | { t: 'beat' };
