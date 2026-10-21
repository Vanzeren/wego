// Merge an OOPIF sub-capture into the parent snapshot text.
// The iframe's own line (carrying [ref=N]) was emitted by the parent capture
// without children; the sub-capture's lines are inserted right after it,
// indented one level deeper than the iframe line.
export function mergeFrameCapture(content, iframeRefId, subContent) {
  const lines = content.split('\n');
  const marker = `[ref=${iframeRefId}]`;
  const idx = lines.findIndex((l) => l.includes(marker));
  if (idx < 0) return content;
  const depth = (lines[idx].match(/^(?:  )*/) ?? [''])[0].length / 2;
  const pad = '  '.repeat(depth + 1);
  const subLines = subContent.split('\n').filter((l) => l.length > 0).map((l) => pad + l);
  lines.splice(idx + 1, 0, ...subLines);
  return lines.join('\n');
}

// Tag ref entries from an OOPIF capture with the owning frame target id.
export function tagFrameRefs(refs, frameId) {
  return refs.map((r) => ({ ...r, frameId }));
}
