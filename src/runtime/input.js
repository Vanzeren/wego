// Input dispatch helpers: key mapping for Input.dispatchKeyEvent and
// mouse event dispatch. Linux: 'ControlOrMeta' resolves to Control.

const NAMED_KEYS = {
  Enter: { key: 'Enter', code: 'Enter', vk: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', vk: 9, text: '\t' },
  Escape: { key: 'Escape', code: 'Escape', vk: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', vk: 8 },
  Delete: { key: 'Delete', code: 'Delete', vk: 46 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
  Home: { key: 'Home', code: 'Home', vk: 36 },
  End: { key: 'End', code: 'End', vk: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', vk: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', vk: 34 },
  Insert: { key: 'Insert', code: 'Insert', vk: 45 },
  Shift: { key: 'Shift', code: 'ShiftLeft', vk: 16 },
  Control: { key: 'Control', code: 'ControlLeft', vk: 17 },
  Alt: { key: 'Alt', code: 'AltLeft', vk: 18 },
  Meta: { key: 'Meta', code: 'MetaLeft', vk: 91 },
  ' ': { key: ' ', code: 'Space', vk: 32, text: ' ' },
};
for (let i = 1; i <= 12; i++) {
  NAMED_KEYS['F' + i] = { key: 'F' + i, code: 'F' + i, vk: 111 + i };
}

const MOD_BIT = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };

function describeSingleKey(key) {
  if (NAMED_KEYS[key]) return { ...NAMED_KEYS[key], modifier: MOD_BIT[key] ? key : null };
  if (key.length === 1) {
    const ch = key;
    const upper = ch.toUpperCase();
    // crude but sufficient code/vk mapping for printable ASCII
    let code;
    if (/[a-zA-Z]/.test(ch)) code = 'Key' + upper;
    else if (/[0-9]/.test(ch)) code = 'Digit' + ch;
    else code = null;
    return { key: ch, code, vk: upper.charCodeAt(0), text: ch, modifier: null };
  }
  throw Object.assign(new Error(`Unknown key: ${key}`), { error_code: 'EGO_INVALID_ARGUMENT' });
}

// 'ControlOrMeta+Shift+A' → { parts: [...], modifiers: bitmask }
export function parseKeySpec(spec) {
  if (typeof spec !== 'string' || spec === '') {
    throw Object.assign(new TypeError('key must be a non-empty string'), { error_code: 'EGO_INVALID_ARGUMENT' });
  }
  const parts = spec.split('+').map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) throw Object.assign(new Error(`Unknown key: ${spec}`), { error_code: 'EGO_INVALID_ARGUMENT' });
  let modifiers = 0;
  const keys = parts.map((p) => (p === 'ControlOrMeta' ? 'Control' : p));
  for (const k of keys.slice(0, -1)) {
    const d = describeSingleKey(k);
    if (!d.modifier) throw Object.assign(new Error(`Non-modifier key in chord position: ${k}`), { error_code: 'EGO_INVALID_ARGUMENT' });
    modifiers |= MOD_BIT[d.modifier];
  }
  const main = describeSingleKey(keys[keys.length - 1]);
  if (main.modifier) modifiers |= MOD_BIT[main.modifier];
  // shift-modified printable: adjust text (e.g. Shift+a → 'A')
  let text = main.text;
  if (text && (modifiers & MOD_BIT.Shift) && /^[a-z]$/.test(text)) text = text.toUpperCase();
  // chords with non-Shift modifiers don't insert text (Shift+a → 'A' does)
  if ((modifiers & ~MOD_BIT.Shift) && text && text.length === 1 && text !== '\r' && text !== '\t') text = undefined;
  return { main: { ...main, text }, modifiers, keys };
}

export async function keyDown(session, desc) {
  const { main, modifiers } = desc;
  await session.send('Input.dispatchKeyEvent', {
    type: main.text ? 'keyDown' : 'rawKeyDown',
    key: main.key,
    code: main.code,
    windowsVirtualKeyCode: main.vk,
    nativeVirtualKeyCode: main.vk,
    modifiers,
    ...(main.text ? { text: main.text } : {}),
  });
}

export async function keyUp(session, desc) {
  const { main, modifiers } = desc;
  await session.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: main.key,
    code: main.code,
    windowsVirtualKeyCode: main.vk,
    nativeVirtualKeyCode: main.vk,
    modifiers,
  });
}

export async function pressKey(session, spec) {
  const desc = parseKeySpec(spec);
  await keyDown(session, desc);
  await keyUp(session, desc);
}

export async function typeText(session, text, { delay = 0 } = {}) {
  for (const ch of text) {
    await pressKey(session, ch);
    if (delay) await new Promise((r) => setTimeout(r, delay));
  }
}

const MOUSE_BUTTONS = { left: 1, right: 2, middle: 4 };

export async function mouseEvent(session, type, x, y, opts = {}) {
  await session.send('Input.dispatchMouseEvent', {
    type,
    x,
    y,
    button: opts.button || 'none',
    buttons: opts.buttons ?? 0,
    clickCount: opts.clickCount || 0,
    ...(opts.deltaX !== undefined ? { deltaX: opts.deltaX, deltaY: opts.deltaY } : {}),
  });
}

export { MOUSE_BUTTONS };
