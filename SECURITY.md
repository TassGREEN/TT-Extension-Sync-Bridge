# 安全与隐私边界

## 永不访问 / 永不同步

- 聊天记录
- 聊天摘要
- 聊天 metadata
- 角色对话正文及类似聊天内容文件
- 梦境创客 `characterStores` 会话元数据
- 梦境创客 `workspaceFiles`、session/lease blob 和其他会话文件索引

Bridge 的浏览器入口只接触目标 adapter 明确列出的 `extension_settings` / localStorage / IndexedDB 数据、酒馆助手公共脚本 API、TT Extension Store，以及梦境创客 Global Skill 已在设置中明确引用的 `/user/files/` 文件。

Bridge 的文件 host 不是通用文件浏览器：读取/删除只接受 `/user/files/<安全文件名>` URL，上传只接受不含目录分隔符、路径穿越或 query/hash 的安全 basename。Dream adapter 也只根据 `globalSkills` 索引读取 `SKILL.md` 和它列出的资源文件，不枚举文件目录。

早期版本遗留的梦境创客 `characterStores.*.url` 修复只根据设置内已有 binding ID 和源码固定命名规则重建本机路径；不下载、解析或输出索引/会话文件内容。修复后的字段也不会进入新版可移植快照。

## 敏感数据与加密模式

默认情况下，API Key、Token、密码、Cookie、授权头、账号标识、Provider URL/Base URL 等按字段名脱敏；恢复时保留目标设备本地值。

开启“加密同步敏感配置”后，以下内容可进入**加密 envelope**：

- 酒馆助手完整全局脚本正文
- API 管理器完整 API config（Key / URL 等）
- 梦境创客可移植设置中的 Provider 敏感内容
- 梦境创客用户自建 Global Skill 的 `SKILL.md` 与资源文件字节
- st-chatu8 的凭据以及 worker/workflow presets

Bridge 使用 PBKDF2-SHA-256（310,000 次）从用户口令派生 256-bit AES-GCM 密钥，随机 16-byte salt、12-byte IV，并用 adapter/context 作为 AAD。公开快照中只保存加密 envelope 和带密钥的内容指纹，不保存这些内容的明文或口令。

按用户选择，口令保存在设备本地 `tt_extension_sync_bridge.sensitive_passphrase.v1` localStorage key 中，不进入 Extension Store 或 TT 同步。WebView 没有供该扩展使用的系统钥匙串边界，因此该值不是操作系统级安全存储：同一来源内运行的其他酒馆脚本理论上可访问它。UI 提供“忘记本机口令”立即清除；清除不会删除同步快照。

已有加密快照不能由非敏感采集降级覆盖。缺少或错误口令时，恢复在任何目标设置/文件写入前终止。

## 梦境创客文件事务边界

Global Skill 的源设备 `/user/files/...` URL 不视为可移植身份。采集时 Bridge 会下载设置中明确引用的 Skill 文件、校验 SHA-256，并把文件字节只放入加密 payload；目标设备恢复时重新上传文件并重建 `globalSkills.*.url`、资源 URL 和 `files["global-skill:..."]` registry。

恢复优先复用目标设备已存在且 SHA-256 一致的 Skill 文件。上传过程中失败会清理由本次恢复新建的文件；若设置持久化失败，也会回滚本次新上传文件。为了避免误删其他插件/旧版本仍引用的文件，成功恢复后暂不主动删除旧的孤儿物理文件，只移除失效的 Global Skill registry 引用。

以下 Dream 数据保持目标设备本地，即使旧快照曾包含这些字段也不应成为新版跨设备文件来源：`characterStores`、`workspaceFiles`、普通 `files`、`builtinSkillPackages`、`floatingButtonOffset` 和 `syncRevision`。

## 完整性与覆盖保护

- canonical JSON 生成两个稳定 SHA-256：`contentHash` 保护完整原始 payload，`nonSensitiveHash` 忽略脱敏占位符；对加密 envelope 只纳入带密钥的稳定内容指纹，不纳入随机 salt/IV/ciphertext。相同敏感内容的重复采集保持幂等，敏感内容变化仍会产生新修订。
- Dream Global Skill 文件在采集与恢复时额外校验文件字节 SHA-256 和 size；目标文件被删除或损坏后，预览会重新报告 `would-change`，恢复会重新上传正确内容。
- 任何 snapshot hash 不匹配都在调用 adapter 写入前终止。
- 未跟踪本地差异不会自动覆盖。
- 未知 snapshot/schema/adapter/plugin 数据版本不覆盖。
- 不提供未确认的“覆盖全部设置”。
- 酒馆助手正常自动/手动采集检测到脚本集合相对已有完整快照缩水时都会返回 `deferred`，避免设备初始化中的半成品污染完整快照；脚本删除目前不作为跨设备同步操作传播。
- 酒馆助手恢复必须通过公共脚本 API 更新内部权威 store；接口未就绪时只返回等待状态，不直接写底层 `extension_settings`。
- 酒馆助手恢复采用增量合并，不删除目标设备独有脚本；已知数据库/API/梦境创客脚本支持别名匹配，无法唯一判定的逻辑目标进入硬冲突。

## 诊断导出

诊断文件/可复制日志只含 adapter 状态、版本、时间、哈希和结构性探针。酒馆助手只暴露脚本树计数/公开已知 ID 覆盖信息；Dream 只暴露 Global Skill 文件数量和总字节等统计，不含文件名、文件正文、snapshot payload、Provider、工作流正文或脚本正文。错误文本会再次清理 credential-like 字符串和 URL，未知探针字段不会直接导出。

## 已知限制

- 字段名脱敏无法证明任意第三方结构中不存在语义隐蔽的凭据；需要跨设备搬运任意脚本正文/工作流/文件资产时因此只允许走显式加密模式。
- Global Skill 可以包含二进制资源；加密快照会用 base64 携带这些字节，因此大型 Skill 包会显著增大 Extension Store 快照和 TT-Sync 流量。本项目不截断文件；源插件自身的文件大小限制仍然生效。
- 为避免误删共享文件，Dream Global Skill 成功换版后可能留下未再引用的旧 `/user/files/` 物理文件；这是磁盘空间泄漏风险，不是隐私扩大，后续可以在有可靠引用计数后再做清理。
- 所有设备上保存的同步口令均丢失后无法恢复已有加密快照；Bridge 不提供口令找回。
- st-chatu8 IndexedDB 只访问 `chatu8_gallery` v6 的 `tags` store，并仅处理 index `fileName == "manual"` 的用户手工标签；不会创建缺失数据库，不复制图片、词表或其他记录。
- 真实跨物理设备同步仍依赖用户配置的 TT-Sync 数据集和网络/本地同步链路。
