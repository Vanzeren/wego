// Validate all site learnings: manifest schema, referenced files exist,
// tools import cleanly. Mirrors upstream ego's validate:site-skills.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../skills/wego-browser/learnings');
let failed = 0;
const fail = (msg) => { failed++; console.error(`not ok - ${msg}`); };

const sites = fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()) : [];
if (!sites.length) fail('no learnings found');

for (const site of sites) {
  const root = path.join(dir, site.name);
  let m;
  try {
    m = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  } catch (e) {
    fail(`${site.name}: manifest.json unreadable: ${e.message}`);
    continue;
  }
  if (!Array.isArray(m.domains) || !m.domains.length) fail(`${site.name}: manifest needs non-empty domains[]`);
  for (const note of m.notes ?? []) {
    if (!fs.existsSync(path.join(root, note))) fail(`${site.name}: missing note ${note}`);
  }
  for (const tool of m.tools ?? []) {
    const f = path.join(root, 'tools', `${tool}.mjs`);
    if (!fs.existsSync(f)) { fail(`${site.name}: missing tool ${tool}.mjs`); continue; }
    try {
      const mod = await import(pathToFileURL(f).href);
      if (typeof mod.default !== 'function') fail(`${site.name}: tool ${tool} has no default function export`);
    } catch (e) {
      fail(`${site.name}: tool ${tool} fails to load: ${e.message}`);
    }
  }
  for (const bt of m.browserTools ?? []) {
    const f = path.join(root, 'browser-tools', `${bt}.js`);
    if (!fs.existsSync(f)) { fail(`${site.name}: missing browser-tool ${bt}.js`); continue; }
    try {
      const src = fs.readFileSync(f, 'utf8');
      new Function('module', 'exports', src.replace(/export\s+default/, 'module.exports ='));
    } catch (e) {
      fail(`${site.name}: browser-tool ${bt} has a syntax error: ${e.message}`);
    }
  }
  console.log(`ok - ${site.name} (${(m.notes ?? []).length} notes, ${(m.tools ?? []).length} tools, ${(m.browserTools ?? []).length} browser-tools)`);
}

if (failed) { console.error(`VALIDATE FAIL (${failed})`); process.exit(1); }
console.log('VALIDATE PASS');
