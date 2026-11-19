'use strict';

function createUniqueProfileId(usedIds, index) {
  const base = `shell-profile-${index + 1}`;
  let id = base;
  let suffix = 2;
  while (usedIds.has(id)) {
    id = `${base}-${suffix++}`;
  }
  return id;
}

function normalizeShellProfiles(profiles, fallbackProfiles = []) {
  const source = Array.isArray(profiles) ? profiles : fallbackProfiles;
  const explicitIdOwners = new Map();
  source.forEach((profile, index) => {
    const id = typeof profile?.id === 'string' ? profile.id.trim() : '';
    if (id && !explicitIdOwners.has(id)) explicitIdOwners.set(id, index);
  });
  const usedIds = new Set(explicitIdOwners.keys());
  return source.flatMap((profile, index) => {
    if (!profile || typeof profile !== 'object') return [];
    let id = typeof profile.id === 'string' ? profile.id.trim() : '';
    if (!id || explicitIdOwners.get(id) !== index) id = createUniqueProfileId(usedIds, index);
    usedIds.add(id);
    return [{
      id,
      name: typeof profile.name === 'string' ? profile.name : '',
      executable: typeof profile.executable === 'string' ? profile.executable : '',
      args: Array.isArray(profile.args) ? profile.args.filter(arg => typeof arg === 'string') : [],
      shellType: typeof profile.shellType === 'string' && profile.shellType ? profile.shellType : 'auto'
    }];
  });
}

function resolveDefaultShellProfileId(config, profiles) {
  const id = typeof config?.defaultShellProfileId === 'string' ? config.defaultShellProfileId : '';
  if (id && profiles.some(profile => profile.id === id)) return id;

  const legacyReference = typeof config?.defaultShellProfile === 'string' ? config.defaultShellProfile : '';
  if (!legacyReference) return '';
  return profiles.find(profile => profile.id === legacyReference || profile.name === legacyReference)?.id || '';
}

function findShellProfile(profiles, selector) {
  if (!Array.isArray(profiles) || !profiles.length || !selector) return null;
  const exact = String(selector);
  const byId = profiles.find(profile => profile.id === exact);
  if (byId) return byId;

  const search = exact.toLowerCase();
  return profiles.find(profile => String(profile.name || '').toLowerCase() === search)
    || profiles.find(profile => String(profile.shellType || '').toLowerCase() === search)
    || null;
}

module.exports = {
  findShellProfile,
  normalizeShellProfiles,
  resolveDefaultShellProfileId
};
