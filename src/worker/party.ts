import { DurableObject } from 'cloudflare:workers';
import {
  CLOSE,
  MAX_MESSAGE_BYTES,
  sanitizeName,
  type ClientMsg,
  type IceCandidate,
  type IceServer,
  type ServerMsg,
  type SignalData,
} from '../shared/protocol';
import { MAX_PLAYERS, Room, type RoomSnapshot } from './room';

interface Attachment {
  pid?: string;
  /** The ping the room last showed for this player, kept here so it survives hibernation without a storage write. */
  ping?: number;
}

const attachment = (ws: WebSocket | undefined): Attachment => (ws?.deserializeAttachment() as Attachment | null) ?? {};

const PID_RE = /^[A-Za-z0-9_-]{16,64}$/;
const MAX_MESSAGES_PER_SECOND = 90;
/** Signals get their own budget: a new host answering eleven guests sends far more than 90 a second for a moment. */
const MAX_SIGNALS_PER_SECOND = 400;
const SNAPSHOT_KEY = 'room';
const STUN_ONLY: IceServer[] = [{ urls: 'stun:stun.cloudflare.com:3478' }];
const TURN_TTL_S = 43200;
/** A party hands every page the same TURN credential while more than half its life is left. */
const TURN_REUSE_MS = (TURN_TTL_S * 1000) / 2;
const TURN_TIMEOUT_MS = 3000;
/** Browsers block port 53, so a URL on it only times out. */
const PORT_53 = /:53(?:[/?]|$)/;

/** Keeps the well-formed servers of a TURN response and drops their port 53 URLs. */
function usableIceServers(list: unknown): IceServer[] {
  if (!Array.isArray(list)) return [];
  const servers: IceServer[] = [];
  for (const s of list) {
    if (typeof s !== 'object' || s === null) continue;
    const { urls, username, credential } = s as Record<string, unknown>;
    const all: unknown[] = typeof urls === 'string' ? [urls] : Array.isArray(urls) ? urls : [];
    const kept = all.filter((u): u is string => typeof u === 'string' && !PORT_53.test(u));
    if (!kept.length) continue;
    servers.push({
      urls: kept,
      ...(typeof username === 'string' && { username }),
      ...(typeof credential === 'string' && { credential }),
    });
  }
  return servers;
}

const optional = (v: unknown, type: 'string' | 'number') => v === undefined || v === null || typeof v === type;

/** Rebuilds relayed signalling from its known fields, or returns null when it isn't an offer, answer or candidate. */
function signalData(d: unknown): SignalData | null {
  if (typeof d !== 'object' || d === null || Object.keys(d).length !== 1) return null;
  if ('sdp' in d) {
    const { type, sdp } = (d.sdp ?? {}) as Record<string, unknown>;
    if ((type !== 'offer' && type !== 'answer') || typeof sdp !== 'string') return null;
    return { sdp: { type, sdp } };
  }
  if (!('candidate' in d)) return null;
  if (d.candidate === null) return { candidate: null };
  const c = (d.candidate ?? {}) as Record<string, unknown>;
  if (typeof c.candidate !== 'string' || !optional(c.sdpMid, 'string') || !optional(c.sdpMLineIndex, 'number')) return null;
  if (!optional(c.usernameFragment, 'string')) return null;
  const { candidate, sdpMid, sdpMLineIndex, usernameFragment } = c as IceCandidate;
  return { candidate: { candidate, sdpMid, sdpMLineIndex, usernameFragment } };
}

/**
 * Optional Worker secrets for Cloudflare TURN. Local dev and previews run without them and hand out STUN only, so
 * guests behind strict NATs can't connect there.
 */
export interface TurnSecrets {
  TURN_KEY_ID?: string;
  TURN_KEY_API_TOKEN?: string;
}

/**
 * STUN and TURN servers for a party's pages. With the TURN key set they include a short-lived Cloudflare TURN
 * credential. Without it, or when Cloudflare doesn't answer in time, pages get Cloudflare STUN alone.
 */
