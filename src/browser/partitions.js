// Profile → Electron session partition mapping, shared by window.js
// (tab views) and bridge.js (cookie import target).
export function partitionForProfile(profileId) {
  return profileId === 'Default'
    ? 'persist:default'
    : `persist:profile-${String(profileId).replace(/[^a-zA-Z0-9_-]/g, '_')}`;
}
