import '@fontsource/chakra-petch/500.css';
import '@fontsource/chakra-petch/700.css';
import './style.css';
import { clampToConvex, homePosition, makeLayout, MAX_SEATS, MIN_SEATS, zoneFor } from '../shared/geometry';
import { createWorld, serve, step, type World } from '../shared/physics';
import {
  CODE_ALPHABET,
  CODE_LENGTH,
  MATCH_PHASES,
  normalizeCode,
  PALETTE,
  sanitizeName,
  TICK_HZ,
  type HostMsg,
  type IceServer,
  type MatchMsg,
  type RoomMsg,
  type ServerMsg,
} from '../shared/protocol';
import { DEFAULT_SETTINGS } from '../shared/settings';
import type { Vec } from '../shared/vec';
import { Sfx } from './audio';
import { Fx } from './fx';
import { HostRuntime } from './host';
import { InputSampler } from './input';
import { Net, type NetStatus } from './net';
import { GuestLink, hasRelay, RELAY } from './peer';
import { SLOW_MS, UNSTABLE_RATE } from './ping';
import { predictor } from './predict';
import { Renderer, type Frame } from './render';
import { GameState, mergeRoom, type Due } from './state';
import { UI } from './ui';

const NAME_KEY = 'puckagon:name';
const PID_KEY = 'puckagon:pid';
const TICK_MS = 1000 / TICK_HZ;
/** A guest in a match with no snapshot for this long is told it is waiting for the host. */
const HOST_QUIET_MS = 1000;
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

