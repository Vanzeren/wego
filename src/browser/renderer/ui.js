// Browser chrome UI. Keep layout constants in sync with window.js.
const CHROME_HEIGHT = 84;
const SIDEBAR_WIDTH = 200;

let state = { activeSpaceId: null, spaces: [] };
let dragging = null; // active tab drag session; render() is frozen meanwhile
let suppressNextClick = false; // swallow the click that follows a real drag
const knownTabs = new Set(); // animate only genuinely new tabs/spaces
const knownSpaces = new Set();
let bannerShown = false;

const $ = (sel) => document.querySelector(sel);

function activeSpace() {
  return state.spaces.find((s) => s.id === state.activeSpaceId) ?? null;
}

// ---- tab drag to reorder ------------------------------------------------

function startTabDrag(e, tabEl, targetId) {
  const strip = $('#tabstrip');
  const startX = e.clientX;
  let active = false;
  let ghost = null;
  let indicator = null;
  let toIndex = -1;

  const begin = () => {
    active = true;
    dragging = {};
    const rect = tabEl.getBoundingClientRect();
    ghost = tabEl.cloneNode(true);
    Object.assign(ghost.style, {
      position: 'fixed', left: `${rect.left}px`, top: `${rect.top}px`,
      width: `${rect.width}px`, zIndex: 1000, pointerEvents: 'none',
      opacity: 0.92, boxShadow: '0 6px 18px rgba(0,0,0,.45)',
    });
    document.body.appendChild(ghost);
    tabEl.style.opacity = '0.35';
    indicator = document.createElement('div');
    indicator.id = 'drop-indicator';
    strip.appendChild(indicator);
    document.body.style.cursor = 'grabbing';
  };

  const computeIndex = (x) => {
    const tabs = [...strip.querySelectorAll('.tab')].filter((t) => t !== tabEl);
    for (let i = 0; i < tabs.length; i++) {
      const r = tabs[i].getBoundingClientRect();
      if (x < r.left + r.width / 2) return i;
    }
    return tabs.length;
  };

  const placeIndicator = () => {
    const tabs = [...strip.querySelectorAll('.tab')].filter((t) => t !== tabEl);
    const anchor = tabs[toIndex] ?? null;
    const stripRect = strip.getBoundingClientRect();
    const x = anchor ? anchor.getBoundingClientRect().left - 1
      : (tabs.length ? tabs[tabs.length - 1].getBoundingClientRect().right + 1 : stripRect.left + 4);
    Object.assign(indicator.style, { left: `${x - stripRect.left + strip.scrollLeft}px` });
  };

  const onMove = (ev) => {
    if (!active && Math.abs(ev.clientX - startX) > 5) begin();
    if (!active) return;
    ev.preventDefault();
    ghost.style.left = `${ev.clientX - 12}px`;
    toIndex = computeIndex(ev.clientX);
    placeIndicator();
  };

  const onUp = (ev) => {
    window.removeEventListener('pointermove', onMove, true);
    window.removeEventListener('pointerup', onUp, true);
    document.body.style.cursor = '';
    const wasActive = active;
    const drop = toIndex;
    ghost?.remove();
    indicator?.remove();
    tabEl.style.opacity = '';
    dragging = null;
    if (wasActive) {
      ev.stopPropagation();
      ev.preventDefault();
      suppressNextClick = true;
      setTimeout(() => { suppressNextClick = false; }, 0);
      const from = [...$('#tabstrip').querySelectorAll('.tab')].indexOf(tabEl);
      if (drop >= 0 && drop !== from) {
        window.ego.action('moveTab', { targetId, toIndex: drop });
      } else {
        render(); // no move: repaint to clear any visual residue
      }
    }
  };

  window.addEventListener('pointermove', onMove, true);
  window.addEventListener('pointerup', onUp, true);
}

