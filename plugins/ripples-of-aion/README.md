# 岁月涟漪（Ripples of Aion）

Cyrene 结构化记忆层插件：把每轮对话中值得长期记住的事实**逐条沉淀**（LLM 抽取、内容哈希去重），提供关键词 + 向量的混合检索与 LLM 精排、实体属性时间轴（新值写入自动闭合旧值的 `valid_until`）、主观热度衰减与 autoDream 空闲整合（主题簇 / 矛盾标注，只产洞察不改写原记忆），并附带可视化面板（记忆 / 图谱 / 检索台 / 状态 / 设置五页）。

- 源码仓库：<https://github.com/modusensus/Ripples-of-Aion>（112 个 vitest 用例 + CI 契约测试，契约测试直接加载本目录同源的构建产物）
- 目录内容：`manifest.json`（清单）、`index.cjs`（入口，esbuild 自包含打包、未压缩）、`panel/`（面板静态页，入口以无框窗口加载，见下文说明）

## 使用

- 安装后在插件列表**手动启用**
- 面板：插件卡片「打开」，五页导航：记忆（浏览 / 过滤 / 时间树）、图谱（实体共现力导向图）、检索台（真·混合检索调试：分数 / 来源徽章 / 精排开关）、状态（autoDream 沉淀与「立即做梦」）、设置
- AI 工具（自动注册）：`ripples-of-aion_recall`（最近回忆）、`ripples-of-aion_search`（混合检索 + 精排）、`ripples-of-aion_timeline`（实体属性时间轴）、`ripples-of-aion_forget`（软删指定记忆）

## 配置（可选，装完即用）

| 需求 | 配置项 | 默认值 |
| --- | --- | --- |
| 语义检索 | `embeddingProvider` = `openai-compatible` + 端点 / 模型 | `none`（纯关键词） |
| Embedding API Key | 宿主 secrets 键名 `embedding_api_key` | — |
| LLM 精排 | `rerankEnabled` | 开（失败自动降级原序） |
| autoDream 空闲整合 | `consolidationEnabled` | 开 |

以上均可在面板「设置」页直接编辑。

## 依赖说明（manifest.deps）

| 依赖 | 用途 |
| --- | --- |
| `llm` | 事实抽取、autoDream 整合、检索精排的文本生成 |
| `conversations` | 读取轮次消息用于抽取 |
| `secrets` | 读取 embedding API Key（只经 `ctx.deps.secrets` 存取，不落明文、不打日志） |

## 风险与数据说明

- **网络出口唯一**：仅当用户配置 `openai-compatible` embedding 后，向用户自填的端点 POST 文本做向量化；未配置时插件零网络请求。除此之外无任何外联。
- **数据边界**：全部记忆写入插件自身数据目录（`plugin-data/ripples-of-aion/`，JSONL 追加日志），不读宿主数据目录之外的任何敏感位置；卸载插件不丢记忆。
- **LLM 消耗**：抽取 / 整合 / 精排消耗宿主配置的模型额度（均有条数 / token 上限护栏，可分别关停）；所有后台路径失败仅 `log.warn` 降级，绝不阻断聊天主流程。
- **面板窗口**：`panel/` 为插件自带静态资源，入口以无框 Electron 窗口加载（`nodeIntegration` 仅用于 `ipcRenderer` 与宿主私有 IPC 通信）；记忆内容（LLM 派生数据）一律 `textContent` 渲染，不拼接 HTML。
- **事件**：仅监听宿主 `host:turn:finished`（内部只投队列不 await）；停用插件即可干净退出，无定时器 / 子进程残留。
