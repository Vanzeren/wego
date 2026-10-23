// wego-browser CLI: nodejs | skill | launch | help | version | doctor
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const execFileP = promisify(execFile);

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const VERSION = '0.1.0';

function socketPath() {
  return process.env.WEGO_BRIDGE_SOCK || path.join(os.homedir(), '.wego', 'bridge.sock');
}

function probeSocket(sockPath, timeoutMs = 300) {
  return new Promise((resolve) => {
    const sock = net.connect(sockPath);
    const done = (ok) => {
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
  });
}

// One NDJSON bridge request; throws on error response or connect failure.
function bridgeRequest(method, params = {}, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(socketPath());
    let buf = '';
    const fail = (err) => {
      sock.destroy();
      reject(err);
    };
    sock.setTimeout(timeoutMs, () => fail(new Error(`bridge ${method}: timeout`)));
    sock.once('error', fail);
    sock.on('data', (chunk) => {
      buf += chunk;
      // skip push events and other frames; only our response (id 1) resolves
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue; // unframed garbage; bridge drops it too
        }
        if (msg.id !== 1) continue; // debounced push (e.g. spaceChanged)
        if (msg.error) {
          const err = new Error(msg.error.message || `bridge ${method} failed`);
          err.error_code = msg.error.error_code;
          return fail(err);
        }
        sock.destroy();
        resolve(msg.result);
        return;
      }
    });
    sock.on('connect', () => {
      sock.write(JSON.stringify({ id: 1, method, params }) + '\n');
    });
  });
}

// Electron binary resolution: explicit env override → repo-local devDependency
// (npm ci gives a pinned, reproducible Electron) → PATH fallback.
function resolveElectron() {
  if (process.env.WEGO_ELECTRON) return process.env.WEGO_ELECTRON;
  const local = path.join(repoRoot, 'node_modules', 'electron', 'dist', 'electron');
  if (fs.existsSync(local)) return local;
  return 'electron';
}

// Start the browser if the bridge is unreachable, wait for readiness.
// Electron stderr goes to <stateDir>/electron-stderr.log — a silent launch
// failure (missing system libs, sandbox helper) is otherwise undiagnosable.
async function ensureBrowser() {
  if (await probeSocket(socketPath())) return;
  const electron = resolveElectron();
  let stderrFd = 'ignore';
  const logFile = path.join(path.dirname(socketPath()), 'electron-stderr.log');
  try { stderrFd = fs.openSync(logFile, 'a'); } catch { /* state dir not writable */ }
  const child = spawn(electron, [repoRoot], {
    detached: true,
    stdio: ['ignore', 'ignore', stderrFd],
    env: process.env, // WEGO_BRIDGE_SOCK passes through when set
  });
  child.unref();
  child.once('error', () => {}); // poll below reports the failure
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250));
    if (await probeSocket(socketPath())) return;
  }
  console.error('failed to start the wego browser');
  try {
    const log = fs.readFileSync(logFile, 'utf8');
    if (log.trim()) console.error('last electron stderr:\n' + log.trim().split('\n').slice(-15).join('\n'));
  } catch { /* no log captured */ }
  process.exit(1);
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

const USAGE = `wego-browser ${VERSION} — drive the wego agent browser on Linux

Usage: wego-browser <command>

Commands:
  nodejs      Run a browser automation script (stdin or -e '<code>')
  skill       Print the wego-browser agent skill guide
  launch      Start the wego browser and wait until ready
  profiles    List profiles; 'profiles create <name>' adds one
  version     Print the CLI version
  doctor      Check the local environment
  help        Show this help

Options for 'nodejs':
  -e <code>         Run inline code instead of reading stdin
  --sdk-path <dir>  Accepted for ego compatibility; ignored on Linux
  -h, --help        Show 'nodejs' usage

Environment:
  WEGO_BRIDGE_SOCK   Bridge socket path (default ~/.wego/bridge.sock)
  WEGO_ELECTRON      Electron binary to launch (default: electron on PATH)
`;

const NODEJS_USAGE = `Usage: wego-browser nodejs [-e '<code>'] [--sdk-path <dir>]

Reads JavaScript from stdin (or -e) and runs it against the wego browser,
starting the browser first when it is not running.
`;

