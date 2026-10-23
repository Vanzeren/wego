// Site learnings: reusable per-site automation experience.
// Layout: <learningsDir>/<site>/manifest.json { domains: [...], notes: [...] }
// + notes/*.md. Pure fs; no electron.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../skills/wego-browser/learnings',
);

export function learningsDir() {
  return process.env.WEGO_BROWSER_AGENT_WORKSPACE
    ? path.join(process.env.WEGO_BROWSER_AGENT_WORKSPACE, 'learnings')
    : DEFAULT_DIR;
}

// domain match: exact host or subdomain of a manifest domain
function hostMatches(host, domain) {
  return host === domain || host.endsWith('.' + domain);
}

export function findLearning(host) {
  const dir = learningsDir();
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    let manifest;
    try { manifest = JSON.parse(fs.readFileSync(path.join(dir, e.name, 'manifest.json'), 'utf8')); }
    catch { continue; }
    const domains = Array.isArray(manifest.domains) ? manifest.domains : [];
    if (domains.some((d) => hostMatches(host, d))) return { site: e.name, manifest, dir: path.join(dir, e.name) };
  }
  return null;
}

export function readLearningNotes(host) {
  const hit = findLearning(host);
  if (!hit) return null;
  const parts = [];
  for (const note of hit.manifest.notes ?? []) {
    try { parts.push(fs.readFileSync(path.join(hit.dir, note), 'utf8')); } catch { /* skip */ }
  }
  return parts.length ? parts.join('\n\n---\n\n') : null;
}

export function hostOf(url) {
  try { return new URL(url).hostname; } catch { return null; }
}
