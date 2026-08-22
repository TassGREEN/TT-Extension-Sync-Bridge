# 验收证据

更新时间：2026-08-22。这里区分“已由当前状态证明”和“仍需真实 TT/第二设备证明”，不把单元测试替代成实机结论。

| 要求 | 当前状态 | 权威证据 |
| --- | --- | --- |
| 独立可安装扩展 | 已证明 | `manifest.json`、入口、CSS 和源码已复制到当前 TT `data/extensions/third-party/TT-Extension-Sync-Bridge`，安装目录与项目文件哈希一致；TT 重启后用户从真实设置 UI 执行“立即采集”成功 |
| Extension Store 为唯一同步载体 | 已证明 | `ExtensionStoreSnapshotStore` 只调用 `window.__TAURITAVERN__.api.extension.store`；五份真实 adapter 快照均写入 `_tauritavern/extension-store/tt-extension-sync-bridge/kv/snapshots`，推送后的服务端副本逐文件大小与 SHA-256 完全一致 |
| 五个 adapter | 已证明实现 | 酒馆助手脚本、数据库、API 管理器、梦境创客、st-chatu8 均有独立 capture/preview/restore/validate；68 项测试通过 |
| 数据库真实路径 | 已证明 | 实机 schema 确认两层路径 `extension_settings.__userscripts.shujuku_v104__userscript_settings_v1`；真实只读 capture/hash 验证通过 |
| st-chatu8 版本与 IndexedDB 边界 | 已证明 | 仅接受 2.8.x / `chatu8_gallery` v6；真实 WebView 采集确认 DB 可访问且当前手动标签为 0 条；只同步 `tags.fileName == "manual"`，单事务替换并保留其他记录；缺失 DB 不创建而延迟到插件初始化后重试 |
| 酒馆助手稳定 ID | 已证明 | 只采集三个固定 ID；本机真实脚本 capture/hash 通过；同名异 ID 测试为硬冲突 |
| 敏感数据默认排除 | 已证明到真实快照层 | 旧版五份真实 Extension Store 快照的 `sensitiveDataIncluded` 均为 `false`，凭据形态命中均为 0；API 管理器真实 localStorage 采集得到 6 项并产生 9 个脱敏占位符 |
| 梦境创客 Provider 加密同步 | 自动化已证明，实机待验证 | AES-GCM/PBKDF2 envelope、明文/口令不落快照、稳定带密钥指纹、重复采集幂等、缺/错口令零写入、正确口令空设备恢复、禁止加密快照降级覆盖均有测试；还需 TT 实机重新采集与第二设备恢复 |
| 梦境创客会话索引指针修复 | 自动化已证明，实机待触发 | 仅对 v0.1.0 特征（完整 binding ID/revision/size/SHA-256、只缺 URL）按固定命名规则补回 URL；不读取索引或会话文件；未知不完整记录不处理 |
| 手机端脚本部分初始化 | 自动化已证明，手机待复测 | controller 公共接口复现旧版 `failed`；现改为 `deferred`，旧完整快照 content hash/revision 保持不变，部分 payload 不发布；现有部分与快照一致时自动补齐，不同时保持冲突 |
| 本机记住加密口令 | 自动化已证明，实机待复测 | 口令与开关可跨重载保留并可清除；仅写设备 localStorage，不进入 Extension Store；同源脚本可访问的边界已写入 UI/安全文档 |
| 手机可复制诊断 | 自动化已证明，手机待复测 | 实时探针只报告版本、结构计数和固定目标 ID found/missing；诊断固定白名单丢弃未知字段，不含 payload/正文；UI 提供剪贴板与长按文本框双路径 |
| 酒馆助手晚初始化覆盖 | 诊断证据确认，修复待手机复测 | 手机日志显示完整快照已应用后约 2.6 秒，API 管理器与梦境创客脚本 ID 再次消失；manifest 契约现要求 Bridge `loading_order > 100`，当前为 110 |
| 不读取聊天/摘要/metadata | 已证明到源码边界 | 浏览器入口不导入聊天 API；host 只暴露目标 `extension_settings`、指定 localStorage、manifest 版本与 Extension Store；诊断不含 payload |
| 完整性、版本、迁移与冲突 | 已证明 | `contentHash` 校验完整 payload；`nonSensitiveHash` 用于跨设备一致性；未知 schema/未来 adapter/不支持插件版本拒绝；旧 adapter 版本无显式迁移即拒绝 |
| 幂等与缺失插件 | 已证明 | 单 adapter 和完整五-adapter A→B 模拟测试均通过；重复恢复全部 `noop`，脚本数量保持 3；缺失目标返回 `missing-target` |
| UI 要求 | 部分实机证明 | 用户已从旧版真实设置 UI 成功执行“立即采集”；当前源码包含总开关、各 adapter、手动/自动采集、会话内加密口令、预览、确认恢复、状态/时间/双 hash/来源设备、脱敏诊断；新版口令流程待实机验收 |
| 物理设备 A→B→A | A→服务端已证明 | 设备 A 已生成并推送五份真实快照，服务端逐文件 SHA-256 相同；仍需第二设备下载/恢复并比较 `nonSensitiveHash`，再回传 A 完成闭环 |
| 启用/禁用/卸载 | 未证明 | 依赖当前 TT 重新发现扩展后执行 UI 验收；扩展没有删除或 cleanup hook，卸载不会主动删除目标数据 |
| 文档 | 已证明 | `README.md`、`SUPPORT_MATRIX.md`、`SECURITY.md`、`MANUAL_E2E.md` |

