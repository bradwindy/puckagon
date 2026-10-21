import { cloudflare } from '@cloudflare/vite-plugin';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [cloudflare()],
  // Emit every asset as a file. Inlined data: URIs (small font subsets) would break the font-src CSP.
  build: { assetsInlineLimit: 0 },
});
