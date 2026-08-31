const { spawn, spawnSync } = require('node:child_process');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');

const HOST = '127.0.0.1';
const DEFAULT_PORT = 5173;
const MAX_PORT_SCAN = 100;
const projectRoot = path.resolve(__dirname, '..');

function parsePort(value, fallback) {
  const port = Number.parseInt(value ?? '', 10);
  return Number.isInteger(port) && port > 0 && port < 65_536 ? port : fallback;
}

function canListen(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    const cleanup = (available) => {
      server.removeAllListeners();
      server.close(() => resolve(available));
    };
    server.once('error', () => cleanup(false));
    server.listen(port, HOST, () => cleanup(true));
  });
}

async function findAvailablePort(preferredPort) {
  for (let offset = 0; offset < MAX_PORT_SCAN; offset += 1) {
    const candidate = preferredPort + offset;
    if (candidate >= 65_536) break;
    if (await canListen(candidate)) return candidate;
  }
  throw new Error(`No available development port found from ${preferredPort}.`);
}

function waitForVite(url, timeoutMs = 30_000) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      const request = http.get(url, (response) => {
        response.resume();
        if (response.statusCode && response.statusCode < 500) {
          resolve();
        } else {
          retry();
        }
      });
      request.on('error', retry);
      request.setTimeout(1_000, () => request.destroy());
    };
    const retry = () => {
      if (Date.now() - startedAt >= timeoutMs) {
        reject(new Error(`Timed out waiting for Vite at ${url}.`));
        return;
      }
      setTimeout(check, 200);
    };
    check();
  });
}

function terminate(child) {
  if (!child || child.exitCode !== null || child.killed || !child.pid) return;
  if (process.platform === 'win32') {
    // `child.kill()` only closes the wrapper on Windows. Kill the exact
    // process tree so Electron renderer/utility children do not survive a
    // Ctrl+C and hold the Vite port or user-data lock on the next run.
    spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true });
    return;
  }
  child.kill('SIGTERM');
}

async function main() {
  const preferredPort = parsePort(process.env.VITE_PORT, DEFAULT_PORT);
  const port = await findAvailablePort(preferredPort);
  if (port !== preferredPort) {
    console.log(`Port ${preferredPort} is already in use; using ${port} for this development session.`);
  }

  const viteCli = path.join(projectRoot, 'node_modules', 'vite', 'bin', 'vite.js');
  const vite = spawn(process.execPath, [viteCli, '--host', HOST, '--port', String(port)], {
    cwd: projectRoot,
    env: { ...process.env, VITE_PORT: String(port) },
    stdio: 'inherit',
    windowsHide: false,
  });

  let electron;
  let shuttingDown = false;
  const shutdown = (exitCode = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    terminate(electron);
    terminate(vite);
    if (exitCode !== null) process.exitCode = exitCode;
  };

  vite.once('error', (error) => {
    console.error('Unable to start Vite:', error.message);
    shutdown(1);
  });
  vite.once('exit', (code, signal) => {
    if (!shuttingDown && (code ?? 1) !== 0) {
      console.error(`Vite exited with ${signal ? `signal ${signal}` : `code ${code}`}.`);
      shutdown(code ?? 1);
    }
  });

  try {
    await waitForVite(`http://${HOST}:${port}`);
    const electronArgs = [path.join(projectRoot, 'node_modules/electron/cli.js')];
    const cdpPort = parsePort(process.env.ELECTRON_CDP_PORT, 0);
    if (cdpPort > 0) electronArgs.push(`--remote-debugging-port=${cdpPort}`);
    const userDataDir = process.env.ELECTRON_USER_DATA_DIR?.trim();
    if (userDataDir) electronArgs.push(`--user-data-dir=${path.resolve(projectRoot, userDataDir)}`);
    electronArgs.push('.');
    electron = spawn(process.execPath, electronArgs, {
      cwd: projectRoot,
      env: { ...process.env, ELECTRON_RENDERER_URL: `http://${HOST}:${port}` },
      stdio: 'inherit',
      windowsHide: false,
    });
    electron.once('error', (error) => {
      console.error('Unable to start Electron:', error.message);
      shutdown(1);
    });
    electron.once('exit', (code, signal) => {
      if (!shuttingDown) {
        if (signal) console.error(`Electron exited with signal ${signal}.`);
        shutdown(code ?? 1);
      }
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    shutdown(1);
  }

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => shutdown(0));
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
