import { KEEPALIVE_MS, TICK_HZ } from '../shared/protocol';
import { Match, type MatchIO } from './match';
import type { FromWorker, MatchInit, ToWorker } from './messages';

/** The parts of DedicatedWorkerGlobalScope used here. This file is type-checked with the app's DOM lib. */
interface Scope {
  postMessage(msg: FromWorker): void;
  addEventListener(type: 'message', listener: (e: MessageEvent<ToWorker>) => void): void;
}

const scope = self as unknown as Scope;
const STEP_MS = 1000 / TICK_HZ;
const MAX_CATCH_UP = 4;

const post = (msg: FromWorker) => scope.postMessage(msg);
const io: MatchIO = {
  send: (msg, reliable) => post({ t: 'send', data: JSON.stringify(msg), reliable }),
  report: (msg) => post({ t: 'report', msg }),
  random: Math.random,
};

let match: Match | null = null;
let loop: ReturnType<typeof setTimeout> | null = null;
let loopStart = 0;
let ticksRun = 0;
let beatAt = 0;

function begin(init: MatchInit): void {
  stop();
  const now = performance.now();
  match = new Match(io, init, now);
  loopStart = beatAt = now;
  ticksRun = 0;
  schedule();
}

/** Aims each timer at the next tick boundary, so ticks follow the clock however the browser rounds delays. */
function schedule(): void {
  const next = loopStart + (ticksRun + 1) * STEP_MS;
  loop = setTimeout(run, Math.max(0, Math.ceil(next - performance.now())));
}

/**
 * Runs the ticks that are due, at most MAX_CATCH_UP per wake, so a long stall isn't replayed at once. A tick that
 * throws is left uncaught, so the page sees the worker's error event and ends the match instead of this worker running
 * a broken one.
 */
function run(): void {
  loop = null;
  const now = performance.now();
  const due = Math.floor((now - loopStart) / STEP_MS);
  ticksRun = Math.max(ticksRun, due - MAX_CATCH_UP);
  while (ticksRun < due && match && !match.over) {
    ticksRun++;
    match.tick(now);
  }
  if (!match || match.over) return;
  if (now - beatAt >= KEEPALIVE_MS) {
    beatAt = now;
    post({ t: 'beat' });
  }
  schedule();
}

function stop(): void {
  if (loop) clearTimeout(loop);
  loop = null;
  match = null;
}

scope.addEventListener('message', ({ data: msg }) => {
  switch (msg.t) {
    case 'start':
      begin(msg.init);
      break;
    case 'input':
      match?.input(msg.id, msg.s, msg.q);
      break;
    case 'link':
      match?.link(msg.id, msg.up, performance.now());
      break;
    case 'quit':
      match?.quit(msg.id);
      break;
    case 'stop':
      stop();
      break;
  }
});
