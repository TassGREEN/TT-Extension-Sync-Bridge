import { buildDiagnostics } from '../core/diagnostics.js';
import { createPassphraseSensitiveCodec } from '../core/sensitive-envelope.js';

function statusText(status) {
  return ({
    captured: '已采集',
    unchanged: '已同步',
    applied: '已恢复',
    noop: '已同步',
    'would-change': '待恢复',
    conflict: '本地有修改',
    incompatible: '版本不兼容',
    'missing-target': '目标未安装',
    deferred: '等待插件初始化',
    locked: '等待加密口令',
    'no-snapshot': '无快照',
    failed: '失败',
  })[status] ?? '未检查';
}

function formatTime(value) {
  if (typeof value !== 'string') return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';

  const now = new Date();
  const sameDay = (
    date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate()
  );
  const hour = String(date.getHours()).padStart(2, '0');
  const minute = String(date.getMinutes()).padStart(2, '0');
  if (sameDay) return `今天 ${hour}:${minute}`;
  return `${date.getMonth() + 1}月${date.getDate()}日 ${hour}:${minute}`;
}

function latestTime(...values) {
  let latest = null;
  let latestMs = -Infinity;
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const time = Date.parse(value);
    if (Number.isNaN(time) || time <= latestMs) continue;
    latest = value;
    latestMs = time;
  }
  return latest;
}

