'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  findShellProfile,
  normalizeShellProfiles,
  resolveDefaultShellProfileId
} = require('../shell-profiles');

test('assigns unique stable IDs while preserving profile argv', () => {
  const profiles = normalizeShellProfiles([
    { name: 'CMD', executable: 'cmd.exe', args: [], shellType: 'cmd' },
    { id: 'shell-profile-1', name: 'Reserved', executable: 'pwsh.exe', args: ['-File', String.raw`C:\Program Files\script.ps1`], shellType: 'pwsh' },
    { id: 'custom', name: 'Second', executable: 'pwsh.exe', args: [], shellType: 'pwsh' }
  ]);

  assert.deepEqual(profiles.map(profile => profile.id), ['shell-profile-1-2', 'shell-profile-1', 'custom']);
  assert.deepEqual(profiles[1].args, ['-File', String.raw`C:\Program Files\script.ps1`]);
});

test('migrates a legacy default profile name to its stable ID', () => {
  const profiles = normalizeShellProfiles([
    { id: 'cmd-id', name: 'CMD', executable: 'cmd.exe', args: [], shellType: 'cmd' },
    { id: 'pwsh-id', name: 'PowerShell', executable: 'powershell.exe', args: [], shellType: 'powershell' }
  ]);

  assert.equal(resolveDefaultShellProfileId({ defaultShellProfile: 'PowerShell' }, profiles), 'pwsh-id');
  assert.equal(resolveDefaultShellProfileId({ defaultShellProfileId: 'pwsh-id' }, profiles), 'pwsh-id');
  assert.equal(resolveDefaultShellProfileId({ defaultShellProfileId: 'deleted' }, profiles), '');

  profiles[1].name = 'Renamed PowerShell';
  assert.equal(resolveDefaultShellProfileId({ defaultShellProfileId: 'pwsh-id' }, profiles), 'pwsh-id');
  assert.equal(resolveDefaultShellProfileId({ defaultShellProfileId: 'pwsh-id' }, profiles.slice(0, 1)), '');
});

test('selects profiles by ID before ambiguous shell type', () => {
  const profiles = normalizeShellProfiles([
    { id: 'pwsh-a', name: 'PowerShell A', executable: 'pwsh.exe', args: ['-NoLogo'], shellType: 'pwsh' },
    { id: 'pwsh-b', name: 'PowerShell B', executable: 'pwsh.exe', args: ['-NoProfile'], shellType: 'pwsh' }
  ]);

  assert.equal(findShellProfile(profiles, 'pwsh-b').name, 'PowerShell B');
  assert.equal(findShellProfile(profiles, 'pwsh').name, 'PowerShell A');
  assert.equal(findShellProfile(profiles, 'missing'), null);
});
