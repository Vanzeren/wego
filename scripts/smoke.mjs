// End-to-end smoke: static fixture server + ego-browser nodejs round.
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixturesDir = path.join(repoRoot, 'fixtures');
const OVERALL_TIMEOUT_MS = 60_000;

const MIME = { '.html': 'text/html; charset=utf-8', '.png': 'image/png', '.js': 'text/javascript' };

const checks = [];
const check = (ok, label) => {
  checks.push({ ok, label });
  console.log(`${ok ? 'ok' : 'not ok'} - ${label}`);
};

const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '') || 'page.html';
  const file = path.join(fixturesDir, rel);
  if (!file.startsWith(fixturesDir) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404).end('not found');
    return;
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;

fs.writeFileSync('/tmp/ego-smoke-upload.txt', `smoke-upload ${Date.now()}\n`);

const script = `
const assert = (cond, label) => {
  if (!cond) { console.error('SMOKE ASSERT FAIL: ' + label); process.exit(1); }
  console.log('smoke assert ok: ' + label);
};
const task = await taskSpace('ego-smoke');
const page = task.page('p1');
await page.goto(${JSON.stringify(baseUrl + '/page.html')});
await page.waitForLoadState();

const snap = await page.snapshot();
assert(snap.includes('Sign in'), 'snapshot contains "Sign in"');
assert(snap.includes('Frame button'), 'snapshot contains "Frame button"');

const emailLine = snap.split('\\n').find((l) => l.includes('Email') && /\\[ref=\\d+\\]/.test(l));
assert(emailLine, 'snapshot has a ref for the Email textbox: ' + (emailLine ?? 'none'));
const ref = '@' + emailLine.match(/\\[ref=(\\d+)\\]/)[1];
await page.fill(ref, 'smoke@example.com');
await page.click('text="Sign in"');
await page.waitForFunction(
  () => document.getElementById('headline').textContent.startsWith('Welcome'),
  undefined,
  { timeout: 5000 },
);
const headline = await page.evaluate(() => document.getElementById('headline').textContent);
assert(headline === 'Welcome smoke@example.com', 'headline is "Welcome smoke@example.com", got: ' + headline);

const shot = await page.screenshot({ path: '/tmp/ego-smoke.png' });
assert(typeof shot === 'string' && shot.length > 0, 'screenshot saved: ' + shot);

// file chooser: arm before the click, then resolve with a real file
const chooserPromise = page.waitForFileChooser({ timeout: 8000 });
await page.click('text="Upload"');
const chooser = await chooserPromise;
await chooser.setFiles('/tmp/ego-smoke-upload.txt');
await page.waitForFunction(
  () => document.getElementById('log').textContent.includes('file=ego-smoke-upload.txt:'),
  undefined,
  { timeout: 5000 },
);
console.log('smoke assert ok: file chooser upload reflected in page log');

await task.finish({ keep: [] });
console.log('SMOKE SCRIPT DONE');
`;

let child;
let failed = false;
try {
  const result = await new Promise((resolve) => {
    child = spawn('node', [path.join(repoRoot, 'bin', 'ego-browser'), 'nodejs'], {
      cwd: repoRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; process.stdout.write(d); });
    child.stderr.on('data', (d) => { out += d; process.stderr.write(d); });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ code: null, out, timedOut: true });
    }, OVERALL_TIMEOUT_MS);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out, timedOut: false });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: null, out: out + String(err), timedOut: false });
    });
    child.stdin.end(script);
  });

  check(!result.timedOut, `completed within ${OVERALL_TIMEOUT_MS / 1000}s`);
  check(result.code === 0, `ego-browser nodejs exited 0 (got ${result.code})`);
  check(result.out.includes('SMOKE SCRIPT DONE'), 'script reached completion marker');
  check(result.out.includes('smoke assert ok: snapshot contains "Sign in"'), 'assert: snapshot has Sign in');
  check(result.out.includes('smoke assert ok: snapshot contains "Frame button"'), 'assert: snapshot has Frame button');
  check(result.out.includes('Welcome smoke@example.com'), 'assert: headline updated after Sign in');
  check(result.out.includes('file chooser upload reflected'), 'assert: file chooser upload');
  check(fs.existsSync('/tmp/ego-smoke.png') && fs.statSync('/tmp/ego-smoke.png').size > 0, 'screenshot exists at /tmp/ego-smoke.png');
  failed = checks.some((c) => !c.ok);
} finally {
  server.close();
  if (child && !child.killed) child.kill('SIGKILL');
}

console.log(failed ? 'SMOKE FAIL' : 'SMOKE PASS');
process.exit(failed ? 1 : 0);
