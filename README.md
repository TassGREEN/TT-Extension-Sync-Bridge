# TT Extension Sync Bridge

一个只负责同步第三方插件可移植配置的 TauriTavern 前端扩展。它把经过白名单过滤、脱敏或显式加密的快照写入 TauriTavern Extension Store，再由 TT 自带同步功能搬到其他设备。

当前版本不是自动扫描所有插件的通用同步器，而是使用经过审计的白名单 adapter，专门支持 st-chatu8，以及酒馆助手、蚀心入魔·数据库、API 管理器和梦境创客。

同步载体固定为：

```text
_tauritavern/extension-store/tt-extension-sync-bridge/snapshots/*.json
```

本扩展不会读取、收集或同步聊天记录、聊天摘要、聊天元数据、梦境创客会话索引或 session blob，也不会修改 TT、TT-Sync 或任何目标插件源码。

## 当前支持

- st-chatu8 2.8.x 的可移植设置、加密后的 API/工作流配置，以及 `chatu8_gallery/tags` 中 `fileName="manual"` 的用户手工标签
- 蚀心入魔·数据库的用户数据库配置
- API 管理器 2.x 兼容存储格式中的配置；启用加密后可跨设备恢复 Key / URL 等敏感配置
- 梦境创客数据版本 4 的 Agent、Preset、Provider 等可移植设置；启用加密后同步 Provider 敏感配置以及用户自建 Global Skill 的 `SKILL.md` 和资源文件
- 酒馆助手 4.x 的完整全局脚本树；脚本正文只在启用加密同步时进入快照

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

目标设备还需要安装酒馆助手和 st-chatu8。数据库、API 管理器、梦境创客以及其他已采集的酒馆助手全局脚本，可以由完整加密快照恢复到目标设备。首次恢复出新的酒馆助手脚本后建议再重启一次 TT，让脚本正式执行。

重新加载 TT 后，在扩展设置中找到 `TT Extension Sync Bridge`。扩展的 `loading_order` 为 110，晚于当前 st-chatu8 和酒馆助手。恢复酒馆助手全局脚本时，Bridge 使用酒馆助手提供的 `getScriptTrees` / `replaceScriptTrees` 公共接口写入其内部权威 store；若该接口尚未就绪则等待，不会直接改底层 `extension_settings` 并误报成功。

## 使用

1. 在源设备打开 Bridge 设置页，保留需要同步的 adapter 开关。
2. 若需要真正跨设备搬运酒馆助手脚本正文、API 凭据、梦境创客 Global Skill 文件或 st-chatu8 工作流，勾选“加密同步敏感配置”，输入至少 8 位同步口令。
3. 点击“立即采集”。手动采集代表你明确确认当前源设备状态；例如主动删除了某个酒馆助手脚本后，手动采集允许把较小的脚本集合发布成新快照。
4. 使用 TT 自带同步上传 Extension Store。
5. 在目标设备同步下载并重新加载 TT；启用了加密快照时，在目标设备输入同一口令。
6. Bridge 会自动应用无冲突的干净设备/已跟踪更新；已有未跟踪本地差异会停止并标记冲突。
7. 对冲突先点“恢复前预览”，确认后再恢复。

同步口令只保存在本机 Bridge 专用 localStorage，不进入 TT 设置或同步快照；可用“忘记本机口令”清除。忘记所有设备上的口令后无法恢复已有加密快照。

未开启加密同步时，凭据、任意酒馆助手脚本正文、梦境创客 Global Skill 文件和 st-chatu8 工作流正文不会以明文进入同步快照。已有加密快照也不能被普通非敏感采集降级覆盖。

## 梦境创客文件边界

梦境创客把多种数据都存放在 `/user/files/`，但它们并不都属于“设置”。Bridge 只把**用户自建 Global Skill**视为可移植配置资产：加密采集 `SKILL.md` 与该 Skill 的资源文件，在目标设备重新上传后重建本地 URL 和 `global-skill:*` 文件索引。

以下内容明确保持目标设备本地，不从源设备搬运：

