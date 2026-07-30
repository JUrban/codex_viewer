## 2026-07-30 12:19Z — 增量加载的现有边界

- Unknown: 单个 session 已有的“增量加载”是在数据源层增量读取，还是仅在 API/客户端分页？
- Actions: 追踪 Codex source 的发现、文件指纹缓存、whole-file decoder、timeline normalization、items API 与客户端 load-more 链路，并核对相关测试。
- Evidence: `CodexSessionSource.refresh()` 在 rollout 指纹变化时整文件 decode/normalize；`SessionQueryService.items()` 只对已归一化 timeline 按 ordinal 分页；`useSessionReader.loadMore()` 使用 `nextAfterOrdinal` 拉取并合并下一页。
- Outcome: 当前增量能力仅是已归一化内存 timeline 的分段传输和客户端累积，不是 JSONL tail parsing。
- User decision: 需求范围仅为单个 session 内消息/事件的增量加载，不包含 session 列表分页。
- Status: resolved
- Implication: 本功能应修正分页一致性和失效域，不必引入文件 watcher、持久 offset 或增量 decoder。

## 2026-07-30 12:19Z — 全局 generation 是否是中断根因

- Unknown: 活跃 session 持续变化为何会中断所有其他 session 的增量请求？
- Actions: 追踪 source signature、catalog aggregate signature、snapshot publication、generation 校验、HTTP 409 映射及客户端 stale/restart 行为，并核对 server/client 回归。
- Evidence: 任一 rollout 指纹变化都会改变 source 和 catalog signature，使唯一 catalog generation 加一；items、tool、directive 都要求请求 generation 严格等于该全局值；客户端收到 `stale_generation` 后重新加载 detail 与第一页。
- Outcome: 中断由 catalog-wide generation 被误用为 session 内容版本直接造成；它是确定性协议行为，不是 AbortController 或 refresh 竞态。
- User decision: 一个持续更新的活跃 session 不得中断其他 session 的增量更新。
- Status: resolved
- Implication: session reader 相关 API 必须脱离 catalog generation，使用 session-scoped consistency token。

## 2026-07-30 12:19Z — 是否可以直接移除版本校验

- Unknown: ordinal 分页与 lazy detail 是否可以在不校验版本的情况下安全工作？
- Actions: 检查 item ID/ordinal 的来源以及 append、truncate、atomic replace、archive move、partial tail 和 tool pending/completed 的既有行为与测试。
- Evidence: item ID 基于物理行 ordinal；append 时旧前缀通常稳定，但 truncate/replacement/reorder 可让同 ordinal 或 ID 指向不同内容；现有测试明确支持文件替换并要求旧 generation 失效。
- Outcome: 不可直接取消校验。无关 session 的变化不应失效当前游标，但同一 session 的内容或元数据变化必须推进其 revision，让旧请求安全失败并重启。
- User decision: API 尚未发布、没有兼容负担，可按需直接修改。
- Status: resolved
- Implication: 直接重塑契约并明确区分 `catalogGeneration` 与 `sessionRevision`，不保留旧 `generation` 别名或兼容层。

## 2026-07-30 12:19Z — catalog 与 session 的版本边界

- Unknown: 全局 generation 是否应完全移除，以及 session revision 应保护哪些响应？
- Actions: 分析 list offset 对排序、搜索、facet、关系变化的一致性需求，以及 detail/items/tool/directive 对单 session 内容身份的依赖。
- Evidence: catalog 任一 session 变化都可能改变全局排序、搜索结果和 offset，因此 list 后续页仍需 catalog-wide token；detail、items、tool、directive 只读取一个已发布的 normalized session，跨 session 共用 token 会制造无关失效。聚合阶段还会改写 parent/child relationship。
- Outcome: catalog list 保留并显式命名 `catalogGeneration`；session detail、items、tool、directive 共用一个 `sessionRevision`，以最终发布的 session 视图为失效边界。
- User decision: None
- Status: accepted assumption
- Implication: 使用一个 session revision 可覆盖 timeline、lazy details、diagnostics、archive/relationship 元数据变化，避免过早拆出多个版本概念；更细拆分仅作为未来优化。

## 2026-07-30 12:29Z — 最终 session 视图 digest 的规模成本

- Unknown: 对最终聚合后的 session 视图计算 canonical digest，是否会在现有 3,000 session、100 MB+ 规模门槛下造成不可接受的 CPU 或内存开销？
- Actions: 运行现有 `npm run benchmark:scale` 记录 3,000 session、112,456,067-byte corpus 基线；再运行一次性内存原型，对 3,000 个、约 54,982,000 bytes 的 normalized message payload 计算 SHA-256 digest 和随机 revision token。原型未修改 tracked 文件。
- Evidence: 现有 cold catalog 为 474.2 ms、峰值 RSS 323,698,688 bytes；一次性 JSON 序列化原型完成 3,000 个 digest 用时 89.6 ms、RSS 增量约 70,172,672 bytes。显式流式 canonical hasher 可避免原型为 `JSON.stringify` 产生的大块临时字符串；既有 source/normalized 对象复用还允许后续按对象身份与关系输入缓存 digest。
- Outcome: digest CPU 约为当前 cold build 的 19%，不足以推翻 final-view correctness boundary；原型内存增量提示实现必须采用逐字段流式 hashing，并把性能纳入 scale benchmark。首版可全量计算以降低漏判风险，若实现后 benchmark 明显退化，再在 aggregate 层加入不影响正确性的 digest cache/dirty hint。
- User decision: None
- Status: validation gate
- Implication: 推荐 final-view canonical digest + opaque random revision；不新增 source-level revision authority。实施里程碑必须验证 cold build、no-change refresh、单-session append refresh 和 peak RSS。
