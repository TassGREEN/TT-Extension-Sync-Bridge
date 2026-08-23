# 验收证据

更新时间：2026-08-24。这里严格区分“源码/自动化已经证明”和“仍需真实 TT 双设备证明”，不把单元测试替代成实机结论。

## 0.2.14 当前结论

| 要求 | 当前状态 | 证据 / 仍需验证 |
| --- | --- | --- |
| 独立可安装扩展 | 已有实机证据 | 旧版 Bridge 已在真实 TauriTavern 设置页运行、采集并写入 Extension Store；0.2.14 保持相同入口/manifest 结构，版本号统一为 0.2.14 |
| Extension Store 为同步载体 | 已有实机证据 | 旧版五 adapter 快照曾通过 TT-Sync A→服务端逐文件校验；0.2.14 仍由 `ExtensionStoreSnapshotStore` 读写 `_tauritavern/extension-store/tt-extension-sync-bridge/snapshots/*.json` |
| 五个 adapter | 自动化已证明 | 酒馆助手、数据库、API 管理器、梦境创客、st-chatu8 均进入完整 A→B 模拟往返；最终 CI 以 PR 最新测试结果为准 |
| API 管理器 2.x 存储兼容 | 自动化已证明，双设备已有正向现象 | 支持 raw array、wrapper、唯一嵌套数组、object map、2.1.1 `grouped-api-configs`；双设备测试中 API 管理器已成功同步，0.2.14 继续保留这些修复 |
| 酒馆助手完整全局脚本 | 自动化已证明，0.2.14 双设备待复测 | 加密快照包含完整全局脚本树；公开 payload 无正文；按 UUID/逻辑别名增量合并，目标独有脚本保留；额外全局脚本不再局限于三个固定目标 |
| 酒馆助手缩水保护 | 自动化已证明 | adapter 有 `captureRegression`，controller 默认阻止较小脚本集合覆盖已有完整快照；正常自动/手动 UI 均不暴露绕过开关；脚本删除当前不跨设备传播 |
| Tavern Helper 权威 store 写入 | 源码与自动化已证明，双设备待复测 | 恢复通过 `getScriptTrees` / `replaceScriptTrees`，接口未就绪返回 `deferred`；此前手机端“先恢复后消失”的根因已定位到内部权威 store 覆盖 |
| 梦境创客普通可移植设置 | 自动化已证明，0.2.14 双设备待复测 | Agent、Preset、Provider 等可移植设置进入 v4 payload；旧 v1-v3 adapter 有显式迁移，未知版本拒绝 |
| 梦境创客 Global Skill 真文件 | 上游源码 + 自动化已证明，双设备待复测 | 已对照梦境创客 `GlobalSkillStore`：registry key、`SKILL.md`、资源索引与 `/user/files/` 写法一致；Bridge 加密打包字节，目标重新上传/重建 URL；删除或损坏目标文件后可检测并修复 |
| 梦境创客会话边界 | 自动化已证明 | `characterStores`、`workspaceFiles`、普通 `files`/session/lease blob、`builtinSkillPackages` 始终保留目标本地；旧快照也不能把源设备 `/user/files/...` 会话引用灌到目标 |
| Dream Global Skill 上游限制 | 源码已确认 | 上游创客保存 Global Skill 时限制单资源 20MB、单 Skill 资源总计 100MB、文件+目录 500 项；Bridge 不枚举目录，只处理上游 `globalSkills` 已引用资产并逐文件校验 size/SHA-256 |
| st-chatu8 workflow / 敏感设置 | 自动化已证明，0.2.14 双设备待复测 | worker/workflow 正文只进入加密 envelope；恢复后触发插件运行态 refresh；manual tags 仍只处理 `fileName="manual"` |
| st-chatu8 IndexedDB 边界 | 已有源码/实机读取证据 | 只接受已审计 2.8.x / `chatu8_gallery` v6；只替换 manual tags，保留安装词表、图片与非 manual 数据；缺失 DB 不创建 |
| 数据库 adapter | 已有源码/实机证据 | 实机路径 `extension_settings.__userscripts.shujuku_v104__userscript_settings_v1` 已确认；窗口状态明确排除 |
| 敏感内容不明文进公开快照 | 自动化已证明 | Tavern Helper 脚本正文、API config Key/URL、Dream Provider/Global Skill 字节、st-chatu8 workflow/凭据均只在显式加密模式进入 AES-GCM envelope；测试检查序列化快照不含测试明文 |
| 加密与降级保护 | 自动化已证明 | PBKDF2-SHA-256 + AES-GCM；缺口令 `locked`、错口令零写入；已有加密快照拒绝非敏感降级覆盖；口令只在本机 Bridge localStorage |
| `/user/files/` 文件 host 边界 | 自动化已证明 | 只允许 `/user/files/<单一安全文件名>`；拒绝 `..`、编码路径穿越、目录分隔符、query/hash 和不安全 upload 返回路径；不提供目录枚举 |
| 不读取聊天/摘要/metadata | 源码边界已证明 | Bridge 不导入聊天 API；Dream 明确排除会话索引/workspace/session blob；诊断不含 snapshot payload/正文 |
| 完整性、版本、迁移与冲突 | 自动化已证明 | `contentHash` 校验原始 payload，`nonSensitiveHash` 处理跨设备脱敏一致性；未知 schema/adapter/plugin 版本拒绝；硬冲突不允许强制覆盖 |
| 幂等 | 自动化已证明 | 全 adapter 模拟 A→B 后重复恢复收敛到 `noop`；Dream Global Skill 健康时不重复上传文件，Tavern Helper 不重复建脚本 |
| UI | 源码已完成，0.2.14 实机待复测 | 同步范围和同步详情为抽屉；外层显示最近更新时间；诊断为抽屉式“复制诊断日志”；不再单独导出脱敏文件 |
| 0.2.14 物理设备 A→B→A | **待复测** | 旧版双设备测试成功暴露了三个缺口：Dream/st 数据未完整恢复、酒馆助手额外脚本未同步；0.2.14 正是针对这些缺口扩展契约，需按 `MANUAL_E2E.md` 再做一次完整闭环 |

