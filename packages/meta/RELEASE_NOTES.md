# 完整版 8.3.2

- 主插件：`@linfengqaqtat/dsh-scriptor@8.3.2`。
- 检索增强：`@linfengqaqtat/dsh-scriptor-retrieval@8.3.2`。
- 配套 DSH `0.2.1-rc.3`，Node ^22.19.0 或 ^24.0.0，源码/CLI 环境使用 pnpm 11.27.1。
- 仅更新宿主兼容声明和依赖，保留 8.3.1 的功能与修复，没有新增写作、检索或桌宠功能。
- 先备份并升级 DSH，再更新已使用的组件并重启，无需迁移作品。仍使用 DSH 0.2.1-rc.2 时保留 Scriptor 8.3.1；旧 DSH 0.2.0-rc.2 用户继续固定 Scriptor 8.2.2。
- 四包同批为 8.3.2；检索和桌宠同步兼容版本，桌宠不包含在 full 中。
- 嵌入、场景和重排默认关闭。组合包与分别安装主包/提供方二选一；详见 [升级指南](https://github.com/lingfengQAQ/webnovel-writer/blob/v8/docs/user/upgrade-backup.md)。
- 可视化重设计不包含在本版。
