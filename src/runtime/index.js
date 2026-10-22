// Runtime entry: runScript(source, { scriptName }) executes an wego-browser
// script body with the helper surface injected as async-function parameters.

import { connectWego } from '../client/wego.js';
import { CDPManager, CDPError } from './cdp.js';
import { TaskSpace } from './task-space.js';

const HELP = {
  'taskSpace': 'taskSpace(nameOrId) → TaskSpace — name: create-or-resume; numeric id: select existing agent-owned space',
  'listTaskSpaces': 'listTaskSpaces() → { taskSpaces: [...] }',
  'claimTaskSpace': 'claimTaskSpace(id, name?) → TaskSpace',
  'takeOverTaskSpace': 'takeOverTaskSpace(id) → TaskSpace',
  'help': 'help(name?) — list helpers, or one entry e.g. help("page.click")',
  'cliLog': 'cliLog(...args) — JSON-safe line output',
  'space.page': 'space.page(label="p1") → Page (sync); space.newPage(url?) → Page; space.pages(); space.tabs()',
  'space.adopt': 'space.adopt(tabOrPage, {as?}) → Page; space.release(label); space.userPage() → Page|null',
  'space.handOff': 'space.handOff(); space.finish({keep=[]}); space.waitForControl({timeout}); space.cdp(method,params)',
  'page.goto': 'page.goto(url, {timeout, waitUntil:"load"|"domcontentloaded"|"networkidle"})',
  'page.wait': 'page.waitForURL(s|re|fn,{timeout}); waitForLoadState(state,{timeout}); waitForSelector(target,{state,timeout}); waitForFunction(fn,arg,{timeout}); waitForTimeout(ms); waitForEvent("popup"|"download",{timeout})',
  'page.snapshot': 'page.snapshot(options?) → content string; page.snapshot.raw(options?) → {content, refs}; refs as "@N" targets',
  'page.actions': 'page.click/dblclick/hover(target,{label?}); dragAndDrop(src,dst); fill(target,text); selectOption(target, values|{label}|{index}|null); focus(target); press(target,key); setInputFiles(target,absPaths)',
  'page.dialogs': 'page.acceptDialog(promptText?); page.dismissDialog(); page.info() → {url,title,dialog?}',
  'page.mouse': 'page.mouse.click(x,y); move(x,y); down({button}); up({button}); wheel(dx,dy)',
  'page.keyboard': 'page.keyboard.down/up/press(key); type(text,{delay}); insertText(text); paste({text}) — chords "ControlOrMeta+A" (Control on Linux)',
  'page.evaluate': 'page.evaluate(fnOrString, arg); page.fetch(url, options?) → {ok,status,statusText,url,headers,body}; page.cdp(method,params); page.screenshot({path?}) → path; page.close()',
  'selectors': '"@N" | "ref=N" | "text=..." | text="exact" | "loc=css:..." | "loc=role:button[name=X]" (+[name*=X]) | "loc=href:..." | "xpath=..." | "css=..." | raw CSS; terminal ">> nth=N"',
};

function cliLog(...args) {
  const line = args.map((a) => {
    if (typeof a === 'string') return a;
    try { return JSON.stringify(a); } catch { return String(a); }
  }).join(' ');
  process.stdout.write(line + '\n');
}

function help(name) {
  if (name) {
    const entry = HELP[name];
    cliLog(entry ? `${name}: ${entry}` : `no help for ${JSON.stringify(name)}`);
    return;
  }
  for (const [k, v] of Object.entries(HELP)) cliLog(`${k}: ${v}`);
}

export async function runScript(source, { scriptName = 'script' } = {}) {
  const ego = await connectWego();
  const cdp = new CDPManager(ego);
  const ctx = { ego, cdp };

  async function materialize(descriptor) {
    const space = new TaskSpace(ctx, descriptor);
    // map existing tabs: first tab → p1, then p2…
    const { tabs } = await ego._call('listTabs', { id: descriptor.id }).catch(() => ({ tabs: [] }));
    for (const t of tabs) space._adoptTarget(t.targetId, 'agent');
    return space;
  }

  async function taskSpace(nameOrId, options) {
    if (options !== undefined && (typeof options !== 'object' || options === null || Array.isArray(options))) {
      throw Object.assign(new TypeError('taskSpace(name, options) options must be an object'), { error_code: 'WEGO_INVALID_ARGUMENT' });
    }
    if (typeof nameOrId === 'number') {
      const { taskSpaces } = await ego.listTaskSpaces();
      const found = taskSpaces.find((s) => s.id === nameOrId);
      if (!found) throw new CDPError(`Task space not found: ${nameOrId}`, 'WEGO_TASK_SPACE_NOT_FOUND');
      if (found.ownership !== 'agent') {
        throw new CDPError(`Task space ${nameOrId} is not agent-owned (use takeOverTaskSpace)`, 'WEGO_OPERATION_FAILED');
      }
      const descriptor = await ego.claimTaskSpace(nameOrId);
      return materialize({ ...found, ...descriptor });
    }
    if (typeof nameOrId === 'string' && nameOrId) {
      // create-or-resume: bridge resumes on agent-owned name collision.
      // { profile } applies only at creation, matching ego semantics.
      const descriptor = await ego.createTaskSpace(nameOrId, options?.profile);
      return materialize(descriptor);
    }
    throw Object.assign(new TypeError('taskSpace(nameOrId) expects a name string or numeric id'), { error_code: 'WEGO_INVALID_ARGUMENT' });
  }

  async function claimTaskSpace(id, name) {
    const descriptor = await ego.claimTaskSpace(id, name);
    const { taskSpaces } = await ego.listTaskSpaces();
    const found = taskSpaces.find((s) => s.id === descriptor.id) || {};
    return materialize({ ...found, ...descriptor });
  }

  async function takeOverTaskSpace(id) {
    ego.useTaskSpace(id);
    await ego.takeOverTaskSpace();
    const { taskSpaces } = await ego.listTaskSpaces();
    const found = taskSpaces.find((s) => s.id === id);
    if (!found) throw new CDPError(`Task space not found: ${id}`, 'WEGO_TASK_SPACE_NOT_FOUND');
    const descriptor = await ego.claimTaskSpace(id);
    return materialize({ ...found, ...descriptor });
  }

  async function listTaskSpaces() {
    return ego.listTaskSpaces();
  }

  const helpers = { taskSpace, listTaskSpaces, claimTaskSpace, takeOverTaskSpace, help, cliLog };
  const names = Object.keys(helpers);

  let exitCode = 0;
  try {
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    const fn = new AsyncFunction(...names, `'use strict';\n${source}`);
    await fn(...names.map((n) => helpers[n]));
  } catch (err) {
    exitCode = 1;
    const code = err && err.error_code ? ` [${err.error_code}]` : '';
    process.stderr.write(`${scriptName}: ${err && err.stack ? err.stack : err}${code}\n`);
  } finally {
    await cdp.detachAll().catch(() => {});
    ego.close();
  }
  return { exitCode };
}
