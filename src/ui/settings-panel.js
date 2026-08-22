import { buildDiagnostics } from '../core/diagnostics.js';
import { createPassphraseSensitiveCodec } from '../core/sensitive-envelope.js';

function statusText(status) {
  return ({
    captured: '已采集',
    unchanged: '已同步',
    applied: '已恢复',
    noop: '已同步',
    'would-change': '待恢复',
    conflict: '冲突',
    incompatible: '版本不兼容',
    'missing-target': '目标未安装',
    deferred: '等待插件初始化',
    locked: '等待加密口令',
    'no-snapshot': '无快照',
    failed: '失败',
  })[status] ?? '未检查';
}

function shortHash(hash) {
  return typeof hash === 'string' ? hash.slice(0, 16) : '—';
}

function downloadJson(filename, value) {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function mountBridgeSettingsPanel(runtime) {
  const existing = document.querySelector('#tt-extension-sync-bridge-settings');
  if (existing) return { root: existing, refreshStatus: async () => {} };
  const settingsContainer = document.querySelector('#extensions_settings');
  if (!settingsContainer) return null;
  const root = document.createElement('div');
  root.id = 'tt-extension-sync-bridge-settings';
  root.className = 'extension_container tt-sync-bridge';
  root.innerHTML = `
    <div class="inline-drawer">
      <div class="inline-drawer-toggle inline-drawer-header">
        <b>TT Extension Sync Bridge</b>
        <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
      </div>
      <div class="inline-drawer-content">
        <p class="ttsb-note">仅同步第三方插件设置快照；不读取聊天、摘要或聊天元数据。</p>
        <label class="checkbox_label"><input data-setting="masterEnabled" type="checkbox"> 总开关</label>
        <label class="checkbox_label"><input data-setting="autoCapture" type="checkbox"> 扩展设置加载完成后自动采集</label>
        <div class="ttsb-sensitive-box">
          <label class="checkbox_label"><input data-setting="sensitiveDataSync" type="checkbox"> 加密同步梦境创客 Provider（API URL / Key）</label>
          <input data-setting="sensitivePassphrase" type="password" autocomplete="off" minlength="8" placeholder="同步口令（至少 8 位）" disabled>
          <small>口令只保留在当前页面内存，不写入 localStorage，也不会参与同步；另一台设备需输入相同口令。</small>
        </div>
        <div class="ttsb-adapters"></div>
        <div class="ttsb-actions">
          <button type="button" class="menu_button" data-action="capture">立即采集</button>
          <button type="button" class="menu_button" data-action="preview">从同步快照恢复前预览</button>
          <button type="button" class="menu_button" data-action="restore" disabled>确认并恢复</button>
          <button type="button" class="menu_button" data-action="diagnostics">导出脱敏诊断</button>
        </div>
        <div class="ttsb-summary" role="status"></div>
        <div class="ttsb-status-list"></div>
      </div>
    </div>`;

  const adaptersContainer = root.querySelector('.ttsb-adapters');
  const statusContainer = root.querySelector('.ttsb-status-list');
  const summary = root.querySelector('.ttsb-summary');
  const restoreButton = root.querySelector('[data-action="restore"]');
  const sensitiveToggle = root.querySelector('[data-setting="sensitiveDataSync"]');
  const sensitivePassphrase = root.querySelector('[data-setting="sensitivePassphrase"]');
  let previews = null;
  let sensitiveSessionEnabled = false;

  for (const adapter of runtime.controller.listAdapters()) {
    const label = document.createElement('label');
    label.className = 'checkbox_label ttsb-adapter-toggle';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.dataset.adapterId = adapter.id;
    label.append(checkbox, document.createTextNode(` ${adapter.label}`));
    adaptersContainer.append(label);
  }

  function enabledAdapterIds() {
    const preferences = runtime.preferences.get();
    return runtime.controller.listAdapters()
      .map(adapter => adapter.id)
      .filter(id => preferences.adapters[id]);
  }

  function syncControls() {
    const preferences = runtime.preferences.get();
    root.querySelector('[data-setting="masterEnabled"]').checked = preferences.masterEnabled;
    root.querySelector('[data-setting="autoCapture"]').checked = preferences.autoCapture;
    sensitiveToggle.checked = sensitiveSessionEnabled;
    sensitivePassphrase.disabled = !sensitiveSessionEnabled || !preferences.masterEnabled;
    for (const checkbox of root.querySelectorAll('[data-adapter-id]')) {
      checkbox.checked = preferences.adapters[checkbox.dataset.adapterId] !== false;
      checkbox.disabled = !preferences.masterEnabled;
    }
  }

  function sensitiveCodec() {
    if (!sensitiveSessionEnabled) return null;
    return createPassphraseSensitiveCodec(sensitivePassphrase.value);
  }

  async function refreshStatus() {
    statusContainer.replaceChildren();
    for (const adapter of runtime.controller.listAdapters()) {
      const snapshot = await runtime.snapshotStore.getSnapshot(adapter.id).catch(() => null);
      const state = runtime.localState.getAdapterState(adapter.id);
      const preview = previews?.find(item => item.adapterId === adapter.id);
      const row = document.createElement('div');
      row.className = `ttsb-status ttsb-status-${preview?.status ?? state.lastResult?.status ?? 'unknown'}`;
      const title = document.createElement('strong');
      title.textContent = adapter.label;
      const status = document.createElement('span');
      status.textContent = statusText(preview?.status ?? state.lastResult?.status);
      const metadata = document.createElement('small');
      metadata.textContent = snapshot
        ? `快照 ${snapshot.capturedAt} · rev ${snapshot.sourceRevision} · 内容 ${shortHash(snapshot.contentHash)} · 非敏感 ${shortHash(snapshot.nonSensitiveHash)} · 来源 ${snapshot.deviceId}`
        : '尚无同步快照';
      row.append(title, status, metadata);
      if (preview?.reason) {
        const reason = document.createElement('small');
        reason.textContent = `原因：${preview.reason}`;
        row.append(reason);
      }
      statusContainer.append(row);
    }
  }

  async function busy(label, operation) {
    summary.textContent = label;
    root.classList.add('ttsb-busy');
    try {
      return await operation();
    } finally {
      root.classList.remove('ttsb-busy');
    }
  }

  root.querySelector('[data-setting="masterEnabled"]').addEventListener('change', event => {
    runtime.preferences.update({ masterEnabled: event.currentTarget.checked });
    previews = null;
    restoreButton.disabled = true;
    syncControls();
  });
  root.querySelector('[data-setting="autoCapture"]').addEventListener('change', async event => {
    runtime.preferences.update({ autoCapture: event.currentTarget.checked });
    if (event.currentTarget.checked) {
      await busy('正在执行首次自动采集…', () => runtime.controller.captureAll(enabledAdapterIds()));
      summary.textContent = '自动采集已开启。';
      await refreshStatus();
    }
  });
  sensitiveToggle.addEventListener('change', event => {
    sensitiveSessionEnabled = event.currentTarget.checked;
    previews = null;
    restoreButton.disabled = true;
    syncControls();
  });
  sensitivePassphrase.addEventListener('input', () => {
    previews = null;
    restoreButton.disabled = true;
  });
  for (const checkbox of root.querySelectorAll('[data-adapter-id]')) {
    checkbox.addEventListener('change', event => {
      runtime.preferences.update({ adapters: { [event.currentTarget.dataset.adapterId]: event.currentTarget.checked } });
      previews = null;
      restoreButton.disabled = true;
    });
  }

  root.querySelector('[data-action="capture"]').addEventListener('click', async () => {
    if (!runtime.preferences.get().masterEnabled) return;
    previews = null;
    restoreButton.disabled = true;
    let codec;
    try {
      codec = sensitiveCodec();
    } catch (error) {
      summary.textContent = error instanceof Error ? error.message : String(error);
      return;
    }
    const results = await busy('正在采集并写入 Extension Store…', async () => {
      const output = [];
      for (const adapterId of enabledAdapterIds()) {
        const includeSensitive = adapterId === 'dream-card-agent' && codec !== null;
        output.push(...await runtime.controller.captureAll([adapterId], { includeSensitive, sensitiveCodec: codec }));
      }
      return output;
    });
    summary.textContent = `采集完成：${results.filter(item => item.status === 'captured').length} 项更新，${results.filter(item => item.status === 'failed').length} 项失败。`;
    await refreshStatus();
  });

  root.querySelector('[data-action="preview"]').addEventListener('click', async () => {
    if (!runtime.preferences.get().masterEnabled) return;
    let codec;
    try {
      codec = sensitiveCodec();
    } catch (error) {
      summary.textContent = error instanceof Error ? error.message : String(error);
      return;
    }
    previews = await busy('正在验证快照并生成恢复预览…', async () => {
      const results = [];
      for (const adapterId of enabledAdapterIds()) {
        try {
          results.push(await runtime.controller.previewRestore(adapterId, { sensitiveCodec: codec }));
        } catch (error) {
          results.push({ status: 'failed', adapterId, error });
        }
      }
      return results;
    });
    const changes = previews.filter(item => item.status === 'would-change').length;
    const conflicts = previews.filter(item => item.status === 'conflict').length;
    const failures = previews.filter(item => item.status === 'failed').length;
    const locked = previews.filter(item => item.status === 'locked').length;
    summary.textContent = `预览完成：${changes} 项待恢复，${conflicts} 项冲突，${locked} 项等待口令，${failures} 项失败。`;
    restoreButton.disabled = changes + conflicts === 0 || failures > 0;
    await refreshStatus();
  });

  restoreButton.addEventListener('click', async () => {
    if (!previews) return;
    const hardConflicts = previews.filter(item => item.status === 'conflict' && item.hardConflict);
    const candidates = previews.filter(item => item.status === 'would-change' || (item.status === 'conflict' && !item.hardConflict));
    if (candidates.length === 0) {
      summary.textContent = hardConflicts.length ? '存在不可强制覆盖的脚本 ID 冲突。' : '没有待恢复内容。';
      return;
    }
    if (!globalThis.confirm(`将恢复 ${candidates.length} 个 adapter。已解锁的梦境创客 Provider 将从加密快照恢复，确定继续吗？`)) return;
    const codec = sensitiveCodec();
    const results = await busy('正在恢复设置…', async () => {
      const output = [];
      for (const preview of candidates) {
        output.push(await runtime.controller.restore(preview.adapterId, {
          confirmConflict: preview.status === 'conflict',
          sensitiveCodec: codec,
        }));
      }
      return output;
    });
    previews = null;
    restoreButton.disabled = true;
    summary.textContent = `恢复完成：${results.filter(item => item.status === 'applied').length} 项已应用。建议刷新页面验证目标插件。`;
    await refreshStatus();
  });

  root.querySelector('[data-action="diagnostics"]').addEventListener('click', async () => {
    const diagnostics = await buildDiagnostics({
      adapters: runtime.controller.listAdapters(),
      snapshotStore: runtime.snapshotStore,
      localState: runtime.localState,
      pluginVersions: runtime.pluginVersions,
    });
    downloadJson(`tt-extension-sync-bridge-diagnostics-${new Date().toISOString().replace(/[:.]/g, '-')}.json`, diagnostics);
    summary.textContent = '脱敏诊断已导出；其中不含快照 payload、聊天或凭据值。';
  });

  settingsContainer.append(root);
  syncControls();
  void refreshStatus();
  return { root, refreshStatus };
}
