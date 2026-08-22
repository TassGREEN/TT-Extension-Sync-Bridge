# 安全与隐私边界

## 永不访问

- 聊天记录
- 聊天摘要
- 聊天 metadata
- 角色对话正文及类似聊天内容文件

Bridge 的浏览器入口只接触目标插件的 `extension_settings`、明确列出的 localStorage key、酒馆助手三个稳定脚本记录，以及 TT Extension Store API。

## 敏感数据

当前版本不实现敏感数据同步。API Key、Token、密码、Cookie、授权头、账号标识、Provider URL/Base URL 等按字段名脱敏；恢复时保留目标设备本地值。用户即使通过代码请求 `includeSensitive: true`，也会 fail closed。

酒馆助手脚本正文无法按普通对象字段可靠脱敏，因此若检测到典型明文 token 形态，Bridge 会拒绝采集该 adapter，并且错误中不包含实际值。

## 完整性与覆盖保护

- canonical JSON 生成两个稳定 SHA-256：`contentHash` 保护完整原始 payload，`nonSensitiveHash` 忽略脱敏占位符并用于跨设备冲突/一致性判断。这样本地凭据字段是否存在不会制造假冲突。
- 任何 hash 不匹配都在调用 adapter 写入前终止。
- 未跟踪本地差异不会自动覆盖。
- 同名异 ID 脚本不覆盖。
- 未知 snapshot/schema/adapter/plugin 数据版本不覆盖。
- 不提供未确认的“覆盖全部设置”。

## 诊断导出

诊断文件只含 adapter 状态、版本、时间和哈希，不含 snapshot payload。错误文本会再次清理 credential-like 字符串和 URL。分享诊断前仍建议人工检查。

## 已知限制

- 字段名脱敏无法证明任意第三方结构中不存在语义隐蔽的凭据。适配器因此使用保守规则，并对脚本正文增加凭据形态拦截。
- 敏感值不跨设备同步，目标设备需要自行配置。
- st-chatu8 IndexedDB 只访问 `chatu8_gallery` v6 的 `tags` store，并仅处理 index `fileName == "manual"` 的用户手工标签；不会创建缺失数据库，不复制图片、词表或其他记录。
- 真实跨物理设备同步仍依赖用户配置的 TT-Sync 数据集和网络/本地同步链路。
