// Zoom ladder for page and UI scaling. Pure logic; window.js wires it to
// before-input-event handlers and settings persistence.

export const ZOOM_MIN = 0.5;
export const ZOOM_MAX = 2.0;
const STEP = 1.1;

// dir: +1 in, -1 out, 0 reset. Result rounded to 2 decimals, clamped.
export function nextZoom(current, dir) {
  if (dir === 0) return 1;
  const next = dir > 0 ? current * STEP : current / STEP;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(next * 100) / 100));
}

export const LEVEL_MIN = -3;
export const LEVEL_MAX = 5;
const LEVEL_STEP = 0.5;

// Chromium zoom-level ladder for setZoomLevel (0 = 100%; factor ≈ 1.2^level).
export function nextZoomLevel(current, dir) {
  if (dir === 0) return 0;
  return Math.min(LEVEL_MAX, Math.max(LEVEL_MIN, current + dir * LEVEL_STEP));
}

export function zoomFromKey(input) {
  // Returns { scope: 'page'|'ui', dir } or null. Plain Ctrl → page,
  // Ctrl+Shift → whole-app UI. Mirrors Chrome's zoom shortcuts.
  if (!input || input.type !== 'keyDown' || !input.control || input.alt || input.meta) return null;
  const scope = input.shift ? 'ui' : 'page';
  if (input.key === '+' || input.key === '=') return { scope, dir: 1 };
  if (input.key === '-' || input.key === '_') return { scope, dir: -1 };
  if (input.key === '0') return { scope, dir: 0 };
  return null;
}