- `characterStores`
- `workspaceFiles`（其中含 session 引用、临时工作区和附件状态）
- 普通 `files` / session / lease blob 索引
- `builtinSkillPackages` 下载缓存
- `floatingButtonOffset`
- `syncRevision`

这样可以恢复真正的用户 Skill，同时不把会话、历史或设备缓存混进设置同步。

旧版加密 Dream 快照若没有 Global Skill 文件包，仍可迁移普通可移植设置，但不会把旧设备的 `/user/files/...` URL 当作可移植文件引用灌到新设备；要完整迁移 Global Skill，请在新版 Bridge 的源设备重新执行一次加密采集。

v0.2.0 起仍会在采集梦境创客时修复早期版本曾误删的 `characterStores.*.url`：仅当引用具备完整 binding ID、revision、size 和 SHA-256 且只缺 URL 时，按创客固定文件命名规则补回本机指针；不会打开会话或索引文件内容，该字段也不会进入新版可移植快照。

## 酒馆助手脚本保护

启用加密同步后，Bridge 会采集完整的酒馆助手全局脚本树，而不再只覆盖三个固定脚本。恢复采用增量合并：

- 同一 UUID 的脚本更新到源内容，但保留目标设备现有位置/UUID 语义；
- 三个已知脚本还支持名称别名匹配，避免重新导入导致 UUID 变化后生成重复项；
- 源设备新增的其他全局脚本会补到目标设备；
- 目标设备独有脚本不会因恢复被删除；
- 自动采集检测到脚本集合相对已有完整快照异常缩水时会 `deferred`，防止新设备初始化中的半成品覆盖完整快照；
- 手动“立即采集”允许缩水，用于明确同步你主动删除脚本后的新状态。

## 冲突规则

- 快照 schema、adapter 版本、payload 结构或 SHA-256 不合法：拒绝写入。
- 目标插件版本不在已审计范围：拒绝写入。
- 本机数据自上次采集/应用后发生变化：要求人工确认。
- 酒馆助手中出现无法唯一判定的同名逻辑目标：硬冲突，不允许强制覆盖。
- 同一快照重复恢复：返回 `noop`，不重复创建脚本、文件或记录。
- 目标插件未安装：保留快照，返回 `missing-target`，不报致命错误。
- 加密快照未提供口令：返回 `locked`，不写入；错误口令解密失败，仍不写入。
- 已有加密快照时执行非敏感采集：拒绝覆盖，避免丢失已同步的敏感/文件内容。

## 手机诊断日志

设置页的“复制诊断日志”会生成一份实时脱敏 JSON。它包含 Bridge/目标插件版本、快照元数据、最近状态，以及酒馆助手脚本树的结构计数；Dream 只额外暴露 Global Skill 文件数量/总字节等结构性信息。诊断不含 snapshot payload、脚本正文、Provider、工作流正文、口令、聊天或会话数据。

## 本地状态

以下 localStorage key 仅保存 Bridge 自身偏好、设备 ID、最近哈希和状态，不进入 Extension Store：

```text
tt_extension_sync_bridge.preferences.v1
tt_extension_sync_bridge.local_state.v1
tt_extension_sync_bridge.sensitive_passphrase.v1
```

最后一项是用户明确保存后的设备本地敏感值。同一 SillyTavern/WebView 来源内运行的其他脚本理论上也能访问 localStorage；不接受该边界时请使用“忘记本机口令”，之后每次手动输入。

禁用或卸载扩展不会删除目标插件数据。卸载扩展也不会自动删除已同步快照，避免无提示的数据丢失。

## 开发与验证

需要 Node.js 20 或更高版本：

```powershell
npm test
```

当前自动测试覆盖采集、脱敏/加密、稳定序列化、哈希校验、版本迁移、冲突、恢复、Tavern Helper 全局脚本合并/缩水保护、Dream Global Skill 文件跨设备重建与损坏修复、st-chatu8 workflow 恢复、IndexedDB manual-tags 事务以及全 adapter 加密 A→B 往返。实机双设备步骤见 [MANUAL_E2E.md](MANUAL_E2E.md)，安全边界见 [SECURITY.md](SECURITY.md)。

已完成与仍待实机证明的项目分开记录在 [VERIFICATION.md](VERIFICATION.md)。
