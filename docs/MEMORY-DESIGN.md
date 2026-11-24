# 记忆分层方案（可共享 / 不可共享）

> 状态：**方案待用户拍板，未动代码**（2026-11-24 晚）
> 相关：`docs/ARCHITECTURE.md`（三端分工）、AI 分享（`ai_share` 表）

## 1. 为什么必须做

现在 AI 只有一份记忆，主人和访客共用：

- 访客可能从对话里套出主人的私事（隐私泄漏）
- 访客聊出来的事会混进主人的记忆（污染）
- 主人已经把 AI 分享出去了（`ai_share.enabled = 1`，默认 20 条/天/人），这个洞是真实存在的

## 2. 安全不变式（做出来的东西必须满足）

1. **访客永远拿不到私人记忆**——不是"提示词里说别说"，而是上下文里根本没有
2. **访客的记忆不污染主人记忆**——访客说过的事，主人侧不可见（除非访客自己说给主人听）
3. **主人看不到访客的对话内容**（已有约定，继续成立）
4. **关掉分享 = 立刻失效**（已有）
5. **配额仍然生效**（已有）

## 3. 现状盘点

| 项 | 现状 |
|---|---|
| 记忆存储 | DSH 的 nmem 插件，单脑：`~/.dsh/nmem/brain-export.json`（神经元/突触/纤维，`metadata` 自由字段） |
| Nest 的角色 | 只**读**导出：`/api/ai/:id/memory` 给主人看规模与最近 8 条；不做读写 |
| 分享规矩 | ✅ 开关 / 每日配额 / 主人盲区 / 访客名单；🚧 `allow_plugins` 字段有了但执行层没接 |
| 记忆分层 | ❌ 完全没有 |

关键限制：**记忆的检索和写入都发生在 DSH 内部**，Nest 没法在 nmem 查询时加过滤条件。所以方案必须解决"在哪一层做隔离"。

## 4. 四套候选方案

### A. nmem 原生 scope（最干净，但要改记忆插件）
- nmem 的 neuron/fiber `metadata` 加 `scope: public|private|guest:<uid>`
- 记忆检索时按当前会话的 scope 过滤；写入时打上当前 scope
- 优点：一处改动，所有入口（DSH 桌面、Nest、未来别的客户端）统一生效
- 缺点：要动 nmem 插件本体（Python/venv 里），升级 DSH 时可能被覆盖；我们只在手机容器里用过它，没维护过源码

### B. Nest 侧「记忆闸门」（MVP，推荐先做）
- 记忆仍全部留在 nmem（主人视角不变）
- Nest 另建一张小表 `memory_notes`：主人手动（或 AI 建议后主人确认）把"可以公开的事"摘录成 note，标 `public`
- 桥接时：
  - **主人会话**：照旧，用 nmem 全量
  - **访客会话**：不给 nmem，改为注入「人设 + 公共 notes + 该访客自己的 notes」
- 优点：不改 DSH/nmem；隐私边界在 Nest 侧，可测可审计；默认全私有，天然安全
- 缺点：公共记忆要主人维护（可让 AI 主动建议"这句要不要公开"）；主人会话里的新记忆不会自动进公共层

### C. 双 DSH 实例（隔离最彻底，最重）
- 主人用「全脑 DSH」，访客用「公共脑 DSH」（独立 profile / 独立 nmem 目录）
- 优点：物理隔离，绝无串味
- 缺点：手机要跑两个 DSH（内存、电量、端口、桥接都要翻倍），手机场景不现实

### D. 推荐路线：B 先上，A 作长期
```
第一步（MVP，1~2 天量级）：
  Nest 表 memory_notes + 资料页「记忆」管理 + 访客会话注入公共/访客层
第二步（增强）：
  访客会话里 AI 想记东西 → 只写进「访客自己的 notes」，不碰 nmem
  主人可一键把 nmem 里的某条「提升为公共」（AI 建议 + 主人点确认）
第三步（长期，可选）：
  若 nmem 支持自定义 scope 查询，再迁到 A，把过滤下推到记忆层
```

## 5. 数据模型草案（B 方案）

```sql
-- 主人在 Nest 里维护的"记忆卡片"
CREATE TABLE IF NOT EXISTS memory_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ai_id INTEGER NOT NULL,              -- 属于哪个 AI
  scope TEXT NOT NULL,                 -- 'public' | 'private' | 'guest'
  guest_id INTEGER,                    -- scope='guest' 时，属于哪个访客
  text TEXT NOT NULL,                  -- 一句话事实（可长）
  source_conv INTEGER,                 -- 从哪条会话摘出来的（可空）
  source_msg INTEGER,                  -- 从哪条消息摘出来（可空）
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notes_ai ON memory_notes(ai_id, scope);
```

