#!/usr/bin/env node
import { spawn } from 'child_process';
import path from 'path';
import net from 'net';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(__dirname, '..', 'src', 'index.ts');
const root = path.join(__dirname, '..');

// Resolve PORT the same way src/index.ts does (dotenv), so the check hits
// the port the server would actually bind even without PORT in the shell.
function resolvePort() {
  const fromEnv = process.env.PORT;
  if (fromEnv) return parseInt(fromEnv, 10);
  try {
    const envFile = fs.readFileSync(path.join(root, '.env'), 'utf8');
    const match = envFile.match(/^PORT\s*=\s*(\d+)/m);
    if (match) return parseInt(match[1], 10);
  } catch { /* no .env, fall back to default */ }
  return 3000;
}

function isPortBusy(port) {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host: '127.0.0.1' });
    sock.setTimeout(3000, () => { sock.destroy(); resolve(true); });
    sock.once('connect', () => { sock.destroy(); resolve(true); });
    sock.once('error', () => resolve(false));
  });
}

const port = resolvePort();
const args = process.argv.slice(2);

// If anything is already listening on the port (the systemd service, a manual
// instance, or an unrelated process), spawning another qwenproxy would crash
// with EADDRINUSE — warn and exit instead.
if (await isPortBusy(port)) {
  console.log(`[qwenproxy] Port ${port} is already in use — another qwenproxy instance appears to be running at http://localhost:${port}.`);
  console.log(`[qwenproxy] Stop the existing instance first if you want to start a new one.`);
  process.exit(0);
}

const proc = spawn('node', ['--import', 'tsx', script, ...args], { stdio: 'inherit', cwd: root });
proc.on('close', (code) => process.exit(code ?? 0));
