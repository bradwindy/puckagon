import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      // The room looks up its own data centre when a match starts. Tests answer that here instead of going online.
      miniflare: { outboundService: () => new Response('colo=TST\n') },
    }),
  ],
  test: {
    include: ['test/**/*.test.ts'],
  },
});
