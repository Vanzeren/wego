// Behavioral tests for Page events and form actions with scripted CDP responses.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

import { Page } from '../src/runtime/page.js';
import { populate } from '../src/runtime/refs.js';

function actionPage(element) {
  const page = Object.create(Page.prototype);
  page._popups = [];
  page._dialog = null;
  page._receipt = async () => ({ ok: true });
  const events = [];
  element.dispatchEvent = (event) => events.push(event.type);
  const session = {
    async send(method, params) {
      if (method === 'Runtime.evaluate') return { result: { objectId: 'element-1' } };
      if (method !== 'Runtime.callFunctionOn') throw new Error(`unexpected CDP method ${method}`);
      try {
        const fn = vm.runInNewContext(`(${params.functionDeclaration})`, {
          Event: class { constructor(type) { this.type = type; } },
        });
        const args = (params.arguments ?? []).map((arg) => arg.value);
        return { result: { value: fn.apply(element, args) } };
      } catch (error) {
        return { result: {}, exceptionDetails: { exception: { description: error.message } } };
      }
    },
  };
  page._session = async () => session;
  populate(page, [{ refId: 1, role: 'combobox', name: 'Plan' }]);
  return { page, events };
}

test('selectOption selects a string value and emits input/change', async () => {
  const selected = [true, false];
  const element = {
    options: ['free', 'pro'].map((value, index) => ({
      value,
      label: value === 'free' ? 'Free' : 'Pro',
      index,
      get selected() { return selected[index]; },
      set selected(value) {
        if (value) {
          for (let i = 0; i < selected.length; i++) selected[i] = i === index;
        } else {
          selected[index] = false;
        }
      },
    })),
  };
  const { page, events } = actionPage(element);
  await page.selectOption('@1', 'pro');
  assert.equal(element.options[0].selected, false);
  assert.equal(element.options[1].selected, true);
  assert.deepEqual(events, ['input', 'change']);
});

test('selectOption surfaces in-page exceptions instead of returning success', async () => {
  const { page } = actionPage({});
  await assert.rejects(
    page.selectOption('@1', 'pro'),
    (error) => error.error_code === 'WEGO_OPERATION_FAILED' && /selectOption/.test(error.message),
  );
});

test("waitForEvent('popup') resolves with the adopted Page", async () => {
  const page = Object.create(Page.prototype);
  page._popups = [];
  page._popupWaiters = [];
  const adopted = { label: 'p2', async waitForLoadState() {} };
  page.space = {
    _ownsTarget: (targetId) => targetId === 'T2',
    _labelForTarget: () => 'p2',
    page: (label) => label === 'p2' ? adopted : null,
  };
  let targetCreated;
  page._ctx = () => ({ cdp: { browser: { on: (method, listener) => {
    assert.equal(method, 'Target.targetCreated');
    targetCreated = listener;
    return () => {};
  } } } });
  const waiting = page.waitForEvent('popup', { timeout: 1000 });
  targetCreated({ targetInfo: { type: 'page', targetId: 'T2' } });
  const popup = await waiting;
  assert.equal(popup, adopted);
  await popup.waitForLoadState();
});
