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
    strictPort: true,
    watch: {
      // M2: agent worktrees live under `.claude/worktrees/<id>/`, each a FULL
      // checkout of this repo with a `node_modules` symlink back to this one.
      // The dev server's watcher walks the project root, so a file written in
      // a worktree — a rebase touching `tsconfig.json`, a subagent saving a
      // component — read as a change to THIS project and force-reloaded the
      // user's live app mid-session. The worktrees are gitignored and are
      // never inputs to this build; the watcher has no business in them.
      ignored: ['**/.claude/**']
    }
  }
});
