import { describe, expect, it } from 'vitest';
import { Match } from '../src/host/match';
import type { MatchSeat } from '../src/host/messages';
import {
  BOT_LEVELS,
  COUNTDOWN_MS,
  MAX_SAMPLES,
  RECONNECT_GRACE_MS,
  SCORED_MS,
  TICK_HZ,
  type BotLevel,
  type EventMsg,
  type HostMsg,
  type MatchMsg,
  type SeatState,
  type SnapMsg,
} from '../src/shared/protocol';
import { resolveGoal } from '../src/shared/rules';
import { DEFAULT_SETTINGS, type Settings } from '../src/shared/settings';

const STEP_MS = 1000 / TICK_HZ;
const MATCH = 3;

/** Small seeded generator, so bot matches play out the same way on every run. */
function seeded(seed: number): () => number {
  return () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
}

interface Options {
  settings?: Partial<Settings>;
  /** Guests whose game links are open at the start. All of them unless given. */
  linked?: string[];
  bots?: BotLevel[];
  random?: () => number;
}

/** A new match MATCH with `people` people seated in order, p0 (the host) first, then any bots as bot0, bot1, ... */
function newMatch(people: number, opts: Options = {}) {
  const sent: { msg: HostMsg; reliable: boolean }[] = [];
  const reports: MatchMsg[] = [];
  const clock = { now: 1_000_000 };
  const ids = Array.from({ length: people }, (_, i) => `p${i}`);
  const players: MatchSeat[] = [
    ...ids.map((id) => ({ id, bot: null })),
    ...(opts.bots ?? []).map((bot, i) => ({ id: `bot${i}`, bot })),
  ].map((p, seat) => ({ ...p, seat }));
  const match = new Match(
    {
      send: (msg, reliable) => sent.push({ msg, reliable }),
      report: (msg) => reports.push(msg),
      random: opts.random ?? (() => 0.5),
    },
    {
      match: MATCH,
      settings: { ...DEFAULT_SETTINGS, ...opts.settings },
      seats: players.length,
      players,
      host: 'p0',
      linked: opts.linked ?? ids.slice(1),
    },
    clock.now,
  );
  const of = <T extends HostMsg['t']>(t: T) =>
    sent.map((s) => s.msg).filter((m): m is Extract<HostMsg, { t: T }> => m.t === t);
  const lastMatch = () => of('match').at(-1)!;
  const tick = () => match.tick((clock.now += STEP_MS));
  const tickFor = (ms: number) => {
    for (let i = 0; i < Math.ceil(ms / STEP_MS) + 1; i++) tick();
  };
  /** Fires the puck from the centre straight into a seat's goal, as if `hitter` had just hit it. */
  const shootAt = (seat: number, hitter: number) => {
    for (let i = 0; i < 1000 && match.phase !== 'playing'; i++) tick();
    const w = match.world!;
    const side = w.layout.sides[w.layout.goalSide[seat]];
    w.puck = { x: 0, y: 0, vx: -side.normal.x * 2, vy: -side.normal.y * 2 };
    w.lastHitter = hitter;
    w.touches = [hitter];
    w.mallets = w.mallets.map(() => null);
    for (let i = 0; i < 300 && match.phase === 'playing'; i++) tick();
  };
  return { match, sent, reports, of, lastMatch, clock, tick, tickFor, shootAt };
}

/** A match past its countdown. */
function startMatch(people: number, opts: Options = {}) {
  const r = newMatch(people, opts);
  r.tickFor(COUNTDOWN_MS);
  return r;
}

const seatsOf = <K extends keyof SeatState>(msg: MatchMsg, key: K) => msg.seats.map((s) => s[key]);

describe('resolveGoal', () => {
  it('credits the last toucher other than the conceder, and nobody for own goals or untouched pucks', () => {
    expect(resolveGoal('points', 2, [0])).toEqual({ scorer: 0, kind: 'score' });
    expect(resolveGoal('points', 2, [2, 0, 1])).toEqual({ scorer: 0, kind: 'score' });
    expect(resolveGoal('points', 2, [2])).toEqual({ scorer: -1, kind: 'own' });
    expect(resolveGoal('points', 2, [])).toEqual({ scorer: -1, kind: 'none' });
    expect(resolveGoal('lives', 2, [2, 1])).toEqual({ scorer: 1, kind: 'life' });
  });
});

