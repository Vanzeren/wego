// Electron appends "<appName>/<version> Electron/<version>" to the UA and
// picky sites (QQ Mail etc.) bounce non-mainstream agents. Strip those
// tokens; the Chrome/<version> token tracks the runtime automatically.
// Pure module (no electron import) so it is unit-testable.
export function cleanUserAgent(ua) {
  return ua
    .replace(/ [\w.-]+\/[\w.]+(?= Chrome\/)/, '') // appName/version before Chrome
    .replace(/ Electron\/[\w.]+/, '');
}
