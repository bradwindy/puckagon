import { DurableObject } from 'cloudflare:workers';
import { CLOSE, MAX_MESSAGE_BYTES, sanitizeName, TICK_HZ, type ClientMsg, type ServerMsg } from '../shared/protocol';
import { MAX_PLAYERS, Room, type RoomSnapshot } from './room';

interface Attachment {
  pid: string;
}

const PID_RE = /^[A-Za-z0-9_-]{16,64}$/;
const MAX_MESSAGES_PER_SECOND = 90;
const SNAPSHOT_KEY = 'room';
const STALL_MS = 1000;

/** One Durable Object per party code. Uses the WebSocket Hibernation API so an idle lobby costs nothing. */
export class Party extends DurableObject<Env> {
  private room: Room;
  private sockets = new Map<string, WebSocket>();
  private loop: ReturnType<typeof setInterval> | null = null;
  private purgeTimer: ReturnType<typeof setTimeout> | null = null;
  private lastTickAt = 0;
  private budget = new WeakMap<WebSocket, { second: number; count: number }>();
  private saved = '';

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.room = new Room({
      send: (pid, msg) => this.send(this.sockets.get(pid), msg),
      broadcast: (msg) => {
        const data = JSON.stringify(msg);
        for (const ws of this.sockets.values()) this.sendRaw(ws, data);
      },
      random: Math.random,
      newId: () => crypto.randomUUID().slice(0, 8),
    });
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));

    for (const ws of ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() as Attachment | null;
      if (att?.pid && ws.readyState === WebSocket.OPEN) this.sockets.set(att.pid, ws);
    }
    const snap = ctx.storage.kv.get<RoomSnapshot>(SNAPSHOT_KEY);
    if (snap) {
      this.room.restore(snap, new Set(this.sockets.keys()), Date.now());
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
    if (typeof message !== 'string' || message.length > MAX_MESSAGE_BYTES || !this.allow(ws)) return;
    let msg: ClientMsg;
    try {
      msg = JSON.parse(message) as ClientMsg;
    } catch {
      return;
    }
    if (typeof msg !== 'object' || msg === null) return;
    this.watchdog();
    const pid = (ws.deserializeAttachment() as Attachment | null)?.pid;

    if (msg.t === 'hello') {
      if (pid || typeof msg.pid !== 'string' || !PID_RE.test(msg.pid)) return;
      if (!this.room.players.some((p) => p.pid === msg.pid) && this.room.players.length >= MAX_PLAYERS) {
        this.closeQuietly(ws, CLOSE.full, 'This party is full');
        return;
      }
      const previous = this.sockets.get(msg.pid);
      ws.serializeAttachment({ pid: msg.pid } satisfies Attachment);
      this.sockets.set(msg.pid, ws);
      if (previous && previous !== ws) this.closeQuietly(previous, CLOSE.replaced, 'Replaced by a newer connection');
      this.room.join(msg.pid, sanitizeName(msg.name) || 'Player');
      await this.afterChange();
      return;
    }
    if (!pid || this.sockets.get(pid) !== ws) return;

    switch (msg.t) {
      case 'p':
        this.room.input(pid, Number(msg.x), Number(msg.y));
        return;
      case 'settings':
        this.room.updateSettings(pid, msg.s);
        break;
      case 'start':
        this.room.start(pid);
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
    const pid = (ws.deserializeAttachment() as Attachment | null)?.pid;
    if (!pid) return;
    // After waking from hibernation the closing socket is no longer listed, so a missing entry still counts.
    const current = this.sockets.get(pid);
    if (current && current !== ws) return;
    this.sockets.delete(pid);
    this.room.leave(pid, Date.now(), quit);
    await this.afterChange();
  }

  private allow(ws: WebSocket): boolean {
    const second = Math.floor(Date.now() / 1000);
    const b = this.budget.get(ws);
    if (!b || b.second !== second) {
      this.budget.set(ws, { second, count: 1 });
      return true;
    }
    b.count++;
    return b.count <= MAX_MESSAGES_PER_SECOND;
  }

  /** Persists lobby-level state and starts or stops the timers. Never runs inside a tick. */
  private async afterChange(): Promise<void> {
    if (this.room.players.length === 0) {
      this.stopLoop();
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
    if (this.room.inMatch) {
      this.clearPurge();
      this.startLoop();
    } else {
      this.stopLoop();
      this.schedulePurge();
    }
  }

  /** Outside a match there is no tick, so a one-shot timer ends the reconnect grace of anyone who left. */
  private schedulePurge(): void {
    const at = this.room.nextPurgeAt();
    if (this.purgeTimer || at === null) return;
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

  private startLoop(): void {
    if (this.loop) return;
    this.lastTickAt = Date.now();
    this.loop = setInterval(() => {
      this.lastTickAt = Date.now();
      this.room.tick(this.lastTickAt);
      if (!this.room.inMatch) {
        this.afterChange().catch((err) => console.error(JSON.stringify({ event: 'match_end_failed', error: String(err) })));
      }
    }, 1000 / TICK_HZ);
  }

  private stopLoop(): void {
    if (!this.loop) return;
    clearInterval(this.loop);
    this.loop = null;
  }

  /** The runtime can stop rescheduling an interval that runs out of CPU budget. Restart it if ticks have stalled. */
  private watchdog(): void {
    if (this.loop && this.room.inMatch && Date.now() - this.lastTickAt > STALL_MS) {
      console.warn(JSON.stringify({ event: 'tick_stall_restart', stalledMs: Date.now() - this.lastTickAt }));
      this.stopLoop();
      this.startLoop();
    }
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