describe('Match scoring', () => {
  it('gives the point to the last hitter and ends at the target', () => {
    const { shootAt, lastMatch } = startMatch(3, { settings: { target: 3 } });
    expect(lastMatch().phase).toBe('playing');
    for (let i = 0; i < 3; i++) shootAt(1, 0);
    expect(lastMatch()).toMatchObject({ phase: 'over', winner: 'p0' });
    expect(seatsOf(lastMatch(), 'score')).toEqual([3, 0, 0]);
  });

  it('does not score own goals', () => {
    const { shootAt, lastMatch } = startMatch(2);
    shootAt(1, 1);
    expect(seatsOf(lastMatch(), 'score')).toEqual([0, 0]);
  });

  it('in lives mode, closes the goal of a player who runs out and crowns the last one standing', () => {
    const { match, shootAt, lastMatch } = startMatch(3, { settings: { mode: 'lives', target: 3 } });
    for (let i = 0; i < 3; i++) shootAt(2, 0);
    expect(lastMatch().seats[2]).toMatchObject({ lives: 0, out: true });
    expect(match.world!.open[2]).toBe(false);
    for (let i = 0; i < 3; i++) shootAt(1, 0);
    expect(lastMatch()).toMatchObject({ phase: 'over', winner: 'p0' });
  });
});

describe('Match messages', () => {
  const COUNTDOWN_TICKS = (COUNTDOWN_MS * TICK_HZ) / 1000;
  const SCORED_TICKS = (SCORED_MS * TICK_HZ) / 1000;

  it('numbers every change, says which tick each phase began on, and reports exactly what it sends', () => {
    const { match, sent, reports, of, lastMatch, clock, tickFor, shootAt } = newMatch(2);
    const fresh: SeatState = { score: 0, lives: DEFAULT_SETTINGS.target, out: false, linked: true };
    expect(sent).toEqual([
      {
        reliable: true,
        msg: { t: 'match', match: MATCH, v: 1, phase: 'countdown', k: 0, timer: COUNTDOWN_MS, seats: [fresh, fresh], winner: null },
      },
    ]);

    tickFor(COUNTDOWN_MS);
    expect(lastMatch()).toMatchObject({ v: 2, phase: 'playing', k: COUNTDOWN_TICKS, timer: 0 });
    const snapAt = (k: number) => of('s').find((s) => s.k === k)!;
    expect(snapAt(COUNTDOWN_TICKS - 1).p).toEqual([0, 0, 0, 0]);
    expect(snapAt(COUNTDOWN_TICKS).p).not.toEqual([0, 0, 0, 0]);

    match.link('p1', false, clock.now);
    expect(lastMatch()).toMatchObject({ v: 3, phase: 'playing', k: COUNTDOWN_TICKS });
    expect(seatsOf(lastMatch(), 'linked')).toEqual([true, false]);

    shootAt(1, 0);
    const goal = of('goal').at(-1)!;
    expect(goal).toMatchObject({ n: MATCH, seat: 1, scorer: 0, kind: 'score' });
    expect(lastMatch()).toMatchObject({ v: 4, phase: 'scored', k: goal.k, timer: SCORED_MS });
    expect(seatsOf(lastMatch(), 'score')).toEqual([1, 0]);

    tickFor(SCORED_MS);
    expect(lastMatch()).toMatchObject({ v: 5, phase: 'playing', k: goal.k + SCORED_TICKS });

    expect(sent.filter((s) => s.msg.t === 'match' || s.msg.t === 'goal').every((s) => s.reliable)).toBe(true);
    expect(reports).toEqual(of('match'));
  });

  it("sends a snapshot of every tick unreliably, and a tick's hits and bounces reliably on their own", () => {
    const { match, sent, tick } = startMatch(2);
    const w = match.world!;
    const { mid, normal } = w.layout.sides.find((s) => s.owner < 0)!;
    const gap = w.layout.puckR + 0.01;
    w.puck = { x: mid.x + normal.x * gap, y: mid.y + normal.y * gap, vx: -normal.x * 3, vy: -normal.y * 3 };
    const from = sent.length;
    tick();
    tick();
    const out = sent.slice(from);
    expect(out.map((s) => [s.msg.t, s.reliable])).toEqual([
      ['e', true],
      ['s', false],
      ['s', false],
    ]);
    const [e, s] = out.map((o) => o.msg) as [EventMsg, SnapMsg];
    expect(s.n).toBe(MATCH);
    expect(s).not.toHaveProperty('e');
    expect(e).toMatchObject({ n: MATCH, k: s.k });
    expect(e.e.map((ev) => ev[0])).toEqual([1]);
  });
});

