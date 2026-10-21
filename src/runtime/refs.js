// Per-Page ref ledger: refId -> { framePath?, role, name }.
// Populated from bridge snapshot() results; '@N' / 'ref=N' resolution goes
// through the in-page registry (globalThis.__egoSnapshot) to get a CDP
// objectId. Stale/absent refs raise ElementResolutionError{kind:'stale'}.

export class ElementResolutionError extends Error {
  constructor(kind, message) {
    super(message);
    this.name = 'ElementResolutionError';
    this.kind = kind; // 'stale' | 'not_found' | 'ambiguous' | 'not_actionable'
  }
}

const ledgers = new WeakMap(); // Page -> Map<number, {framePath?, role, name}>

export function ledgerFor(page) {
  let m = ledgers.get(page);
  if (!m) {
    m = new Map();
    ledgers.set(page, m);
  }
  return m;
}

// Full-page snapshot replaces; subtree/viewport merges by refId.
// Entries carry frameId when the node lives in an OOPIF (its own CDP target).
export function populate(page, refs, { fullPage = true } = {}) {
  const ledger = ledgerFor(page);
  if (fullPage) ledger.clear();
  for (const ref of refs || []) {
    ledger.set(ref.refId, { framePath: ref.framePath, frameId: ref.frameId, role: ref.role, name: ref.name });
  }
}

export function lookup(page, refId) {
  return ledgerFor(page).get(refId) || null;
}

// Parse '@N' or 'ref=N'; returns integer or null if not a ref target.
export function parseRefTarget(target) {
  if (typeof target === 'number' && Number.isInteger(target)) return target;
  if (typeof target !== 'string') return null;
  let m = /^@(\d+)$/.exec(target.trim());
  if (m) return Number(m[1]);
  m = /^ref=(\d+)$/.exec(target.trim());
  if (m) return Number(m[1]);
  return null;
}

// Resolve '@N' to { objectId, session }. OOPIF refs (ledger entry has
// frameId = the frame's CDP target id) resolve on a session attached to that
// frame target; everything else uses the page session. All subsequent work
// with the objectId MUST use the returned session — objectIds are
// session-local.
export async function resolve(page, target) {
  const refId = parseRefTarget(target);
  if (refId === null) return null; // not a ref target
  const entry = lookup(page, refId);
  if (!entry) {
    throw new ElementResolutionError('stale', `Ref @${refId} is not from this page's latest snapshot; re-snapshot and retry`);
  }
  const session = entry.frameId
    ? await page._ctx().cdp.attach(entry.frameId)
    : await page._session();
  const expr = `(globalThis.__egoSnapshot && globalThis.__egoSnapshot.getRefElement(${refId})) || null`;
  const { result } = await session.send('Runtime.evaluate', {
    expression: expr,
    returnByValue: false,
  });
  if (!result || result.subtype === 'null' || !result.objectId) {
    throw new ElementResolutionError('stale', `Ref @${refId} is stale (element gone or document navigated); re-snapshot and retry`);
  }
  return { objectId: result.objectId, session };
}
