# 当前源码的工具清单

完整写作模式共有 **32 个 Scriptor 工具：31 个业务工具 + 1 个条件委派工具**。这里不包含 DSH 自带的文件、Shell、普通子代理等工具，也不包含测试专用工具。

唯一名称清单位于 `packages/bundle/src/tool-catalog.ts`：`NOVEL_TOOL_NAMES` 对应业务工厂，`NOVEL_CONDITIONAL_TOOL_NAMES` 对应条件注册，`NOVEL_PRODUCTION_TOOL_NAMES` 是二者合并后的完整清单。

| 环境 | Scriptor 工具数 |
| --- | --- |
| 写作主控，原生 `subagent` 可用 | 32 |
| 写作主控，原生 `subagent` 不可用 | 31 |
| 普通模式或 Scriptor 已卸载 | 0 |

`novel_delegate` 随原生 `subagent` 注册和撤销。五种 role 共用这一个工具，不算五个工具。模型选择、后台执行和取消沿用原生委派；普通研究仍走原生 `subagent`。只有明确角色的目标实例才获得对应写作规则与权限。

## 业务工具（31 个）

| 工具 | 用途 |
| --- | --- |
| `novel_reference_source` | 管理参考小说来源 |
| `novel_reference_analyze` | 渐进拆解参考小说 |
| `novel_reference_query` | 检索参考机制与证据 |
| `novel_reference_report` | 保存拆书报告与灵感 |
| `novel_select_book` | 选择作品 |
| `novel_create_book` | 创建作品 |
| `novel_update_contract` | 更新作品契约 |
| `novel_get_story_status` | 查询当前写作状态 |
| `novel_search_finalized` | 检索定稿 |
| `novel_index_manage` | 管理检索索引 |
| `novel_prepare_pack` | 写入定稿准备包 |
| `novel_settle_chapter` | 执行定稿沉淀 |
| `novel_new_outline_draft` | 创建章细纲草案 |
| `novel_confirm_outline` | 确认章细纲 |
| `novel_update_skeleton` | 更新故事骨架 |
| `novel_update_volume_layout` | 更新分卷布局 |
| `novel_roll_window` | 滚动近期窗口 |
| `novel_confirm_worldbook_entry` | 确认世界书条目 |
| `novel_confirm_volume_outline` | 确认卷纲 |
| `novel_assemble_materials` | 保存章节材料包 |
| `novel_apply_revision` | 应用作者给定的小修 |
| `novel_apply_revision_batch` | 批量落实改稿处置 |
| `novel_import_draft` | 导入作者稿 |
| `novel_record_review_findings` | 记录审读发现项 |
| `novel_record_proposal` | 登记修改提案 |
| `novel_resolve_proposal` | 处置修改提案 |
| `novel_apply_retcon` | 执行吃书补偿 |
| `novel_record_memory` | 保存作者或本书记忆 |
| `novel_note_pending` | 记录待补事项 |
| `novel_get_book_progress` | 查询作品进度 |
| `novel_editor_suggest` | 交回编辑器建议 |

## 条件委派工具（1 个）

| 工具 | 注册条件与用途 |
| --- | --- |
| `novel_delegate` | 写作主控的原生 `subagent` 可用时注册；按 role 派发起草、润色、改稿、审读或沉淀对账 |

业务结果卡只覆盖上述 31 个业务工具；委派结果沿用原生格式，不套用业务工具的 `ok` 结果协议。

## 数量验证

- 工具清单测试核对名称唯一、业务工厂与清单一致、本文列举完整。
- 不配置原生委派的 Loader 夹具核对业务清单，共 31 个。
- 原生委派集成测试核对完整名称集，共 32 个；停用原生委派后回到 31，恢复后回到 32，卸载 Scriptor 后为 0。
- 技能和文件打包另行核对：12 个技能、24 份参考文档、8 个脚本入口。打包文件数不代替运行时工具注册数量。
