// Browser chrome UI. Keep layout constants in sync with window.js.
const CHROME_HEIGHT = 84;
const SIDEBAR_WIDTH = 200;

let state = { activeSpaceId: null, spaces: [] };

const $ = (sel) => document.querySelector(sel);

function activeSpace() {
  return state.spaces.find((s) => s.id === state.activeSpaceId) ?? null;
}

function render() {
  const space = activeSpace();
  const activeTab = space?.tabs.find((t) => t.targetId === space.activeTargetId) ?? null;

  const omnibox = $('#omnibox');
  if (document.activeElement !== omnibox) {
    omnibox.value = activeTab && activeTab.url !== 'about:blank' ? activeTab.url : '';
  }

  const strip = $('#tabstrip');
  strip.textContent = '';
  for (const tab of space?.tabs ?? []) {
    const el = document.createElement('div');
    el.className = `tab${tab.targetId === space.activeTargetId ? ' active' : ''}`;
    el.title = tab.url;
    const label = document.createElement('span');
    label.textContent = tab.title || (tab.url !== 'about:blank' ? tab.url : 'New Tab');
    const close = document.createElement('span');
    close.className = 'close';
    close.textContent = '×';
    close.addEventListener('click', (e) => {
      e.stopPropagation();
      window.ego.action('closeTab', { targetId: tab.targetId });
    });
    el.append(label, close);
    el.addEventListener('click', () => window.ego.action('activateTab', { targetId: tab.targetId }));
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
    const control = document.createElement('div');
    control.className = 'control';
    control.textContent = s.control === 'agent' ? 'Agent in control' : 'You are in control';
    el.appendChild(control);
    if (s.agentState) {
      const st = document.createElement('div');
      st.className = 'agentstate';
      st.textContent = s.agentState;
      el.appendChild(st);
    }
    el.addEventListener('click', () => window.ego.action('switchSpace', { id: s.id }));
    list.appendChild(el);
  }

  $('#banner').style.display = space && space.ownership === 'agent' && space.control === 'agent' ? 'flex' : 'none';
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

window.ego.onState((s) => { state = s; render(); });
window.ego.onHighlight(({ x, y }) => flashRing(x, y));
