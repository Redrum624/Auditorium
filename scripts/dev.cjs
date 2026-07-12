const { spawn } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');

const PORT = 3005;
const HOST = 'localhost';
const ROOT = path.join(__dirname, '..');

// Spawn the real vite/electron executables directly (no shell, no npm/npx
// wrapper) so `child.kill()` terminates the actual process instead of an
// intermediary shell whose descendants would otherwise be orphaned.
const viteBin = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
const electronBin = require('electron');

let vite = null;
let electron = null;
let shuttingDown = false;

function waitForPort(port, host, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    function attempt() {
      const socket = net.connect(port, host);
      socket.once('connect', () => {
        socket.end();
        resolve();
      });
      socket.once('error', () => {
        socket.destroy();
        if (Date.now() > deadline) {
          reject(new Error(`Timed out waiting for ${host}:${port}`));
          return;
        }
        setTimeout(attempt, 250);
      });
    }
    attempt();
  });
}

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (electron && !electron.killed) {
    electron.kill();
  }
  if (vite && !vite.killed) {
    vite.kill();
  }
  process.exit(code);
}

async function main() {
  vite = spawn(process.execPath, [viteBin, '--port', String(PORT), '--strictPort'], {
    cwd: ROOT,
    stdio: 'inherit'
  });

  vite.on('exit', (code) => {
    vite = null;
    if (!shuttingDown) {
      console.log(`vite exited (code ${code}), shutting down`);
      shutdown(code ?? 0);
    }
  });

  try {
    await waitForPort(PORT, HOST, 30000);
  } catch (err) {
    console.error(err.message);
    shutdown(1);
    return;
  }

  electron = spawn(electronBin, ['.'], {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, VITE_DEV_SERVER: '1' }
  });

  electron.on('exit', (code) => {
    electron = null;
    if (!shuttingDown) {
      console.log(`electron exited (code ${code}), shutting down`);
      shutdown(code ?? 0);
    }
  });
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

main();
