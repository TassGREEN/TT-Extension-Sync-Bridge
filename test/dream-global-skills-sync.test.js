import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DREAM_SCRIPT_ID,
  DREAM_SETTINGS_KEY,
  dreamCardAgentAdapter,
} from '../src/adapters/dream-card-agent-adapter.js';
import { sha256Bytes } from '../src/core/hash.js';
import { isRedacted } from '../src/core/redaction.js';
import { createPassphraseSensitiveCodec } from '../src/core/sensitive-envelope.js';
import { createMemoryHost } from './helpers/memory-host.js';

async function fixture() {
  const mainName = 'DreamCreator--GlobalSkill--portable--main.md';
  const resourceName = 'DreamCreator--GlobalSkill--portable--reference.txt';
  const mainUrl = '/user/files/source-portable-main.md';
  const resourceUrl = '/user/files/source-portable-reference.txt';
  const mainBytes = new TextEncoder().encode('---\nname: Portable Skill\n---\nsecret skill instructions');
  const resourceBytes = new TextEncoder().encode('portable reference body');
  const mainSha256 = await sha256Bytes(mainBytes);
  const resourceSha256 = await sha256Bytes(resourceBytes);

  const sourceSettings = {
    version: 4,
    syncRevision: 7,
    floatingButtonOffset: { x: 1, y: 2 },
    providers: [{ id: 'provider-1', apiKey: 'source-secret', model: 'model-a' }],
    agentConfigurations: [{ id: 'agent-1', name: 'Agent', skills: [], toolIds: [] }],
    presetProfiles: [{ id: 'preset-1', name: 'Preset' }],
    globalSkills: {
      portable: {
        id: 'portable',
        name: 'Portable Skill',
        description: 'portable',
        loading: 'full',
        revision: 3,
        updatedAt: 123,
        sha256: mainSha256,
        url: mainUrl,
        files: {
          'reference.txt': {
            path: 'reference.txt',
            mediaType: 'text/plain',
            name: resourceName,
            sha256: resourceSha256,
            size: resourceBytes.byteLength,
            url: resourceUrl,
          },
        },
      },
    },
    files: {
      'global-skill:portable:SKILL.md': {
        bindingId: 'global',
        createdAt: 10,
        name: mainName,
        size: mainBytes.byteLength,
        url: mainUrl,
      },
      'global-skill:portable:reference.txt': {
        bindingId: 'global',
        createdAt: 11,
        name: resourceName,
        size: resourceBytes.byteLength,
        url: resourceUrl,
      },
      'session:source-session': {
        bindingId: 'source-character',
        createdAt: 12,
        name: 'source-session.bin',
        size: 99,
        url: '/user/files/source-session.bin',
      },
    },
    characterStores: {
      source: {
        bindingId: 'source',
        characterName: 'Source Character',
        revision: 1,
        sha256: 'a'.repeat(64),
        size: 10,
        updatedAt: 1,
        url: '/user/files/source-character.json',
      },
    },
    workspaceFiles: {
      sourceWorkspace: {
        bindingId: 'source',
        createdAt: 1,
        fileId: 'sourceWorkspace',
        logicalPath: 'project.yaml',
        mediaType: 'text/yaml',
        name: 'source-project.yaml',
        referencedSessionIds: ['source-session'],
        scope: 'character-persistent',
        sha256: 'b'.repeat(64),
        size: 10,
        updatedAt: 1,
        url: '/user/files/source-project.yaml',
      },
    },
    builtinSkillPackages: {
      builtinCache: {
        downloadedAt: 1,
        id: 'builtinCache',
        protocolVersion: 1,
        sha256: 'c'.repeat(64),
        size: 10,
        sourceUrl: 'https://example.invalid/builtin.zip',
        url: '/user/files/source-builtin.zip',
        version: 1,
      },
    },
  };

  return {
    mainName,
    resourceName,
    mainUrl,
    resourceUrl,
    mainBytes,
    resourceBytes,
    sourceSettings,
  };
}

function hostWithSettings(settings, files = {}) {
  const host = createMemoryHost({
    extensionSettings: settings ? { [DREAM_SETTINGS_KEY]: settings } : {},
    files,
  });
  host.hasTavernScript = id => id === DREAM_SCRIPT_ID;
  return host;
}

