// page.mouse / page.keyboard namespace factories. They only need the owning
// Page's session, popup watcher, receipt, and shared mouse position.
import { parseKeySpec, keyDown, keyUp, pressKey, typeText, mouseEvent, MOUSE_BUTTONS } from '../input.js';

export function buildMouse(page) {
  return {
    async click(x, y, { label } = {}) {
      void label;
      page._watchPopups();
      await page._dispatchClick({ x, y }, { clickCount: 1 });
      return page._receipt();
    },
    async move(x, y, { label } = {}) {
      void label;
      const session = await page._session();
      page._mousePos = { x, y };
      await mouseEvent(session, 'mouseMoved', x, y);
    },
    async down({ button = 'left' } = {}) {
      const session = await page._session();
      const { x, y } = page._mousePos;
      await mouseEvent(session, 'mousePressed', x, y, { button, buttons: MOUSE_BUTTONS[button] || 1, clickCount: 1 });
    },
    async up({ button = 'left' } = {}) {
      const session = await page._session();
      const { x, y } = page._mousePos;
      await mouseEvent(session, 'mouseReleased', x, y, { button, buttons: 0, clickCount: 1 });
    },
    async wheel(dx, dy, { label } = {}) {
      void label;
      const session = await page._session();
      const { x, y } = page._mousePos;
      await session.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: dx, deltaY: dy });
    },
  };
}

export function buildKeyboard(page) {
  return {
    async down(key) { await keyDown(await page._session(), parseKeySpec(key)); },
    async up(key) { await keyUp(await page._session(), parseKeySpec(key)); },
    async press(key) { await pressKey(await page._session(), key); },
    async type(text, { delay = 0 } = {}) { await typeText(await page._session(), String(text), { delay }); },
    async insertText(text) { await (await page._session()).send('Input.insertText', { text: String(text) }); },
    async paste({ text, html } = {}) {
      if (typeof text !== 'string' && typeof html !== 'string') {
        throw Object.assign(new TypeError('paste requires {text} and/or {html}'), { error_code: 'WEGO_INVALID_ARGUMENT' });
      }
      // Browser-side clipboard write + native paste + clipboard restore.
      await page._ctx().ego._call('paste', {
        id: page.spaceId,
        targetId: page.targetId,
        ...(text !== undefined ? { text } : {}),
        ...(html !== undefined ? { html } : {}),
      });
    },
  };
}
