// Unit tests for the site-learnings loader.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { findLearning, readLearningNotes, hostOf, learningsDir, listSiteTools, runSiteTool, runSiteBrowserTool } from '../src/runtime/learning.js';

function withLearningDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wego-learn-'));
  process.env.WEGO_BROWSER_AGENT_WORKSPACE = dir;
  fs.mkdirSync(path.join(dir, 'learnings', 'example.com', 'notes'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'learnings', 'example.com', 'manifest.json'),
    JSON.stringify({ site: 'example.com', domains: ['example.com'], notes: ['notes/a.md'] }));
  fs.writeFileSync(path.join(dir, 'learnings', 'example.com', 'notes', 'a.md'), '# example notes\n');
  t.after(() => { delete process.env.WEGO_BROWSER_AGENT_WORKSPACE; fs.rmSync(dir, { recursive: true, force: true }); });
  return dir;
}

test('findLearning matches host and subdomains; misses others', (t) => {
  withLearningDir(t);
  assert.equal(findLearning('example.com')?.site, 'example.com');
  assert.equal(findLearning('www.example.com')?.site, 'example.com');
  assert.equal(findLearning('notexample.com'), null);
  assert.equal(findLearning('example.com.evil.io'), null); // suffix trap must not match
});

test('readLearningNotes returns note content; unknown host returns null', (t) => {
  withLearningDir(t);
  assert.match(readLearningNotes('example.com'), /example notes/);
  assert.equal(readLearningNotes('nope.io'), null);
});

test('user learnings dir (~/.wego) contains mail.qq.com with notes', () => {
  delete process.env.WEGO_BROWSER_AGENT_WORKSPACE;
  const hit = findLearning('wx.mail.qq.com');
  assert.ok(hit);
  const notes = readLearningNotes('mail.qq.com');
  assert.match(notes, /cmp-account-input/);
});

test('bundled example (publishable) exposes readPageInfo browser-tool', async () => {
  delete process.env.WEGO_BROWSER_AGENT_WORKSPACE;
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

test('hostOf parses urls; bare hosts return null (learnContext passes them through)', () => {
  assert.equal(hostOf('https://wx.mail.qq.com/home'), 'wx.mail.qq.com');
  assert.equal(hostOf('mail.qq.com'), null);
  assert.equal(hostOf('not a url'), null);
  assert.ok(learningsDir().endsWith('learnings'));
});

test('listSiteTools exposes tools/browserTools/intents for mail.qq.com', () => {
  delete process.env.WEGO_BROWSER_AGENT_WORKSPACE;
  const tools = listSiteTools('wx.mail.qq.com');
  assert.ok(tools.tools.includes('compose'));
  assert.ok(tools.browserTools.includes('readCompose'));
  assert.ok(tools.intents.length > 0);
  assert.equal(listSiteTools('unknown.io'), null);
});

test('runSiteTool rejects unknown sites and undeclared tools', async () => {
  delete process.env.WEGO_BROWSER_AGENT_WORKSPACE;
  await assert.rejects(() => runSiteTool('unknown.io', 'x'), /no learning/);
  await assert.rejects(() => runSiteTool('mail.qq.com', 'nope'), /no tool "nope"/);
});

test('runSiteBrowserTool rejects undeclared browser-tools', async () => {
  delete process.env.WEGO_BROWSER_AGENT_WORKSPACE;
  await assert.rejects(() => runSiteBrowserTool({}, 'mail.qq.com', 'nope'), /no browser-tool "nope"/);
});

// The real compose browser-tool: in-page DOM read of a fake compose form.
test('readCompose browser-tool reads recipients/subject/body', async () => {
  delete process.env.WEGO_BROWSER_AGENT_WORKSPACE;
  const mod = await import(process.env.HOME + '/.wego/learnings/mail.qq.com/browser-tools/readCompose.js');
  const fn = mod.default;
  const fakeDoc = {
    querySelector(sel) {
      if (sel === '.receiver-editor-wrap') return { textContent: '收件人 campus@dewu.com 抄送' };
      if (sel === 'div[contenteditable="true"]') return { textContent: '正文内容' };
      return null;
    },
    querySelectorAll() { return [{ value: '' }, { value: '主题X' }]; },
  };
  const page = { evaluate: (f, arg) => { globalThis.document = fakeDoc; try { return f(arg); } finally { delete globalThis.document; } } };
  globalThis.location = { href: 'https://wx.mail.qq.com/#/compose' };
  const out = await runSiteBrowserTool(page, 'mail.qq.com', 'readCompose');
  delete globalThis.location;
  assert.equal(out.subject, '主题X');
  assert.equal(out.body, '正文内容');
  assert.match(out.recipients, /campus@dewu\.com/);
});