async function cmdNodejs(args) {
  let code = null;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '-h' || arg === '--help') {
      process.stdout.write(NODEJS_USAGE);
      return 0;
    }
    if (arg === '-e') {
      code = args[++i];
      if (code === undefined) {
        console.error('nodejs: -e requires an argument');
        return 2;
      }
      continue;
    }
    if (arg === '--sdk-path') {
      if (args[++i] === undefined) {
        console.error('nodejs: --sdk-path requires an argument');
        return 2;
      }
      console.error('note: --sdk-path is accepted for ego compatibility and ignored on Linux');
      continue;
    }
    console.error(`nodejs: unknown argument: ${arg}`);
    process.stderr.write(NODEJS_USAGE);
    return 2;
  }
  if (code === null) code = await readStdin();
  await ensureBrowser();
  await bridgeRequest('ping');
  const { runScript } = await import('../runtime/index.js');
  const { exitCode } = await runScript(code, { scriptName: 'stdin' });
  return exitCode;
}

function cmdSkill(args) {
  if (args.length > 0) {
    console.error('usage: wego-browser skill');
    return 2;
  }
  const skillPath = path.join(repoRoot, 'skill-body', 'SKILL.md');
  let body;
  try {
    body = fs.readFileSync(skillPath, 'utf8');
  } catch {
    console.error(`skill guide not found: ${skillPath}`);
    return 1;
  }
  process.stdout.write(body);
  return 0;
}

async function cmdLaunch() {
  await ensureBrowser();
  await bridgeRequest('ping');
  console.log('wego browser is running');
  return 0;
}

async function cmdProfiles(args) {
  const [sub, ...rest] = args;
  await ensureBrowser();
  if (sub === undefined || sub === 'list') {
    const { profiles } = await bridgeRequest('listProfiles');
    for (const p of profiles) {
      console.log(`${p.id}\t${p.name}${p.isDefault ? '\t(default)' : ''}`);
    }
    return 0;
  }
  if (sub === 'create') {
    const name = rest.join(' ').trim();
    if (!name) {
      console.error('usage: wego-browser profiles create <name>');
      return 2;
    }
    const profile = await bridgeRequest('createProfile', { name });
    console.log(`${profile.id}\t${profile.name}`);
    return 0;
  }
  if (sub === 'import-chrome') {
    const params = {};
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === '--profile' && rest[i + 1]) params.profileId = rest[++i];
      else if (rest[i] === '--chrome-dir' && rest[i + 1]) params.chromeDir = rest[++i];
      else {
        console.error('usage: wego-browser profiles import-chrome [--profile <id>] [--chrome-dir <path>]');
        return 2;
      }
    }
    const r = await bridgeRequest('importChromeCookies', params, 120_000);
    console.log(`imported ${r.imported}/${r.total} Chrome cookies into profile ${r.profileId}` +
      (r.expired ? ` (${r.expired} expired skipped)` : '') +
      (r.undecryptable ? ` (${r.undecryptable} undecryptable)` : '') +
      (r.failed ? ` (${r.failed} rejected)` : ''));
    return r.imported > 0 || r.total === 0 ? 0 : 1;
  }
  console.error('usage: wego-browser profiles [list] | profiles create <name> | profiles import-chrome [--profile <id>] [--chrome-dir <path>]');
  return 2;
}

async function cmdDoctor() {
  let failed = false;
  const report = (ok, label, detail = '') => {
    if (!ok) failed = true;
    console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  };

  const [major] = process.versions.node.split('.').map(Number);
  report(major >= 22, 'node >= 22', `node ${process.versions.node}`);

  const electron = resolveElectron();
  try {
    const { stdout } = await execFileP(electron, ['--version']);
    report(true, 'electron binary resolvable', stdout.trim());
  } catch {
    report(false, 'electron binary resolvable', `'${electron}' not found on PATH (set WEGO_ELECTRON)`);
  }

  const display = process.env.DISPLAY || process.env.WAYLAND_DISPLAY;
  report(Boolean(display), 'display available', display ? `DISPLAY=${process.env.DISPLAY ?? ''} WAYLAND_DISPLAY=${process.env.WAYLAND_DISPLAY ?? ''}` : 'neither DISPLAY nor WAYLAND_DISPLAY is set');

  const sockPath = socketPath();
  if (fs.existsSync(sockPath)) {
    report(await probeSocket(sockPath), 'bridge socket reachable', sockPath);
  } else {
    console.log(`SKIP bridge socket reachable — browser not running (no socket at ${sockPath})`);
  }

  return failed ? 1 : 0;
}

export async function run(argv) {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case 'nodejs':
      return cmdNodejs(rest);
    case 'skill':
      return cmdSkill(rest);
    case 'launch':
      return cmdLaunch();
    case 'profiles':
      return cmdProfiles(rest);
    case 'version':
      console.log(VERSION);
      return 0;
    case 'doctor':
      return cmdDoctor();
    case 'help':
    case '-h':
    case '--help':
    case undefined:
      process.stdout.write(USAGE);
      return 0;
    default:
      console.error(`unknown command: ${cmd}`);
      process.stderr.write(USAGE);
      return 2;
  }
}