function render() {
  if (dragging) return; // strip is mid-drag; re-render after drop
  const space = activeSpace();
  const activeTab = space?.tabs.find((t) => t.targetId === space.activeTargetId) ?? null;

  const omnibox = $('#omnibox');
  if (document.activeElement !== omnibox) {
    omnibox.value = activeTab && activeTab.url !== 'about:blank' ? activeTab.url : '';
  }

  const strip = $('#tabstrip');
  strip.textContent = '';
  let tabIndex = 0;
  for (const tab of space?.tabs ?? []) {
    const el = document.createElement('div');
    el.className = `tab${tab.targetId === space.activeTargetId ? ' active' : ''}`;
    // Key by position+url: the placeholder targetId swaps to the real CDP id
    // shortly after creation, and keying by targetId would replay the
    // enter animation.
    const animKey = `${tabIndex}:${tab.url}`;
    tabIndex++;
    if (!knownTabs.has(animKey)) {
      knownTabs.add(animKey);
      el.classList.add('entering');
      el.addEventListener('animationend', () => el.classList.remove('entering'), { once: true });
    }
    el.title = tab.url;
    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = tab.title || (tab.url !== 'about:blank' ? tab.url : 'New Tab');
    const close = document.createElement('span');
    close.className = 'close';
    close.textContent = '×';
    close.addEventListener('click', (e) => {
      e.stopPropagation();
      window.ego.action('closeTab', { targetId: tab.targetId });
    });
    el.append(label, close);
    el.addEventListener('click', () => {
      if (suppressNextClick) return;
      window.ego.action('activateTab', { targetId: tab.targetId });
    });
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.target.closest('.close')) return;
      startTabDrag(e, el, tab.targetId);
    });
    strip.appendChild(el);
  }
  const plus = document.createElement('button');
  plus.id = 'newtab';
  plus.textContent = '+';
  plus.title = 'New tab';
  plus.addEventListener('click', () => window.ego.action('newTab'));
  strip.appendChild(plus);

  const list = $('#spaces');
  list.textContent = '';
  for (const s of state.spaces) {
    const el = document.createElement('div');
    el.className = `space${s.id === state.activeSpaceId ? ' active' : ''}`;
    if (!knownSpaces.has(s.id)) {
      knownSpaces.add(s.id);
      el.classList.add('entering');
      el.addEventListener('animationend', () => el.classList.remove('entering'), { once: true });
    }
    const row = document.createElement('div');
    row.className = 'row';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = s.name;
    const badge = document.createElement('span');
    badge.className = `badge ${s.ownership}`;
    badge.textContent = s.ownership === 'agent' ? 'Agent' : 'You';
    row.append(name, badge);
    el.appendChild(row);
    const bottom = document.createElement('div');
    bottom.className = 'bottom';
    const control = document.createElement('div');
    control.className = `control ${s.control === 'agent' ? 'ctl-agent' : 'ctl-user'}`;
    control.textContent = s.control === 'agent' ? 'Agent in control' : 'You are in control';
    bottom.appendChild(control);
    const del = document.createElement('span');
    del.className = 'del';
    del.textContent = '×';
    del.title = 'Close space';
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      if (del.classList.contains('confirm')) {
        del.classList.remove('confirm');
        del.textContent = '×';
        window.ego.action('closeSpace', { id: s.id });
        return;
      }
      del.classList.add('confirm');
      del.textContent = 'del';
      setTimeout(() => {
        del.classList.remove('confirm');
        del.textContent = '×';
      }, 2500);
    });
    bottom.appendChild(del);
    el.appendChild(bottom);
    if (s.agentState) {
      const st = document.createElement('div');
      st.className = 'agentstate';
      st.textContent = s.agentState;
      el.appendChild(st);
    }
    el.addEventListener('click', () => window.ego.action('switchSpace', { id: s.id }));
    list.appendChild(el);
  }

  const showBanner = space && space.ownership === 'agent' && space.control === 'agent';
  const banner = $('#banner');
  banner.style.display = showBanner ? 'flex' : 'none';
  if (showBanner && !bannerShown) {
    banner.classList.remove('showing');
    void banner.offsetWidth; // restart the animation
    banner.classList.add('showing');
  }
  bannerShown = !!showBanner;
  $('#handback').style.display = space && space.ownership === 'agent' && space.control === 'user' ? 'block' : 'none';
}

function navigate(raw) {
  const v = raw.trim();
  if (!v) return;
  let url;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(v)) url = v;
  else if (/^\S+\.\S+$/.test(v)) url = `https://${v}`;
  else url = `https://duckduckgo.com/?q=${encodeURIComponent(v)}`;
  window.ego.action('navigate', { url });
}

function flashRing(x, y) {
  const ring = document.createElement('div');
  ring.className = 'ring';
  ring.style.left = `${SIDEBAR_WIDTH + x - 12}px`;
  ring.style.top = `${CHROME_HEIGHT + y - 12}px`;
  $('#overlay').appendChild(ring);
  setTimeout(() => ring.remove(), 650);
}

$('#back').addEventListener('click', () => window.ego.action('back'));
$('#forward').addEventListener('click', () => window.ego.action('forward'));
$('#reload').addEventListener('click', () => window.ego.action('reload'));
$('#omnibox').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') navigate(e.target.value);
});
$('#takeover').addEventListener('click', () => window.ego.action('takeover'));
$('#handback').addEventListener('click', () => window.ego.action('handback'));
$('#winmin').addEventListener('click', () => window.ego.action('winControl', { op: 'minimize' }));
$('#winmax').addEventListener('click', () => window.ego.action('winControl', { op: 'maximize' }));
$('#winc').addEventListener('click', () => window.ego.action('winControl', { op: 'close' }));

// ---- space management ----
$('#newspace').addEventListener('click', () => {
  const row = $('#newspace-row');
  const input = $('#newspace-input');
  const open = row.style.display === 'block';
  row.style.display = open ? 'none' : 'block';
  row.classList.toggle('open', !open);
  if (!open) {
    input.value = '';
    input.focus();
  }
});
$('#newspace-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    $('#newspace-row').style.display = 'none';
    window.ego.action('newSpace', { name: e.target.value });
  } else if (e.key === 'Escape') {
    $('#newspace-row').style.display = 'none';
  }
});
// Double-click the drag region toggles maximize, like a native titlebar.
$('#navbar').addEventListener('dblclick', (e) => {
  if (e.target.closest('button, input')) return;
  window.ego.action('winControl', { op: 'maximize' });
});

window.ego.onState((s) => { state = s; render(); });
window.ego.onHighlight(({ x, y }) => flashRing(x, y));
