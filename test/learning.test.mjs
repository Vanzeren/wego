// Unit tests for the site-learnings loader.
// Hermetic: every test runs against a fixture learnings tree in a tmp dir
// (impersonal host example.test). No dependence on ~/.wego or real sites.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { findLearning, readLearningNotes, hostOf, learningsDir, listSiteTools, runSiteTool, runSiteBrowserTool } from '../src/runtime/learning.js';

// Fixture browser-tool source: same DOM-reading shape as a real compose
// reader, but against generic selectors with no personal data.
const READ_COMPOSE_SRC = `// Read the current compose form state (runs IN PAGE via page.evaluate).
export default function readCompose() {
  const ed = document.querySelector('div[contenteditable="true"]');
  return {
    recipients: document.querySelector('.receiver-editor-wrap')?.textContent.replace(/\\s+/g, ' ').trim() ?? null,
    subject: [...document.querySelectorAll('input')].map((i) => i.value).find((v) => v) ?? '',
    body: ed ? ed.textContent : null,
    url: location.href,
  };
}
`;

// Build a full learnings fixture (manifest + notes + tools + browser-tools)
// for host example.test in a fresh tmp workspace.
function withLearningDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wego-learn-'));
  process.env.WEGO_BROWSER_AGENT_WORKSPACE = dir;
  const site = path.join(dir, 'learnings', 'example.test');
  fs.mkdirSync(path.join(site, 'notes'), { recursive: true });
  fs.mkdirSync(path.join(site, 'tools'), { recursive: true });
  fs.mkdirSync(path.join(site, 'browser-tools'), { recursive: true });
  fs.writeFileSync(path.join(site, 'manifest.json'), JSON.stringify({
    site: 'example.test',
    domains: ['example.test', 'wx.example.test'],
    intents: ['compose email', 'read page'],
    notes: ['notes/a.md'],
    tools: ['compose'],
    browserTools: ['readCompose'],
  }));
  fs.writeFileSync(path.join(site, 'notes', 'a.md'), '# example notes\ncompose: fill .receiver-editor-wrap\n');
  fs.writeFileSync(path.join(site, 'tools', 'compose.mjs'),
    'export default async (args) => ({ composed: true, to: args.to ?? null });\n');
  fs.writeFileSync(path.join(site, 'browser-tools', 'readCompose.js'), READ_COMPOSE_SRC);
  t.after(() => { delete process.env.WEGO_BROWSER_AGENT_WORKSPACE; fs.rmSync(dir, { recursive: true, force: true }); });
  return dir;
}

test('findLearning matches host and subdomains; misses others', (t) => {
  withLearningDir(t);
  assert.equal(findLearning('example.test')?.site, 'example.test');
  assert.equal(findLearning('wx.example.test')?.site, 'example.test');
  assert.equal(findLearning('notexample.test'), null);
  assert.equal(findLearning('example.test.evil.io'), null); // suffix trap must not match
});

test('readLearningNotes returns note content; unknown host returns null', (t) => {
  withLearningDir(t);
  assert.match(readLearningNotes('example.test'), /example notes/);
  assert.match(readLearningNotes('wx.example.test'), /receiver-editor-wrap/);
  assert.equal(readLearningNotes('nope.io'), null);
});

test('fixture learnings dir contains example.test with notes', (t) => {
  withLearningDir(t);
  const hit = findLearning('wx.example.test');
  assert.ok(hit);
  const notes = readLearningNotes('example.test');
  assert.match(notes, /compose/);
});

test('bundled example (publishable) exposes readPageInfo browser-tool', async (t) => {
  withLearningDir(t); // keep hermetic even though this imports from the repo
  const mod = await import('../skills/wego-browser/learnings-example/example.com/browser-tools/readPageInfo.js');
  const fakeDoc = {
    title: 'Example Domain',
    querySelector(sel) {
      if (sel === 'h1') return { textContent: 'Example Domain' };
      if (sel === 'a') return { href: 'https://example.com/more' };
      return null;
    },
  };
  globalThis.document = fakeDoc;
  try {
    assert.deepEqual(mod.default(), { title: 'Example Domain', heading: 'Example Domain', firstLink: 'https://example.com/more' });
  } finally {
    delete globalThis.document;
  }
});

test('hostOf parses urls; bare hosts return null (learnContext passes them through)', (t) => {
  withLearningDir(t);
  assert.equal(hostOf('https://wx.example.test/home'), 'wx.example.test');
  assert.equal(hostOf('example.test'), null);
  assert.equal(hostOf('not a url'), null);
  assert.ok(learningsDir().endsWith('learnings'));
});

test('listSiteTools exposes tools/browserTools/intents for example.test', (t) => {
  withLearningDir(t);
  const tools = listSiteTools('wx.example.test');
  assert.ok(tools.tools.includes('compose'));
  assert.ok(tools.browserTools.includes('readCompose'));
  assert.ok(tools.intents.length > 0);
  assert.equal(listSiteTools('unknown.io'), null);
});

test('runSiteTool rejects unknown sites and undeclared tools; runs declared tool', async (t) => {
  withLearningDir(t);
  await assert.rejects(() => runSiteTool('unknown.io', 'x'), /no learning/);
  await assert.rejects(() => runSiteTool('example.test', 'nope'), /no tool "nope"/);
  assert.deepEqual(await runSiteTool('example.test', 'compose', { to: 'user@example.test' }),
    { composed: true, to: 'user@example.test' });
});

test('runSiteBrowserTool rejects undeclared browser-tools', async (t) => {
  withLearningDir(t);
  await assert.rejects(() => runSiteBrowserTool({}, 'example.test', 'nope'), /no browser-tool "nope"/);
});

// The compose browser-tool: in-page DOM read of a fake compose form.
test('readCompose browser-tool reads recipients/subject/body', async (t) => {
  withLearningDir(t);
  const fakeDoc = {
    querySelector(sel) {
      if (sel === '.receiver-editor-wrap') return { textContent: 'To user@example.test Cc' };
      if (sel === 'div[contenteditable="true"]') return { textContent: 'Body text' };
      return null;
    },
    querySelectorAll() { return [{ value: '' }, { value: 'Subject X' }]; },
  };
  const page = { evaluate: (f, arg) => { globalThis.document = fakeDoc; try { return f(arg); } finally { delete globalThis.document; } } };
  globalThis.location = { href: 'https://example.test/compose' };
  const out = await runSiteBrowserTool(page, 'example.test', 'readCompose');
  delete globalThis.location;
  assert.equal(out.subject, 'Subject X');
  assert.equal(out.body, 'Body text');
  assert.match(out.recipients, /user@example\.test/);
  assert.equal(out.url, 'https://example.test/compose');
});
