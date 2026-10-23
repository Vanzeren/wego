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

// Executable experience: per-site tools.
//   tools/<name>.mjs          — node-side; export default async (args) => …
//                               args carries whatever the caller passes (a
//                               Page under args.page unlocks real input).
//   browser-tools/<name>.js   — in-page; export default async (arg) => …
//                               (self-contained; serialized into the page)
export function listSiteTools(host) {
  const hit = findLearning(host);
  if (!hit) return null;
  return {
    site: hit.site,
    tools: hit.manifest.tools ?? [],
    browserTools: hit.manifest.browserTools ?? [],
    intents: hit.manifest.intents ?? [],
  };
}

export async function runSiteTool(host, name, args = {}) {
  const hit = findLearning(host);
  if (!hit) throw new Error(`no learning for ${host}`);
  if (!(hit.manifest.tools ?? []).includes(name)) {
    throw new Error(`no tool ${JSON.stringify(name)} in ${hit.site} (have: ${(hit.manifest.tools ?? []).join(', ') || 'none'})`);
  }
  const mod = await import(path.join(hit.dir, 'tools', `${name}.mjs`));
  if (typeof mod.default !== 'function') throw new Error(`tool ${name} has no default export`);
  return mod.default(args);
}

export async function runSiteBrowserTool(page, host, name, arg) {
  const hit = findLearning(host);
  if (!hit) throw new Error(`no learning for ${host}`);
  if (!(hit.manifest.browserTools ?? []).includes(name)) {
    throw new Error(`no browser-tool ${JSON.stringify(name)} in ${hit.site} (have: ${(hit.manifest.browserTools ?? []).join(', ') || 'none'})`);
  }
  const mod = await import(path.join(hit.dir, 'browser-tools', `${name}.js`));
  if (typeof mod.default !== 'function') throw new Error(`browser-tool ${name} has no default export`);
  return page.evaluate(mod.default, arg);
}

