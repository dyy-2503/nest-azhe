# 记忆分层方案 v2（按“记什么”分层，不按“给谁看”分层）

> 状态：**PC 侧已实现并自测通过（164/0），待部署手机本地世界**。2026-11-25 晚按用户澄清重写。
> v1 的错误理解：把“公开”当成“把我的私事给别人看”。用户的意思是——**AI 要记得住人，不失忆**。

## 1. 用户要的是什么

> “公开的理解是能够记住一个人的特点，在和别人聊天时提到了这个人知道这个人，不会失忆。”
> “当普通人际记忆，自然聊（除敏感外）。”

所以核心诉求是**跨对话的人认知**，不是公开隐私：

- 小肥鱼记得**阿哲是谁**（名字、关系、特点、近况）
- 跟任何人聊天时提到阿哲，它都认识，不会问“阿哲是谁”
- 像真人一样自然聊到别人，**但敏感的事不外说**

## 2. 三类记忆

| 类型 | 内容 | 范围 |
|---|---|---|
| **person 人物档案** | 你认识的人：称呼、关系、稳定特点、近况 | **跨对话共享**（主人/访客/群都认识这些人） |
| **event 事件记忆** | 具体聊了什么、发生过的私事、约定 | **私有**：只在主人会话（和当事人会话）里用 |
| **guest 访客记忆** | 访客自己说的事（我是谁、我喜欢什么） | 只对该访客生效；他自己可以点名公开 |

## 3. 数据模型（v2）

```sql
CREATE TABLE IF NOT EXISTS memory_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ai_id INTEGER NOT NULL,
  kind TEXT NOT NULL,              -- 'person' | 'event' | 'guest'
  subject_id INTEGER,              -- person：对应哪个 user（可空，外部人物用 subject_name）
  subject_name TEXT,               -- person：外部人物的名字（没注册账号也能记）
  text TEXT NOT NULL,              -- 一句话事实（自然语言）
  visibility TEXT NOT NULL,        -- 'shared' | 'private'
  sensitive INTEGER NOT NULL DEFAULT 0,  -- 1=敏感，不跨人
  weight REAL NOT NULL DEFAULT 1.0,      -- 遗忘曲线权重
  reinforce INTEGER NOT NULL DEFAULT 0,  -- 被提及/引用次数
  last_used_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notes_ai_kind ON memory_notes(ai_id, kind, visibility);
CREATE INDEX IF NOT EXISTS idx_notes_subject ON memory_notes(ai_id, subject_id);
```

- `person` 的 `visibility` 默认 `shared`（要“记得住人”就必须共享）
- `event` 的 `visibility` 默认 `private`
- `guest` 默认 `private`，访客可主动改成 `shared`（→ 归入公共认知，主人也可见）
- `sensitive=1` 的条目**任何情况下都不跨人注入**（只有主人会话能看到）

## 4. 注入规则矩阵

| 会话 | person(shared, 非敏感) | person(sensitive) | event(private) | guest(自己的) |
|---|---|---|---|---|
| 主人私聊 | ✅ | ✅ | ✅ | ✅ |
| 访客私聊 | ✅（自然聊） | ❌ | ❌ | ❌（只有自己的） |
| 群聊 | ✅ | ❌ | ❌ | 仅当事人自己的 |
| AI 主动说话 | ✅ | ✅（仅主人） | ✅ | — |

「自然聊」的意思：访客问“你认识阿哲吗”“阿哲喜欢什么”，AI 可以像人一样回答；但它不会主动把敏感内容倒出来。

## 5. 敏感边界（自动 + 手动）

- **自动判定**（AI 写入时打标）：健康、财务、感情纠纷、家庭矛盾、位置行踪、身份信息 → `sensitive=1`
- **手动**：主人在人物档案里逐条打勾“不外说”
- **默认保守**：拿不准就标敏感（宁可少说）

## 6. 遗忘曲线（按用户要求，第 3 条）

- 公共认知（person 的 shared 条目）**不遗忘**——这正是“不失忆”的要求；`weight` 只用于排序（越熟越靠前），最低保持 0.2
- `event`：τ = 180 天；权重 < 0.15 进入沉睡（不进上下文），可搜索唤醒
- `guest`：τ = 30 天；权重 < 0.1 沉睡，沉睡 180 天后物理删除
- 强化：一条记忆被对话引用一次 → `weight = min(1, weight + 0.3)`，刷新 `last_used_at`

## 7. 谁维护

- **AI 维护**：对话里发现“这个人有什么特点”“发生了什么值得记的事”→ 自动写 card/event
- **提交申请**：要改成 `shared`（跨人可见）的条目，AI 生成申请，**主人点确认**才生效
- 主人可在资料页看到：人物档案列表、正在遗忘的事件、待确认的申请

## 8. 接口草案

```
GET    /api/ai/:id/memory/people            人物档案列表（主人）
GET    /api/ai/:id/memory/notes?kind=event 事件记忆分页
POST   /api/ai/:id/memory/notes            新增（默认 event/private）
PATCH  /api/ai/:id/memory/notes/:noteId     改 text / visibility / sensitive
DELETE /api/ai/:id/memory/notes/:noteId
GET    /api/ai/:id/memory/suggestions       待确认的“转共享”申请
POST   /api/ai/:id/memory/suggestions/:id  通过 / 拒绝
```

## 9. 验收标准（写进 selftest）

1. 访客会话的上下文里包含**人物档案的 shared 非敏感条目**（AI 能认出人）
2. 访客会话的上下文里**不含** event 记忆、不含 sensitive 条目
3. 访客问“阿哲是谁”→ AI 能基于人物档案回答（真机对话测试）
4. 主人会话里 person/event/sensitive 全都能用
5. 群聊只注入 person(shared) + 各自 guest
6. 访客 A 的 guest 记忆不出现在访客 B 的上下文
7. 关分享 → 访客 403；配额用尽 → 429（回归）
8. 人物档案权重不衰减到丢失（长期保留）

## 10. 拍板记录

| # | 问题 | 决定 |
|---|---|---|
| 1 | 新记忆默认可见性 | 默认私有（**事件类**）；人物档案默认共享 |
| 2 | 主人能否看访客记忆 | 只看条数，除非访客主动公开 |
| 3 | 访客记忆保留 | 遗忘曲线（30 天 τ，沉睡 180 天删除） |
| 4 | 公共记忆谁维护 | AI 维护 + 主人确认 |
| 5 | 群聊怎么用记忆 | 群聊只用 person(shared) + 当事人 guest，不注入私事 |
| 6 | 换宿主怎么搬 | memory_notes 跟 Nest 库搬；nmem 尽量一起搬，搬不动重建 |
| 7 | 人物档案能聊多深 | **自然聊（除敏感）**：像真人一样提得到人，敏感条目不外说 |
| 8 | “公开”的定义 | 不是公开隐私，而是 **AI 记得住人、不失忆** |