/** `?ahead=40` in the page URL draws a match at most this many ms ahead of the host, to compare against the default. */
function aheadFromQuery(search: string): number {
  const n = Number(new URLSearchParams(search).get('ahead') || NaN);
  return n >= 0 ? n : Infinity;
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
  readonly state = new GameState(aheadFromQuery(location.search));
  readonly net: Net;
  status: NetStatus = 'connecting';
  pointer: Vec | null = null;
  private myMallet: Vec | null = null;
  private input = new InputSampler();
  /** The party's latest room and the host's latest match state. `state.room` is the two merged. */
  private party: RoomMsg | null = null;
  private hostMatch: MatchMsg | null = null;
  private ice: IceServer[] | null = null;
  /** At most one of these: the match runs on this page, or this page has a game link to the host. */
  private host: HostRuntime | null = null;
  private link: GuestLink | null = null;
  /** The ping last told to the party on this socket, or -1. */
  private reported = -1;
  /** When the last snapshot came, or when waiting for one began. */
  private heardAt = 0;
  private ended = false;
  private relayWarned = false;
  private unstableUntil = 0;
  private badSince = Infinity;
  private warned = false;
  /**
   * When the merged room's match, phase or phase tick last changed. The countdown counts from it until a snapshot
   * comes. A new version alone doesn't move it, so the host's first report doesn't restart the count.
   */
  private roomAt = 0;
  private roomKey = '';
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
        // Another tab took over, or this one can't join, so it stops without a bye: the player hasn't left.
        if (status === 'replaced' || status === 'outdated' || status === 'full') this.end();
        ui.update(this.state, status);
      },
      () => this.host?.hosting ?? false,
    );
    this.net.connect();
  }

  /** Leave. The host hears it first, so our goal closes at once. */
  close(): void {
    this.link?.leave();
    this.link = null;
    this.end();
    this.net.close();
  }

  private end(): void {
    this.ended = true;
    clearTimeout(this.celebrateTimer);
    this.dropLink();
    this.dropHost();
  }

  private onMessage(msg: ServerMsg): void {
    switch (msg.t) {
      case 'welcome':
        if (msg.id !== this.state.myId) {
          this.dropLink();
          this.dropHost();
        }
        this.state.myId = msg.id;
        // The party forgets a ping when the socket drops, and may have missed match reports while it was down.
        this.reported = -1;
        this.reportRtt(this.ping());
        this.host?.resend();
        break;
      case 'ice':
        this.ice = msg.servers;
        if (RELAY && !this.relayWarned && !hasRelay(msg.servers)) {
          this.relayWarned = true;
          ui.flash("No relay server here, so ?relay=1 can't connect.", 5000);
        }
        this.host?.setIce(msg.servers);
        this.syncRole();
        break;
      case 'room':
        this.party = msg;
        // A lobby message can come after the next match's state that came over the link, which must survive it.
        if (msg.phase === 'lobby' && (this.hostMatch?.match ?? 0) <= msg.match) this.hostMatch = null;
        this.syncRole();
        this.host?.onRoom(msg);
        this.applyRoom();
        break;
      case 'signal':
        if (this.host) this.host.signal(msg.from, msg.l, msg.d);
        else if (msg.from === this.party?.host) this.link?.signal(msg.l, msg.d);
        break;
      case 'left':
        this.host?.quit(msg.id);
        break;
    }
  }

  /** From the host, over the game link, or straight from the worker on the host's own page. */
  private onHostMsg(msg: HostMsg): void {
    switch (msg.t) {
      case 's':
        if (this.state.onSnap(msg, performance.now())) this.heardAt = performance.now();
        break;
      case 'e':
        this.state.onEvents(msg);
        break;
      case 'goal':
        this.state.onGoal(msg);
        break;
      case 'match': {
        const had = this.hostMatch;
        if (had && (msg.match < had.match || (msg.match === had.match && msg.v <= had.v))) return;
        this.hostMatch = msg;
        this.applyRoom();
        break;
      }
    }
  }

  /** The party host runs the match on their page. Everyone else keeps a game link to the host. */
  private syncRole(): void {
    const room = this.party;
    const me = this.state.myId;
    if (this.ended || !room || !me) return;
    if (room.host === me) {
      this.dropLink();
      if (this.host) return;
      this.host = new HostRuntime(me, {
        send: (m) => this.net.send(m),
        deliver: (m) => this.onHostMsg(m),
        beat: () => this.net.keepalive(),
      });
      if (this.ice) this.host.setIce(this.ice);
      this.reported = -1;
      this.reportRtt(0);
      return;
    }
    if (this.host) {
      this.dropHost();
      this.reported = -1;
    }
    if (this.link && this.link.host !== room.host) this.dropLink();
    if (this.link || !room.host || !this.ice) return;
    const host = room.host;
    this.link = new GuestLink(host, () => this.ice ?? [], {
      signal: (l, d) => this.net.send({ t: 'signal', to: host, l, d }),
      message: (m) => this.onHostMsg(m),
      change: (up) => {
        if (!up) return;
        // A new link starts with nothing applied, so samples from before it must not count as still to apply.
        this.input.forget();
        this.heardAt = performance.now();
      },
      rtt: (ms) => this.reportRtt(ms),
    });
  }

  private dropLink(): void {
    this.link?.close();
    this.link = null;
  }

  private dropHost(): void {
    this.host?.stop();
    this.host = null;
  }

  /** Round trip to the host: 0 on the host's own page, or -1 until this page's link is up and timed. */
  private ping(): number {
    if (this.host) return 0;
    return this.link?.up ? this.link.rtt : -1;
  }

  private reportRtt(ms: number): void {
    // The room only shows a change this big, so smaller ones aren't worth a message.
    if (ms < 0 || (this.reported >= 0 && Math.abs(ms - this.reported) < Math.max(20, this.reported * 0.2))) return;
    this.reported = ms;
    this.net.send({ t: 'rtt', ms });
  }

  private applyRoom(): void {
    if (!this.party) return;
    const now = performance.now();
    const prev = this.state.room;
    const room = mergeRoom(this.party, this.hostMatch);
    if (room === prev) return;
    this.state.onRoom(room);
    const key = `${room.match}:${room.phase}:${room.k}`;
    if (key !== this.roomKey) {
      this.roomKey = key;
      this.roomAt = now;
    }
    if (room.match !== prev?.match) {
      // Samples kept from the last match may be for another seat or table.
      this.input.forget();
      this.heardAt = now;
    }
    this.onPhase(prev, room);
    ui.update(this.state, this.status);
  }

  private onPhase(before: RoomMsg | null, room: RoomMsg): void {
    const prev = before?.phase;
    const next = room.phase;
    if (prev === next) {
      if (next === 'lobby' && (before?.players.length ?? 0) < room.players.length) sfx.join();
      return;
    }
    if (before && MATCH_PHASES.includes(before.phase) && next === 'lobby') {
      ui.flash(before.host !== room.host ? 'The host left, so the match ended.' : 'The match was stopped.', 4000);
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

  /**
   * Moves your mallet's target to the pointer and samples it, from every frame and every pointer move, so samples keep
   * coming at 60 Hz when frames drop to 30. Returns your seat while you play, or -1.
   */
  steer(now: number): number {
    const st = this.state;
    const room = st.room;
    const layout = st.layout;
    const me = st.me;
    if (!room || !layout) return -1;
    const active = me && me.seat >= 0 && me.seat < layout.seats && !me.out && room.phase !== 'over' ? me.seat : -1;
    if (active >= 0 && this.pointer) {
      const w = renderer.toWorld(this.pointer.x, this.pointer.y);
      this.myMallet = clampToConvex(w, zoneFor(layout, active, room.settings.zone));
    } else if (active < 0) {
      this.myMallet = null;
    }
    if (active < 0 || !MATCH_PHASES.includes(room.phase)) return active;
    // Players who haven't touched the table yet still send samples, from where the host parked their mallet.
    this.myMallet ??= homePosition(layout, active, room.settings.zone);
    // The worker on the host's own page gets every message, so only a guest repeats the samples not yet applied.
    const batch = this.input.sample(now, this.myMallet, this.host ? undefined : st.ack(active));
    if (!batch) return active;
    if (this.host) this.host.input(batch.s, batch.q);
    else this.link?.send({ t: 'p', ...batch });
    return active;
  }

  frame(now: number, fit: Frame['fit']): Frame | null {
    const st = this.state;
    const room = st.room;
    const layout = st.layout;
    if (!room || !layout) return null;

    const active = this.steer(now);
    const inMatch = MATCH_PHASES.includes(room.phase);
    const open = Array.from({ length: layout.seats }, (_, seat) => !st.bySeat(seat)?.out);
    const predict =
      inMatch && active >= 0 && this.myMallet
        ? predictor(this.input, now, { layout, settings: room.settings, seat: active, open, pointer: this.myMallet })
        : null;
    const view = st.view(now, predict);
    if (active >= 0) this.input.prune(st.ack(active));
    for (const due of view.due) this.handleDue(due);
    if (view.served && view.puck) fx.serve(view.puck.x, view.puck.y);
    const me = st.me;
    const viewSeat = me && me.seat < layout.seats ? me.seat : -1;
    document.body.classList.toggle('aiming', active >= 0);

    const waiting = this.waitingFor(now, inMatch);
    ui.setWaiting(waiting);
    // A host that stopped sending isn't this player's connection, so it isn't called slow or unstable.
    const live = inMatch && !waiting;
    if (live && st.lateRate > UNSTABLE_RATE) this.unstableUntil = now + UNSTABLE_HOLD_MS;
    const unstable = live && now < this.unstableUntil;
    const ping = this.ping();
    ui.setPing(ping, unstable);
    this.watchConnection(now, waiting ? -1 : ping, unstable);

    // Counted on the host's ticks once they come, so GO lands as the puck appears.
    const left = view.tick === null ? room.timer - (now - this.roomAt) : room.timer - (view.tick - room.k) * TICK_MS;
    const countdown = room.phase === 'countdown' ? Math.max(0, Math.min(room.timer, left)) : 0;
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
      puck: inMatch || room.phase === 'over' ? view.puck : null,
      puckSpeed: view.speed,
      hitter: view.hitter,
      mallets: view.mallets,
      myMallet: view.mallet ?? this.myMallet,
      countdown,
      fit,
    };
  }

  /** What a guest is waiting on in a match: its link to the host, or the host's snapshots. '' for nothing. */
  private waitingFor(now: number, inMatch: boolean): string {
    if (!inMatch || this.host) return '';
    if (!this.link?.up) return 'Connecting to the host…';
    return now - this.heardAt > HOST_QUIET_MS ? 'Waiting for the host…' : '';
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
      history.pushState(null, '', `/p/${code}${location.search}`);
      enterParty(code, sanitizeName(name));
    },
    join(raw, name) {
      const code = normalizeCode(raw);
      if (!code) {
        ui.showHome(name, `Party codes are ${CODE_LENGTH} letters and numbers.`);
        return;
      }
      saveName(name);
      history.pushState(null, '', `/p/${code}${location.search}`);
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
      history.pushState(null, '', `/${location.search}`);
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
  if (!party) return;
  // Moves the browser merged into this event, with their own times, fill in samples between slow frames.
  for (const c of e.getCoalescedEvents?.() ?? []) {
    party.pointer = { x: c.clientX, y: c.clientY };
    party.steer(c.timeStamp);
  }
  party.pointer = { x: e.clientX, y: e.clientY };
  party.steer(performance.now());
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
