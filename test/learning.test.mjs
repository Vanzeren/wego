// Unit tests for the site-learnings loader.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { findLearning, readLearningNotes, hostOf, learningsDir } from '../src/runtime/learning.js';

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

test('real learnings dir contains mail.qq.com with notes', () => {
  delete process.env.WEGO_BROWSER_AGENT_WORKSPACE;
  const hit = findLearning('wx.mail.qq.com');
  assert.ok(hit);
  const notes = readLearningNotes('mail.qq.com');
  assert.match(notes, /cmp-account-input/);
});

test('hostOf parses urls; bare hosts return null (learnContext passes them through)', () => {
  assert.equal(hostOf('https://wx.mail.qq.com/home'), 'wx.mail.qq.com');
  assert.equal(hostOf('mail.qq.com'), null);
  assert.equal(hostOf('not a url'), null);
  assert.ok(learningsDir().endsWith('learnings'));
});