describe('Match presence', () => {
  it('closes the goal of a guest whose link stays down for the grace, and keeps one who relinks in time', () => {
    const { match, clock, tickFor, lastMatch } = startMatch(3, { settings: { target: 15 } });
    match.link('p1', false, clock.now);
    match.link('p2', false, clock.now);
    tickFor(2000);
    match.link('p1', true, clock.now);
    expect(seatsOf(lastMatch(), 'linked')).toEqual([true, true, false]);
    tickFor(RECONNECT_GRACE_MS);
    expect(match.world!.open).toEqual([true, true, false]);
    expect(seatsOf(lastMatch(), 'out')).toEqual([false, false, true]);
    expect(lastMatch().phase).not.toBe('over');
  });

  it('closes the goal of a guest who never links, but not of one linked at the start', () => {
    const { tickFor, lastMatch } = newMatch(3, { linked: ['p1'], bots: ['easy'], settings: { target: 15 } });
    expect(seatsOf(lastMatch(), 'linked')).toEqual([true, true, false, true]);
    tickFor(RECONNECT_GRACE_MS - 500);
    expect(seatsOf(lastMatch(), 'out')).toEqual([false, false, false, false]);
    tickFor(600);
    expect(seatsOf(lastMatch(), 'out')).toEqual([false, false, true, false]);
  });

  it('never credits a player who has been knocked out with a later goal', () => {
    const { match, clock, tickFor, shootAt, lastMatch } = startMatch(3, { settings: { target: 3 } });
    for (let i = 0; i < 2; i++) shootAt(1, 2);
    for (let i = 0; i < 300 && match.phase !== 'playing'; i++) tickFor(STEP_MS);
    const w = match.world!;
    // p2's parked mallet touches the puck, then p2's link grace runs out while the puck is held still.
    w.touches = [2];
    w.lastHitter = 2;
    w.frozen = true;
    match.link('p2', false, clock.now);
    tickFor(RECONNECT_GRACE_MS + 100);
    expect(lastMatch().seats[2].out).toBe(true);
    const side = w.layout.sides[w.layout.goalSide[0]];
    w.puck = { x: 0, y: 0, vx: -side.normal.x * 2, vy: -side.normal.y * 2 };
    w.mallets = w.mallets.map(() => null);
    w.frozen = false;
    tickFor(1500);
    expect(lastMatch().seats[2].score).toBe(2);
    expect(lastMatch().phase).not.toBe('over');
  });

  it('closes the goal of a guest who presses Leave at once, and ends the match when one player is left', () => {
    const { match, lastMatch } = startMatch(3);
    match.quit('p2');
    expect(match.world!.open).toEqual([true, true, false]);
    expect(lastMatch()).toMatchObject({ phase: 'playing' });
    expect(seatsOf(lastMatch(), 'out')).toEqual([false, false, true]);
    match.quit('p1');
    expect(lastMatch()).toMatchObject({ phase: 'over', winner: 'p0' });
  });
});

describe('Match input', () => {
  /** Points on a line from a seat's mallet towards the centre, `step` apart. */
  const sweep = (match: Match, seat: number, step: number) => {
    const { x, y } = match.world!.mallets[seat]!;
    const d = Math.hypot(x, y);
    return (i: number) => [x - (x / d) * step * i, y - (y / d) * step * i];
  };
  const mallet = (match: Match, seat: number) => match.world!.mallets[seat]!;

  it('moves the mallet the same distance every tick when samples arrive two at a time', () => {
    const { match, tick } = startMatch(2);
    const at = sweep(match, 0, 0.01);
    const moved: number[] = [];
    for (let i = 1; i < 20; i += 2) {
      match.input('p0', i, [...at(i), ...at(i + 1)]);
      for (let j = 0; j < 2; j++) {
        const { x, y } = mallet(match, 0);
        tick();
        moved.push(Math.round(Math.hypot(mallet(match, 0).x - x, mallet(match, 0).y - y) * 1000) / 1000);
      }
    }
    expect(moved).toEqual(moved.map(() => 0.01));
  });

  it('keeps only the newest four samples, holds the last one, and ignores malformed input', () => {
    const { match, tick } = startMatch(2);
    const at = sweep(match, 0, 0.05);
    const target = () => [mallet(match, 0).tx, mallet(match, 0).ty];
    match.input('p0', 1, [...at(1), ...at(2)]);
    match.input('p0', 3, [...at(3), ...at(4), ...at(5)]);
    tick();
    expect(target()).toEqual(at(2));
    for (let i = 0; i < 4; i++) tick();
    expect(target()).toEqual(at(5));
    const tooMany = Array.from({ length: MAX_SAMPLES + 1 }, (_, i) => at(6 + i)).flat();
    const badSamples = [[at(6)[0]], tooMany, [at(6)[0], NaN], [at(6)[0], '0.1'], 'x'];
    const bad = [...badSamples.map((q) => [6, q]), ...[-1, 6.5, Infinity, '6', undefined].map((s) => [s, at(6)])];
    for (const [s, q] of bad) {
      match.input('p0', s, q);
      tick();
      expect(target()).toEqual(at(5));
    }
  });

  it('acks the last sample applied in every snapshot, skips samples the queue dropped, and starts over on a new link', () => {
    const { match, of, clock, tick } = startMatch(2);
    const at = sweep(match, 1, 0.001);
    const acks = () => of('s').at(-1)!.a;
    tick();
    expect(acks()).toEqual([-1, -1]);

    const seen: number[] = [];
    for (let s = 0; s < 40; s += 2) {
      match.input('p1', s, [...at(s), ...at(s + 1)]);
      for (let j = 0; j < 2; j++) {
        tick();
        seen.push(acks()[1]);
      }
    }
    expect(seen).toEqual(seen.map((_, i) => i));

    match.input('p1', 40, [...at(40), ...at(41), ...at(42)]);
    match.input('p1', 43, [...at(43), ...at(44), ...at(45)]);
    seen.length = 0;
    for (let i = 0; i < 5; i++) {
      tick();
      seen.push(acks()[1]);
    }
    expect(seen).toEqual([42, 43, 44, 45, 45]);

    // A reloaded page numbers its samples from 0 again.
    match.link('p1', false, clock.now);
    match.link('p1', true, clock.now);
    tick();
    expect(acks()).toEqual([-1, -1]);
    match.input('p1', 7, at(7));
    tick();
    expect(acks()).toEqual([-1, 7]);
  });

  it('takes each sample once, however often it is repeated', () => {
    const { match, of, tick } = startMatch(2);
    const at = sweep(match, 1, 0.01);
    match.input('p1', 0, [...at(0), ...at(1)]);
    tick();
    // The next message repeats sample 1, which isn't acked yet, and a late copy of the first arrives too.
    match.input('p1', 1, [...at(1), ...at(2)]);
    match.input('p1', 0, [...at(0), ...at(1)]);
    const acks: number[] = [];
    for (let i = 0; i < 3; i++) {
      tick();
      acks.push(of('s').at(-1)!.a[1]);
    }
    expect(acks).toEqual([1, 2, 2]);
  });
});

