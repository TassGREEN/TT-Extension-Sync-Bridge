import test from 'node:test';
import assert from 'node:assert/strict';

import {
  TARGET_TAVERN_SCRIPTS,
  TAVERN_HELPER_SETTINGS_KEY,
  tavernHelperScriptsAdapter,
} from '../src/adapters/tavern-helper-scripts-adapter.js';
import { createMemoryHost } from './helpers/memory-host.js';

const [DATABASE_SCRIPT] = TARGET_TAVERN_SCRIPTS;

function script(id, name, content) {
  return {
    type: 'script',
    enabled: true,
    name,
    id,
    content,
    info: '',
    button: { enabled: true, buttons: [] },
    data: {},
    export_with: { data: true, button: true },
  };
}

function hostWithScripts(scripts) {
  return createMemoryHost({
    extensionSettings: {
      [TAVERN_HELPER_SETTINGS_KEY]: {
        script: { enabled: { global: true, presets: [], characters: [] }, scripts },
      },
    },
    pluginVersions: { 'third-party/JS-Slash-Runner': '4.9.3' },
  });
}

test('legacy partial Tavern Helper payload cannot masquerade as a complete no-op snapshot', async () => {
  const database = script(DATABASE_SCRIPT.id, DATABASE_SCRIPT.name, 'source-db');
  const legacyPartialPayload = {
    dataVersion: 1,
    pluginVersion: '4.9.3',
    records: [{
      targetKey: DATABASE_SCRIPT.key,
      record: database,
      path: { kind: 'root', treeIndex: 0 },
    }],
  };
  const mobile = hostWithScripts([database]);

  await assert.rejects(
    () => tavernHelperScriptsAdapter.preview(mobile, legacyPartialPayload),
    /snapshot is incomplete; recapture on a source device/i,
  );
  await assert.rejects(
    () => tavernHelperScriptsAdapter.restore(mobile, legacyPartialPayload),
    /snapshot is incomplete; recapture on a source device/i,
  );
});
