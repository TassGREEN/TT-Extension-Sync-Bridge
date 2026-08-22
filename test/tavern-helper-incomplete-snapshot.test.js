import test from 'node:test';
import assert from 'node:assert/strict';

import {
  TARGET_TAVERN_SCRIPTS,
  TAVERN_HELPER_SETTINGS_KEY,
  tavernHelperScriptsAdapter,
} from '../src/adapters/tavern-helper-scripts-adapter.js';
import { createMemoryHost } from './helpers/memory-host.js';

const [DATABASE_SCRIPT, API_SCRIPT, DREAM_SCRIPT] = TARGET_TAVERN_SCRIPTS;

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
  const source = hostWithScripts([
    script(DATABASE_SCRIPT.id, DATABASE_SCRIPT.name, 'source-db'),
    script(API_SCRIPT.id, API_SCRIPT.name, 'source-api'),
    script(DREAM_SCRIPT.id, DREAM_SCRIPT.name, 'source-dream'),
  ]);
  const captured = await tavernHelperScriptsAdapter.capture(source);
  const partialPayload = {
    ...captured.payload,
    records: captured.payload.records.slice(0, 1),
  };
  const mobile = hostWithScripts([
    script(DATABASE_SCRIPT.id, DATABASE_SCRIPT.name, 'source-db'),
  ]);

  await assert.rejects(
    () => tavernHelperScriptsAdapter.preview(mobile, partialPayload),
    /snapshot is incomplete; recapture on a source device/i,
  );
  await assert.rejects(
    () => tavernHelperScriptsAdapter.restore(mobile, partialPayload),
    /snapshot is incomplete; recapture on a source device/i,
  );
});
