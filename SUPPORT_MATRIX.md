# 支持矩阵

| Adapter | 来源 | 会同步 | 明确排除 / 本机保留 | 版本策略 |
| --- | --- | --- | --- | --- |
| 酒馆助手全局脚本 | 酒馆助手公共 `getScriptTrees` / `replaceScriptTrees` API | 启用加密后同步完整全局脚本树；已知数据库/API 管理器/梦境创客脚本额外支持名称别名匹配 | 非加密模式不发布任意脚本正文；恢复不删除目标设备独有脚本；自动采集异常缩水会等待 | 酒馆助手 4.x 公共 API；接口未就绪时等待；无法唯一匹配的逻辑目标为硬冲突 |
| 蚀心入魔·数据库 | `extension_settings.__userscripts.shujuku_v104__userscript_settings_v1` | global meta、默认 profile settings/template、template presets 等用户配置 | `shujuku_v104_windowStates` | adapter payload v1；未知版本拒绝 |
| API 管理器 | localStorage | 分类/切换等可移植配置；启用加密后同步完整 API config（包括 Key / URL） | collapsed categories、sync metadata、debug modal 等设备/UI 状态 | 兼容已审计的 2.x 存储形态，包括 raw array、wrapper、map、grouped-api-configs；无法唯一识别结构时 fail closed |
| 梦境创客 | `extension_settings.dream-card-agent` + Global Skill 对应 `/user/files/` | Agent、Preset、Provider 等可移植设置；启用加密后同步 Provider 敏感配置和用户自建 Global Skill 的 `SKILL.md`/资源文件，并在目标设备重建 URL | `characterStores`、`workspaceFiles`、普通 `files`/session/lease blob、`builtinSkillPackages` 缓存、`floatingButtonOffset`、`syncRevision` | 插件数据版本 4；adapter payload v4；显式迁移旧 adapter v1-v3，旧快照不搬源设备文件 URL |
| st-chatu8 | `extension_settings.st-chatu8`；IndexedDB `chatu8_gallery/tags` | 标准可移植设置；启用加密后同步凭据与 worker/workflow presets；`fileName="manual"` 的用户手工标签 | 缓存、日志、队列/运行态、浮动按钮设备位置、图片/视频路径、已安装词表和图片数据库等 | 仅已审计 2.8.x / DB v6；其他版本拒绝 |

## 酒馆助手已知逻辑脚本

这三个脚本仍保留稳定 ID/别名保护，用于重新导入后 UUID 变化时避免重复；它们不再是酒馆助手同步范围的上限。

| 脚本 | 稳定 ID |
| --- | --- |
| 蚀心入魔·数据库 | `8e1213cb-732a-444b-8a80-631e1cf614b5` |
| API 管理器 | `9dce28ae-a88e-45c6-a211-f5980602de51` |
| 梦境创客 | `41179c00-7593-4cf5-b32b-4d6bb3a6b0c2` |

## 梦境创客文件

只把 Global Skill 文件视为设置级可移植资产：

| Dream 数据 | 处理方式 | 原因 |
| --- | --- | --- |
| `globalSkills.*.url` / `globalSkills.*.files.*.url` | 不直接同步 URL；加密采集对应文件字节，目标设备重新上传后重建 URL | `/user/files/` URL 是设备本地物理引用，真正可移植的是 Skill 内容 |
| `files["global-skill:..."]` | 目标设备根据新上传文件重建 | 属于 Global Skill 的本地 registry |
| `characterStores` | 不同步 | 关联角色/会话元数据 |
| `workspaceFiles` | 不同步 | 包含持久/临时工作区、附件与 `referencedSessionIds` |
| 普通 `files`、`session:*`、`lease:*` | 不同步 | 会话/blob/运行态边界 |
| `builtinSkillPackages` | 不同步 | 可重新下载的缓存 |

## st-chatu8 IndexedDB

只同步源码已确认属于用户创建数据的 manual tags，不做全库复制：

| Database | Version | Stores | 原因 |
| --- | ---: | --- | --- |
| `chatu8_gallery` | 6 | `tags` | 仅同步 index `fileName == "manual"` 的记录，以 `name` 为稳定身份；单事务替换且保留其他 `fileName` 的记录 |
| `chatu8_gallery` | 6 | `tupianhuancun`, `vocabularies`, `groups`, `subgroups`，以及非 manual `tags` | 图片元数据、已安装/可重建词表及派生索引，不同步 |
| `chatu8_config_images` | 2 | `config_images` | 配置图片及 SD/ComfyUI 缓存，不属于设置同步范围 |

## 快照和迁移

快照 envelope schema 为 v1。`contentHash` 校验完整 payload，`nonSensitiveHash` 在移除脱敏占位符后计算；加密 envelope 只保留稳定的带密钥内容指纹参与该 hash。adapter 只接受当前版本或显式提供迁移函数的旧版本；先验证旧快照原始 SHA-256，再执行迁移。未来版本没有明确迁移函数时一律拒绝恢复，不猜测字段含义。