- `public`：人设、公开喜好、愿意让访客知道的事（**访客可见**）
- `private`：主人隐私、关系、约定（**只有主人会话可见**；默认归类）
- `guest`：某个访客和 AI 聊出来的事实（**只对该 guest_id 可见**）

## 6. 桥接层改动（`bridge/nest-bridge.mjs`）

会话开始时根据 `viewer_kind + viewer_id` 决定上下文：

| 会话类型 | 记忆来源 |
|---|---|
| 主人 × 自己的 AI | nmem 全量（现状不变） |
| 访客 × 别人的 AI | `persona` + `memory_notes(scope='public')` + `memory_notes(scope='guest', guest_id=我)` |
| 群聊里的 AI | 按群成员里是否含"非主人"决定：含则走公共层，否则全量（**待定**） |

落地时给 bridge 的会话启动参数加一个 `memoryScope` 字段，Nest 侧组装文本；bridge 只负责"把这段记忆拼进提示词"，不再自己判断。

## 7. 接口草案

```
GET    /api/ai/:id/memory/notes           主人：列出所有 notes（public/private/guest）
POST   /api/ai/:id/memory/notes           主人：新增 note（默认 private）
PATCH  /api/ai/:id/memory/notes/:noteId   主人：改 text / 改 scope（public ↔ private）
DELETE /api/ai/:id/memory/notes/:noteId   主人：删除
POST   /api/ai/:id/memory/suggest         可选：让 AI 从最近对话里建议"哪些适合公开"，主人逐条确认
```
- 所有接口都校验 `ai.owner_id === me.id`，访客一律 403
- `guest` 层不通过 HTTP 暴露给主人列表（避免主人读到访客内容）；只在桥接时使用

## 8. UI 草案（AI 资料页）

```
记忆
├─ 私有记忆（N 条）      ← 默认；只有你和它单独聊的时候用
│   [ ] 我住在…
│   [ ] 我不喜欢…
├─ 可分享记忆（M 条）    ← 访客也能用；分享前至少放几条，否则访客只知道人设
│   [x] 我喜欢猫
├─ + 新增一条记忆        （选择 私有 / 可分享）
└─ 查看记忆星图（主人专属，现状保留）
```

分享开关打开时提示：「访客只能看到『可分享记忆』，私人记忆不会带过去。当前可分享 0 条，要不要先加几条？」

## 9. 验收标准（写成 selftest）

1. 访客会话的上下文里 **不包含**任何 private note 的原文（字符串级断言）
2. 主人会话里 **包含** private note 原文
3. 访客 A 的 guest note 不出现在访客 B 的上下文里
4. 关掉分享后，访客发消息得 403（已有，回归）
5. 配额用尽得 429（已有，回归）
6. 主人列表接口读不到 `scope='guest'` 的内容
7. 群里同时有主人和访客时，走公共层（按第 6 节待定规则确认后实现）

## 10. 需要你拍板的开放问题

1. **默认值**：新记忆默认「私有」还是「可分享」？（建议私有）
2. **访客记忆归属**：访客跟 AI 聊出来的事，要不要让主人知道"存在这么一条"（只有条数、没有内容）？（建议只给条数）
3. **访客记忆保留**：留多久？（建议 90 天自动清）
4. **谁维护可分享记忆**：AI 主动建议 + 主人确认，还是纯手动？（建议 AI 建议、主人确认）
5. **群聊场景**：群里只要有外人，就降级到公共层——接受吗？
6. **跨世界**：以后 AI 记忆换宿主（手机 ↔ 电脑）时，`memory_notes` 跟 nmem 一起搬，还是 Nest 库自己搬？

## 11. 风险

- **伪隐私**：如果只靠提示词说"别说私人内容"，不算做了。必须上下文里没有 → 所以选 B（在注入前就过滤）
- **公共层太空**：主人懒得维护 → 访客体验像"失忆"。缓解：分享开启时强制/建议先填 3 条
- **主人会话记忆不回流**：主人聊天产生的新记忆不会自动成为公共 → 靠"AI 建议公开"补
- **nmem 单脑**：A 方案落地前，记忆仍然是"一台机器一份"，多 AI 共用（见 DECISIONS.md）