## 已确认的历史实机证据

2026-08-22 至 2026-08-23 的旧版实机调试已经确认：

- Bridge 能在真实 TT 设置页运行并写入 Extension Store；
- TT-Sync 能把 Bridge 快照搬到另一设备/服务端；
- API 管理器经过存储格式修复后能跨设备恢复；
- Tavern Helper 公共 API 在真实 4.x 环境可用；
- 旧实现对 Dream/st/额外全局脚本的覆盖不足，双设备测试可稳定复现，因此不能把旧版“设置快照已同步”当成 0.2.14 新契约的实机完成证据。

这些失败不是被删掉的历史，而是 0.2.14 扩大同步边界的直接依据。

## 当前自动化覆盖

测试集覆盖至少以下路径：

- snapshot 稳定序列化、完整/非敏感 hash、篡改拒绝和 adapter 迁移；
- controller 未跟踪本地差异、`noop` 基线、依赖未就绪、加密锁定和 capture regression；
- Tavern Helper 完整加密脚本树、任意额外全局脚本、UUID/别名合并、目标独有脚本保留、重复恢复、缩水保护和公共 API 写入；
- API 管理器多种 2.x 存储 dialect、敏感/非敏感恢复和 JSON 兼容；
- Dream v4 可移植设置、旧快照本地边界、Global Skill 文件加密打包、目标重建、损坏修复和 session 数据不越界；
- st-chatu8 加密 workflow/凭据、运行态 refresh、manual tags IndexedDB 事务；
- 浏览器 host `/user/files/` 下载/上传/删除以及路径穿越拒绝；
- 五 adapter 加密 A→B 总往返、重复恢复 `noop`、重新采集 `unchanged`。

最终自动化结果以 PR #12 最后一次 `Temporary Bridge Tests` 成功运行作为发布前证据，不在本文硬编码容易过时的测试数量。

## 发布前仍需的真实闭环

按 `MANUAL_E2E.md` 在两台物理设备验证：

1. A 加密采集完整 Tavern Helper + API + Dream Global Skill + st workflow；
2. TT-Sync A→B；
3. B 正确口令恢复，验证 Global Skill 真文件和额外全局脚本可直接使用；
4. 验证 B 独有脚本、Dream session/workspace 数据未被覆盖；
5. 重复恢复为 `noop`；
6. B 修改可移植内容后反向采集，完成 B→A；
7. 最终双方 `nonSensitiveHash` 在相同可移植内容上收敛。

在这一步完成前，应称 0.2.14 为“自动化验证完成、物理双设备待最终验收”，而不是“实机完全证明”。
