# TT Extension Sync Bridge

一个只负责同步第三方插件设置的 TauriTavern 前端扩展。它把经过白名单过滤和脱敏的设置快照写入 TauriTavern Extension Store，再由 TT 自带同步功能搬到其他设备。

当前版本不是自动扫描所有插件的通用同步器，而是使用经过审计的白名单 adapter，专门支持 st-chatu8，以及酒馆助手中的“蚀心入魔·数据库”“API 管理器 2.0.3”“梦境创客”。这样可以避免把 API Key、缓存、聊天衍生数据或设备状态误同步出去。

同步载体固定为：

```text
_tauritavern/extension-store/tt-extension-sync-bridge/snapshots/*.json
```

本扩展不会读取、收集或处理聊天记录、聊天摘要、聊天元数据，也不会修改 TT、TT-Sync 或任何目标插件源码。

## 当前支持

- st-chatu8 2.8.x 的 `extension_settings` 安全配置，以及 `chatu8_gallery/tags` 中 `fileName="manual"` 的用户手工标签
- 蚀心入魔·数据库的用户数据库配置
- API 管理器 2.0.3 的选定 localStorage 配置
- 梦境创客数据版本 4 的用户配置
- 酒馆助手 4.x 全局脚本库内三个固定脚本 ID 的完整脚本记录

精确字段、排除项和兼容范围见 [SUPPORT_MATRIX.md](SUPPORT_MATRIX.md)。

## 安装

在 SillyTavern / TauriTavern 的扩展管理器中选择“安装扩展”，粘贴以下 Git 仓库地址：

```text
https://github.com/TassGREEN/TT-Extension-Sync-Bridge
```

也可以手动 clone 到当前 TT 用户数据目录：

```text
data/extensions/third-party/TT-Extension-Sync-Bridge
```

目标设备还需要安装酒馆助手和 st-chatu8；数据库、API 管理器和梦境创客三个酒馆助手脚本可以由同步快照恢复，无需单独安装。

重新加载 TT 后，在扩展设置中找到 `TT Extension Sync Bridge`。扩展的 `loading_order` 为 1，会先于当前 st-chatu8（9）和酒馆助手（100）运行。

## 使用

1. 在源设备打开 Bridge 设置页，保留需要同步的 adapter 开关。
2. 点击“立即采集”。
3. 使用 TT 自带同步上传 Extension Store。
4. 在目标设备同步下载并重新加载 TT。
5. Bridge 会自动应用无冲突的干净设备/已跟踪更新；已有未跟踪本地差异会停止并标记冲突。
6. 对冲突先点“恢复前预览”，确认后再恢复。

“敏感数据同步”在当前版本中不可开启。凭据只留在各设备本地；恢复时快照中的脱敏占位符会保留目标设备已有凭据。

每份快照同时记录 `contentHash`（完整 payload 完整性）和 `nonSensitiveHash`（忽略脱敏占位符后的跨设备一致性）。冲突判断使用后者，避免两台设备本地凭据字段是否存在造成假冲突。

## 冲突规则

- 快照 schema、adapter 版本、payload 结构或 SHA-256 不合法：拒绝写入。
- 目标插件版本不在已审计范围：拒绝写入。
- 本机数据自上次采集/应用后发生变化：要求人工确认。
- 酒馆助手中出现“同名但不同 ID”的目标脚本：硬冲突，不允许强制覆盖。
- 同一快照重复恢复：返回 `noop`，不重复创建脚本或记录。
- 目标插件未安装：保留快照，返回 `missing-target`，不报致命错误。

## 本地状态

以下 localStorage key 仅保存 Bridge 自身偏好、设备 ID、最近哈希和状态，不进入 Extension Store：

```text
tt_extension_sync_bridge.preferences.v1
tt_extension_sync_bridge.local_state.v1
```

禁用或卸载扩展不会删除目标插件数据。卸载扩展也不会自动删除已同步快照，避免无提示的数据丢失。

## 开发与验证

需要 Node.js 20 或更高版本：

```powershell
npm test
```

当前测试覆盖采集、脱敏、稳定序列化、哈希校验、版本迁移契约、冲突、恢复、缺失插件、IndexedDB manual-tags 事务和幂等性。实机双设备步骤见 [MANUAL_E2E.md](MANUAL_E2E.md)，安全边界见 [SECURITY.md](SECURITY.md)。

已完成与仍待实机证明的项目分开记录在 [VERIFICATION.md](VERIFICATION.md)。
