import { defineConfig } from '@playwright/test';

/** Not Vite's default, so a dev server you already have running doesn't get in the way. */
const PORT = 5287;

export default defineConfig({
  testDir: './e2e',
  timeout: 180000,
  workers: 1,
  forbidOnly: !!process.env.CI,
  reporter: 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    channel: 'chrome',
    // Two browser contexts on one machine connect over host candidates, which Chrome otherwise hides behind mDNS names.
    launchOptions: { args: ['--disable-features=WebRtcHideLocalIpsWithMdns'] },
  },
  webServer: {
    command: `npm run dev -- --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    timeout: 60000,
  },
});
