import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// index.html's CSP allows `ws:` and `http://localhost:3005` in connect-src
// solely so the Vite dev server's HMR websocket can reach the page. Neither
// is needed (or safe) in a production build, which never talks to a dev
// server. This plugin only runs for `vite build` (apply: 'build') and
// rewrites connect-src down to 'self' in the emitted dist/index.html.
function hardenProductionCsp(): Plugin {
  return {
    name: 'harden-production-csp',
    apply: 'build',
    transformIndexHtml(html) {
      return html.replace(
        /connect-src [^;"]*/,
        "connect-src 'self'"
      );
    }
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), hardenProductionCsp()],
  base: './',
  build: {
    outDir: 'dist',
    sourcemap: true
  },
  server: {
    port: 3005,
    strictPort: true
  }
});