describe('Match hit events', () => {
  it('keeps a held puck quiet after its first contact, and sends at most one hit per seat every four ticks', () => {
    const { match, sent, tick } = startMatch(2);
    const w = match.world!;
    const events = (kind: 0 | 1, from: number) =>
      sent.slice(from).flatMap(({ msg }) => (msg.t === 'e' ? msg.e.filter((e) => e[0] === kind).map((e) => e[4]) : []));
    /** Puts the puck against a seat's mallet, `angle` radians round from the side facing the centre, moving into it. */
    const strike = (seat: number, angle: number) => {
      const m = w.mallets[seat]!;
      const toCentre = Math.atan2(-m.y, -m.x) + angle;
      const [nx, ny] = [Math.cos(toCentre), Math.sin(toCentre)];
      const gap = w.layout.puckR + w.layout.malletR + 0.01;
      w.puck = { x: m.x + nx * gap, y: m.y + ny * gap, vx: -nx * 3, vy: -ny * 3 };
    };

    let from = sent.length;
    for (let i = 0; i < 16; i++) {
      strike(i % 2, 0);
      tick();
    }
    expect(events(0, from)).toEqual([0, 1]);

    w.puck = { x: 0, y: 0, vx: 0, vy: 0 };
    for (let i = 0; i < 30; i++) tick();
    from = sent.length;
    for (let i = 0; i < 16; i++) {
      strike(i % 2, ((i >> 1) - 3.5) * 0.4);
      tick();
    }
    const hits = events(0, from);
    expect(hits.filter((seat) => seat === 0)).toHaveLength(4);
    expect(hits.filter((seat) => seat === 1)).toHaveLength(4);

    from = sent.length;
    const wall = w.layout.sides.find((s) => s.owner < 0)!;
    for (let i = 0; i < 16; i++) {
      const { mid, normal } = wall;
      const gap = w.layout.puckR + 0.01;
      w.puck = { x: mid.x + normal.x * gap, y: mid.y + normal.y * gap, vx: -normal.x * 3, vy: -normal.y * 3 };
      tick();
    }
    expect(events(1, from)).toHaveLength(1);
  });
});

describe('Match bots', () => {
  it('bots of each level play a full match to the end without a person touching the puck', () => {
    for (const level of BOT_LEVELS) {
      const { match, of, tick } = newMatch(1, { bots: [level, level], settings: { target: 3 }, random: seeded(7) });
      for (let i = 0; i < 5 * 60 * TICK_HZ && !match.over; i++) tick();
      expect(match.over).toBe(true);
      expect(of('goal').filter((g) => g.kind === 'score').length).toBeGreaterThanOrEqual(3);
    }
  });
});
