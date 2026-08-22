# 支持矩阵

| Adapter | 来源 | 会同步 | 明确排除 | 版本策略 |
| --- | --- | --- | --- | --- |
| 酒馆助手全局脚本 | `extension_settings.tavern_helper.script.scripts` | 三个稳定 ID 的完整脚本记录 | 其他脚本；检测到疑似内嵌凭据时整项拒绝采集 | 酒馆助手 4.x；同名异 ID 为硬冲突 |
| 蚀心入魔·数据库 | `extension_settings.__userscripts.shujuku_v104__userscript_settings_v1` | global meta、默认 profile settings/template、template presets 等用户配置 | `shujuku_v104_windowStates` | adapter payload v1；未知版本拒绝 |
| API 管理器 2.0.3 | localStorage | `api_configs_manager`、`api_configs_categories`、`api_configs_category_switch_indexes` 的非敏感部分 | collapsed categories、sync metadata、debug modal；Key、Token、URL、账号等敏感字段 | adapter payload v1；JSON 损坏时拒绝采集/恢复 |
| 梦境创客 | `extension_settings.dream-card-agent` | Provider/Agent、技能、角色存储、文件和工作区中的非敏感用户数据 | `floatingButtonOffset`、`syncRevision`、凭据字段 | 插件数据版本 4；其他版本拒绝 |
| st-chatu8 | `extension_settings.st-chatu8`；IndexedDB `chatu8_gallery/tags` | 经白名单排除与敏感字段脱敏后的标准设置；`fileName="manual"` 的用户手工标签 | 缓存、日志、worker/队列、测试输出、浮动按钮设备位置、图片/视频路径、已安装词表和图片数据库等 | 仅已审计 2.8.x / DB v6；其他版本拒绝 |

## 酒馆助手脚本 ID

| 脚本 | 稳定 ID |
| --- | --- |
| 蚀心入魔·数据库 | `8e1213cb-732a-444b-8a80-631e1cf614b5` |
| API 管理器 | `9dce28ae-a88e-45c6-a211-f5980602de51` |
| 梦境创客 | `41179c00-7593-4cf5-b32b-4d6bb3a6b0c2` |

## st-chatu8 IndexedDB

第一版只同步源码已确认属于用户创建数据的 manual tags，不做全库复制：

| Database | Version | Stores | 原因 |
| --- | ---: | --- | --- |
| `chatu8_gallery` | 6 | `tags` | 仅同步 index `fileName == "manual"` 的记录，以 `name` 为稳定身份；单事务替换且保留其他 `fileName` 的记录 |
| `chatu8_gallery` | 6 | `tupianhuancun`, `vocabularies`, `groups`, `subgroups`，以及非 manual `tags` | 图片元数据、已安装/可重建词表及派生索引，不同步 |
| `chatu8_config_images` | 2 | `config_images` | 配置图片及 SD/ComfyUI 缓存，不属于第一版设置同步范围 |

## 快照和迁移

快照 envelope schema 为 v1。`contentHash` 校验完整 payload，`nonSensitiveHash` 在移除脱敏占位符后计算并用于往返一致性判断。adapter 只接受当前版本或显式提供迁移函数的旧版本；先验证旧快照原始 SHA-256，再执行迁移。未来版本没有明确迁移函数时一律拒绝恢复，不猜测字段含义。
