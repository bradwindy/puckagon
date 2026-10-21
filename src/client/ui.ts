import { MAX_SEATS, MIN_SEATS } from '../shared/geometry';
import { CODE_LENGTH, NAME_MAX, PALETTE, type BotLevel, type PublicPlayer } from '../shared/protocol';
import { TARGET_MAX, TARGET_MIN, type Settings } from '../shared/settings';
import type { NetStatus } from './net';
import { pingLevel } from './ping';
import type { GameState } from './state';

type Child = Node | string | null | undefined | false;

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, unknown> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, val] of Object.entries(props)) {
    if (val === undefined || val === false) continue;
    if (k === 'class') el.className = String(val);
    else if (k === 'style') for (const [prop, value] of Object.entries(val as Record<string, string>)) el.style.setProperty(prop, value);
    else if (k.startsWith('on') && typeof val === 'function') el.addEventListener(k.slice(2), val as EventListener);
    else if (k in el) (el as unknown as Record<string, unknown>)[k] = val;
    else el.setAttribute(k, String(val));
  }
  for (const c of children) if (c) el.append(c);
  return el;
}

export interface UIHandlers {
  create(name: string): void;
  join(code: string, name: string): void;
  enter(name: string): void;
  settings(s: Partial<Settings>): void;
  start(): void;
  again(): void;
  addBot(level: BotLevel): void;
  removeBot(id: string): void;
  leave(): void;
  mute(): boolean;
  unlockAudio(): void;
}

interface Option<T> {
  value: T;
  label: string;
}

const ZONE: Option<Settings['zone']>[] = [
  { value: 'wedge', label: 'Own wedge' },
  { value: 'free', label: 'Anywhere' },
];
const MODE: Option<Settings['mode']>[] = [
  { value: 'points', label: 'First to N' },
  { value: 'lives', label: 'Lives' },
];
const SPEED: Option<Settings['speed']>[] = [
  { value: 'chill', label: 'Chill' },
  { value: 'normal', label: 'Normal' },
  { value: 'chaos', label: 'Chaos' },
];
const BOTS: Option<BotLevel>[] = [
  { value: 'easy', label: 'Easy' },
  { value: 'medium', label: 'Medium' },
  { value: 'hard', label: 'Hard' },
];
const SIZE: Option<Settings['goal']>[] = [
  { value: 'S', label: 'S' },
  { value: 'M', label: 'M' },
  { value: 'L', label: 'L' },
];

function showPing(tag: HTMLElement, p: PublicPlayer): void {
  const known = !p.bot && p.connected && p.ping >= 0;
  tag.className = known ? `ping-tag ping-${pingLevel(p.ping)}` : 'ping-tag hidden';
  tag.textContent = known ? `${p.ping} ms` : '';
}

/** Wide screens and landscape phones put the lobby beside the table instead of under it. Matches style.css. */
const sidePanel = () => window.matchMedia('(min-width: 820px), (orientation: landscape) and (min-width: 640px)').matches;

export class UI {
  private screen: HTMLElement | null = null;
  private bar: HTMLElement | null = null;
  private panel: HTMLElement | null = null;
  private toast: HTMLElement | null = null;
  private ping: HTMLElement | null = null;
  private pingKey = '';
  private code = '';
  private lastPanelKey = '';
  /** Lobby ping tags by player id, updated in place so a ping change never rebuilds the panel under a tap. */
  private pingTags = new Map<string, HTMLElement>();

  constructor(
    private root: HTMLElement,
    private on: UIHandlers,
    private muted: boolean,
  ) {
    root.addEventListener('pointerdown', () => on.unlockAudio(), { capture: true });
  }

  private clear(): void {
    this.root.replaceChildren();
    this.screen = this.bar = this.panel = this.toast = this.ping = null;
    this.lastPanelKey = this.pingKey = '';
  }

  private nameInput(name: string): HTMLInputElement {
    return h('input', {
      class: 'input',
      value: name,
      maxLength: NAME_MAX,
      placeholder: 'Your name',
      autocomplete: 'nickname',
      'aria-label': 'Your name',
      required: true,
    });
  }