async function copyText(value, textarea) {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    textarea.focus();
    textarea.select();
    return document.execCommand('copy');
  }
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
        <b>TT Extension Sync Bridge <span data-bridge-version></span></b>
        <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
      </div>
      <div class="inline-drawer-content">
        <p class="ttsb-note">仅同步第三方插件设置快照；不读取聊天、摘要或聊天元数据。</p>
        <label class="checkbox_label"><input data-setting="masterEnabled" type="checkbox"> 总开关</label>
        <label class="checkbox_label"><input data-setting="autoCapture" type="checkbox"> 扩展设置加载完成后自动采集</label>
        <div class="ttsb-sensitive-box">
          <label class="checkbox_label"><input data-setting="sensitiveDataSync" type="checkbox"> 加密同步敏感配置（API 管理器 / 梦境创客 / st-chatu8）</label>
          <input data-setting="sensitivePassphrase" type="password" autocomplete="off" minlength="8" placeholder="同步口令（至少 8 位）" disabled>
          <small>口令只保存在本机，不进入 TT 同步快照；另一台设备首次使用时输入同一口令。</small>
          <button type="button" class="menu_button" data-action="forget-passphrase">忘记本机口令</button>
        </div>

        <details class="ttsb-subdrawer ttsb-sync-range">
          <summary>同步范围 <small>默认全部</small></summary>
          <div class="ttsb-adapters"></div>
        </details>

        <div class="ttsb-actions">
          <button type="button" class="menu_button" data-action="capture">立即采集</button>
          <button type="button" class="menu_button" data-action="preview">从同步快照恢复前预览</button>
          <button type="button" class="menu_button" data-action="restore" disabled>确认并恢复</button>
          <button type="button" class="menu_button" data-action="copy-diagnostics">复制诊断日志</button>
        </div>
        <div class="ttsb-summary" role="status"></div>

        <div class="ttsb-overview" aria-live="polite">
          <span>最近更新</span>
          <strong data-latest-update>—</strong>
        </div>

        <details class="ttsb-subdrawer ttsb-status-drawer">
          <summary>同步详情 <small data-status-count></small></summary>
          <div class="ttsb-status-list"></div>
        </details>

        <details class="ttsb-subdrawer ttsb-diagnostics-drawer" data-diagnostics-drawer>
          <summary>诊断日志</summary>
          <textarea class="ttsb-diagnostics-log" data-diagnostics-log rows="14" readonly spellcheck="false"></textarea>
        </details>
      </div>
    </div>`;

  const adaptersContainer = root.querySelector('.ttsb-adapters');
  const statusContainer = root.querySelector('.ttsb-status-list');
  const latestUpdate = root.querySelector('[data-latest-update]');
  const statusCount = root.querySelector('[data-status-count]');
  const summary = root.querySelector('.ttsb-summary');
  const restoreButton = root.querySelector('[data-action="restore"]');
  const sensitiveToggle = root.querySelector('[data-setting="sensitiveDataSync"]');
  const sensitivePassphrase = root.querySelector('[data-setting="sensitivePassphrase"]');
  const diagnosticsLog = root.querySelector('[data-diagnostics-log]');
  const diagnosticsDrawer = root.querySelector('[data-diagnostics-drawer]');
  let previews = null;

  root.querySelector('[data-bridge-version]').textContent = `v${runtime.bridgeVersion ?? 'unknown'}`;
  sensitivePassphrase.value = runtime.passphrases.get();

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
    sensitiveToggle.checked = preferences.sensitiveDataSync;
    sensitivePassphrase.disabled = !preferences.sensitiveDataSync || !preferences.masterEnabled;
    for (const checkbox of root.querySelectorAll('[data-adapter-id]')) {
      checkbox.checked = preferences.adapters[checkbox.dataset.adapterId] !== false;
      checkbox.disabled = !preferences.masterEnabled;
    }
  }

  function sensitiveCodec() {
    if (!runtime.preferences.get().sensitiveDataSync) return null;
    const codec = createPassphraseSensitiveCodec(sensitivePassphrase.value);
    runtime.passphrases.set(sensitivePassphrase.value);
    return codec;
  }

  async function captureEnabledAdapters(codec) {
    const output = [];
    for (const adapterId of enabledAdapterIds()) {
      output.push(...await runtime.controller.captureAll([adapterId], { sensitiveCodec: codec }));
    }
    return output;
  }

  async function createDiagnostics() {
    const adapterProbes = {};
    await Promise.all(runtime.controller.listAdapters().map(async adapter => {
      adapterProbes[adapter.id] = await runtime.controller.diagnoseAdapter(adapter.id).catch(() => null);
    }));
    return buildDiagnostics({
      adapters: runtime.controller.listAdapters(),
      snapshotStore: runtime.snapshotStore,
      localState: runtime.localState,
      pluginVersions: runtime.pluginVersions,
      adapterProbes,
      bridgeVersion: runtime.bridgeVersion,
    });
  }

  async function refreshStatus() {
    statusContainer.replaceChildren();
    let latestCapturedAt = null;
    let trackedCount = 0;

    for (const adapter of runtime.controller.listAdapters()) {
      const snapshot = await runtime.snapshotStore.getSnapshot(adapter.id).catch(() => null);
      const state = runtime.localState.getAdapterState(adapter.id);
      const preview = previews?.find(item => item.adapterId === adapter.id);
      const effectiveStatus = preview?.status ?? state.lastResult?.status ?? 'unknown';
      const lastCapture = latestTime(state.lastCapturedAt, snapshot?.capturedAt);
      latestCapturedAt = latestTime(latestCapturedAt, lastCapture);
      trackedCount += 1;

      const row = document.createElement('div');
      row.className = `ttsb-status ttsb-status-${effectiveStatus}`;

      const title = document.createElement('strong');
      title.textContent = adapter.label;

      const status = document.createElement('span');
      status.className = 'ttsb-status-text';
      status.textContent = statusText(effectiveStatus);

      const metadata = document.createElement('small');
      metadata.className = 'ttsb-status-meta';
      const encrypted = snapshot?.sensitiveDataIncluded ? ' · 加密快照' : '';
      metadata.textContent = snapshot
        ? `上次采集：${formatTime(lastCapture)}${encrypted}`
        : '上次采集：尚无快照';

      row.append(title, status, metadata);

      const reasonText = preview?.reason || (effectiveStatus === 'failed' ? state.error?.message : null);
      if (reasonText) {
        const reason = document.createElement('small');
        reason.className = 'ttsb-status-reason';
        reason.textContent = `原因：${reasonText}`;
        row.append(reason);
      }
      statusContainer.append(row);
    }

    latestUpdate.textContent = latestCapturedAt ? formatTime(latestCapturedAt) : '尚无快照';
    statusCount.textContent = trackedCount > 0 ? `${trackedCount} 项` : '';
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
      let codec;
      try {
        codec = sensitiveCodec();
      } catch (error) {
        summary.textContent = error instanceof Error ? error.message : String(error);
        return;
      }
      await busy('正在执行首次自动采集…', () => captureEnabledAdapters(codec));
      summary.textContent = '自动采集已开启。';
      await refreshStatus();
    }
  });

  sensitiveToggle.addEventListener('change', event => {
    runtime.preferences.update({ sensitiveDataSync: event.currentTarget.checked });
    previews = null;
    restoreButton.disabled = true;
    syncControls();
  });

  sensitivePassphrase.addEventListener('input', () => {
    previews = null;
    restoreButton.disabled = true;
  });

  sensitivePassphrase.addEventListener('change', () => {
    if (sensitivePassphrase.value.length >= 8) {
      runtime.passphrases.set(sensitivePassphrase.value);
      summary.textContent = '同步口令已保存在本机。';
    }
  });

  root.querySelector('[data-action="forget-passphrase"]').addEventListener('click', () => {
    runtime.passphrases.clear();
    runtime.preferences.update({ sensitiveDataSync: false });
    sensitivePassphrase.value = '';
    previews = null;
    restoreButton.disabled = true;
    summary.textContent = '本机保存的同步口令已清除；同步快照未删除。';
    syncControls();
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
    const results = await busy('正在采集并写入 Extension Store…', () => captureEnabledAdapters(codec));
    summary.textContent = `采集完成：${results.filter(item => item.status === 'captured').length} 项更新，${results.filter(item => item.status === 'deferred').length} 项等待初始化，${results.filter(item => item.status === 'failed').length} 项失败。`;
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
    summary.textContent = `预览完成：${changes} 项待恢复，${conflicts} 项本地有修改，${locked} 项等待口令，${failures} 项失败。`;
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
    if (!globalThis.confirm(`将恢复 ${candidates.length} 个 adapter。已解锁的敏感配置将从加密快照恢复，确定继续吗？`)) return;
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

  root.querySelector('[data-action="copy-diagnostics"]').addEventListener('click', async () => {
    const diagnostics = await busy('正在生成实时脱敏诊断…', () => createDiagnostics());
    const serialized = JSON.stringify(diagnostics, null, 2);
    diagnosticsLog.value = serialized;
    diagnosticsDrawer.open = true;
    const copied = await copyText(serialized, diagnosticsLog);
    summary.textContent = copied
      ? '诊断日志已生成并复制。'
      : '诊断日志已展开；请长按文本框全选复制。';
  });

  settingsContainer.append(root);
  syncControls();
  void refreshStatus();
  return { root, refreshStatus };
}
