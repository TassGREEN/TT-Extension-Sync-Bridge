# 手工端到端验证

全程不要打开、导出或检查聊天、摘要、聊天 metadata、梦境创客会话索引或 session blob。

## 准备

1. 两台设备均安装相同版本 TT、Bridge 0.2.14 和目标插件；酒馆助手使用 4.x 公共脚本 API，st-chatu8 使用已审计的 2.8.x。
2. TT 同步数据集启用 `extensions.store`。
3. 两端准备同一条至少 8 位的**测试同步口令**；不要在日志或截图中记录真实凭据值。
4. 设备 A 准备可辨认但不敏感的测试内容：
   - 酒馆助手：除数据库/API 管理器/梦境创客外，再放一个普通全局测试脚本；
   - API 管理器：准备一个测试配置；
   - 梦境创客：准备一个用户自建 Global Skill，至少包含 `SKILL.md` 和一个小资源文件；
   - st-chatu8：准备一个测试 workflow/preset 和一个 manual tag（如当前环境方便）；
   - 数据库：准备一个非敏感偏好。
5. 设备 B 保留至少一个**仅 B 存在**的酒馆助手测试脚本，并保留一个只属于 B 的 Dream session/workspace 引用，用来验证“目标本机数据不会被源设备清掉/搬运”。
6. 先备份当前 TT 用户数据目录。

## A → B：完整加密同步

1. A 打开 Bridge，启用“加密同步敏感配置”，输入测试口令。
2. 点击“立即采集”。确认五个 adapter 没有 `failed`；如 Tavern Helper 显示 `global-script-set-shrank` / 等待初始化，先确认源设备脚本已全部加载，不要强行覆盖快照。
3. 复制诊断日志，只检查版本、状态、脚本数量/ID、hash、Dream Global Skill 文件统计；不要输出 snapshot payload/ciphertext。
4. A 执行 TT 上传同步。
5. B 执行 TT 下载同步并重新加载 TT。
6. B 尚未输入口令时，相关加密 adapter 预览应显示 `locked`，目标设置和文件不应改变。
7. B 输入错误口令时应解密失败，目标设置和 `/user/files/` 不应产生新写入。
8. B 输入正确口令，执行“恢复前预览”。确认没有未知版本、hash 错误或无法唯一判定的脚本冲突。
9. 执行恢复并刷新/重启 TT（首次新增酒馆助手脚本后尤其建议重启）。

## B 上逐项验证

### 酒馆助手

- A 的普通全局测试脚本已经出现在 B，正文一致。
- 数据库/API 管理器/梦境创客脚本没有因为 UUID 不同被重复创建。
- B 原本独有的全局测试脚本仍存在；恢复是增量合并，不传播删除。
- 再次恢复同一快照返回 `noop`，脚本数量不继续增加。

### API 管理器

- 测试配置的模型/分类等可移植数据一致。
- 开启加密同步时，Key / URL 等敏感配置可在 B 正常使用。
- 重复恢复不改变存储 dialect，也不产生重复配置。

### 梦境创客

- Agent、Preset、Provider 等可移植设置恢复。
- 用户 Global Skill 可以在 B 正常打开，`SKILL.md` 与资源内容一致。
- 检查 Dream 设置中的 Global Skill URL：应指向 B 本机重新建立的 `/user/files/...`，不能要求与 A 的物理 URL 相同。
- B 原有 `characterStores`、`workspaceFiles`、普通 `files`/session/lease 索引、`builtinSkillPackages` 缓存保持 B 本地值；A 的 session/workspace 引用不能出现在 B。
- 删除 B 上刚恢复的某个 Global Skill 文件后，仅做恢复预览：应重新显示 `would-change`；再恢复应重新上传并修复文件。
- 再次恢复完整健康状态时返回 `noop`。

### st-chatu8

- 标准可移植设置一致。
- 开启加密后，测试凭据和 worker/workflow preset 恢复。
- 恢复后无需依赖再次手工改设置才能让运行态看到新配置；刷新页面后仍一致。
- manual tag 恢复，同时已安装词表、图片/视频缓存和非 manual tag 未被替换。

### 数据库

- 用户数据库配置恢复。
- 窗口位置等设备 UI 状态不被 A 覆盖。

## 快照缩水保护

1. 在 A 已经有一份完整 Tavern Helper 加密快照后，临时让酒馆助手只暴露其中一部分脚本（可用隔离测试环境/fixture，不要破坏真实脚本）。
2. 无论自动采集还是点击“立即采集”，Bridge 都应返回 `deferred` / `global-script-set-shrank`，已有完整快照的 revision/hash 保持不变。
3. 恢复完整脚本集合后重新采集，正常变化才可发布。

注意：当前酒馆助手跨设备策略是**增量合并**，脚本删除不会传播到另一台设备。

## B → A 往返

1. B 修改一个明确可移植的测试偏好/脚本内容，并立即采集。
2. B 上传，A 下载并重新加载。
3. A 预览并恢复。
4. A 再次采集；比较双方每个 adapter 的 `nonSensitiveHash`，应在内容一致后收敛。
5. 重复恢复确认 `noop`，无重复脚本、配置或 Global Skill 文件写入。

## 失败路径

- 临时禁用一个目标插件：Bridge 应保留快照并报告 `missing-target`。
- Tavern Helper 公共脚本 API 尚未就绪：应 `deferred`，不直接改底层 `extension_settings`。
- 制造无法唯一判定的同名脚本/文件夹：应报告硬冲突且不写入。
- 使用不受支持的插件版本：应报告 `incompatible`。
- 修改测试快照副本但不更新 hash：应在任何设置/文件写入前拒绝。
- 清除目标设备同步口令：加密快照仍保留，但预览应重新显示 `locked`。
- 已有加密快照时关闭加密开关再采集：应拒绝降级覆盖。
- 构造 `/user/files/../...`、编码路径穿越或带目录的上传名：Bridge 文件 host 应拒绝。

不要通过编辑真实同步快照做破坏性测试；使用隔离副本或自动化测试 fixture。
