# 安全与隐私边界

## 永不访问

- 聊天记录
- 聊天摘要
- 聊天 metadata
- 角色对话正文及类似聊天内容文件

Bridge 的浏览器入口只接触目标插件的 `extension_settings`、明确列出的 localStorage key、酒馆助手三个稳定脚本记录，以及 TT Extension Store API。

v0.1.0 遗留的梦境创客索引 URL 修复只根据设置内已有 binding ID 和源码固定命名规则重建路径；不下载、解析或输出索引/会话文件内容。

## 敏感数据

默认情况下，API Key、Token、密码、Cookie、授权头、账号标识、Provider URL/Base URL 等按字段名脱敏；恢复时保留目标设备本地值。

唯一可选的敏感同步范围是梦境创客完整 `providers` 数组，其中包含 Provider Base URL、创客自身已加密的 `secrets`，以及模型级 `requestSecrets`。Bridge 使用 PBKDF2-SHA-256（310,000 次）从用户口令派生 256-bit AES-GCM 密钥，随机 16-byte salt、12-byte IV，并用 adapter/context 作为 AAD。快照中只保存加密 envelope 和带密钥的内容指纹，不保存明文或口令。

按用户选择，口令保存在设备本地 `tt_extension_sync_bridge.sensitive_passphrase.v1` localStorage key 中，不进入 Extension Store 或 TT 同步。WebView 没有供该扩展使用的系统钥匙串边界，因此该值不是操作系统级安全存储：同一来源内运行的其他酒馆脚本理论上可访问它。UI 提供“忘记本机口令”立即清除；清除不会删除同步快照。

其他 adapter 即使通过代码请求 `includeSensitive: true` 仍 fail closed。已有加密快照不能由非敏感采集降级覆盖。缺少或错误口令时，恢复在任何目标设置写入前终止。

酒馆助手脚本正文无法按普通对象字段可靠脱敏，因此若检测到典型明文 token 形态，Bridge 会拒绝采集该 adapter，并且错误中不包含实际值。

## 完整性与覆盖保护

- canonical JSON 生成两个稳定 SHA-256：`contentHash` 保护完整原始 payload，`nonSensitiveHash` 忽略脱敏占位符；对加密 envelope 只纳入带密钥的稳定内容指纹，不纳入随机 salt/IV/ciphertext。这样相同敏感内容的重复采集保持幂等，敏感内容变化仍会产生新修订。
- 任何 hash 不匹配都在调用 adapter 写入前终止。
- 未跟踪本地差异不会自动覆盖。
- 同名异 ID 脚本不覆盖。
- 未知 snapshot/schema/adapter/plugin 数据版本不覆盖。
- 不提供未确认的“覆盖全部设置”。
- 酒馆助手三个目标脚本未全部初始化时返回 `deferred`，不发布部分 payload，也不覆盖已有完整快照。仅当已存在的部分目标脚本逐项合并后完全不变时，自动恢复才会补齐缺失脚本；任何现有内容差异仍进入冲突流程。

## 诊断导出

诊断文件只含 adapter 状态、版本、时间和哈希，不含 snapshot payload。错误文本会再次清理 credential-like 字符串和 URL。分享诊断前仍建议人工检查。

## 已知限制

- 字段名脱敏无法证明任意第三方结构中不存在语义隐蔽的凭据。适配器因此使用保守规则，并对脚本正文增加凭据形态拦截。
- 除梦境创客 Provider 的显式口令加密模式外，敏感值不跨设备同步，目标设备需要自行配置。
- 所有设备上保存的同步口令均丢失后无法恢复已有加密快照；Bridge 不提供口令找回。
- st-chatu8 IndexedDB 只访问 `chatu8_gallery` v6 的 `tags` store，并仅处理 index `fileName == "manual"` 的用户手工标签；不会创建缺失数据库，不复制图片、词表或其他记录。
- 真实跨物理设备同步仍依赖用户配置的 TT-Sync 数据集和网络/本地同步链路。