export async function iceServers(env: TurnSecrets): Promise<IceServer[]> {
  const { TURN_KEY_ID: keyId, TURN_KEY_API_TOKEN: token } = env;
  if (!keyId || !token) return STUN_ONLY;
  try {
    const res = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${keyId}/credentials/generate-ice-servers`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ttl: TURN_TTL_S }),
      signal: AbortSignal.timeout(TURN_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`TURN credentials request returned ${res.status}`);
    const servers = usableIceServers(((await res.json()) as { iceServers?: unknown } | null)?.iceServers);
    if (!servers.length) throw new Error('TURN credentials response had no usable servers');
    return servers;
  } catch (err) {
    console.error(JSON.stringify({ event: 'turn_failed', error: String(err) }));
    return STUN_ONLY;
  }
}

/**
 * One Durable Object per party code. It runs the lobby, relays WebRTC signalling between the host's page and its
 * guests, and mirrors the match state the host reports. Uses the WebSocket Hibernation API so an idle lobby costs nothing.
 */
export class Party extends DurableObject<Env & TurnSecrets> {
  private room: Room;
  private sockets = new Map<string, WebSocket>();
  private purgeTimer: ReturnType<typeof setTimeout> | null = null;
  private purgeAt = 0;
  private budget = new WeakMap<WebSocket, { second: number; messages: number; signals: number }>();
  private helloAt = new WeakMap<WebSocket, number>();
  private ice: { servers: Promise<IceServer[]>; at: number } | null = null;
  private wokeAt = Date.now();
  private saved = '';

  constructor(ctx: DurableObjectState, env: Env & TurnSecrets) {
    super(ctx, env);
    this.room = new Room({
      send: (pid, msg) => this.send(this.sockets.get(pid), msg),
      broadcast: (msg) => {
        const data = JSON.stringify(msg);
        for (const ws of this.sockets.values()) this.sendRaw(ws, data);
      },
      newId: () => crypto.randomUUID().slice(0, 8),
      seenAt: (pid) => this.seenAt(pid),
    });
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));

    const pings = new Map<string, number>();
    for (const ws of ctx.getWebSockets()) {
      const att = attachment(ws);
      if (!att.pid || ws.readyState !== WebSocket.OPEN) continue;
      this.sockets.set(att.pid, ws);
      if (att.ping !== undefined) pings.set(att.pid, att.ping);
    }
    const snap = ctx.storage.kv.get<RoomSnapshot>(SNAPSHOT_KEY);
    if (snap) {
      this.room.restore(snap, new Set(this.sockets.keys()), Date.now(), pings);
      this.schedulePurge();
    }
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected a WebSocket upgrade', { status: 426 });
    }
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string' || message.length > MAX_MESSAGE_BYTES) return;
    // Pages put `t` first, so the budget is picked and spent before a flood costs a parse.
    const signal = message.startsWith('{"t":"signal"');
    if (!this.allow(ws, signal)) return;
    let msg: ClientMsg | null;
    try {
      msg = JSON.parse(message) as ClientMsg | null;
    } catch {
      return;
    }
    // A repeated key could dress up another message as a signal to spend the bigger budget.
    if (typeof msg !== 'object' || msg === null || signal !== (msg.t === 'signal')) return;
    const att = attachment(ws);
    const pid = att.pid;

    if (msg.t === 'hello') {
      if (pid || typeof msg.pid !== 'string' || !PID_RE.test(msg.pid)) return;
      if (!this.room.players.some((p) => p.pid === msg.pid) && this.room.players.length >= MAX_PLAYERS) {
        this.closeQuietly(ws, CLOSE.full, 'This party is full');
        return;
      }
      const previous = this.sockets.get(msg.pid);
      ws.serializeAttachment({ ...att, pid: msg.pid } satisfies Attachment);
      this.sockets.set(msg.pid, ws);
      this.helloAt.set(ws, Date.now());
      if (previous && previous !== ws) this.closeQuietly(previous, CLOSE.replaced, 'Replaced by a newer connection');
      this.room.join(msg.pid, sanitizeName(msg.name) || 'Player');
      await this.afterChange();
      // Other messages from this socket are handled while the TURN request is out.
      this.send(ws, { t: 'ice', servers: await this.sharedIceServers() });
      return;
    }
    if (!pid || this.sockets.get(pid) !== ws) return;

    switch (msg.t) {
      case 'rtt': {
        const ping = this.room.reportPing(pid, msg.ms);
        if (ping !== null) ws.serializeAttachment({ ...att, ping } satisfies Attachment);
        return;
      }
      case 'signal': {
        const from = this.room.idOf(pid);
        const to = this.room.peer(pid, msg.to);
        const d = signalData(msg.d);
        if (from && to && d && Number.isSafeInteger(msg.l)) {
          this.send(this.sockets.get(to.pid), { t: 'signal', from, l: msg.l, d });
        }
        return;
      }
      case 'settings':
        this.room.updateSettings(pid, msg.s);
        break;
      case 'start':
        this.room.start(pid);
        break;
      case 'match':
        this.room.report(pid, msg);
        break;
      case 'abort':
        this.room.abort(pid, msg.match);
        break;
      case 'again':
        this.room.again(pid);
        break;
      case 'addBot':
        this.room.addBot(pid, msg.level);
        break;
      case 'removeBot':
        this.room.removeBot(pid, msg.id);
        break;
      default:
        return;
    }
    await this.afterChange();
  }

  async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    await this.disconnect(ws, code === CLOSE.left);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.disconnect(ws, false);
  }

  private async disconnect(ws: WebSocket, quit: boolean): Promise<void> {
    const pid = attachment(ws).pid;
    if (!pid) return;
    // After waking from hibernation the closing socket is no longer listed, so a missing entry still counts.
    const current = this.sockets.get(pid);
    if (current && current !== ws) return;
    this.sockets.delete(pid);
    this.room.leave(pid, Date.now(), quit);
    await this.afterChange();
  }

  /**
   * When the player's socket last showed life: its last automatic pong, or else when it said hello or when this object
   * woke, whichever is later. Null when they have no socket.
   */
  private seenAt(pid: string): number | null {
    const ws = this.sockets.get(pid);
    if (!ws) return null;
    const pong = this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? -Infinity;
    return Math.max(pong, this.helloAt.get(ws) ?? this.wokeAt);
  }

  private allow(ws: WebSocket, signal: boolean): boolean {
    const second = Math.floor(Date.now() / 1000);
    let b = this.budget.get(ws);
    if (!b || b.second !== second) this.budget.set(ws, (b = { second, messages: 0, signals: 0 }));
    return signal ? ++b.signals <= MAX_SIGNALS_PER_SECOND : ++b.messages <= MAX_MESSAGES_PER_SECOND;
  }

  /** The party's ice servers, made once for every page until TURN_REUSE_MS. A failed TURN request isn't kept. */
  private sharedIceServers(): Promise<IceServer[]> {
    const now = Date.now();
    if (this.ice && now - this.ice.at < TURN_REUSE_MS) return this.ice.servers;
    const ice = { servers: iceServers(this.env), at: now };
    this.ice = ice;
    void ice.servers.then((servers) => {
      if (servers === STUN_ONLY && this.ice === ice) this.ice = null;
    });
    return ice.servers;
  }

  /** Persists the lobby and arms the purge timer. */
  private async afterChange(): Promise<void> {
    if (this.room.players.length === 0) {
      this.clearPurge();
      this.saved = '';
      await this.ctx.storage.deleteAll();
      return;
    }
    // Skip no-op writes: ignored messages from guests must not cost a row write each.
    const json = JSON.stringify(this.room.snapshot());
    if (json !== this.saved) {
      this.ctx.storage.kv.put(SNAPSHOT_KEY, this.room.snapshot());
      this.saved = json;
    }
    this.schedulePurge();
  }

  /**
   * A one-shot timer ends reconnect graces and a match whose host is gone. Graces differ in length, so a new deadline
   * earlier than the armed one re-arms it.
   */
  private schedulePurge(): void {
    const at = this.room.nextPurgeAt();
    if (at === null) {
      this.clearPurge();
      return;
    }
    if (this.purgeTimer && this.purgeAt <= at) return;
    this.clearPurge();
    this.purgeAt = at;
    this.purgeTimer = setTimeout(
      () => {
        this.purgeTimer = null;
        this.room.purge(Date.now());
        this.afterChange().catch((err) => console.error(JSON.stringify({ event: 'purge_failed', error: String(err) })));
      },
      Math.max(0, at - Date.now()) + 50,
    );
  }

  private clearPurge(): void {
    if (!this.purgeTimer) return;
    clearTimeout(this.purgeTimer);
    this.purgeTimer = null;
  }

  private closeQuietly(ws: WebSocket, code: number, reason: string): void {
    try {
      ws.close(code, reason);
    } catch {
      // already closing
    }
  }

  private send(ws: WebSocket | undefined, msg: ServerMsg): void {
    if (ws) this.sendRaw(ws, JSON.stringify(msg));
  }

  private sendRaw(ws: WebSocket, data: string): void {
    try {
      ws.send(data);
    } catch {
      // socket is closing; webSocketClose will clean up
    }
  }
}
