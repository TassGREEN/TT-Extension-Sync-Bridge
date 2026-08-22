# TT Extension Sync Bridge

一个只负责同步第三方插件设置的 TauriTavern 前端扩展。它把经过白名单过滤和脱敏的设置快照写入 TauriTavern Extension Store，再由 TT 自带同步功能搬到其他设备。

当前版本不是自动扫描所有插件的通用同步器，而是使用经过审计的白名单 adapter，专门支持 st-chatu8，以及酒馆助手中的“蚀心入魔·数据库”“API 管理器 2.0.3”“梦境创客”。默认脱敏；梦境创客 Provider 的 API URL / Key 可选择用口令加密后同步。

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

若要同步梦境创客 Provider 的 API URL / Key：源设备勾选“加密同步梦境创客 Provider”，输入至少 8 位同步口令，再点“立即采集”；目标设备下载同步后勾选同一项、输入完全相同的口令，再执行恢复预览和恢复。每台设备只需首次输入，口令保存在该设备的 Bridge 专用 localStorage，不进入 TT 设置或同步快照；可用“忘记本机口令”清除。忘记所有设备上的口令后无法恢复已有加密快照。

未开启加密同步时，凭据只留在各设备本地，脱敏占位符会保留目标设备已有凭据。已有加密快照不能被普通非敏感采集降级覆盖。其他 adapter 的敏感字段仍不支持同步。

v0.2.0 会在采集梦境创客时修复 v0.1.0 曾误删的 `characterStores.*.url`：仅当引用具备完整 binding ID、revision、size 和 SHA-256 且只缺 URL 时，按创客固定文件命名规则补回指针；不会打开会话或索引文件。

手机端若点击采集时酒馆助手三个目标脚本尚未全部初始化，Bridge 会显示“等待插件初始化”，保留已有完整快照，不再误显示为普通失败，也绝不会发布部分脚本快照。

每份快照同时记录 `contentHash`（完整 payload 完整性）和 `nonSensitiveHash`（忽略脱敏占位符后的跨设备一致性）。冲突判断使用后者，避免两台设备本地凭据字段是否存在造成假冲突。

## 冲突规则

- 快照 schema、adapter 版本、payload 结构或 SHA-256 不合法：拒绝写入。
- 目标插件版本不在已审计范围：拒绝写入。
- 本机数据自上次采集/应用后发生变化：要求人工确认。
- 酒馆助手中出现“同名但不同 ID”的目标脚本：硬冲突，不允许强制覆盖。
- 同一快照重复恢复：返回 `noop`，不重复创建脚本或记录。
- 目标插件未安装：保留快照，返回 `missing-target`，不报致命错误。
- 加密快照未提供口令：返回 `locked`，不写入；错误口令解密失败，仍不写入。
- 已有加密快照时执行非敏感采集：拒绝覆盖，避免丢失已同步的 Provider 凭据。

## 本地状态

以下 localStorage key 仅保存 Bridge 自身偏好、设备 ID、最近哈希和状态，不进入 Extension Store：

```text
tt_extension_sync_bridge.preferences.v1
tt_extension_sync_bridge.local_state.v1
tt_extension_sync_bridge.sensitive_passphrase.v1
```

最后一项是用户明确选择“记住口令”后的设备本地敏感值。同一 SillyTavern/WebView 来源内运行的其他脚本理论上也能访问 localStorage；不接受该边界时请使用“忘记本机口令”，之后每次手动输入。

禁用或卸载扩展不会删除目标插件数据。卸载扩展也不会自动删除已同步快照，避免无提示的数据丢失。

## 开发与验证

需要 Node.js 20 或更高版本：

```powershell
npm test
```

当前测试覆盖采集、脱敏、稳定序列化、哈希校验、版本迁移契约、冲突、恢复、缺失插件、IndexedDB manual-tags 事务和幂等性。实机双设备步骤见 [MANUAL_E2E.md](MANUAL_E2E.md)，安全边界见 [SECURITY.md](SECURITY.md)。

已完成与仍待实机证明的项目分开记录在 [VERIFICATION.md](VERIFICATION.md)。
