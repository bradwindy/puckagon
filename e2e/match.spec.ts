import { expect, test, type Page } from '@playwright/test';
import { DEFAULT_SETTINGS, TARGET_MIN } from '../src/shared/settings';

interface Recorded {
  pcs: RTCPeerConnection[];
}

/** The fields of an RTCDataChannelStats entry used here. TypeScript's DOM types don't include it. */
interface ChannelStats {
  type: string;
  label?: string;
  messagesSent?: number;
  messagesReceived?: number;
}

/** Runs in the page before its own scripts, and keeps every RTCPeerConnection it makes so the test can read their stats. */
function recordPeerConnections(): void {
  const pcs: RTCPeerConnection[] = [];
  (window as unknown as Recorded).pcs = pcs;
  const Native = window.RTCPeerConnection;
  window.RTCPeerConnection = class extends Native {
    constructor(config?: RTCConfiguration) {
      super(config);
      pcs.push(this);
    }
  };
}

/** The message types the page's party sockets carry, either way. */
function partyFrames(page: Page): Set<string> {
  const types = new Set<string>();
  page.on('websocket', (ws) => {
    if (!ws.url().includes('/api/party/')) return;
    const note = ({ payload }: { payload: string | Buffer }) => {
      if (typeof payload !== 'string' || payload === 'ping' || payload === 'pong') return;
      types.add(String((JSON.parse(payload) as { t?: unknown }).t));
    };
    ws.on('framesent', note);
    ws.on('framereceived', note);
  });
  return types;
}

/** Messages each way on the page's open `state` channels: snapshots and pongs in, inputs and pings out. */
function stateTraffic(page: Page): Promise<{ sent: number; received: number }> {
  return page.evaluate(async () => {
    const total = { sent: 0, received: 0 };
    for (const pc of (window as unknown as Recorded).pcs) {
      if (pc.connectionState === 'closed') continue;
      (await pc.getStats()).forEach((s: ChannelStats) => {
        if (s.type !== 'data-channel' || s.label !== 'state') return;
        total.sent += s.messagesSent ?? 0;
        total.received += s.messagesReceived ?? 0;
      });
    }
    return total;
  });
}

test('a guest plays a match with the host over a game link, not the party socket', async ({ browser }) => {
  const hostContext = await browser.newContext();
  const guestContext = await browser.newContext();
  await guestContext.addInitScript(recordPeerConnections);
  const host = await hostContext.newPage();
  const guest = await guestContext.newPage();
  const hostFrames = partyFrames(host);
  const guestFrames = partyFrames(guest);

  await host.goto('/');
  await host.getByLabel('Your name').fill('Host');
  await host.getByRole('button', { name: 'Create party' }).click();
  await expect(host).toHaveURL(/\/p\/[A-Z0-9]{5}$/);
  await host.getByRole('button', { name: '+ Hard' }).click();
  for (let target = DEFAULT_SETTINGS.target - 1; target >= TARGET_MIN; target--) {
    await host.getByRole('button', { name: 'Less' }).click();
    await expect(host.locator('.stepper output')).toHaveText(String(target));
  }
  // A fast puck and wide goals keep the match short.
  await host.getByRole('group', { name: 'Puck speed' }).getByRole('button', { name: 'Chaos' }).click();
  await host.getByRole('group', { name: 'Goal size' }).getByRole('button', { name: 'L', exact: true }).click();

  await guest.goto(new URL(host.url()).pathname);
  await guest.getByLabel('Your name').fill('Guest');
  await guest.getByRole('button', { name: 'Join party' }).click();
  // The guest's ping shows in the host's lobby once its game link is up and has timed a round trip.
  await expect(host.locator('li.player', { hasText: 'Guest' }).locator('.ping-tag')).toHaveText(/^\d+ ms$/, { timeout: 15000 });

  await host.getByRole('button', { name: 'Start with 3' }).click();
  await expect(guest.getByText('WINNER')).toBeVisible({ timeout: 150000 });
  await expect(host.getByText('WINNER')).toBeVisible();

  const traffic = await stateTraffic(guest);
  // Every match has at least its 3 s countdown, through which the host sends a snapshot and the guest an input each tick.
  expect(traffic.received).toBeGreaterThan(180);
  expect(traffic.sent).toBeGreaterThan(180);
  for (const frames of [hostFrames, guestFrames]) {
    const types = [...frames];
    expect(types).toContain('room');
    expect(types).toContain('signal');
    expect(types).not.toContain('s');
    expect(types).not.toContain('p');
  }

  await hostContext.close();
  await guestContext.close();
});