## 当前自动化结果

```text
tests 68
pass 68
fail 0
```

完整集成测试覆盖：设备 A 同时采集五个 adapter，设备 B 按“脚本→数据库/API/梦境→st-chatu8”顺序恢复，注入 B 本地凭据，再次恢复全部 `noop`，重新采集全部 `unchanged`，五个 `nonSensitiveHash` 与 A 一致。

## 实机只读 capture 结果

| Adapter | 结果 | Payload bytes | 脱敏占位符 | 凭据形态命中 |
| --- | --- | ---: | ---: | ---: |
| 酒馆助手三个脚本 | verified | 648404 | 0 | 0 |
| 蚀心入魔·数据库 | verified | 164019 | 1 | 0 |
| 梦境创客 | verified | 4812 | 14 | 0 |
| st-chatu8 settings 部分 | verified | 555656 | 46 | 0 |

st-chatu8 manual-tags IndexedDB 支持是在上述早期只读采集后补入的；后续真实 Extension Store 采集已确认 WebView DB 读取成功，证据见下节。

上述只读审计未写入 Extension Store，也未输出 payload 或任何凭据值。

## 实机 Extension Store 与推送结果

2026-08-22 TT 重启后，用户从 Bridge 设置 UI 执行“立即采集”。五份快照的 schema、adapter 版本、完整 payload hash 和非敏感 hash 均通过验证；随后通过 TT-Sync 推送至 `A:\Game\TauriTavern\TT-Sync-Store`，服务端副本与本机逐字节一致。

| Adapter | Bytes | 脱敏占位符 | 凭据形态命中 | 本机/服务端 SHA-256 |
| --- | ---: | ---: | ---: | --- |
| API 管理器 2.0.3 | 8490 | 9 | 0 | `ADFB61AB59F4A325FF8B610F3BBC6DBAA881BB9323C197B2547BB9B9519A6665` |
| 蚀心入魔·数据库 | 164534 | 1 | 0 | `8887C9333FAC3C8E5DECACF92EB8C2AA4ABF0654F4C8AB37F04A25B1C81C67E6` |
| 梦境创客 | 7563 | 14 | 0 | `FA3A9B640C94FDD224BFC21820B3A3742C93088EF3A18262E8F530F1FEC7FD97` |
| st-chatu8 | 640739 | 46 | 0 | `28C6D00BDF0935315C8878081B2DFD84BEF9BC09487267E84EF580F3FAEF524A` |
| 酒馆助手三个脚本 | 650008 | 0 | 0 | `2D9B9388875A091354504B05B3363DC0D65BB4F193A070931A1611E51FF3B656` |

st-chatu8 的真实快照标记 `manualTags.captured = true`，说明 WebView IndexedDB 读取成功；本机当前手动标签为 0 条。整个验证过程只输出计数、状态和哈希，未输出 payload 或凭据值。