  showHome(name: string, error = ''): void {
    this.clear();
    const nameEl = this.nameInput(name);
    const codeEl = h('input', {
      class: 'input code',
      maxLength: CODE_LENGTH,
      placeholder: 'CODE',
      autocapitalize: 'characters',
      'aria-label': 'Party code',
    });
    const err = h('p', { class: 'error', role: 'alert' }, error);
    const needName = () => {
      const n = nameEl.value.trim();
      if (!n) {
        err.textContent = 'Pick a name first.';
        nameEl.focus();
      }
      return n;
    };
    const join = () => {
      const n = needName();
      if (n) this.on.join(codeEl.value, n);
    };
    codeEl.enterKeyHint = 'go';
    codeEl.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      join();
    });
    const form = h(
      'form',
      {
        class: 'card',
        onsubmit: (e: Event) => {
          e.preventDefault();
          const n = needName();
          if (n) this.on.create(n);
        },
      },
      h('label', { class: 'field' }, h('span', {}, 'Name'), nameEl),
      h('button', { class: 'btn primary big', type: 'submit' }, 'Create party'),
      h('div', { class: 'or' }, h('span', {}, 'or join one')),
      h(
        'div',
        { class: 'row' },
        codeEl,
        h(
          'button',
          {
            class: 'btn',
            type: 'button',
            onclick: join,
          },
          'Join',
        ),
      ),
      err,
    );
    this.screen = h(
      'main',
      { class: 'home' },
      h('h1', { class: 'logo' }, 'PUCK', h('span', {}, 'AGON')),
      h('p', { class: 'tagline' }, `Air hockey for ${MIN_SEATS} to ${MAX_SEATS}. Every player adds a side.`),
      form,
      h('p', { class: 'hint' }, 'Move your mallet with the mouse or a finger. Last to touch the puck scores.'),
    );
    this.root.append(this.screen);
  }

  showNamePrompt(code: string, name: string): void {
    this.clear();
    const nameEl = this.nameInput(name);
    this.screen = h(
      'main',
      { class: 'home' },
      h('h1', { class: 'logo small' }, 'PUCK', h('span', {}, 'AGON')),
      h(
        'form',
        {
          class: 'card',
          onsubmit: (e: Event) => {
            e.preventDefault();
            const n = nameEl.value.trim();
            if (n) this.on.enter(n);
          },
        },
        h('p', { class: 'invite' }, 'You are invited to party ', h('b', {}, code)),
        h('label', { class: 'field' }, h('span', {}, 'Name'), nameEl),
        h('button', { class: 'btn primary big', type: 'submit' }, 'Join party'),
      ),
    );
    this.root.append(this.screen);
    nameEl.focus();
  }

  showParty(code: string): void {
    this.clear();
    this.code = code;
    const muteBtn = h('button', { class: 'btn icon', title: 'Sound on/off', 'aria-label': 'Toggle sound' }, this.muted ? 'Sound off' : 'Sound on');
    muteBtn.addEventListener('click', () => {
      this.muted = this.on.mute();
      muteBtn.textContent = this.muted ? 'Sound off' : 'Sound on';
    });
    this.ping = h('span', { class: 'ping hidden' });
    this.bar = h(
      'header',
      { class: 'bar' },
      h('a', { class: 'logo tiny', href: '/', onclick: (e: Event) => (e.preventDefault(), this.on.leave()) }, 'PUCK', h('span', {}, 'AGON')),
      h('button', { class: 'chip', title: 'Copy invite link', onclick: () => this.copyLink() }, h('span', { class: 'chip-label' }, 'Party '), code),
      this.ping,
      muteBtn,
      h('button', { class: 'btn icon', onclick: () => this.on.leave() }, 'Leave'),
    );
    this.panel = h('aside', { class: 'panel hidden' });
    this.toast = h('div', { class: 'toast hidden', role: 'status' });
    this.root.append(this.bar, this.panel, this.toast);
  }

  inviteUrl(): string {
    return `${location.origin}/p/${this.code}`;
  }

  private async copyLink(): Promise<void> {
    const url = this.inviteUrl();
    try {
      if (navigator.share && matchMedia('(pointer: coarse)').matches) {
        await navigator.share({ title: 'Puckagon', text: 'Join my air hockey party', url });
        return;
      }
      await navigator.clipboard.writeText(url);
      this.flash('Invite link copied');
    } catch {
      this.flash(url);
    }
  }

  flash(text: string, ms = 1800): void {
    if (!this.toast) return;
    this.toast.textContent = text;
    this.toast.classList.remove('hidden');
    clearTimeout((this.toast as unknown as { t?: number }).t);
    (this.toast as unknown as { t?: number }).t = window.setTimeout(() => this.toast?.classList.add('hidden'), ms);
  }

  /** Shows your ping in the top bar, or hides it while unknown. */
  setPing(ms: number, unstable: boolean): void {
    const key = `${ms}:${unstable}`;
    if (!this.ping || key === this.pingKey) return;
    this.pingKey = key;
    this.ping.className = unstable ? 'ping ping-bad unstable' : ms < 0 ? 'ping hidden' : `ping ping-${pingLevel(ms)}`;
    this.ping.textContent = unstable ? 'unstable' : `${ms} ms`;
    this.ping.title = unstable ? 'The game is arriving unevenly, so the puck may stutter' : 'Your ping to the party';
  }

  /** Area of the window the table should fit in, given what overlays are showing. */
  fitRect(): { x: number; y: number; w: number; h: number } {
    const w = window.innerWidth;
    const hgt = window.innerHeight;
    const top = this.bar ? this.bar.offsetHeight + 8 : 0;
    const pad = 12;
    if (this.panel && !this.panel.classList.contains('hidden')) {
      if (this.panel.classList.contains('mini')) {
        return { x: pad, y: top + pad, w: w - pad * 2, h: hgt - top - pad * 2 - this.panel.offsetHeight - 16 };
      }
      if (sidePanel()) {
        const pw = this.panel.offsetWidth + 24;
        return { x: pad, y: top + pad, w: w - pw - pad * 2, h: hgt - top - pad * 2 };
      }
      const ph = this.panel.offsetHeight + 12;
      return { x: pad, y: top + pad, w: w - pad * 2, h: Math.max(160, hgt - ph - top - pad * 2) };
    }
    if (this.screen) return { x: 0, y: 0, w, h: hgt };
    return { x: pad, y: top + pad, w: w - pad * 2, h: hgt - top - pad * 2 };
  }

  update(state: GameState, status: NetStatus): void {
    if (!this.panel || !this.toast) return;
    if (status === 'reconnecting' || status === 'connecting') {
      this.toast.textContent = status === 'connecting' ? 'Connecting…' : 'Reconnecting…';
      this.toast.classList.remove('hidden');
    } else if (status === 'replaced') {
      this.toast.textContent = 'This party is open in another tab.';
      this.toast.classList.remove('hidden');
    } else if (status === 'outdated') {
      this.toast.replaceChildren(
        'Puckagon was updated. ',
        h('button', { class: 'btn icon', onclick: () => location.reload() }, 'Reload'),
      );
      this.toast.classList.add('action');
      this.toast.classList.remove('hidden');
    } else if (this.toast.textContent?.endsWith('…')) {
      this.toast.classList.add('hidden');
    }

    const room = state.room;
    if (!room) return;
    const players = room.players.map((p) => ({ ...p, ping: 0 }));
    const key = JSON.stringify([room.phase, room.host, room.settings, players, room.winner, state.myId]);
    if (key === this.lastPanelKey) {
      for (const p of room.players) {
        const tag = this.pingTags.get(p.id);
        if (tag) showPing(tag, p);
      }
      return;
    }
    this.lastPanelKey = key;

    this.pingTags.clear();
    if (room.phase === 'lobby') this.renderLobby(state);
    else if (room.phase === 'over') this.renderOver(state);
    else this.renderPlaying(state);
  }

  private playerRow(p: PublicPlayer, state: GameState, removable = false): HTMLElement {
    const room = state.room!;
    const tags: string[] = [];
    if (p.bot) tags.push(`${p.bot} bot`);
    if (p.id === room.host) tags.push('host');
    if (p.id === state.myId) tags.push('you');
    if (p.seat < 0) tags.push('watching');
    if (!p.connected) tags.push('away');
    const ping = h('span');
    showPing(ping, p);
    this.pingTags.set(p.id, ping);
    return h(
      'li',
      { class: `player${p.connected ? '' : ' away'}` },
      h('span', { class: 'dot', style: { '--c': PALETTE[p.color] } }),
      h('span', { class: 'name' }, p.name),
      h('span', { class: 'tags' }, tags.join(' · ')),
      ping,
      removable &&
        h('button', { class: 'remove', title: `Remove ${p.name}`, 'aria-label': `Remove ${p.name}`, onclick: () => this.on.removeBot(p.id) }, '×'),
    );
  }

  private segmented<T extends string>(label: string, options: Option<T>[], value: T, enabled: boolean, pick: (v: T) => void): HTMLElement {
    return h(
      'div',
      { class: 'setting' },
      h('span', { class: 'label' }, label),
      h(
        'div',
        { class: 'seg', role: 'group', 'aria-label': label },
        ...options.map((o) =>
          h(
            'button',
            {
              class: o.value === value ? 'on' : '',
              disabled: !enabled,
              'aria-pressed': String(o.value === value),
              onclick: () => pick(o.value),
            },
            o.label,
          ),
        ),
      ),
    );
  }

  private renderLobby(state: GameState): void {
    const room = state.room!;
    const host = state.isHost;
    const s = room.settings;
    const seated = room.players.filter((p) => p.seat >= 0);
    const ready = seated.filter((p) => p.connected).length;
    const set = (patch: Partial<Settings>) => this.on.settings(patch);

    const stepper = h(
      'div',
      { class: 'setting' },
      h('span', { class: 'label' }, s.mode === 'lives' ? 'Lives each' : 'Points to win'),
      h(
        'div',
        { class: 'stepper' },
        h('button', { disabled: !host || s.target <= TARGET_MIN, 'aria-label': 'Less', onclick: () => set({ target: s.target - 1 }) }, '−'),
        h('output', {}, String(s.target)),
        h('button', { disabled: !host || s.target >= TARGET_MAX, 'aria-label': 'More', onclick: () => set({ target: s.target + 1 }) }, '+'),
      ),
    );

    const canStart = host && ready >= MIN_SEATS;
    const startLabel = host
      ? ready < MIN_SEATS
        ? 'Waiting for players…'
        : `Start with ${ready}`
      : 'Waiting for the host to start';

    const children: Child[] = [
      h(
        'div',
        { class: 'invitebox' },
        h('div', { class: 'code' }, room.players.length ? this.code : ''),
        h('button', { class: 'btn primary', onclick: () => this.copyLink() }, 'Copy invite link'),
      ),
      h('h2', {}, `Players ${seated.length}/${MAX_SEATS}`),
      h('ul', { class: 'players' }, ...room.players.map((p) => this.playerRow(p, state, host && !!p.bot))),
      host &&
        h(
          'div',
          { class: 'setting' },
          h('span', { class: 'label' }, 'Add a bot'),
          h(
            'div',
            { class: 'seg', role: 'group', 'aria-label': 'Add a bot' },
            ...BOTS.map((b) =>
              h('button', { disabled: seated.length >= MAX_SEATS, onclick: () => this.on.addBot(b.value) }, `+ ${b.label}`),
            ),
          ),
        ),
      host && ready < MIN_SEATS && h('p', { class: 'muted hint-solo' }, 'Share the link, or add a bot to play solo.'),
      h('h2', {}, host ? 'Settings' : 'Settings (host picks)'),
      this.segmented('Scoring', MODE, s.mode, host, (mode) => set({ mode })),
      stepper,
      this.segmented('Mallet zone', ZONE, s.zone, host, (zone) => set({ zone })),
      this.segmented('Puck speed', SPEED, s.speed, host, (speed) => set({ speed })),
      this.segmented('Goal size', SIZE, s.goal, host, (goal) => set({ goal })),
      this.segmented('Mallet size', SIZE, s.mallet, host, (mallet) => set({ mallet })),
      h('button', { class: 'btn primary big start', disabled: !canStart, onclick: () => this.on.start() }, startLabel),
    ];
    this.panel!.replaceChildren(...children.filter((c): c is Node => c instanceof Node));
    this.panel!.classList.remove('hidden', 'mini');
  }

  private renderPlaying(state: GameState): void {
    const me = state.me;
    if (me && me.seat < 0) {
      const full = state.room!.players.filter((p) => p.seat >= 0 && !p.bot).length >= MAX_SEATS;
      const text = full ? "You're watching. The table is full, so you'll get the next free seat." : "You're watching. You'll play next match.";
      this.panel!.replaceChildren(h('p', { class: 'watching' }, text));
      this.panel!.classList.remove('hidden');
      this.panel!.classList.add('mini');
    } else {
      this.panel!.classList.add('hidden');
    }
  }

  private renderOver(state: GameState): void {
    const room = state.room!;
    const winner = room.players.find((p) => p.id === room.winner);
    const seated = room.players.filter((p) => p.seat >= 0);
    const standings = [...seated].sort((a, b) =>
      room.settings.mode === 'lives' ? Number(a.out) - Number(b.out) || b.lives - a.lives : b.score - a.score,
    );
    this.panel!.classList.remove('mini');
    this.panel!.replaceChildren(
      h(
        'div',
        { class: 'winner', style: { '--c': winner ? PALETTE[winner.color] : '#fff' } },
        h('div', { class: 'crown' }, 'WINNER'),
        h('div', { class: 'wname' }, winner ? winner.name : 'Nobody'),
      ),
      h(
        'ol',
        { class: 'standings' },
        ...standings.map((p) =>
          h(
            'li',
            {},
            h('span', { class: 'dot', style: { '--c': PALETTE[p.color] } }),
            h('span', { class: 'name' }, p.name),
            h('span', { class: 'pts' }, room.settings.mode === 'lives' ? (p.out ? 'out' : `${p.lives} ♥`) : String(p.score)),
          ),
        ),
      ),
      state.isHost
        ? h('button', { class: 'btn primary big start', onclick: () => this.on.again() }, 'Play again')
        : h('p', { class: 'muted' }, 'Waiting for the host to start another round'),
    );
    this.panel!.classList.remove('hidden');
  }
}
