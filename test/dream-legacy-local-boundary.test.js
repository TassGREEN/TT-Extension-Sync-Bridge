import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DREAM_SCRIPT_ID,
  DREAM_SETTINGS_KEY,
  dreamCardAgentAdapter,
} from '../src/adapters/dream-card-agent-adapter.js';
import { createMemoryHost } from './helpers/memory-host.js';

function legacyPayload() {
  return {
    dataVersion: 3,
    pluginDataVersion: 4,
    settings: {
      version: 4,
      activeThemeId: 'source-theme',
      providers: [],
      globalSkills: {
        sourceSkill: { id: 'sourceSkill', url: '/user/files/source-skill.md' },
      },
      characterStores: {
        sourceCharacter: { bindingId: 'sourceCharacter', url: '/user/files/source-character.json' },
      },
      workspaceFiles: {
        sourceWorkspace: { fileId: 'sourceWorkspace', sessionId: 'source-session', url: '/user/files/source-workspace.bin' },
      },
      builtinSkillPackages: {
        sourceCache: { id: 'sourceCache', url: '/user/files/source-cache.zip' },
      },
      files: {
        'session:source-session': { url: '/user/files/source-session.bin' },
      },
      floatingButtonOffset: { x: 1, y: 2 },
      syncRevision: 99,
    },
  };
}

function targetSettings() {
  return {
    version: 4,
    activeThemeId: 'target-theme',
    providers: [],
    globalSkills: {
      targetSkill: { id: 'targetSkill', url: '/user/files/target-skill.md' },
    },
    characterStores: {
      targetCharacter: { bindingId: 'targetCharacter', url: '/user/files/target-character.json' },
    },
    workspaceFiles: {
      targetWorkspace: { fileId: 'targetWorkspace', sessionId: 'target-session', url: '/user/files/target-workspace.bin' },
    },
    builtinSkillPackages: {
      targetCache: { id: 'targetCache', url: '/user/files/target-cache.zip' },
    },
    files: {
      'session:target-session': { url: '/user/files/target-session.bin' },
    },
    floatingButtonOffset: { x: 90, y: 80 },
    syncRevision: 7,
  };
}

test('legacy Dream snapshots cannot restore source device file indexes or Global Skill URLs', async () => {
  const migrated = dreamCardAgentAdapter.migratePayload(legacyPayload(), 3);
  const local = targetSettings();
  const target = createMemoryHost({ extensionSettings: { [DREAM_SETTINGS_KEY]: local } });
  target.hasTavernScript = id => id === DREAM_SCRIPT_ID;

  assert.equal((await dreamCardAgentAdapter.restore(target, migrated)).status, 'applied');
  const restored = target.inspect().extensionSettings[DREAM_SETTINGS_KEY];

  assert.equal(restored.activeThemeId, 'source-theme');
  assert.deepEqual(restored.globalSkills, local.globalSkills);
  assert.deepEqual(restored.characterStores, local.characterStores);
  assert.deepEqual(restored.workspaceFiles, local.workspaceFiles);
  assert.deepEqual(restored.builtinSkillPackages, local.builtinSkillPackages);
  assert.deepEqual(restored.files, local.files);
  assert.deepEqual(restored.floatingButtonOffset, local.floatingButtonOffset);
  assert.equal(restored.syncRevision, 8);
  assert.equal(JSON.stringify(restored).includes('source-session.bin'), false);
  assert.equal(JSON.stringify(restored).includes('source-skill.md'), false);
});

test('legacy Dream snapshots do not seed file indexes onto a clean device', async () => {
  const migrated = dreamCardAgentAdapter.migratePayload(legacyPayload(), 3);
  const target = createMemoryHost();
  target.hasTavernScript = id => id === DREAM_SCRIPT_ID;

  assert.equal((await dreamCardAgentAdapter.restore(target, migrated)).status, 'applied');
  const restored = target.inspect().extensionSettings[DREAM_SETTINGS_KEY];

  assert.equal(restored.activeThemeId, 'source-theme');
  assert.equal(Object.hasOwn(restored, 'globalSkills'), false);
  assert.equal(Object.hasOwn(restored, 'characterStores'), false);
  assert.equal(Object.hasOwn(restored, 'workspaceFiles'), false);
  assert.equal(Object.hasOwn(restored, 'builtinSkillPackages'), false);
  assert.equal(Object.hasOwn(restored, 'files'), false);
  assert.equal(Object.hasOwn(restored, 'floatingButtonOffset'), false);
  assert.equal(restored.syncRevision, 1);
});