test('Dream sensitive capture packages global Skill files only inside the encrypted envelope', async () => {
  const data = await fixture();
  const codec = createPassphraseSensitiveCodec('dream skill portable passphrase');
  const host = hostWithSettings(data.sourceSettings, {
    [data.mainUrl]: data.mainBytes,
    [data.resourceUrl]: data.resourceBytes,
  });

  const captured = await dreamCardAgentAdapter.capture(host, { includeSensitive: true, sensitiveCodec: codec });
  const serialized = JSON.stringify(captured.payload);
  const decrypted = await codec.decrypt(captured.payload.encryptedSettings, 'dream-card-agent/settings/v2');

  assert.equal(captured.payload.dataVersion, 4);
  assert.equal(isRedacted(captured.payload.settings.globalSkills), true);
  assert.equal(serialized.includes('secret skill instructions'), false);
  assert.equal(serialized.includes('portable reference body'), false);
  assert.equal(serialized.includes('source-session.bin'), false);
  assert.equal(decrypted.settings.globalSkills.portable.url, undefined);
  assert.equal(decrypted.settings.globalSkills.portable.files['reference.txt'].url, undefined);
  assert.equal(Object.hasOwn(decrypted.settings, 'characterStores'), false);
  assert.equal(Object.hasOwn(decrypted.settings, 'workspaceFiles'), false);
  assert.equal(Object.hasOwn(decrypted.settings, 'builtinSkillPackages'), false);
  assert.equal(Object.hasOwn(decrypted.settings, 'files'), false);
  assert.equal(decrypted.globalSkillAssets.fileCount, 2);
  assert.equal(decrypted.globalSkillAssets.totalBytes, data.mainBytes.byteLength + data.resourceBytes.byteLength);
});

test('Dream encrypted restore rebuilds global Skill files while preserving target-only session state', async () => {
  const data = await fixture();
  const codec = createPassphraseSensitiveCodec('dream skill restore passphrase');
  const source = hostWithSettings(data.sourceSettings, {
    [data.mainUrl]: data.mainBytes,
    [data.resourceUrl]: data.resourceBytes,
  });
  const captured = await dreamCardAgentAdapter.capture(source, { includeSensitive: true, sensitiveCodec: codec });

  const targetSettings = {
    version: 4,
    syncRevision: 20,
    floatingButtonOffset: { x: 90, y: 80 },
    providers: [],
    agentConfigurations: [],
    presetProfiles: [],
    globalSkills: {},
    files: {
      'session:target-session': {
        bindingId: 'target-character',
        createdAt: 30,
        name: 'target-session.bin',
        size: 3,
        url: '/user/files/target-session.bin',
      },
    },
    characterStores: { target: { bindingId: 'target', characterName: 'Target Character' } },
    workspaceFiles: { targetWorkspace: { fileId: 'targetWorkspace', bindingId: 'target' } },
    builtinSkillPackages: { targetCache: { id: 'targetCache' } },
  };
  const target = hostWithSettings(targetSettings, {
    '/user/files/target-session.bin': [1, 2, 3],
  });

  assert.equal((await dreamCardAgentAdapter.preview(target, captured.payload, { sensitiveCodec: codec })).status, 'would-change');
  assert.equal((await dreamCardAgentAdapter.restore(target, captured.payload, { sensitiveCodec: codec })).status, 'applied');

  const firstState = target.inspect();
  const restored = firstState.extensionSettings[DREAM_SETTINGS_KEY];
  const mainUrl = restored.globalSkills.portable.url;
  const resourceUrl = restored.globalSkills.portable.files['reference.txt'].url;

  assert.equal(mainUrl, `/user/files/${data.mainName}`);
  assert.equal(resourceUrl, `/user/files/${data.resourceName}`);
  assert.deepEqual(firstState.files[mainUrl], Array.from(data.mainBytes));
  assert.deepEqual(firstState.files[resourceUrl], Array.from(data.resourceBytes));
  assert.deepEqual(restored.characterStores, targetSettings.characterStores);
  assert.deepEqual(restored.workspaceFiles, targetSettings.workspaceFiles);
  assert.deepEqual(restored.builtinSkillPackages, targetSettings.builtinSkillPackages);
  assert.deepEqual(restored.floatingButtonOffset, targetSettings.floatingButtonOffset);
  assert.equal(restored.files['session:target-session'].url, '/user/files/target-session.bin');
  assert.equal(Object.hasOwn(restored.files, 'session:source-session'), false);
  assert.equal(firstState.fileUploads.length, 2);

  assert.equal((await dreamCardAgentAdapter.restore(target, captured.payload, { sensitiveCodec: codec })).status, 'noop');
  assert.equal(target.inspect().fileUploads.length, 2);

  await target.files.delete(mainUrl);
  assert.equal((await dreamCardAgentAdapter.preview(target, captured.payload, { sensitiveCodec: codec })).status, 'would-change');
  assert.equal((await dreamCardAgentAdapter.restore(target, captured.payload, { sensitiveCodec: codec })).status, 'applied');
  assert.deepEqual(target.inspect().files[mainUrl], Array.from(data.mainBytes));
  assert.equal(target.inspect().fileUploads.length, 3);
});
