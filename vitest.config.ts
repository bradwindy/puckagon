import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      // A made-up TURN key, so parties ask for TURN servers. test/party.test.ts answers those requests itself.
      miniflare: { bindings: { TURN_KEY_ID: 'test-key-id', TURN_KEY_API_TOKEN: 'test-key-token' } },
    }),
  ],
  test: {
    include: ['test/**/*.test.ts'],
  },
});
