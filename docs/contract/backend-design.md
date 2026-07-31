# Octo Docs 协作文档后端 + 前后端交互契约 设计文档

> 版本：v2.0
> 状态：契约 v3 候选 — 文档自治权限模型 + octo 同源集成（合约级修订，待 Allen/Steve 双引擎复核）
> 适用范围：Octo Docs 实时协作文档子系统（Hocuspocus + Yjs 后端，Tiptap 前端）
> 关联文档：《Octo Docs 前端协作方案（Boris）》、《Octo Docs 白板栈（Excalidraw）设计》
>
> **本版重大变更（产品决策，老板定稿）**：权限模型由「依赖 octo 群」改为**文档自治（document-autonomous）**——
> ① 删除「群成员 = 文档权限」继承逻辑，权限不再与 octo 群耦合；
> ② 新增 `doc_member` 直授成员表（reader/writer/admin 三级），`resolveRole` 收敛为「doc_member + owner」；
> ③ 新增 `doc_invite` 链接邀请（仅**已注册 octo 用户**可接受，接受时校验 octo 身份取可信 uid 后落 doc_member 行）；
> ④ documentName 第 3 段语义由 octo group_no 重定义为 docs 原生 `{folder}`（保持与白板 5 段非对称判别兼容，键格式零迁移）；
> ⑤ octo 同源集成结论（零开发复用 vs 需 octo 新增）详见 §4.7，所有 octo 依赖均落到真实代码引用。
> epoch 实时撤销机制**保留**，改为按 `doc_member` 变更（而非群变更）触发。

---

## 0. 文档导读

本文档定义 Octo Docs **协作文档**子系统的后端架构与前后端交互契约。读者对象包括：

- 后端工程师（Hocuspocus 服务、持久化、扩展开发）
- 前端工程师（Tiptap + provider 接入，对齐第 8 章契约）
- 平台/运维工程师（部署、扩展、监控）
- Agent/平台集成工程师（第 7 章程序化接口）

阅读建议：第 1～2 章确立整体定位与服务形态；第 3～5 章为后端核心（持久化、鉴权、扩展）；第 6 章为与 Octo 既有 WuKongIM 基础设施的整合评估；第 7 章为 Agent 编程接口；第 8 章为**前后端交互契约**，需与 Boris 的前端方案逐条对齐；第 9～10 章为生产就绪与依赖合规。

术语约定：

| 术语 | 含义 |
| --- | --- |
| Y.Doc | Yjs 的核心 CRDT 文档对象，所有协作状态的内存表示 |
| update | Yjs 的二进制增量变更（binary encoded update），是同步与持久化的最小单元 |
| awareness | Yjs/y-protocols 的临时状态协议，承载光标、选区、在线用户等非持久化信息 |
| documentName / document_name | 一篇协作文档的 Hocuspocus 路由键与持久化键，格式 `octo:{space}:{folder}:{doc}`，provider 的 `name` 与后端用它路由到同一个 Y.Doc。**与业务主键 `doc_id` 区分**：`doc_id`（如 `d_abc123`）是 `doc_meta` 的业务主键，`document_name` 是 Hocuspocus/持久化层的规范键（见 §3.4 / 附录 B）。**v2.0 起 `{folder}` 为 docs 原生文件夹维度，不再是 octo group_no，权限不从该段派生**（见 §4 / §8.1）|
| doc_member | v2.0 新增的**文档自治成员表**：把 uid 按 role（reader/writer/admin）直接授到某 doc，`resolveRole` 仅查此表 + owner，不再做群继承（见 §3.4 / §4.2）|
| doc_invite | v2.0 新增的**链接邀请表**：一个邀请 token 携带授予 role，仅**已注册 octo 用户**可接受，接受时校验 octo 身份取可信 uid 后落 `doc_member`（见 §3.4 / §4.6）|
| provider | 前端侧的连接器，本系统使用 `@hocuspocus/provider`（HocuspocusProvider）|
| state vector | Yjs 用于描述文档已知状态的向量，用于计算增量 diff |
| snapshot | 对某一时刻 Y.Doc 状态的完整二进制编码（`Y.encodeStateAsUpdate`）|

---

## 1. 总览与定位

### 1.1 协作文档后端的角色

Octo Docs 协作文档后端的核心是 **Hocuspocus** —— Yjs 官方维护的协作后端框架。它不是一个通用业务服务，而是一个**面向 CRDT 实时同步的有状态 WebSocket 服务**，职责高度聚焦：

1. **实时同步（Sync）**：在多个客户端之间双向同步 Yjs update，保证最终一致性。
2. **持久化（Persistence）**：将权威的 Y.Doc 二进制状态落库，并在文档被首次打开时注水（hydrate）。
3. **鉴权（Auth）**：在连接建立阶段校验 collab token，依据**文档自治成员关系（doc_member + owner）**决定该连接对该文档的访问级别；身份（uid）复用 octo 既有能力（见 §4.7）。
4. **扩展（Extension）**：通过生命周期 hook 接入数据库、Redis 广播、日志、Webhook 等。

协作文档后端处于 Octo Docs 系统的**协作中枢**位置：

```
                         ┌─────────────────────────────────────┐
   前端 Tiptap 编辑器 ───▶│  HocuspocusProvider (y-websocket)     │
   (Boris 方案)           └───────────────┬─────────────────────┘
                                          │  WebSocket (Yjs sync + awareness)
                                          ▼
                         ┌─────────────────────────────────────┐
                         │       Hocuspocus Server (本系统)      │
                         │  onAuthenticate / onLoadDocument /    │
                         │  onChange / onStoreDocument ...       │
                         └───┬───────────────┬─────────────┬─────┘
            extension-database│   extension-redis│      Octo 身份校验服务 │
                              ▼               ▼             ▼
                    ┌──────────────┐  ┌────────────┐  ┌──────────────┐
                    │ MySQL/PG     │  │ Redis      │  │ Octo 身份     │
                    │ (Y.Doc 二进制│  │ (pub/sub   │  │ (token→uid;   │
                    │  + doc_member│  │  协作总线) │  │  uid→用户信息)│
                    │  /doc_invite)│  │            │  │              │
                    └──────────────┘  └────────────┘  └──────────────┘
                              │
                              ▼
                    ┌──────────────┐
                    │ COS / S3     │  (图片、附件，仅存引用)
                    └──────────────┘
```

### 1.2 与白板栈（Excalidraw）、前端栈（Tiptap）的边界

Octo Docs 由三个相对独立的栈组成。**协作文档后端只服务于"文档"这一形态**，白板（Excalidraw）是另一条独立链路，二者不共享 Y.Doc，也不共享同步通道。

| 维度 | 协作文档后端（本系统） | 前端栈 Tiptap（Boris） | 白板栈 Excalidraw（独立） |
| --- | --- | --- | --- |
| 定位 | Yjs 协作后端 / 持久化 / 鉴权 | 富文本编辑器 UI + 协作绑定 | 白板绘图 UI + 协作（独立方案）|
| 核心库 | `@hocuspocus/server` + `yjs` | `@tiptap/core` + `@tiptap/extension-collaboration` + `y-prosemirror` | `@excalidraw/excalidraw`（独立同步）|
| CRDT 数据模型 | Y.Doc（ProseMirror schema 映射）| 在内存中操作同一个 Y.Doc | 自有 element 模型，**不复用文档 Y.Doc** |
| 同步协议 | Yjs sync protocol + awareness | 通过 provider 收发 | 独立通道（不在本系统范围）|
| 持久化责任 | 是（权威存储）| 否 | 由白板栈自行负责 |
| 鉴权责任 | 是（onAuthenticate）| 仅传递 token | 由白板栈自行负责 |
| 与本系统的关系 | —— | **强耦合**：通过契约对齐（第 8 章）| **弱关系**：仅在产品层共享空间/权限语义 |

关键边界结论：

- **文档与白板的 Y.Doc 完全隔离**。一篇文档的 documentName 永不与白板的 documentName 冲突；二者可共用 Octo 的空间/成员权限语义，但同步与持久化各自独立。
- **后端不渲染、不理解富文本语义**。Hocuspocus 只搬运 Y.Doc 的二进制 update；ProseMirror schema 的语义解释发生在前端 Tiptap 与服务端 Agent 接口（第 7 章）中。
- **前端不做权威持久化**。前端的 IndexedDB（y-indexeddb）只是离线缓存，权威状态始终在后端 DB。

> **v1（M2）边界修订（XIN-16 契约 / XIN-26）**：白板 v1 协作改为**由本后端承载**——Hocuspocus 服务端权威 Y.Doc + 元素级 CRDT 合并 + 服务端权威 repair（详见 §11）。白板键 `octo:{space}:{folder}:wb:{board}` 在鉴权/路由/持久化各处**放行**（不再 4403 拒绝），与文档键复用同一 `doc_meta`（`doc_type` 列区分，零迁移）。上表「白板栈：弱关系 / 独立同步通道」为 v0 口径；v1 起白板的同步 / 持久化 / 鉴权与文档同栈，仅 element 数据模型不同（顶层 `Y.Map('elements')` / `Y.Map('files')`，非 ProseMirror schema）。

---

## 2. Hocuspocus 服务架构

### 2.1 Server 实例配置

Hocuspocus Server 是一个长驻、有状态的 Node.js 进程。核心配置：

```ts
// server.ts
import { Server } from '@hocuspocus/server'
import { Database } from '@hocuspocus/extension-database'
import { Redis } from '@hocuspocus/extension-redis'
import { Logger } from '@hocuspocus/extension-logger'

const server = new Server({
  name: `octo-docs-${process.env.HOSTNAME}`, // 实例名，便于多节点定位
  port: Number(process.env.HOCUSPOCUS_PORT ?? 1234),

  // 连接上限与超时
  timeout: 30_000,            // 单条消息处理超时
  maxDebounce: 10_000,        // onStoreDocument 最大去抖延迟（强制 flush 上限）
  debounce: 2_000,            // onStoreDocument 去抖窗口（聚合高频写入）
  unloadImmediately: false,   // 最后一个连接断开后不立即卸载文档（留缓冲）

  // 扩展
  extensions: [
    new Logger(),
    new Database({
      fetch: ({ documentName }) => persistence.fetch(documentName),
      // v4：透传 context（lastContext，最后写入连接的 onAuthenticate 返回值）给 store，
      // 供事务内写 doc_meta.updated_by（见 §3.2 / §4.1 P2-A）；丢掉 context 会使 updated_by 永远为空。
      store: ({ documentName, state, context }) => persistence.store(documentName, state, context),
    }),
    new Redis({
      host: process.env.REDIS_HOST,
      port: Number(process.env.REDIS_PORT),
      prefix: 'octo-docs', // 多产品共享 Redis 时隔离 key
    }),
  ],

  // 生命周期 hook（见 2.2）
  async onAuthenticate(data) { /* ... */ },
  async onLoadDocument(data) { /* ... */ },
  async onChange(data) { /* ... */ },
  async onStoreDocument(data) { /* ... */ },
  async onConnect(data) { /* ... */ },
  async onDisconnect(data) { /* ... */ },
})

server.listen()
```

关键配置说明：

| 配置项 | 取值建议 | 说明 |
| --- | --- | --- |
| `debounce` | 2000ms | onStoreDocument 去抖，把高频编辑聚合成较少的落库次数 |
| `maxDebounce` | 10000ms | 即使持续编辑，最多 10s 强制落一次，限制崩溃丢失窗口 |
| `timeout` | 30000ms | 单条消息处理超时，防止恶意/异常消息阻塞 |
| `unloadImmediately` | false | 文档无连接后保留一小段时间，避免频繁卸载/注水抖动 |
| `quiet` | true（生产）| 减少默认日志噪声，由 Logger 扩展统一接管 |

### 2.2 生命周期 Hook

Hocuspocus 把一篇文档从"连接建立"到"持久化"的全过程拆成可插拔的 hook。所有 hook 按扩展注册顺序串行执行；任一 hook 抛错会中断该阶段（鉴权阶段抛错即拒绝连接）。

| Hook | 触发时机 | 主要用途 | 在本系统的实现要点 |
| --- | --- | --- | --- |
| `onConnect` | WebSocket 握手、鉴权**之前** | 连接级早期校验（IP、来源、全局限流）| 做粗粒度限流与黑名单；不访问业务库 |
| `onAuthenticate` | onConnect 之后、加载文档之前 | 校验 token、解析用户、决定权限级别 | 对接 Octo 成员体系，返回 `context`（注入下游）；reader 设置 `connectionConfig.readOnly`（v4）|
| `onLoadDocument` | 文档首次被某节点加载（内存中无该 Y.Doc）| 从 DB 注水 Y.Doc | 调 `extension-database.fetch`；DB 无记录时返回空 Y.Doc 并写元数据 |
| `onChange` | 任一连接产生 Y.Doc update | 感知文档变更（非持久化）| 更新"最近编辑时间"缓存、触发轻量副作用（如搜索索引异步队列）；**不在此落库** |
| `onStoreDocument` | 变更经 debounce 聚合后 | 持久化权威状态 | 调 `extension-database.store`，写入 Y.Doc 二进制；失败需重试/告警（第 9 章）|
| `onDisconnect` | 某连接断开 | 连接级清理、统计 | 更新在线人数指标；最后一个连接断开会触发文档卸载前的最终 store |
| `onDestroy` | Server 关闭 | 优雅停机 | flush 所有内存文档（第 9 章优雅重启）|

补充 hook（按需启用）：`onRequest`（处理非 WS 的 HTTP 请求，可用于健康检查）、`onUpgrade`（WebSocket 升级，可在此读取 query/header）、`beforeHandleMessage`（消息级钩子，可做写权限二次校验）、`afterLoadDocument`、`beforeBroadcastStateless` / `onStateless`（无状态消息通道，用于服务端→客户端的旁路通知）。

### 2.3 连接与 WebSocket 协议；与 Yjs update/awareness 的关系

Hocuspocus 在 WebSocket 之上实现了 Yjs 的**同步协议（y-protocols/sync）**与**感知协议（y-protocols/awareness）**。一条连接上流动两类消息：

1. **Sync 消息**（持久化语义）：基于 state vector 的双向增量同步。
   - **Step 1**：客户端连接后发送自身 state vector（`SyncStep1`），服务端据此计算客户端缺失的 update 并回送（`SyncStep2`）。
   - **Step 2**：服务端把自身缺失的部分向客户端索取，客户端补齐。
   - 之后双向实时广播增量 update。
2. **Awareness 消息**（非持久化语义）：光标位置、选区、在线用户、用户名/颜色等临时状态。awareness 状态**不落库**，连接断开即自动过期清除。

二者关系与处理路径对比：

| 维度 | Yjs update（sync）| awareness |
| --- | --- | --- |
| 语义 | 文档内容的权威变更 | 临时在线/光标状态 |
| 是否持久化 | 是（触发 onStoreDocument）| 否 |
| 触发的 hook | onChange / onStoreDocument | 不触发持久化 hook |
| 多实例广播 | 经 extension-redis pub/sub | 经 extension-redis pub/sub |
| 断连后命运 | 已合并入 Y.Doc，永久保留 | 自动过期（清除该 client 状态）|

**时序：一次完整的编辑同步**

```
Client A            Hocuspocus Node            Client B
  │  edit (local Y.Doc tx)                        │
  │  ── update(diff) ──▶  │                        │
  │                       │ onChange              │
  │                       │ (debounce 计时)        │
  │                       │ ── broadcast update ──▶│  apply → 本地渲染
  │                       │ ── (Redis pub) ──▶ 其它节点
  │                       │                        │
  │            ...(debounce 2s 内无新编辑)...       │
  │                       │ onStoreDocument        │
  │                       │  store(name, state) ──▶ DB
```

---

## 3. 持久化方案

### 3.1 权威存储是 Y.Doc 二进制 update，而非 JSON

这是整个持久化设计的基石：**协作文档的权威状态是 Yjs 的二进制编码，而不是渲染后的 JSON/HTML**。

原因：

- **CRDT 完整性**：Yjs 的合并、撤销/重做、离线冲突解决依赖完整的 CRDT 内部结构（含 tombstone、client/clock 元信息）。一旦序列化成 JSON，这些信息丢失，无法再正确合并并发编辑。
- **无损往返**：`Y.encodeStateAsUpdate(doc)` ↔ `Y.applyUpdate(doc, bin)` 是无损往返；JSON ↔ ProseMirror ↔ Y.Doc 的转换会引入 schema 解释，不能作为权威源。
- **派生视图**：HTML/JSON/纯文本是从 Y.Doc **派生**的只读视图，用于搜索索引、预览、导出，可随时重算，不是真相来源（source of truth）。

因此 DB 中存的是 `LONGBLOB` / `BYTEA`，不是 `JSON` 列。

### 3.2 extension-database 接自有 DB

`@hocuspocus/extension-database` 是一个薄适配层，只要求实现两个函数：

```ts
// persistence.ts
import * as Y from 'yjs'

export const persistence = {
  // 文档被加载时调用：返回该文档的完整二进制状态（Uint8Array）或 null
  // 注意：documentName 即规范持久化键 document_name（octo:{space}:{folder}:{doc}），
  //       不是业务主键 doc_id（见 §3.4 / 附录 B）。
  async fetch(documentName: string): Promise<Uint8Array | null> {
    // db.query 返回行数组；空结果是 []（truthy），必须取第 0 行再判空，
    // 否则 new Uint8Array(undefined) 会读到坏数据。
    const row = (await db.query(
      'SELECT state FROM yjs_document WHERE document_name = ? LIMIT 1',
      [documentName],
    ))[0]
    return row ? new Uint8Array(row.state) : null
  },

  // 持久化时调用：写入当前完整状态（Hocuspocus 已在内存合并好）。
  // 采用 merge-on-write（并集）兜底：绝不比较状态"新旧"，而是把 incoming 与
  // DB 现存状态合并成并集后写回，保证任一节点的 flush 都不会覆盖掉另一份的编辑。
  // 性能旁路：正常单写者路径 incoming ⊇ existing，此时 union ≡ incoming，re-encode 纯属冗余；
  //   故先用 diffUpdate 判断 existing 是否 ⊆ incoming（即 incoming ⊇ existing）——
  //   测 diffUpdate(existingState, encodeStateVector(incomingDoc)) 为空，是则直写 incoming，跳过全量 decode+encode。
  // 注意：store 需要 context 才能落 updated_by；v4 经 onStoreDocument 的 data.context（lastContext）传入。
  async store(documentName: string, incoming: Uint8Array, context?: { user?: { id?: string } }): Promise<void> {
    await db.transaction(async (tx) => {
      // 1. SELECT ... FOR UPDATE 锁定并取最新行（read-modify-write 第二层防御）
      const existing = (await tx.query(
        'SELECT state FROM yjs_document WHERE document_name = ? FOR UPDATE',
        [documentName],
      ))[0]

      // 2. merge-on-write + diffUpdate 旁路：
      //    先判 existing 是否 ⊆ incoming（即 incoming ⊇ existing，incoming 是超集）——
      //    diffUpdate(existingState, encodeStateVector(incomingDoc)) 为空
      //    ⇔ existing 中没有任何超出 incoming 的更新 ⇔ existing ⊆ incoming ⇔ incoming ⊇ existing。
      //    ⚠️ 方向至关重要：必须以 existing 为「被 diff 对象」、incoming 的 state vector 为基准；
      //    若反过来测 diffUpdate(incoming, sv(existing)) 为空，得到的是 incoming ⊆ existing
      //    （incoming 陈旧），此时直写 incoming 会丢掉 existing 多出的编辑（P0-1 复活）。
      let finalState: Buffer
      if (!existing) {
        // 无现存行：直接落 incoming
        finalState = Buffer.from(incoming)
      } else {
        const existingState = new Uint8Array(existing.state)
        const incomingDoc = new Y.Doc()
        Y.applyUpdate(incomingDoc, incoming)
        // surplus = diffUpdate(existingState, sv(incomingDoc))：existing 中超出 incoming 的增量。
        // surplus 为"空 update"（仅含空结构）即表示 existing 中无超出 incoming 的部分，
        // 即 existing ⊆ incoming（incoming 是超集），直写 incoming 安全。
        // ⚠️ 方向：必须 existing 为被 diff 对象、incoming 的 state vector 作基准；写反成
        //    diffUpdate(incoming, sv(existing)) 为空则是 incoming 陈旧（incoming ⊆ existing），直写会丢 existing 编辑。
        const surplus = Y.diffUpdate(existingState, Y.encodeStateVector(incomingDoc))
        if (isEmptyUpdate(surplus)) {
          // 正常单写者路径：incoming ⊇ existing，union 结果就等于 incoming，
          // 直写 incoming、跳过 union 的 decode+encode（等价优化，不违反 P0-2：
          // 这是"严格包含"判定，不是"比较新旧"）。
          finalState = Buffer.from(incoming)
        } else {
          // 检测到并发：incoming 不含 existing 的某些更新（锁等待期间另有写入），
          // 走 union 合并兜底以保证不丢编辑（保留 merge-on-write 正确性路径）。
          const doc = new Y.Doc()
          Y.applyUpdate(doc, existingState)
          Y.applyUpdate(doc, incoming)
          finalState = Buffer.from(Y.encodeStateAsUpdate(doc))
        }
      }

      // 3. UPSERT 单行权威态（document_name 唯一索引），不再追加 version 行、不比较新旧
      await tx.query(
        `INSERT INTO yjs_document (document_name, state, size_bytes, updated_at)
         VALUES (?, ?, ?, NOW(3))
         ON DUPLICATE KEY UPDATE state = VALUES(state),
                                 size_bytes = VALUES(size_bytes),
                                 updated_at = NOW(3)`,
        [documentName, finalState, finalState.length],
      )
      // doc_meta 记录 updated_at 与 updated_by（updated_by 取自 context.user.id，见 §4.1）
      await tx.query(
        'UPDATE doc_meta SET updated_at = NOW(3), updated_by = ? WHERE document_name = ?',
        [context?.user?.id ?? null, documentName],
      )
    })
  },
}
```

> **为何 merge-on-write 而非"比较新旧"**：Yjs 的 state vector 是**偏序**而非全序，两份并发状态可能互不包含，「谁更新」没有良定义——字节比较、blob 长度、version 号、updated_at 都无法判定语义新旧。唯一有意义的布尔判断是「X 是否严格包含 Y」：`diffUpdate(Y, encodeStateVector(X))` 为空 ⇔ X ⊇ Y。因此本系统**永不用「新旧比较」gate 一次 CRDT 写**，统一走并集合并（见 §5.2 一致性模型与附录 C P0-2）。这是防御性第二层；第一层是 §5 的单写者选举（同一文档单内存副本单写者），见 P0-1。

要点：

- `store` 收到的 `state` 已是 Hocuspocus 在内存中聚合后的**完整状态**（`Y.encodeStateAsUpdate`），不是单条增量；适配层在事务内与 DB 现存态做并集合并后写回单行（merge-on-write）。
- **diffUpdate 旁路（性能，P1-D）**：正常单写者路径下 `incoming ⊇ existing`，并集结果恒等于 `incoming`，「读回 existing → decode → 重新 encode」是 **100% 冗余**；而 Yjs 的 decode/encode 是**同步 CPU**、跑在事件循环上、且发生在 `SELECT ... FOR UPDATE` 行锁内，大文档会阻塞整个节点。因此 store 先用 `Y.diffUpdate(existingState, Y.encodeStateVector(incomingDoc))` 判定 `existing ⊆ incoming`（即 `incoming ⊇ existing`，diff 为空即成立）：成立则**直写 incoming、跳过 union 的 re-encode**；**仅当检测到并发**（diff 非空，说明锁等待期间另有写入使 existing 含 incoming 不含的部分更新）时才走 union 合并。⚠️ 判据方向已用真 Yjs 13.6.31 实测钉死：**必须是 `diffUpdate(existing, sv(incoming))` 为空**，**不是** `diffUpdate(incoming, sv(existing))`——后者为空时是 incoming 陈旧（incoming ⊆ existing），拿它做判据会在陈旧 incoming 场景直写、丢掉 existing 多出的编辑 = P0-1 复活（Allen test.js 复现）。**union 合并作为并发兜底的正确性路径被完整保留**，只是从"每次都做"降为"仅并发时做"。跳过 union **不违反 P0-2**——`incoming ⊇ existing` 时 union 结果就等于 incoming，这是基于「严格包含」的等价优化，而非"比较新旧"。注意：该判据需把 incoming decode 出一个临时 Y.Doc 以取其 state vector，故「省一次 decode」的收益比早先宣称的小——省掉的是 union 的全量 re-encode（encodeStateAsUpdate），而非全部 decode；旁路的真正价值在跳过大文档的全量并集 re-encode。
- **updated_by 落库（P2-A）**：store 经 `onStoreDocument` 的 `data.context`（v4 经 `lastContext` 传入最后写入连接的 context）拿到 `user.id`，在同一事务内写 `doc_meta.updated_by`。若 store 仅保留 `documentName + incoming` 旧签名而丢掉 context，`updated_by` 将永远为空。
- `fetch` 返回的二进制会被 Hocuspocus `Y.applyUpdate` 到内存 Y.Doc 完成注水。
- DB 适配层应是幂等、可重试的（第 9 章容错）。merge-on-write 天然幂等：重复 store 同一份 incoming 合并结果不变；diffUpdate 旁路同样幂等（重复直写同一 incoming 结果不变）。
- 持久化键统一用 `document_name`（见 §3.4 / 附录 B），不再用 `doc_id` 直查 `yjs_document`。

### 3.3 持久化模型：单一权威合并态（v1 定稿，不做动态切换）

> v1 删除了旧版「按文档大小阈值在策略 A/B 之间动态切换」的设计——动态切换会让同一文档在两种真相源之间漂移，且与 `extension-database` 的 `store` 语义冲突。v1 **只用一种持久化模型**：单一权威合并态。

**主模型（默认、唯一启用）—— 单行权威合并态（snapshot）**

`extension-database` 的 `store` 每次都拿到内存中聚合后的**完整状态**，本系统在 `store` 内用 merge-on-write 与 DB 现存态合并成并集，UPSERT 写入 `yjs_document` 的**单行**（`document_name` 唯一索引）。`fetch` 直接读这一行注水。没有 version 行环、没有增量日志、没有双写，`yjs_document` 是唯一真相源。

- 写放大：每次写完整态。对绝大多数协作文档（中小体量）可接受；超大文档由 §9.5 的单文档体积上限兜底。
- 读放大：一次读、一次 `applyUpdate`，最低。
- 历史回溯：v1 不在持久化层提供逐版本回溯；如需版本历史，由上层「文档快照/版本」业务功能另行设计（不在本契约范围）。

**可选替代模型（增量日志，二选一，默认不启用）**

若后续确有超大/超高频文档需要降低写放大，可整体切换到「基线 snapshot + 增量日志」模型。**该模型与主模型互斥（二选一真相源），切换是一次性的部署级决策，不在运行时按文档动态切换。** 启用时必须满足以下全部约束，否则不得上线：

1. **不复用 stock `extension-database` 的 `store` 写增量**：stock `store` 永远收到完整合并态，用它写增量会与基线 snapshot 形成双写、两个真相源。增量日志模型需自定义持久化扩展，由其统一管理 snapshot 与日志的读写。
2. **完整 DDL**：必须同时建 `yjs_snapshot`（基线）与 `yjs_update_log`（增量），见 §3.4 可选 DDL，二者都以 `document_name` 为键。
3. **单一权威分配 seq**：`yjs_update_log.seq` 由 DB 自增（`AUTO_INCREMENT`）单一权威分配，**禁止用 `MAX(seq)+1` 应用层自增**（多节点竞态会撞号）。
4. **compact 用 captured_seq，绝不用 version 比较**：

```
fetch(document_name):
  base   = SELECT state, captured_seq FROM yjs_snapshot WHERE document_name=?   -- 单行基线
  deltas = SELECT update_bin FROM yjs_update_log
           WHERE document_name=? AND seq > base.captured_seq ORDER BY seq
  doc = new Y.Doc(); Y.applyUpdate(doc, base.state)
  for d in deltas: Y.applyUpdate(doc, d)
  return Y.encodeStateAsUpdate(doc)

compact(document_name):  // 定时任务 / 增量条数超阈值触发
  capturedSeq = SELECT MAX(seq) FROM yjs_update_log WHERE document_name=?  -- 先钉死本次重放的上界
  doc = 重放 base + (seq <= capturedSeq 的 deltas)
  newState = Y.encodeStateAsUpdate(doc)
  UPSERT yjs_snapshot SET state=newState, captured_seq=capturedSeq WHERE document_name=?
  DELETE FROM yjs_update_log WHERE document_name=? AND seq <= capturedSeq  -- 只删已纳入快照的
```

关键点：先 `MAX(seq)` 钉死 `capturedSeq` 再重放，DELETE 谓词严格用 `seq <= captured_seq`。重放与 DELETE 之间到达的、`seq > capturedSeq` 的新 delta 既不会被纳入本次快照、也不会被删除，下次 fetch/compact 仍可见——**消除了「快照后删除」丢数据边界**。绝不用 `version` 比较做 DELETE 谓词（version 在偏序下无良定义，见 P0-2）。

两模型对比：

| 模型 | 写放大 | 读放大（注水）| 真相源 | v1 状态 |
| --- | --- | --- | --- | --- |
| 单行权威合并态（默认）| 中（每次写完整态）| 低（一次读）| `yjs_document` 单行 | **启用** |
| 基线 snapshot + 增量日志 | 低（只写增量）| 中（base + 重放）| `yjs_snapshot` + `yjs_update_log` | 备选，整体二选一切换，默认关闭 |

### 3.4 业务元数据库与 Y.Doc 二进制表分离

**强约束：业务元数据（标题、归属、权限）与 Y.Doc 二进制状态分表存储。** 元数据需要被频繁查询/索引/JOIN（列表页、搜索、权限判定），而二进制状态是大字段且只按主键存取。混在一起会拖慢元数据查询并造成大字段反复加载。

建表 SQL（MySQL 8 方言，PG 类似）：

```sql
-- 文档元数据（业务库）
CREATE TABLE doc_meta (
  doc_id        VARCHAR(64)  NOT NULL,            -- 业务主键（如 d_abc123），由创建 API 生成
  document_name VARCHAR(256) NOT NULL,            -- 规范持久化/路由键 octo:{space}:{folder}:{doc}
  title         VARCHAR(512) NOT NULL DEFAULT '',
  owner_id      VARCHAR(64)  NOT NULL,            -- 创建者 / 拥有者（Octo user id），隐含 admin（见 §4.2）
  space_id      VARCHAR(64)  NOT NULL,            -- 所属 docs 空间（documentName 第 2 段 {space}），多租隔离维度
  folder_id     VARCHAR(64)  NOT NULL DEFAULT 'f_default', -- docs 原生文件夹（documentName 第 3 段 {folder}）；v2.0：不再是 octo group_no，仅做组织/归类，不派生权限（见 §4 / §8.1）。**非空保留默认值 `f_default`**（省略 folderId 的新建文档归此保留文件夹）；**documentName 第 3 段必须等于本列值**（键与 folder_id 恒一致，见 §8.1）
  doc_type      VARCHAR(32)  NOT NULL DEFAULT 'doc', -- doc / template ...
  status        TINYINT      NOT NULL DEFAULT 1,  -- 1=正常 0=已删除(软删) 2=归档
  permission_epoch BIGINT    NOT NULL DEFAULT 0,   -- 权限版本号（单调递增，权威落 DB；v2.0 按 doc_member 变更 +1，见 §4.5）
  created_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  created_by    VARCHAR(64)  NOT NULL,
  updated_by    VARCHAR(64)  NOT NULL DEFAULT '',
  PRIMARY KEY (doc_id),
  UNIQUE KEY uk_document_name (document_name),    -- document_name 全局唯一
  KEY idx_space (space_id, status, updated_at),
  KEY idx_folder (folder_id, status, updated_at),
  KEY idx_owner (owner_id, status, updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

> 四角色编码是硬切换：先停止所有读写 role 的实例，再运行
> `2026-07-30-recode-doc-roles.sql`，成功后才启动新实例。数据库以
> `octo_schema_metadata.doc_role_encoding=v2` 为权威标记；缺失标记时只有三个
> CHECK 精确呈现 v1 域才允许迁移，其他情况必须中止，不得从行值推测。

-- 文档自治成员（v2.0 新增，替代 v1.x 的 doc_acl —— 见下方迁移说明）
-- 把 uid 按 role 直接授到某 doc；resolveRole 仅查此表 + owner（§4.2），不再做 octo 群继承。
CREATE TABLE doc_member (
  doc_id        VARCHAR(64)  NOT NULL,            -- 关联 doc_meta.doc_id
  uid           VARCHAR(64)  NOT NULL,            -- 被授权的 Octo user id（可信 uid，来源见 §4.4 / §4.6）
  role          TINYINT      NOT NULL,            -- 1=reader 2=commenter 3=writer 4=admin
  granted_by    VARCHAR(64)  NOT NULL,            -- 授权人 uid（直接添加为 owner/admin；链接邀请为 doc_invite.created_by）
  source        TINYINT      NOT NULL DEFAULT 1,  -- 1=direct(直接添加) 2=invite(经 doc_invite 接受)
  invite_token  VARCHAR(64)  NOT NULL DEFAULT '', -- 经邀请加入时记录来源 token（审计/回收），direct 为空
  created_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (doc_id, uid),                      -- 一个 uid 对一个 doc 至多一行（role 升降走 UPDATE）
  KEY idx_uid (uid, role),                        -- 「我能访问哪些 doc」列表页/反查
  KEY idx_doc_role (doc_id, role)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 链接邀请（v2.0 新增）：一个 token 携带授予 role，仅【已注册 octo 用户】可接受（见 §4.6 接受流程）。
CREATE TABLE doc_invite (
  invite_token  VARCHAR(64)  NOT NULL,            -- 邀请 token（高熵随机串，进 URL）
  doc_id        VARCHAR(64)  NOT NULL,            -- 关联 doc_meta.doc_id
  role          TINYINT      NOT NULL DEFAULT 3,  -- 授予 role：1=reader 2=commenter 3=writer(默认) 4=admin
  max_uses      INT          NOT NULL DEFAULT 0,  -- 最大可用次数；0 表示不限次（按 expires_at 控制）
  used_count    INT          NOT NULL DEFAULT 0,  -- 已被接受次数（每成功 accept +1，原子自增并校验上限）
  expires_at    DATETIME(3)  NULL,                -- 过期时间；NULL 表示不过期（仍可被 revoke）
  status        TINYINT      NOT NULL DEFAULT 1,  -- 1=active 0=revoked 2=exhausted(用尽) 3=expired
  created_by    VARCHAR(64)  NOT NULL,            -- 创建邀请的 uid（须对该 doc 具 admin）
  created_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (invite_token),
  KEY idx_doc (doc_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 可选：邀请接受流水（幂等去重 + 审计；防同一 uid 重复消耗 used_count）。
CREATE TABLE doc_invite_redemption (
  invite_token  VARCHAR(64)  NOT NULL,
  uid           VARCHAR(64)  NOT NULL,            -- 接受邀请的可信 uid
  redeemed_at   DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (invite_token, uid)                 -- 同一 uid 对同一 token 仅计一次（再次点击不重复 +used_count）
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 【迁移说明：doc_acl → doc_member】
-- v1.x 的 doc_acl(principal_type ∈ {1=user, 2=group}) 在 v2.0 被 doc_member 取代：
--   · principal_type=user 行 = 直授个人 → 直接迁入 doc_member（doc_id, principal_id→uid, role, granted_by, source=direct）；
--   · principal_type=group 行 = 群授权/群继承 → 「群=权限」语义被产品决策删除，这类行【丢弃】（不再迁移）。
-- 迁移期需对受影响文档逐一确认 owner/admin 已落 doc_member，避免删除群继承后无人可管理（见 §4.2 迁移注意）。

-- Y.Doc 二进制权威态（与元数据分离；主模型：单行权威合并态）
CREATE TABLE yjs_document (
  id            BIGINT       NOT NULL AUTO_INCREMENT,
  document_name VARCHAR(256) NOT NULL,            -- Hocuspocus 路由/持久化键，非 doc_id
  state         LONGBLOB     NOT NULL,            -- Y.encodeStateAsUpdate 结果（并集合并态）
  size_bytes    INT          NOT NULL DEFAULT 0,
  updated_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_document_name (document_name)     -- 每文档单行，store 走 UPSERT + merge-on-write
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 可选：基线 snapshot（仅「增量日志」备选模型启用时建；与上表二选一作真相源，见 §3.3）
CREATE TABLE yjs_snapshot (
  document_name VARCHAR(256) NOT NULL,            -- 与 yjs_update_log 同键
  state         LONGBLOB     NOT NULL,            -- 基线完整态
  captured_seq  BIGINT       NOT NULL,            -- 已重放进本基线的最大 update_log.seq
  size_bytes    INT          NOT NULL DEFAULT 0,
  updated_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (document_name)                     -- 每文档单行基线
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 可选：增量日志（仅「增量日志」备选模型启用时建，见 §3.3）
CREATE TABLE yjs_update_log (
  seq           BIGINT       NOT NULL AUTO_INCREMENT, -- 单一权威分配（DB 自增），禁止应用层 MAX+1
  document_name VARCHAR(256) NOT NULL,
  update_bin    BLOB         NOT NULL,            -- 单条增量 update
  created_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (seq),
  KEY idx_doc_seq (document_name, seq)            -- compact 用 seq <= captured_seq 截断
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 可选：附件引用表（见 3.5）
CREATE TABLE doc_attachment (
  attach_id     VARCHAR(64)  NOT NULL,
  doc_id        VARCHAR(64)  NOT NULL,
  object_key    VARCHAR(1024) NOT NULL,           -- 对象存储 key
  mime          VARCHAR(128) NOT NULL,
  size_bytes    BIGINT       NOT NULL,
  created_by    VARCHAR(64)  NOT NULL,
  created_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (attach_id),
  KEY idx_doc (doc_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

### 3.5 图片/附件走对象存储，文档只存引用

二进制大对象（图片、视频、文件）**绝不进 Y.Doc，也不进 DB 大字段**，而是上传到对象存储（腾讯云 COS / AWS S3），Y.Doc 中只保存引用（object key / 受控 URL）。

流程：

1. 前端选择图片 → 调用后端 `POST /api/v1/docs/:docId/attachments/presign` 获取**预签名上传 URL**。
2. 前端直传对象存储（不经过 Hocuspocus）。
3. 上传成功后，前端在 Tiptap 中插入 image 节点，节点的 `src`/`attrs` 存的是 `attach_id` 或受控访问 URL，而非 base64。
4. 后端登记 `doc_attachment`（建立 doc → 附件引用，便于垃圾回收与权限继承）。
5. 读取时，image 节点的引用经后端换发**带签名的临时访问 URL**（防盗链、权限校验）。

理由：Y.Doc 越小，注水/广播/落库越快；把图片塞进 CRDT 会让 update 体积爆炸、广播放大、合并变慢。

---

## 4. 鉴权与权限

### 4.1 onAuthenticate 校验 collab token

鉴权发生在连接建立的 `onAuthenticate` 阶段，前端通过函数式 `token` getter 取到的**短期 collab token**在连接/重连时传入（collab token 的签发见 4.4）。身份与权限（role）已在签发接口计算并固化进 token claims，连接阶段不重算权限。`onAuthenticate` 的热路径为：**本地验签（CPU、无 IO）+ permission_epoch 比对（`currentEpoch` 优先走 Redis 缓存，miss 才回源 DB）+ 仅当 epoch stale 时才 `recheckCurrentRole` 查 `doc_member`**。即常态路径（epoch 命中即放行）仅一次 Redis 读、不查成员库；只有 epoch 落后（stale）的分支才回源 DB / `doc_member` 复核。换言之 onAuthenticate **不重算权限**，但并非"连接阶段零 IO/零查库"——epoch 一致性校验是必要的轻量 IO。

```ts
// Hocuspocus v4：onAuthenticate 的 payload 含 connectionConfig（在其上设 readOnly）
async onAuthenticate(data) {
  const { token, documentName, connectionConfig } = data

  // 1. 验 collab token：验签 + 校验未过期（exp）
  //    验签失败 / 已过期 => 拒绝连接（前端收到 4401，静默刷新后重连）
  const claims = verifyCollabToken(token) // { uid, documentName, role, permission_epoch, exp }；抛错 => 4401
  if (!claims) throw new Error('Unauthorized')

  // 2. 校验 token 内 documentName 与本次连接的 documentName 一致（防 token 挪用到别的文档）
  //    不一致 => 4403（拒绝，不刷新）
  if (claims.documentName !== documentName) throw new Error('Forbidden')

  // 3. 校验 permission_epoch：与该 {doc} 当前 epoch 比对（见 4.5）。
  //    currentEpoch(documentName)：优先读 Redis 缓存（命中即返回，常态热路径仅此一次 Redis 读），
  //      miss 才回源 DB（epoch 权威落 DB，Redis 仅缓存，见 §4.5 P2-E）；
  //      ⚠️ Redis miss → DB 回源按 {doc} 维度纳入 singleflight 合并并发回源 + 进程内短 TTL 缓存（P2-E），
  //      防止 Redis 宕机/清空时大量连接同时回源 DB 造成 epoch 读 stampede。
  //    epoch 一致（命中）=> 直接放行，不查成员库。
  //    epoch 落后（stale）=> 不直接拒绝，进入 stale 分支复核该 uid 对该 doc 的【当前】权限：
  //      - recheckCurrentRole 仅在此 stale 分支调用（查 doc_member + owner），并带 singleflight + 短 TTL 缓存（见下方 thundering herd 防护）；
  //      - 仍有权（role ∈ reader|writer|admin）=> 抛 4401（可刷新语义），前端静默刷新拿新 epoch token 重连；
  //      - 确实无权（当前 role=none）=> 抛 4403（永久无权，前端不刷新）。
  let epoch: number
  try {
    epoch = await currentEpoch(documentName) // Redis miss → DB singleflight；权威源不可确认则 throw
  } catch {
    throw new Error('Unauthorized') // 4401 退避（权威源不可确认 = fail-closed，P1-C）
  }
  if (claims.permission_epoch < epoch) {
    let currentRole: Role
    try {
      currentRole = await recheckCurrentRole(documentName, claims.uid) // 仅 stale 分支查 doc_member+owner（带 singleflight+缓存）
    } catch {
      throw new Error('Unauthorized') // recheck 不可确认也 fail-closed（4401）
    }
    if (currentRole === 'none') throw new Error('Forbidden')         // 4403：彻底失权
    throw new Error('Unauthorized')                                  // 4401：可刷新，前端刷新 token 重连
  }
  // ⚠️ currentEpoch / recheckCurrentRole 是异步 IO（Redis/DB），必须 await；不 await 则 `number < Promise` 恒 false、
  //    stale 分支永不进入 → 撤销/降权静默失效（P1-C 漏洞）；权威源不可确认一律 fail-closed。

  // 4. role 直接取自 token claims，无需再查库计算（reader|writer|admin）
  const role = claims.role

  // 5. 从 documentName 解析归属，供下游 hook 路由/落库使用：octo:{space}:{folder}:{doc}
  //    ⚠️ v2.0：{folder} 仅为 docs 原生组织维度（路由/归类），【不参与权限判定】——权限完全来自 doc_member + owner（见 §4.2）。
  //    parseDocumentName 执行可执行校验矩阵（非法直接拒绝 4403/4404，不做"尽力解析"）：
  //      a. 按 ':' split。**白板键非对称判别**：若 parts.length === 5 且 parts[3] === 'wb'
  //         （即 octo:{space}:{folder}:wb:{board}），识别为白板键 —— 文档后端不受理白板
  //         （白板不共享文档 Y.Doc/通道），直接拒绝（4403/4404）；
  //      b. 文档键必须 **exactly 4 段**：parts.length !== 4（且非上面的 5 段 wb 形式）一律拒绝（多余段/缺段拒绝）；
  //      c. **首段必须 === 'octo'**：parts[0] !== 'octo' 拒绝；
  //      d. **空段拒绝**：任一段为空字符串拒绝；
  //      e. {doc} 段禁含分隔符 ':' 等非法字符、且禁等于字面量 'wb'（否则分隔歧义 → 错误归属）。
  const parsed = parseDocumentName(documentName) // 5 段 wb / 非 4 段 / 首段非 octo / 空段 / 非法字符 => 抛错拒绝
  if (parsed.kind !== 'document') throw new Error('Forbidden')  // 白板键（kind==='whiteboard'）文档后端不受理 => 4403
  const { space, folder, doc } = parsed

  // 6. 只读用户：v4 在 connectionConfig 上设 readOnly，Yjs 写消息会在【应用之前】被服务端拒绝
  if (role === 'reader') {
    connectionConfig.readOnly = true
  }

  // 7. 注入 context，向下游 hook（onLoadDocument/beforeHandleMessage/onStoreDocument）传递
  return {
    user: { id: claims.uid },
    role,
    permission_epoch: claims.permission_epoch,
    space,
    folder,
    doc,
  }
}
```

下面给出 `parseDocumentName` 的可执行校验矩阵（伪代码，TypeScript 风格），落实 step 5 的**非对称解析**——白板键比文档键多一个字面量判别段 `wb`，故须先判 5 段 wb 形式、再判 4 段文档形式；且 `{doc}` 段**禁止等于 `'wb'`**，以防与白板前缀 `:wb:` 产生归属歧义。注意 v2.0 重定义后**解析逻辑与段数/位置判别完全不变**——只是第 3 段的语义标签由 `{group}` 改名为 `{folder}`，故白板 5 段非对称判别（`parts.length===5 && parts[3]==='wb'`）零改动：

```ts
// 非对称：白板键 5 段 octo:{space}:{folder}:wb:{board}；文档键 4 段 octo:{space}:{folder}:{doc}
// v2.0：第 3 段为 docs 原生 {folder}（不再是 octo group_no），不参与权限判定
function parseDocumentName(name: string) {
  const parts = name.split(':')
  if (parts[0] !== 'octo') throw new Error('bad ns')            // 首段必须为字面量 'octo'
  const seg = /^[A-Za-z0-9_-]+$/                                // 各段受限字符集，禁含 ':'、空段
  // 5 段且第 4 段为字面量 'wb' ⇒ 白板键（多一个 wb 判别段）：文档后端不受理（4403/4404）
  if (parts.length === 5 && parts[3] === 'wb') {
    const [, space, folder, , board] = parts
    if (![space, folder, board].every(s => seg.test(s))) throw new Error('bad seg')
    return { kind: 'whiteboard', space, folder, board }         // 上游据此拒绝（白板不共享文档 Y.Doc/通道）
  }
  // 否则必须 exactly 4 段 ⇒ 文档键
  if (parts.length === 4) {
    const [, space, folder, doc] = parts
    if (![space, folder, doc].every(s => seg.test(s))) throw new Error('bad seg')
    if (doc === 'wb') throw new Error('doc segment must not be "wb" (ambiguous with whiteboard prefix)')
    return { kind: 'document', space, folder, doc }
  }
  throw new Error('bad documentName: segment count')            // 其它段数（多余/缺段）一律拒绝
}
```

> **第 3 段 `{folder}` 与 `doc_meta.folder_id` 必须一致（非空不变量）**：`seg` 正则 `^[A-Za-z0-9_-]+$` 已禁止空段，故第 3 段**永不为空**；它就是该文档的 `doc_meta.folder_id`（非空，DDL 默认保留值 `f_default`，见 §3.4）。解析出的 `folder` **必须等于** `doc_meta(doc).folder_id`——二者由创建 API 在建文档时一并写入、键不可变（见 §8.1）；若发现不一致（数据被篡改/迁移残缺）按 4403 拒绝。**严禁出现空 folder 段**（与 `folder_id NOT NULL` 对齐，消除「DDL 允许空 / 解析拒绝空」的旧矛盾）。

`onAuthenticate` 的返回值会作为 `context` 注入后续所有 hook。**`onStoreDocument` 据此记录 `updated_by`**：从 `onStoreDocument` 的 `data.context`（v4 经 `lastContext` 传入，即最后一次写入连接的 context）取 `user.id`，在 store 事务内写入 `doc_meta.updated_by`（见 §3.2；若沿用只含 `documentName + incoming` 的旧 store 签名会丢掉 context，导致 `updated_by` 永远为空）。**写拒绝必须发生在「消息应用之前」**：reader 由 `connectionConfig.readOnly` 在服务端拦截写消息（已核验：v4 `connectionConfig.readOnly` 即在应用 update 前拒写）；对自定义/直写路径，再在 `beforeHandleMessage` 复查 `role` 与 `permission_epoch`（纵深防御，见 4.5）。**不要用 `onChange` 当权限闸门**——`onChange` 在 update 已合并进内存 Y.Doc 之后才触发，此处无法拒绝写入。

> **onAuthenticate 热路径的 thundering herd 防护**：当发生 **mass 成员变更，或节点重启 / LB 重均衡导致海量持旧 epoch 的 token 同时重连**时，会触发大量连接同时落入 stale 分支并发 `recheckCurrentRole`，可能压垮 `doc_member` 库。防护手段：
> 1. **recheck 结果短 TTL 缓存**：同 `{doc, uid}` 的复核结果在短 TTL（如数秒）内复用，避免同一主体反复回源；
> 2. **singleflight（单飞）合并并发回源**：对同一 `{doc}`（或 `{doc, uid}`）的并发 recheck 合并为一次回源、其余等待其结果，消除惊群；
> 3. **连接级建立速率限流与退避**：在 `onConnect` / 网关层对连接建立速率限流（配合 4429 退避，见 §8.2 / §9.5），平滑重连洪峰。

> **epoch 校验权威源不可确认时的 fail-closed（P1-C）**：step 3 的 epoch 比对，**当 `currentEpoch` 无法从权威源（DB）确认**（Redis miss 且 DB 也抖动/不可用），或该 `{doc}` 已知发生 **doc_member/owner 权限变更**（已收到失效广播 / epoch 已知抬升）时，**凡可能涉及权限收紧（降权/撤销）的判定一律 fail-closed**——抛 **4401（可刷新语义，前端退避后重试）**，**绝不以旧 epoch 缓存放行写权限**；宁可短暂拒绝也不开鉴权旁路。**旧 epoch 缓存容忍仅适用于不涉权限收紧的读保持**（已建立、未涉权限收紧的连接的短时读旧 epoch，窗口量级 ≤ 数秒 TTL，见 §9.2），且一旦 `{doc}` 已知 **doc_member/owner 权限变更**立即失效并转 fail-closed。

> **归属解析说明（v2.0 文档自治）**：documentName 自带 `{space}`/`{folder}`/`{doc}`。**`{folder}` 是 docs 原生文件夹维度，仅用于路由与组织归类，不再是 octo group_no、也不派生任何权限**——这是本版与 v1.x 的根本差异。权限**完全来自文档自治成员关系**：`resolveRole` 只查 `doc_member`（uid 对该 doc 的直授 role）+ `doc_meta.owner_id`（owner 隐含 admin），不做任何群继承（见 §4.2）。这套 role 计算在**签发 collab token 时**完成并写入 token claims；连接阶段的 `onAuthenticate` **不再重算权限**，只做本地验签 + 校验 documentName 一致性 + permission_epoch 比对（优先 Redis 缓存、miss 回源 DB）+ 读取 claims.role；仅当 epoch stale 时才回源 `doc_member` 复核（`recheckCurrentRole`）。`docMetaRepo` 的文档存在/状态校验前移到签发接口（见 4.4）。注意：这并非"连接阶段零查库"——epoch 比对是必要的轻量 IO（常态一次 Redis 读），只是**避免了连接时重算 role 与回查成员库**（除非 stale）。

### 4.2 文档自治成员模型：doc_member + owner；三级权限

> **v2.0 根本变更（老板定稿）**：权限模型由「依赖 octo 群」改为**文档自治**。删除 v1.x「群成员 = 文档权限」的群继承逻辑，以及「`{group}` = group_no 驱动权限」语义。**权限不再与 octo 群耦合**——一篇文档的成员与角色完全由文档自己的成员表 `doc_member` 决定。

权限来源收敛为**两个、且都属于文档自身**：

1. **owner（拥有者）**：`doc_meta.owner_id`，创建者隐含 **admin**，不可被降级/移除（除非转移 owner）。owner 是「删除群继承后仍可管理」的兜底锚点。
2. **doc_member（直授成员）**：`doc_member` 表中 `(doc_id, uid)` 的 role（reader/writer/admin）。成员由 owner/admin **直接按 role 添加**，或经**链接邀请**接受后落行（见 §4.6）。

> **`doc_acl` 去向（设计决策：合并入 `doc_member`，不再保留 ACL 表）**：v1.x `doc_acl` 的 `principal_type=user` 行就是「对个人的直授」，与 `doc_member` 语义完全重合，故**直接以 `doc_member` 取代 `doc_acl`**（更干净：一张表、一种主体、PK `(doc_id, uid)`）。`principal_type=group` 行是被删除的群继承语义，**不再保留**。这样 `resolveRole` 从「max(群继承, ACL)」简化为「`doc_member` + owner」的单表查找。迁移见 §3.4 DDL 末尾的迁移说明。

三级权限语义（不变）：

| 级别 | role 值 | 可读 | 可写（编辑内容）| 可管理（重命名/删除/改成员）| 服务端体现 |
| --- | --- | --- | --- | --- | --- |
| 只读 | reader (1) | ✓ | ✗ | ✗ | `connectionConfig.readOnly = true`，在应用消息前拒绝 Yjs 写 |
| 可写 | writer (2) | ✓ | ✓ | ✗ | 允许同步；元数据/成员写 API 拒绝 |
| 管理 | admin (3) | ✓ | ✓ | ✓ | 允许同步 + 元数据/成员/邀请 API |

`resolveRole` 逻辑（简化为单表 + owner，无群继承、无并集取最高）：

```
resolveRole(uid, docId):
  if uid === doc_meta(docId).owner_id: return admin     // owner 隐含 admin，不可降级
  memberRole = doc_member 中 (docId, uid) 的 role        // reader|writer|admin，单行
  return memberRole ?? none                              // 无成员行 => none（无权）
```

要点：
- 不再读 octo 群成员体系，不再做 `max(...)` 并集——一次 `doc_member` 单行查找（PK `(doc_id, uid)`）+ owner 比对即得 role。
- `recheckCurrentRole(documentName, uid)`（§4.1 stale 分支）即调用此 `resolveRole`（按 documentName→doc_id 解析后查 `doc_member`），不再回查群/旧 ACL 库。
- **迁移注意**：删除群继承后，原本仅靠「群管理员」身份管理文档的用户将失去 admin——迁移脚本须确保每篇存量文档至少有 owner（或一名 admin）已落 `doc_member`/`doc_meta.owner_id`，避免「无人可管理」。

### 4.3 token 校验与 context 注入时序

```
Frontend Provider     签发接口 /api/v1/docs/collab-token     Hocuspocus      Octo 身份 + doc_member DB
      │                        │                              │                    │
      │ ① POST /collab-token   │                              │                    │
      │   (带 Octo 登录态/token)│                              │                    │
      │ ──────────────────────▶│ 校验 octo 身份(token→uid) ───┼───────────────────▶│
      │                        │◀──── 可信 uid ───────────────┼────────────────────│
      │                        │ parseDocumentName→{space,folder,doc}               │
      │                        │ resolveRole = doc_member+owner ┼──────────────────▶│
      │                        │◀──── role（单表查找）─────────┼────────────────────│
      │                        │ [role=none]→HTTP 403 不发 token                    │
      │                        │ 签发短期 collab token          │                    │
      │◀ {token,expiresAt,role}│ claims={uid,documentName,role,permission_epoch,exp}  │
      │                        │                              │                    │
      │ ② WS connect           │                              │                    │
      │   token:()=>collab token                              │                    │
      │ ──────────────────────────────────────────────────────▶│ onConnect(限流/黑名单)
      │                        │                              │ onAuthenticate     │
      │                        │           verifyCollabToken 本地验签 + 校验 exp     │
      │                        │           校验 token.documentName===连接 name      │
      │                        │           [验签失败/过期]→4401                     │
      │                        │           [documentName 不匹配]→4403               │
      │                        │           role=claims.role；[reader]→readOnly      │
      │◀──── auth ok ──────────────────────────────────────────│ return context    │
      │                        │           onLoadDocument (注水) │                  │
      │◀──── SyncStep / update ─────────────────────────────────│                  │
```

鉴权失败时连接被关闭，前端 provider 收到对应的 WebSocket close code（错误码见 8.2）。role 计算（`resolveRole` = doc_member + owner，见 4.2）只在**签发阶段**做一次并写入 token claims；连接阶段的 `onAuthenticate` **不再重算 role、也不回调 octo 身份服务**，只做本地验签 + permission_epoch 比对（优先 Redis 缓存、miss 回源 DB）；仅当 epoch stale 时才回查 `doc_member` 复核当前 role（见 §4.1 step 3 / §4.5）。

### 4.4 token 签发与刷新策略

> 本节为 PM 定稿（采用短期 collab 专用 token，已与前端 Boris 对齐）。

- **短期 collab 专用 token**：协作 WebSocket 连接使用后端签发的**分钟级短期 collab 专用 token**（默认有效期 5 分钟），最小权限，仅授权「特定 documentName + 用户身份」，**不复用长效 octo 登录令牌**（octo 登录态是不透明会话 token，见 §4.7（a））。理由：泄露面小、按文档授权、符合 production-ready 安全要求。
- **签发接口**：新增 `POST /api/v1/docs/collab-token`。
  - 入参：`{ documentName }`；用户身份从请求自带的 **octo 登录态**取（不由前端传 uid，防伪造）。**octo 登录态 = octo-web 已为每个请求注入的 `token` 请求头**（同源复用，见 §4.7 / §10.3）。
  - 身份校验（**零开发复用 octo**）：该端点**直接挂在 octo-server 既有 `AuthMiddleware` 之后**，由 octo 既有的 `CacheTokenParser` 把 `token` 解析为可信 uid（详见 §4.7（a） + 代码引用）；handler 内用 `c.GetLoginUID()` 取 uid，无需自研验签。
  - 授权校验：从 documentName 解析 `{space, folder, doc}` → `resolveRole(uid, doc)` 查 `doc_member` + owner（见 §4.2）；无权限（role=none）直接 HTTP 403，不签发 token。
  - 出参：`{ token, expiresAt, role }`；collab token 的 claims 含 `{ uid, documentName, role, permission_epoch, exp }`，由 **docs 后端私钥签名（JWT）**。`permission_epoch` 取自签发时该文档的当前 epoch（见 4.5）。

> **两层令牌链（least-privilege，务必区分）**：octo 登录态与 collab token 是**两层、不同性质**的凭证，不可混用，更**不可把长效 octo 令牌直接挂到 WS 上**：
> 1. **octo 登录态**：octo 既有的**不透明会话 token**（随机串，存 Redis `token:<value>`，**非 JWT、无签名**，由 octo 登录签发、`CacheTokenParser` 校验，见 §4.7（a））。它只用于**调 `POST /api/v1/docs/collab-token` 时证明身份**（Bearer 风格的同源 `token` 头）。
> 2. **collab token**：docs 后端签发的**分钟级短期 JWT**，最小权限、仅授权「特定 documentName + uid + role + epoch」，**仅用于 WS 握手**。
> 链路：`octo 登录态 → POST /api/v1/docs/collab-token（带 octo token）→ 短期 collab token → WS 握手`。即便同源已持有 octo token，WS 仍坚持签发短期 collab token——以获得**按文档授权 + epoch 实时撤销 + 泄露面最小**，绝不让长效 octo 令牌直接承载 WS 鉴权。
- **前端传递**：`HocuspocusProvider.token` 使用函数式 `() => Promise<string>`，连接/重连前先调签发接口取得最新短期 token 再握手。
- **onAuthenticate 校验**：校验 collab token 签名 + 未过期 + token 内 documentName 与连接 documentName 一致（防 token 挪用到其它文档）；通过则把 `{uid, role}` 注入连接 context。
- **刷新闭环**：token 过期后端返回 WS close code `4401`；前端静默刷新（重新调 `POST /api/v1/docs/collab-token` 取新 token）后自动重连（provider 内置指数退避）；`y-indexeddb` 兜底刷新/重连窗口内本地编辑不丢，重连后由 CRDT 自动合并。
- **与业务 REST 鉴权区分**：协作 WS 连接用短期 collab token；文档元数据等业务 REST 接口仍用 octo 登录态（同源 `token` 头），两者职责分离。

签发接口请求/响应示例（仿 8.4 REST 风格）：

```
POST /api/v1/docs/collab-token
token: <octo 登录会话 token>                 # 同源复用 octo-web 注入的 token 头；身份从登录态取，不传 uid
Content-Type: application/json

Request:
{ "documentName": "octo:s_001:f_888:d_abc123" }   # 第 3 段 f_888 = docs 文件夹，非 octo 群

Response 200:
{
  "token": "<collab JWT>",                   // claims: { uid, documentName, role, permission_epoch, exp }
  "expiresAt": "2026-06-13T08:05:00.000Z",   // 默认 5 分钟后过期
  "role": "writer"
}

Response 403:  # 无权限（role=none，即非 owner 且 doc_member 无行），不签发 token
{ "error": "forbidden" }
```

### 4.5 权限撤销时效：permission_epoch + 连接注册表

> 背景：`onAuthenticate` 只在连接建立时跑一次，`role` 固化进 token，长连 WS 不会逐消息回查成员表。若仅靠 token 5min 有效期，**撤销写权限对当前活动连接无效**，只对新连接/重连生效——这与「成员变更立即生效」存在矛盾。本节给出确定的撤销机制，并把残留窗口写成显式可接受边界。**v2.0：epoch 现在按 `doc_member` 变更触发，不再按群变更。**

机制：

1. **permission_epoch（每文档单调递增）**：每个文档维护一个权限版本号 `permission_epoch`。任何 `doc_member` 变更（新增成员、role 升降、移除成员、owner 转移、邀请被接受落行）都使该文档 epoch +1。签发 collab token 时把当前 epoch 写入 claims（见 4.4）。
   - **epoch 权威必须落 DB（P2-E）**：`permission_epoch` 的权威值存于 DB（如 `doc_meta.permission_epoch`），**Redis 仅作读缓存且 miss 回源 DB**——绝不可只存 Redis。否则 Redis 重启 / 清空后 `currentEpoch` 归零，导致**已撤销的权限被静默"恢复"**（旧 token 的 epoch 重新比对通过），属安全漏洞。**Redis miss 回源 DB 时按 `{doc}` 维度 singleflight 合并并发回源 + 进程内短 TTL 缓存**——防止 Redis 宕机/清空时大量连接同时回源 DB 造成 epoch 读 stampede（见 §4.1 step 3）。
   - **issuer / validator 同源**：签发侧（写入 claims.permission_epoch）与 onAuthenticate 校验侧（读取 currentEpoch）必须**以 DB 为同一权威源**读取 epoch，避免两侧取值漂移。
   - **per-principal 语义澄清（P1-B）**：epoch 虽**每文档单调递增**，但权限变更本质是 **per-principal（针对某 uid）** 的。文档 epoch +1 只是一个「该文档 `doc_member` 发生过变更、需按需复核」的**信号**，**不是"全员失效"开关**——给 U3 授权使 doc epoch+1，**不应**让其他在线 writer 被拒写或被迫重连。具体降权判定按 step 3/4 的 per-principal 逻辑处理。
2. **连接注册表（Redis，跨节点）**：每个活动协作连接登记 `{document_name, uid, node, connectionId, role, permission_epoch}`，供权限变更时定位需要处理的连接。连接断开时清理。
3. **变更广播 + 强制失效**：`doc_member` 变更后，签发侧 epoch +1，并经 Redis 广播一条失效事件 `{document_name, uid?}`。**事件应尽量携带受影响的 `uid`，各节点优先按 uid 精确定位**注册表中该 `{doc, uid}` 的连接处理；**仅当 uid 未知（如批量/无法归因的变更）时，才对该文档的全部连接做"按需复核"**（逐连接 recheck 其当前 role，见 step 4），而非无差别全部踢下线。对定位到的连接执行：
   - 被**彻底失权**（移出成员 / 文档删除 / role=none）：`connection.close(4403)`（4403 = 永久无权），前端展示无权访问、停止重连（不刷新、跳登录/退出）。
   - 被**在线降权但仍有权**（如 writer→reader，epoch 变了但用户对文档仍有访问权）：**不 close 连接**——中途翻 `connectionConfig.readOnly = true`，并通过 **stateless 降级帧** `{type:'role-change', role, permission_epoch, issuedAt}` 实时下发新 `role`；前端按新 role 收敛能力（停止写入、切只读 UI），连接保持。初始 role 以 `POST /api/v1/docs/collab-token` 出参为准（见 §8.2）；stateless 仅用于运行期 role 变更通知，且降级帧必须携带 `permission_epoch`，前端只应用 epoch 单调不降的帧（见 §8.3 stateless 帧结构）。
   - 被**提升**：可不强制处理，待其 token 自然刷新（≤5min）即获得新权限；或主动通知前端重连。
4. **写路径复查（per-principal，P1-B）**：`beforeHandleMessage` 对写消息复查连接 context 的 `permission_epoch` 是否落后于该文档当前 epoch。**「文档当前 epoch」只读本节点本地内存的 epoch watermark**（该本地水位由 step 3 的失效广播刷新），**不在每条写消息上回源 Redis/DB**——逐条写消息的 epoch 比对是纯内存读本地 watermark，避免把写热路径变成 per-write IO；只有命中 stale（连接 epoch < 本地 watermark）后的 `recheckCurrentRole` 才在必要时查库（回源仅发生在 stale 复核分支，且带 singleflight + 短 TTL 缓存）。命中「连接 epoch < 文档 epoch」后，**不无差别拒绝**——而是调用 `recheckCurrentRole(doc, uid)`（带 singleflight + 短 TTL 缓存，见 §4.1 thundering herd 防护）取**该 uid 当前 role**，就地判断该 uid 的 role 是否**实际下降（或失权）**：
   - **仅当该 uid 的 role 实际下降 / 失权**：才拒绝该消息并对该连接走 step 3 的失效流程（翻 readOnly 或 close）。
   - **否则（该 uid 权限未降，epoch 落后只因他人变更）**：**就地把连接 context 的 `permission_epoch` 刷新到当前值并放行**——无关 writer 不因他人（如 U3）的 `doc_member` 变更被拒写或被迫重连。
   （纵深防御，防止广播丢失或时序竞态。）

显式可接受边界（写入文档）：

- **新连接/重连的 token 残留窗口 ≤ 5min**：在 epoch 失效广播尚未触达、且旧 token 未过期的极短窗口内，理论上仍可能用旧 epoch 发起一次新连接；`onAuthenticate` 的 epoch 比对（4.1 step 3）会拒绝**落后** epoch 的连接，故实际窗口取决于 epoch 比对而非 token exp。对「提升权限」类变更，我们**显式接受 ≤5min 的生效延迟**（旧 token 自然过期即收敛），不做强制处理。
- 该边界已与安全要求（§9.6）对齐：撤销/降级**实时生效**（踢连接/翻 readOnly），仅「提升」允许 ≤5min 延迟。

### 4.6 链接邀请（doc_invite）+ 接受流程

文档自治模型下，把协作者拉进文档的两条路径：**① 直接添加**（admin 经 §8.4 成员 API 按 role 加 uid）；**② 链接邀请**（admin 生成一个带 role 的邀请链接，分享出去，受邀人点击并接受）。本节定义②。

**邀请的产生**：admin 调 `POST /api/v1/docs/{docId}/invites`（见 §8.4），指定授予 role（默认 `writer`，可为 `reader`/`writer`/`admin`）、可选 `expiresAt` 与 `maxUses`，后端生成高熵 `invite_token` 落 `doc_invite`（status=active），返回可分享链接（如 `https://<host>/docs/invite/<invite_token>`）。

**HARD CONSTRAINT —— 仅已注册 octo 用户可接受**：邀请**不会**凭空创建身份，**接受时必须先校验 octo 身份取得可信 uid**，再落 `doc_member`。匿名/未注册访客无法接受（无 octo 登录态 → 接受接口 401，前端引导其先完成 octo 登录/注册）。这保证 `doc_member.uid` 永远是一个真实存在的 octo 用户。

**接受流程**（`POST /api/v1/docs/invites/{invite_token}/accept`）：

```
POST /api/v1/docs/invites/{invite_token}/accept
token: <octo 登录会话 token>     # 必须携带 octo 登录态；缺失/无效 => 401（引导先登录/注册）

服务端（单事务）：
  1. 校验 octo 身份：经 octo AuthMiddleware/CacheTokenParser 把 token 解析为【可信 uid】
     （零开发复用 octo，见 §4.7（a））；未登录 => 401。 ← 满足 HARD CONSTRAINT
  2. SELECT ... FOR UPDATE doc_invite WHERE invite_token=?：
     - 不存在 / status≠active        => 410 Gone（已撤销/失效）
     - expires_at 已过               => 410（并置 status=expired）
     - max_uses>0 且 used_count>=max => 410（并置 status=exhausted）
       （例外：对 doc_invite_redemption 已存在 (invite_token, uid) 的「重新接受」放行——
        该 uid 此前已占座、重建不再占座，见 step 4 分支 c，不受用尽门限阻断）
  3. 读现状（同事务）：
     - curRole  := resolveRole(uid, doc)    -- = owner→admin（doc_meta.owner_id）否则 doc_member 的 role，
                                            --   见 §4.2；owner 必解析为 admin（owner 无 doc_member 行），
                                            --   故 owner 接受自己文档的邀请必落分支 a no-op
     - redeemed := EXISTS(SELECT 1 FROM doc_invite_redemption WHERE (invite_token, uid))
  4. 分支（精确语义，逐例互斥；散文 §要点 与此一致）：
     a. curRole 存在 且 curRole >= invite.role（已有 role 不低于邀请 role；含 owner——resolveRole 必返 admin，admin >= 任意 invite.role）：
        => no-op：不写 doc_member、不改 used_count、不改 epoch、不写 redemption；
           返回 200 { role: curRole }（完全幂等；owner 点自己文档邀请链接即落此分支，不产生幽灵成员行/不耗座位/不抬 epoch）。
     b. curRole 存在 且 curRole < invite.role（已是成员、现有 role 低于邀请 role）：
        => **不经邀请链接自动升权**（防静默提权）：不改 doc_member、不改 used_count、不改 epoch；
           返回 200 { role: curRole }（role 保持不变；提权须由 admin 经成员 API 显式操作）。
     c. curRole 不存在 且 redeemed 为真（曾接受过、但 doc_member 已被移除）：视为「重新接受」
        => 重建 doc_member(role=invite.role, source=invite, invite_token, granted_by=invite.created_by)；
           doc_meta.permission_epoch += 1；
           **不再 +used_count、不重复 INSERT redemption**（该 uid 此前已计一次、座位已消耗，避免对 max_uses 双计）；
           返回 200 { docId, documentName, role: invite.role }。
     d. curRole 不存在 且 redeemed 为假（首次接受）：
        => INSERT doc_member(role=invite.role, source=invite, invite_token, granted_by=invite.created_by)；
           INSERT doc_invite_redemption(invite_token, uid)；
           used_count += 1；**仅当 max_uses > 0 且 used_count >= max_uses 才置 status=exhausted**
             （max_uses=0 = 无限次，永不耗尽；与 step 2 用尽门限同一守卫）；
           doc_meta.permission_epoch += 1（新成员立即可签发 collab token）；
           返回 200 { docId, documentName, role: invite.role }。

接受后：前端可立即调 POST /api/v1/docs/collab-token 拿到 collab token 进入文档。
```

要点：
- **身份可信**：`doc_member.uid` 来自服务端校验的 octo 身份，**不接受前端自报 uid**（与 §7.3 on-behalf 同款原则）。
- **role 默认 writer**，可邀为 reader/writer/admin（由邀请创建时固化在 `doc_invite.role`）。
- **幂等（精确语义，对应接受流程 step 4 分支 a–d）**：
  - ① **现有 role ≥ 邀请 role**（含 owner——`resolveRole` 必返 admin）→ no-op，返回现有 role，**不计 used_count、不改 epoch、不写幽灵 doc_member 行**（owner 点自己文档的邀请链接即落此分支）；
  - ② **已是成员但现有 role < 邀请 role** → **不经邀请链接自动升权**（返回现有 role 不变，防静默提权；提权须 admin 经成员 API 显式操作）；
  - ③ **曾接受过但成员已被移除**（redemption 行在、doc_member 缺）→ 视为**重新接受**：重建成员、`epoch += 1`，但**不重复 +used_count**（座位此前已计）；
  - ④ **首次接受** → 落 doc_member、**`used_count += 1`**、`epoch += 1`。
  `doc_invite_redemption` 的 PK `(invite_token, uid)` 是「同一人不重复消耗次数」的去重锚点；**邀请链接只用于「加入/首授」，从不用于降级，也从不用于升权**。
- **撤销**：admin 可 `DELETE /api/v1/docs/{docId}/invites/{invite_token}` 把 status 置 revoked，立即失效（已加入的成员不受影响，需另行在成员 API 移除）。

### 4.7 octo 依赖结论 —— 零开发复用 vs 需 octo 新增

> **本节是本次修订老板最关心的结论**：文档自治权限模型把「身份」与「权限」彻底解耦——**权限完全由 docs 自己的 `doc_member`/`doc_invite` 承载（docs 侧新建，与 octo 无关）**；docs 唯一依赖 octo 的是**两件身份类能力**：① token→可信 uid；② uid→用户信息（昵称/头像，用于 awareness 光标）。以下结论**全部基于实际阅读 octo-server / octo-web 源码**，逐条给出真实文件路径与函数名。

#### (a) token → 可信 uid（连接/邀请/签发都要用）—— **零开发复用**

octo-server 已有完整的「token → 可信用户身份」能力，docs 的 `POST /api/v1/docs/collab-token` 与邀请接受接口**直接复用，无需 octo 改造**：

- **鉴权中间件**：`main.go:121` 处 `route.SetTokenParser(auth.NewCacheTokenParser(ctx.Cache(), ctx.GetConfig().Cache.TokenCachePrefix, ...))` 注册全局 token 解析器；各业务路由组以 `r.Group("/v1", u.ctx.AuthMiddleware(r))` 挂载（`modules/user/api.go:207`、`:219`）。
- **解析器实现**：`pkg/auth/parser.go` 的 `CacheTokenParser.Parse(ctx, token) (wkhttp.UserInfo, error)`（`parser.go:73`）——按 `Cache.Get(Prefix+token)` 在 Redis 查会话，命中后 `auth.Decode` 出 `{UID, Name, Role, Language}`。
- **令牌编解码**：`pkg/auth/tokeninfo.go` 的 `Encode/Decode` 与 `TokenInfo` 结构（`tokeninfo.go:26`、`:51`、`:72`）——当前为 `v2:{json}` 信封（含 `uid`），兼容 legacy `uid@name[@role]`。
- **关键事实（影响契约措辞）**：**octo 的用户 token 是存于 Redis 的不透明会话串（key `token:<value>`），不是 JWT、无签名**——校验 = 缓存查找（`parser.go:77`、`api.go:3999`）。因此 docs 的两层令牌链中，**octo 登录态是不透明会话 token，collab token 才是 docs 自签的 JWT**（见 §4.4）。
- **落地方式**：把 `POST /api/v1/docs/collab-token`、`POST /api/v1/docs/invites/{token}/accept` 等**挂在 octo-server 既有 `AuthMiddleware` 之后**，handler 内 `c.GetLoginUID()` 即得可信 uid，零自研验签。
- **前缀说明**：docs 端点统一挂在 octo `/v1` AuthMiddleware 组下，故完整前缀为 `/api/v1/docs/*`（老板拍定方案 A）。
- **备选（若 docs 后端是独立进程，跨服务校验）**：octo 已暴露 **token 自省端点 `POST /v1/auth/verify`**（`modules/user/api.go:306` 注册、`:3985` 实现 `authVerifyToken`），入参 `{token}`、返回 `{uid, name, role, owned_bots}`——docs 后端可 Bearer 调它换 uid。**此端点已存在，亦为零开发复用。**

#### (b) uid → 用户信息（昵称/头像，用于 awareness 光标）—— **单条复用；批量需 octo 新增一个薄接口**

awareness 光标要展示协作者昵称/头像，需要 uid→用户信息，且因同屏多协作者，**最好是批量**：

- **单条（已有 HTTP）**：`GET /v1/users/:uid`（`modules/user/api.go:210`，handler `User.get`）返回用户详情。用户模型 `modules/user/db.go` 的 `Model`：`Name`（昵称）、`IsUploadAvatar`/`AvatarVersion`（头像），头像可经 `GET /v1/users/:uid/avatar`（`api.go:296`）取。
- **批量（Go 服务层已有，但无通用 HTTP 端点）**：服务层 `Service.GetUsers(uids []string) ([]*Resp, error)`（`modules/user/service.go:1025`）→ `DB.queryByUIDs`（`modules/user/db.go:146`，`SELECT * FROM user WHERE uid in ?`）已是**零 N+1 批量查询**；另有 `Service.GetUserDetails(ctx, uids, loginUID)`（`service.go:569`）。**但 HTTP 暴露面只有单条 `GET /v1/users/:uid` 与「批量在线状态」`POST /v1/user/online`（`api_online.go`，只返在线态、非昵称/头像）——没有通用的「批量 uid→昵称/头像」REST 端点**（批量 profile 目前只在 `friend/sync`、`conversation/sync` 内部被间接使用）。
- **结论 = 需 octo 新增（小）**：octo 需**新增一个薄批量 profile 端点**（如 `POST /v1/users/batch` 入参 `{uids:[...]}` 返回 `[{uid,name,avatar}]`），**实现仅是包一层既有 `GetUsers`**，工作量极小。**这是 (b) 项唯一的「需 octo 新增」**。在它落地前，docs 可临时用单条 `GET /v1/users/:uid` 并发拉取兜底。

#### (c) octo-web 同源集成 —— **零新增基础设施；docs 作为新模块包接入**

octo-web 是 **Vite + Turborepo 的 pnpm monorepo（React）**；docs 同源挂载**复用既有模块/路由/登录态机制，不引入 iframe、不引入 qiankun/wujie/module-federation**：

- **模块系统**：`packages/dmworkbase/src/Service/Module.ts` 的 `IModule { id(); init() }` + `ModuleManager.register()`；各功能包以 `WKApp.shared.registerModule(new XxxModule())` 在 `apps/web/src/index.tsx` 注册（既有 BaseModule/LoginModule/ContactsModule/SummaryModule 等均此模式）。docs 作为**新 workspace 包 `@octo/docs`**，导出一个 `DocsModule implements IModule`，在 `apps/web/src/index.tsx` 加一行注册即可。
- **路由**：自研 `RouteManager`（`packages/dmworkbase/src/Service/Route.tsx`，`WKApp.route.register(path, () => <Cpt/>)`），**非 react-router**；docs 注册 `/docs` 路由。SPA fallback（`nginx.conf.template` / Vite dev）已使任意前端路径回落 `index.html`，无需改网关。
- **登录态/ token 复用**：`packages/dmworkbase/src/Service/APIClient.ts` 的 axios 请求拦截器**自动给每个请求注入 `token` 头**（`APIClient.ts:61-70`，`config.headers["token"] = WKApp.loginInfo.token`，**注意是 `token` 头、非 `Authorization: Bearer`**），并注入 `X-Space-Id`。docs 模块**直接用 `WKApp.apiClient` 发请求即自动带 octo 登录态**——`POST /api/v1/docs/collab-token`、邀请接受等都自动携带身份，**零新增登录/鉴权代码**。
- **结论 = 零新增基础设施**：唯一「新增」是 **docs 自己这个前端模块包**（业务代码），octo-web 侧只需「加一行 registerModule + 一条 workspace 依赖」，**不需要 octo-web 新建挂载点/微前端框架**。

#### 结论速览表

| 能力 | octo 现状（真实代码） | docs 用法 | 结论 |
| --- | --- | --- | --- |
| token→可信 uid（连接/签发/邀请） | `pkg/auth/parser.go:73` `CacheTokenParser.Parse`；`main.go:121` 注册；`modules/user/api.go:207/219` AuthMiddleware 组 | collab-token / 邀请接受挂 AuthMiddleware 后取 `c.GetLoginUID()` | **零开发复用** |
| token 自省（跨服务备选） | `POST /v1/auth/verify`（`modules/user/api.go:306` 注册 / `:3985` `authVerifyToken`），返 `{uid,name,role}` | 独立进程时 Bearer 调用换 uid | **零开发复用（已存在）** |
| uid→用户信息（单条） | `GET /v1/users/:uid`（`api.go:210`）；模型 `db.go` `Model.Name`/`IsUploadAvatar` | 兜底单条拉取 | **零开发复用** |
| uid→用户信息（批量，awareness 光标） | 服务层 `GetUsers`（`service.go:1025`）/`queryByUIDs`（`db.go:146`）已具备；**但无通用批量 profile HTTP 端点** | awareness 同屏多人头像/昵称 | **需 octo 新增**：薄端点 `POST /v1/users/batch`（包一层 `GetUsers`） |
| octo-web 同源挂载 | 模块系统 `Module.ts` `IModule`/`registerModule`；路由 `Route.tsx`；token 注入 `APIClient.ts:61-70` | docs 作为 `@octo/docs` 模块包注册 `/docs` 路由，复用 `WKApp.apiClient` | **零新增基础设施**（仅写 docs 模块本身 + 一行注册） |

> **一句话结论**：除「**octo 批量用户 profile 端点**」一个小新增外，docs 的身份/同源集成**全部零开发复用 octo 既有能力**；权限本身（doc_member/doc_invite）是 docs 自有、与 octo 解耦。

---

## 5. 横向扩展

### 5.1 extension-redis 做多实例广播

单个 Hocuspocus 进程是有状态的（文档活在内存）。要横向扩展到多实例，必须解决"同一篇文档的连接落在不同节点上"时的同步问题。`@hocuspocus/extension-redis` 通过 **Redis Pub/Sub** 充当跨实例的**协作总线**：

- 节点 A 收到某文档的 update / awareness → 在本地广播给 A 上的连接，同时 `PUBLISH` 到 Redis 频道。
- 节点 B/C 订阅该频道，收到后在各自本地广播给其上连接同一文档的客户端。
- 频道按文档隔离（`octo-docs:<documentName>`），避免无关流量。

```
        ┌───────── Node A ─────────┐         ┌───────── Node B ─────────┐
ClientA▶│ apply→local broadcast    │         │ local broadcast →ClientB │◀ClientB
        │      │ PUBLISH            │         │           ▲ SUBSCRIBE    │
        └──────┼───────────────────┘         └───────────┼──────────────┘
               ▼                                          │
            ┌──────────────── Redis Pub/Sub ──────────────┘
                 channel: octo-docs:<documentName>
```

### 5.2 多节点一致性与 sticky session

**一致性模型**：Yjs 是 CRDT，update 满足交换律/结合律/幂等，**到达顺序无关**即可收敛。因此 Redis 广播只需"最终送达"，不要求全局有序。各节点内存中的 Y.Doc 通过应用所有 update 收敛到同一状态。

**持久化一致性（单写者选举为主，merge-on-write 兜底）**：多节点若各自持有同一文档的内存副本并各自 `onStoreDocument`，会产生落库竞态——两份完整快照若互为非超集，按"谁后写谁赢"会静默丢掉对方独有的编辑。本系统用两层防御消除该路径：

- **第一层 · 单写者（默认、强制）**：`documentName` 亲和路由（见下表）保证同一文档只在一个节点有内存副本；配合 §5.3 的**强制 Redis 文档锁**，只有锁持有者执行 flush。`unloadImmediately: false` 避免副本频繁卸载/重建导致的写者抖动。单内存副本 + 单写者 ⇒ 正常路径下不存在并发落库。
- **第二层 · merge-on-write 兜底**：即便发生路由抖动或锁切换导致瞬时双副本，`store` 内 `SELECT ... FOR UPDATE` 取最新行 → `Y.applyUpdate(db, existing)`；`Y.applyUpdate(db, incoming)` → 写并集（见 §3.2）。**绝不比较状态"新旧"**（state vector 是偏序，无良定义，见 P0-2），并集合并保证任一节点的编辑都不会被覆盖丢失。**性能上**，正常单写者路径 `incoming ⊇ existing`，store 用 diffUpdate 旁路直写 incoming、跳过全量 union re-encode（见 §3.2 P1-D）；union 仅在**检测到并发**（diff 非空）时执行，作为兜底正确性路径完整保留。

> 已删除旧版基于版本号唯一约束、以及任何"判新旧/乐观写"的防覆盖表述——版本号唯一键只挡得住「同号」，挡不住「哪份 state 是超集」，反而会让两份都落库、fetch 取到缺编辑的赢家行（详见附录 C P0-1）。

**sticky session 注意点**：

| 项 | 说明 |
| --- | --- |
| 是否必须 sticky | 借助 Redis 广播，连接落在任意节点都能同步；但 `documentName` 亲和路由是**默认且必须启用**的——它是 P0-1 单写者/单内存副本的前提，不再是"可选优化" |
| 默认做法 | 在 LB / 网关按 `documentName` 一致性哈希到节点，使同一文档的连接聚到同一节点（单活内存副本）|
| 亲和的收益 | 单内存副本单写者 → 消除跨节点重复注水与并发落库竞态；减少跨节点 Redis 流量 |
| WebSocket 与 LB | LB 需支持 WebSocket 长连接（Upgrade 透传），关闭短超时，配置足够的连接空闲超时 |
| 重均衡 | 节点扩缩容时连接会重连并重新哈希；新主副本经 §5.3 文档锁接管 flush，Yjs + merge-on-write 保证重连后状态收敛，无数据丢失 |
| 亲和的作用范围 | `documentName` 亲和路由**不仅约束 WS 连接，也约束 Agent/internal 的 HTTP 写入口**（`/internal/agent/docs/*`，走 `openDirectConnection`）——二者必须用**同源一致性哈希**落到同一属主节点（见 §7.3 / §9.1）。否则 HTTP 写会在非属主节点注水**第二份内存副本**、破坏单写者 |

> **亲和路由对 HTTP 写入口同样是硬约束（P1-A）**：单内存副本/单写者的前提是「该文档的**所有写入来源**都汇聚到同一属主节点」。WS 连接走亲和路由的同时，**Agent/internal 的 HTTP 写端点也必须按 documentName 同源哈希到同一属主节点（或由非属主节点代理转发）**，不能落到任意无状态节点直接 `openDirectConnection`——否则即制造第二份内存副本、破坏单写者（详见 §7.3「Agent 写端点的属主节点路由」与 §9.1 拓扑）。

### 5.3 Redis 职责：实时广播 + 文档锁（强制），不做权威存储、不做补齐机制

**强约束**：Redis 在本架构中承担三件事：**实时广播（pub/sub）**、**awareness/通知广播**、以及 **文档主写者锁（强制）**。它**不是权威存储**，也**不承载权威更新补齐**。权威状态永远在 MySQL/PG。

理由与边界：

- **pub/sub 只做实时广播，不作补齐机制**：Pub/Sub 是"发后即忘"，只送达「订阅之后」发布的消息；离线/新加入节点错过的消息**不会补发**。因此**不能依赖 pub/sub 把缺失更新补齐**——若最新编辑只活在另一节点内存里（尚未 flush），新节点从陈旧 DB 快照注水后将永远收不到这段更新，导致客户端分叉。
- **新节点一致性靠 documentName 主节点路由（单活副本，默认）保证**：同一文档只在一个节点有内存副本（§5.2 亲和路由 + 本节文档锁），不存在"跨节点注水分歧"——根本不需要 pub/sub 去补齐权威更新。Redis 仅承载 awareness/通知的实时广播 + 文档锁。
- Redis 持久化（RDB/AOF）不保证 CRDT 完整性与持久级别，把权威状态放 Redis 会让"持久化/容灾/回滚"失去支点。

**强制（非可选）：文档主写者锁**。用 Redis 分布式锁做**文档主写节点选举**——同一文档同一时刻只有一个节点持锁并负责 flush（落库）。这是 P0-1 单写者方案的组成部分（与 documentName 亲和路由、`unloadImmediately:false` 配套），不再是"可选增强"。锁持有者崩溃时锁超时释放，由接管节点重新选举为主写者。

**锁的生命周期语义（TTL / 续约 / 释放，P2-G）**：

- **TTL（租约）**：锁带有限 TTL（lease），持有者崩溃后**到期自动释放**，避免死锁导致文档永久无人 flush。
- **续约（lease 续期）**：持锁节点在持有期间**定期续约**（renew，刷新 TTL），保证长时间活跃文档不会因 TTL 到期被误判失主；续约失败（如与 Redis 失联）即视为失去主写者资格，停止 flush。
- **主动释放**：文档卸载、迁移、或节点优雅停机时**主动释放锁**；特别是 **`server.destroy()`（§9.4 优雅重启）flush 完成后必须释放所持的全部文档锁**，让接管节点能立即选举接管，不必等 TTL 过期。
- **锁的定性 = perf 优化，非正确性点（重要）**：文档锁的作用是**避免重复注水、减少跨节点流量、收敛单写者**（性能/效率优化）；**真正的串行化正确性点是 `store` 内的 `SELECT ... FOR UPDATE` + merge-on-write 并集**。即便锁因 TTL 抖动 / 续约失败导致瞬时双持有者，`FOR UPDATE` + 并集仍保证不丢编辑（见 §3.2 / §5.2 第二层兜底）。因此锁不追求分布式互斥的强一致语义——它是优化层，DB 行锁才是正确性兜底。

---

## 6. WuKongIM 通道整合验证

Octo 已有 WuKongIM 作为 IM/WebSocket 基础设施。一个自然的问题：协作文档的 Yjs 同步是否应复用 WuKongIM 的 WebSocket 通道，而不是让 Hocuspocus 独立开 WS 端口？经 PM 全员对齐，**本章结论在 v1 收敛为单一口径**，桥接复用方案降级为 v2 待评估项（见 §6.3）。

### 6.1 v1 口径（结论先行）

**v1 明确采用单一通道划分，不设并列可选项**：

- **内容同步走 Hocuspocus 独立 WS**：Yjs 的 **sync + awareness 协议一律走 Hocuspocus 独立 WS 端口**，前端 provider 直连（经网关/LB）。WuKongIM **不承载 Yjs 协议**。
- **WuKongIM 仅承载业务通知**：文档的"被分享/被@/有人在编辑/在线编辑提醒"等**业务事件通知**走 WuKongIM（这是 IM 的强项）。
- **鉴权复用 octo 登录态、但 WS 走两层令牌链**：独立 WS **不直接复用长效 octo 登录令牌**。WS provider 握后端签发的**分钟级短期 collab token**；octo 登录态/会话仅用于调 `POST /api/v1/docs/collab-token` 换取该短期 token（见 §4.4 两层令牌链），**绝不把 octo 长效令牌直挂 WS**。这样既做到"一次登录、处处可用"（同源复用 octo 登录态换 token），又满足按文档授权 + epoch 实时撤销 + 泄露面最小。

> **v1 结论（单一口径）**：**v1 = Hocuspocus 独立 WS 承载内容同步（Yjs sync + awareness），WuKongIM 仅承载业务通知；WS 走两层令牌链——provider 握后端签发的分钟级短期 collab token，octo 登录态仅用于换取该短期 token（见 §4.4），绝不把 octo 长效令牌直挂 WS。WuKongIM 桥接 Yjs 为 v2 待评估项，不进 v1。**

### 6.2 选型理由

1. **协议零封装**：Yjs sync 协议复杂（state vector、SyncStep1/2、awareness 过期），Hocuspocus 已完整实现并经社区验证。在 WuKongIM 上重造这套协议是高风险、高维护成本的自研工作。
2. **生态完整**：持久化（extension-database）、横向扩展（extension-redis）、鉴权 hook 都是开箱即用的，复用 WuKongIM 需要把这些能力重新对接一遍。
3. **故障隔离**：文档协作服务与 IM 服务解耦，互不拖累，符合"协作中枢独立可扩展"的定位——文档故障不影响 IM，反之亦然。

### 6.3 v2 展望 / 待评估：WuKongIM 桥接 Yjs（不进 v1）

> ⚠️ **本节为 v2 待评估项，不进 v1，需 v2 单独立项 RFC 评估。** 以下「桥接方案」对比分析仅作为后续评估的留档材料，v1 正文不将其作为并列可选项。

**待评估方案：复用 WuKongIM 通道承载 Yjs**——把 Yjs sync/awareness 二进制封装成 WuKongIM 的自定义消息类型，借其连接管理与鉴权下发，目标是省一条对外 WS 连接。其与 v1 方案的对比留档如下：

| 维度 | v1：Hocuspocus 独立 WS | v2 待评估：复用 WuKongIM 通道 |
| --- | --- | --- |
| 协议契合度 | 高：Yjs sync 协议是 Hocuspocus 原生，零封装 | 低：需把 Yjs 二进制再封装进 WuKongIM 消息体，双层协议 |
| 同步语义 | 直接走 y-protocols（sync/awareness）| 需自实现 update 路由、awareness 过期、SyncStep 往返 |
| 鉴权 | onAuthenticate 直接对接 Octo（见第 4 章）| 可复用 WuKongIM 已建立的鉴权会话，鉴权一次 |
| 持久化/扩展 | extension-database / extension-redis 开箱即用 | 需在 WuKongIM 侧重做持久化与跨节点广播的对接 |
| 多实例扩展 | extension-redis 成熟方案 | 依赖 WuKongIM 的分发，但 CRDT 落库仍需独立做 |
| 运维成本 | 新增一个有状态服务 + 端口 + LB 配置 | 复用现有连接，少一个对外端口；但耦合度高、改造量大 |
| 连接数 | 文档协作与 IM 各一条连接（前端多一条 WS）| 可共用一条连接，省连接数 |
| 演进风险 | 跟随 Hocuspocus/Yjs 社区升级，低风险 | 自研封装层，需长期维护，跟随两套上游 |
| 故障隔离 | 文档故障不影响 IM，反之亦然 | 协作流量与 IM 流量互相影响 |

**评估结论（v2）**：该方案的唯一明确收益是节省一条对外连接，但代价是双层协议自研、持久化/扩展能力重做、故障域耦合。**v1 不采纳**；若后续连接数成为瓶颈，**优先考虑在网关层做 WS 多路复用**（不在应用层耦合两套协议），桥接复用方案则留待 v2 单独立项 RFC 评估。

---

## 7. Agent / CLI 编程接口

除人类用户通过 Tiptap 编辑外，平台需要让 **Agent / CLI / 后台任务**程序化地创建、读取、编辑文档（如智能摘要写回、模板生成、批量处理）。服务端没有 DOM，因此使用 Yjs + y-prosemirror 的**无 DOM 转换函数**。

### 7.1 无 DOM 的 ProseMirror ↔ Y.Doc 转换

`y-prosemirror` 提供纯函数转换，可在 Node.js 服务端运行：

```ts
import * as Y from 'yjs'
import { prosemirrorToYDoc, yDocToProsemirrorJSON } from 'y-prosemirror'
import { buildSchema, COLLAB_FIELD } from '@octo/docs-schema' // 冻结共享包：ProseMirror schema + field 常量，前端产出、后端 import
const schema = buildSchema()

// 读：Y.Doc → ProseMirror JSON（供 Agent 理解内容）
function readDoc(state: Uint8Array) {
  const ydoc = new Y.Doc()
  Y.applyUpdate(ydoc, state)
  return yDocToProsemirrorJSON(ydoc, COLLAB_FIELD) // COLLAB_FIELD = 共享的 XmlFragment 字段名（取自 @octo/docs-schema）
}

// 写：ProseMirror JSON / Node → Y.Doc
function buildDoc(pmNode) {
  const ydoc = prosemirrorToYDoc(pmNode, COLLAB_FIELD)
  return Y.encodeStateAsUpdate(ydoc)
}
```

**关键约束：服务端使用的 ProseMirror schema 必须与前端 Tiptap 配置严格一致**（节点/标记定义、共享字段名）。schema 不一致会导致转换错位或内容丢失。为此，schema 与共享字段名常量 `COLLAB_FIELD`（Tiptap `extension-collaboration` 默认字段，值为 `'default'`）统一由**冻结共享包 `@octo/docs-schema`** 提供（`buildSchema()` 构造 schema、`COLLAB_FIELD` 提供字段名常量），由前端产出、后端与 Agent 转换 import 共用——与前端 §9 对齐，**不再各处硬编码 `'default'` 字符串**，避免定义/常量漂移。

### 7.2 REST/gRPC 接口

为 Agent 暴露一组内部接口（与第 8 章面向前端的元数据 API 同源，但增加内容读写）：

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| POST | `/internal/agent/docs` | 创建文档（可附带初始 ProseMirror JSON）|
| GET | `/internal/agent/docs/:docId/content` | 读取文档内容（返回 ProseMirror JSON / Markdown）|
| PATCH | `/internal/agent/docs/:docId/content` | 编辑文档（应用一段变更）|
| POST | `/internal/agent/docs/:docId/append` | 在文末追加内容（最常见的 Agent 写法）|

接口受内部鉴权（service token / mTLS）保护，并复用文档权限模型（`resolveRole` = doc_member + owner；Agent 以某身份操作，受同样的权限约束）。

### 7.3 写入必须走 Yjs 事务并广播

Agent 的写入**不能直接覆盖 DB 里的二进制**（会丢失正在线上编辑用户的并发变更）。正确路径是：**把变更作为 Yjs update 应用到"活的"文档上，并通过协作总线广播**，让在线用户实时看到 Agent 的编辑。

**统一实现 —— 通过 Hocuspocus 的 server-side direct connection（方式 A）**

Hocuspocus 提供服务端直连 API（`server.openDirectConnection(documentName, context)`），让服务端代码像一个"客户端"一样接入某文档，在事务中修改后自动走标准的同步+持久化+广播路径。在主节点路由（§5.2）下，direct connection 接入的就是该文档的唯一内存副本，与单写者一致，不会制造多写者分叉。

**权限前置校验是强制的**：`openDirectConnection` 绕过 `onAuthenticate`，因此 REST 处理器**必须在开连接之前**显式做权限校验（`resolveRole` = doc_member + owner；Agent 以某身份操作，受与人类用户同样的权限约束）：

```ts
// REST: PATCH /internal/agent/docs/:docId/content
async function handleAgentWrite(req, res) {
  const documentName = await docMetaRepo.resolveDocumentName(req.params.docId)
  if (!documentName) return res.status(404).json({ error: 'not_found' })

  // 1. 强制权限前置校验：Agent 身份对该文档需具备 writer 及以上（resolveRole 查 doc_member+owner）
  //    acting uid（req.agentIdentity.id）必须来自可信内部签发/网关注入并经服务端校验，
  //    【严禁】由调用方在请求体里自填（否则可自选 admin 身份绕过权限校验，见下方 P2-I）。
  const role = await resolveRole(req.agentIdentity.id, req.params.docId)
  if (role !== 'writer' && role !== 'admin') {
    return res.status(403).json({ error: 'forbidden' })
  }

  // 2. 经 Y.Doc 事务合并写入（走标准同步+持久化+广播路径）
  const connection = await server.openDirectConnection(documentName, {
    user: { id: req.agentIdentity.id, name: 'Agent' },
    role,
  })
  await connection.transact((doc) => {
    const fragment = doc.getXmlFragment(COLLAB_FIELD) // 与 §7.1 一致，取自 @octo/docs-schema，不硬编码 'default'
    applyProseMirrorChange(fragment, req.body.change) // y-prosemirror 工具，事务内
  })

  // 3. 同步语义：等落库完成后再返回（见下）
  await connection.disconnect() // disconnect 触发最终 store；落库完成后 resolve
  return res.status(200).json({ ok: true })
}
```

> **删除了旧版「方式 B —— 离线文档 + 重放」**：方式 B 要求"先确认无活跃连接"，但该判断在多节点集群中是 racy 的（确认与写入之间可能有连接接入到另一节点），会与方式 A 路径冲突、制造多写者副本。**生产统一走方式 A**，由主节点路由 + 文档锁保证单写者。

**Agent 写端点的属主节点路由（硬约束，P1-A）**

`openDirectConnection` 会在执行它的进程内**加载该文档的内存副本**。若 Agent 的 HTTP 写请求落到**任意无状态节点**直接 open，该节点会**注水出第二份内存副本**——破坏 §5 的单写者前提；更糟的是，在陈旧 base 上做**位置型 PATCH**（ProseMirror 偏移）会相对错误的文档状态错位。因此 documentName 一致性哈希**不能只施加在 WS 连接上**，**Agent 写端点同样必须按 documentName 亲和路由到该文档的属主节点（owner node）**：

- **硬约束：`openDirectConnection` 只允许在属主节点执行。** §7.3 原先"主节点路由下 direct connection 接入唯一内存副本"是**隐含假设**，此处**升为显式硬约束**——非属主节点**禁止**直接 open（否则即制造多写者副本）。
- **Agent 写端点 `/internal/agent/docs/*` 必须经与 WS 同源的 `documentName` 一致性哈希亲和路由到属主节点。** 两种实现任选其一并写清：
  1. **网关直接亲和路由**：网关层对 `/internal/agent/docs/*` 按 documentName 用**与 WS 相同的一致性哈希**直接路由到属主节点（该节点须运行 Hocuspocus server 实例、能执行 openDirectConnection）。
  2. **属主节点代理转发**：收到请求的节点若**非属主**，按连接注册表 / 一致性哈希查出属主节点，并把请求 **HTTP 代理转发**到属主节点执行 openDirectConnection；不在本地 open。
- **属主未知 / 不在线时**：由一致性哈希**确定性地**选出属主候选节点，并在该候选节点 openDirectConnection（其加载即成为该文档的唯一内存副本），避免"任意节点各自加载"造成的多副本分叉。

> **P2-I · on-behalf acting uid 不可由调用方自填**：`/internal/agent` 的 on-behalf 写入，其 **acting uid 的身份来源必须是可信内部签发的服务间凭证 / 网关注入的身份头**，并由服务端校验；**严禁信任调用方在请求体自带的 uid**——否则调用方可自选一个 admin 身份绕过权限前置校验。授权边界与人类用户一致：acting uid 对该文档需具备 writer 及以上（由上方 `resolveRole` = doc_member + owner 强制），Agent 不因"内部接口"获得越权豁免。

**同步 REST 语义（二选一，写清）**：

- **落库后才返回 200**：处理器 `await connection.disconnect()`（其内部触发最终 `store`）完成后才响应 200，调用方收到 200 即代表已耐久落库。本文档示例采用此语义。
- 或 **返回 202 Accepted**：若不想阻塞等待落库，立即返回 202 表示"已接受、异步落库中"，由调用方按需轮询确认。

不再用"同步返回 200"暗示已落库——单纯 `transact` 返回不代表已写入 DB。

**写入时序：**

```
Agent/CLI ──REST──▶ 网关 / 属主路由
                      │ 按 documentName 亲和定位属主节点（查文档锁/连接注册表）
                      │ 与 WS 同源一致性哈希 → 路由 / 代理转发到属主 Hocuspocus 节点
                      ▼
                    REST 处理器（属主节点）
                      │ resolveDocumentName(docId)  （404 if 不存在）
                      │ resolveRole → 强制权限前置校验（403 if < writer）
                      │ openDirectConnection(documentName)  ← 属主节点唯一内存副本（禁在非属主节点 open）
                      │ doc.transact(() => 写入 PM 变更)
                      │ ── update ──▶ 广播给在线 ClientA/B（实时可见）
                      │ ── (Redis pub) ──▶ 其它节点
                      │ disconnect() → onStoreDocument ──▶ DB（落库）
            ◀─ 200/202 ─│  200=落库后返回 / 202=已接受异步落库
```

要点：所有写入都在 Yjs 事务中完成（保证原子性与正确的 CRDT 时钟），经统一的广播/落库路径，使 Agent 编辑与人类编辑在同一致性模型下无缝合并；权限前置校验（resolveRole = doc_member + owner）+ 主节点路由保证 Agent 写入既不越权也不制造多写者。

---

## 8. 前后端交互契约（与 Boris 前端方案对齐）

> 本章是前后端的**正式契约**，任何字段/路径/错误码变更都需双方评审。

### 8.1 连接握手

前端使用 `HocuspocusProvider` 连接：

```ts
import { HocuspocusProvider } from '@hocuspocus/provider'

const provider = new HocuspocusProvider({
  url: 'wss://docs.octo.example.com/collab', // 网关 → Hocuspocus
  name: documentName,                         // documentName 约定见下
  token: async () => await fetchCollabToken(documentName), // 短期 collab 专用 token（连接/重连前取最新）
  document: ydoc,                             // 前端已建的 Y.Doc
})
```

| 契约项 | 约定 |
| --- | --- |
| 连接 URL | `wss://<host>/collab`，生产强制 `wss`（TLS）|
| `name`（documentName / document_name）| Hocuspocus 路由/持久化键，格式 `octo:{space}:{folder}:{doc}`，其中 `{doc}` 段取自业务主键 `doc_meta.doc_id`；该完整字符串即 `doc_meta.document_name` 与 `yjs_document.document_name`（见 §3.4 / 附录 B）|
| `token` | 短期 collab 专用 token；前端先调 `POST /api/v1/docs/collab-token` 取得，provider 用函数式 `() => Promise<string>` 传入，连接/重连即取最新 |
| 协议 | Yjs sync protocol + awareness（由 provider/server 实现，前端无需关心）|
| 重连 | provider 内置指数退避自动重连；token 过期需前端重新调签发接口刷新 collab token 后重连 |

documentName 命名约定：`octo:{space}:{folder}:{doc}`，各段含义：

- `octo:` — 顶层命名空间前缀，为白板等其它协作内容类型预留扩展空间（如白板用 `octo:...:wb:` 形式）。
- `{space}` — space_id（docs 空间 / 多租隔离维度）。
- `{folder}` — **docs 原生文件夹 id**（v2.0 重定义）。**不再是 octo group_no、不派生权限**——仅用于组织归类与路由。下文「迁移影响」详述兼容性。
- `{doc}` — doc_id（= `doc_meta.doc_id`）。

后端从中解析归属用于路由（**不用于鉴权**，权限来自 doc_member + owner，见 §4.2）。**前端不得自行编造 doc_id**——doc_id 由"创建文档" API（8.4）返回。

**非对称命名约定（文档键 vs 白板键）**：文档侧只受理 **4 段** `octo:{space}:{folder}:{doc}`；白板键为 **5 段** `octo:{space}:{folder}:wb:{board}`（第 4 段为字面量 `wb`）。`parseDocumentName` 做非对称判别——遇到 5 段且 `parts[3] === 'wb'` 的白板键，**由文档后端拒绝**（白板不共享文档 Y.Doc/通道，连接路径 4403/4404）；文档键必须严格 4 段且 `{doc}` 段不得含 `:`、不得等于字面量 `'wb'`（详见 §4.1 step 5 / 附录 B 校验矩阵）。

> **`{group}`→`{folder}` 重定义的迁移影响（关键）**：本次仅改第 3 段的**语义**（octo group_no → docs 文件夹 id），**不改键的结构（段数/分隔/位置）**，因此：
> 1. **键格式零迁移、字节级兼容**：存量 `document_name` 字符串**原样有效**——第 3 段那个曾经是 group_no 的值，迁移期**原样作为该文档的 `folder_id` 落库**（`folder_id := documentName 第 3 段的旧 group 值`），当作一个不透明的 docs 文件夹 id 继续保留。如此 **既不重写 `document_name`、也不改 Y.Doc 二进制**，且 `folder_id` 与键第 3 段天然一致（满足 §8.1 / §4.1 的「第 3 段 == folder_id」不变量）。`doc_meta.document_name` / `yjs_document.document_name` 唯一键、`fetch/store` 路由**全部不变**，**无需重写 Y.Doc 二进制、无需改持久化键**。**注意：保留默认文件夹 `f_default` 仅用于「新建时省略 folderId」的新文档（见 §8.4），不适用于存量文档**——存量文档一律保留其旧第 3 段值为 folder_id，绝不迁入默认文件夹（否则 folder_id 会与 document_name 第 3 段不符）。
> 2. **白板 5 段非对称判别完全不受影响**：判别只依赖 `parts.length===5 && parts[3]==='wb'`（位置型），与第 3 段叫什么无关，故白板键（`octo:{space}:{folder}:wb:{board}`）的识别/拒绝逻辑**零改动**，与白板栈的兼容性保持。
> 3. **唯一的行为变化是「权限不再读第 3 段」**：v1.x 用第 3 段 group_no 做群继承鉴权，v2.0 起鉴权只看 `doc_member`+owner，第 3 段退化为纯组织维度。迁移须配合 §4.2 / §3.4 的 doc_acl→doc_member 数据迁移，确保每篇文档至少有 owner/admin 已落库。
> 4. **评估过的两个替代方案（均被否决）**：① **直接删除第 3 段**（变 3 段 `octo:{space}:{doc}`）——会破坏与白板 5 段键的「4 vs 5」非对称判别基线，迫使白板栈同步改 parse，跨栈风险高，**否决**；② **用 owner 维度替换第 3 段**——owner 已在 `doc_meta.owner_id`、且 owner 可转移会导致键漂移（键必须稳定不可变），**否决**。保留「4 段、第 3 段为稳定 folder id」是改动面最小、跨栈兼容最好的形态。

### 8.2 鉴权失败/权限不足错误码

鉴权阶段失败通过 **WebSocket close code** 返回；provider 触发 `onAuthenticationFailed` / `onClose` 事件，前端据 code 处理：

| Close Code | 含义 | 触发条件 | 前端处理 |
| --- | --- | --- | --- |
| 4401 | Unauthorized | **可刷新**语义：collab token 缺失/无效/过期，或 token 的 permission_epoch 落后但复核后该用户仍有权（见 §4.1 step 3） | 静默重新调 `POST /api/v1/docs/collab-token` 刷新 collab token 后重连；持续失败 → 跳转登录 |
| 4403 | Forbidden | **永久无权**语义：彻底失权（移出成员/文档删除/当前 role=none），或 token 的 documentName 与连接 documentName 不匹配 | 展示"无权访问"页，停止重连（不刷新、必要时跳登录）|
| 4404 | Not Found | 文档不存在或已删除 | 展示"文档不存在"，停止重连 |
| 4409 | Conflict | 文档状态异常（如归档/锁定）| 展示对应提示 |
| 4429 | Too Many Requests | 触发连接级限流 | 退避后重连 |
| 1011 | Internal Error | 服务端异常 | 退避重连 + 上报 |

只读用户（reader）**连接成功**，但服务端通过 `connectionConfig.readOnly` 在**应用写消息之前**拒写（对直写路径再由 `beforeHandleMessage` 复查，见 §4.1）。前端的初始只读 UI **直接用 `POST /api/v1/docs/collab-token` 出参的 `role`**（创建文档 API 8.4 也返回 role），无需等待服务端下发——避免依赖"首帧 stateless 先于 SyncStep2 到达"这一无法保证的时序。stateless 通道仅用于「会话中途 role 变更」的后续通知（见 §8.3，时序不敏感）。

#### 8.2.1 越权写拒绝粒度（连接级 + 消息级，非 update 级）

越权写拒绝的实际粒度是 **连接级 + 消息级两层，不存在 update 级**（Hocuspocus v4 / y-prosemirror 架构事实）：

- **连接级 `connectionConfig.readOnly`**：reader 整条连接不可写，服务端在**应用 update 之前**丢弃其全部写消息（`onAuthenticate` 设 `readOnly = true`，见 §4.1）。
- **消息级 `beforeHandleMessage`**：对一条 sync 消息可整条拒绝或直接断连（纵深防御，复查 `role` / `permission_epoch`）。
- **不存在 update 粒度的选择性拒绝**——Hocuspocus / y-prosemirror **无法**在一条 sync 消息内挑选某几个 Yjs update 接受、另几个拒绝；`onChange` 在 update 已 merge 进内存 Y.Doc **之后**才触发，**不能当权限闸门**。

对前端的契约含义（**前后端契约边界**）：**被降权用户翻 `readOnly` 后，其后续写消息被整体拒绝，后端不做逐条对账（不会悄悄丢弃单条越权 update）**。因此前端在乐观离线/降权窗口内产生的本地越权编辑，**必须由前端自行回滚**——用 UndoManager 回滚，或重载服务端权威快照——**不能假设后端会逐条丢弃越权 update**。

> **stateless 降级帧是 best-effort，不保证送达（P2-C，契约边界）**：§4.5 的 stateless `role-change` 降级帧走"发后即忘"通道，**可能丢失**——若前端**仅依赖收到 stateless 帧才切只读 UI**，丢帧将导致静默丢编辑（用户以为可写、实则被服务端拒）。因此契约明确：**权威闸门是「服务端拒写 + 前端对被拒写的显式回滚」**，stateless 帧只是**时序不敏感的优化通知**。**写被拒时前端必须显式回滚本地编辑并给用户提示**（呼应上文 readOnly 后前端自行回滚）；前端**不得仅凭是否收到 stateless 帧来决定能否写入 / 切 UI**。初始 role 仍以 `POST /api/v1/docs/collab-token` 出参为权威（见 §8.2）。

### 8.3 awareness 字段约定

awareness 用于呈现"谁在线、光标在哪"。前端 `provider.setAwarenessField` 写入，约定字段：

```ts
provider.awareness.setLocalStateField('user', {
  id: 'u_12345',          // Octo user id（必填）
  name: '张三',            // 显示名（必填）
  color: '#F5A623',       // 光标/选区颜色，前端按 user id 稳定生成（必填）
  avatar: 'https://...',  // 头像 URL（可选）
})
// 光标/选区由 y-prosemirror 的 collaboration-cursor 自动维护，字段名 'cursor'
```

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `user.id` | string | 是 | Octo user id，需与鉴权身份一致（后端可校验防伪造）|
| `user.name` | string | 是 | 协作者显示名 |
| `user.color` | string(hex) | 是 | 光标/选区颜色；同一 user 跨会话稳定 |
| `user.avatar` | string | 否 | 头像 URL |
| `cursor` | object | 否 | 由 y-prosemirror 维护的 ProseMirror 选区锚点 |

awareness 不持久化；断连后该 client 状态自动过期清除（默认约 30s 无更新即移除）。

> **awareness 仅用于 presence/cursor**（在线状态、光标、选区、用户名/颜色），**不承载权限**。初始 `role` 由 `POST /api/v1/docs/collab-token` 出参提供（见 §4.4 / §8.2），**不经 stateless 首帧下发**（该时序无法保证）。stateless 通道仅作「会话中途 role 变更」的后续通知（如管理员在线期间调整了某人权限，时序不敏感）。职责分离：awareness = 谁在线/光标在哪，stateless = 后端→前端的中途权限变更/旁路通知。

**stateless role 变更帧结构约定**：运行期 role 变更经 stateless 通道下发，帧结构如下：

```ts
interface RoleChangeFrame {
  type: 'role-change'
  role: 'reader' | 'writer' | 'admin'  // 变更后的新 role
  permission_epoch: number             // 本次变更对应的文档权限版本号（语义见 §4.5）
  issuedAt: string                     // 签发时间（ISO8601），仅用于诊断/日志
}
```

前端处理规则（**单调校验**）：前端维护"已应用 `permission_epoch`"游标，按 `permission_epoch` **单调递增**接受帧——**丢弃 `permission_epoch` 比当前已应用值更低（或相等）的帧**。此规则防止旧 writer 帧因网络乱序晚到、覆盖已应用的新 reader 帧而导致权限回退（如 writer→reader 降权后，乱序晚到的旧 writer 帧若被应用会错误恢复写权限）。`permission_epoch` 每文档单调递增、每次 `doc_member` 变更 +1，其语义见 §4.5。

> **stateless 帧不保证送达（P2-C）**：上述帧是 best-effort 通知，可能丢失；权威闸门是**服务端拒写 + 前端对被拒写的回滚提示**，前端**不能仅依赖 stateless 帧切 UI**（见 §8.2.1）。

#### 8.3.1 awareness 身份校验与字段约束（P2-D）

awareness 由客户端自行 `setLocalStateField` 写入并广播，**必须在服务端校验，不可全盘信任客户端上报**。以下为 **MUST 级可执行契约**——服务端在 `onAwarenessUpdate` 中对每个变更的 client state 逐项校验，任一不满足即拒绝该 awareness 帧：

```
onAwarenessUpdate({ added, updated, removed, awareness, states }, context):
  for each changed clientId state s:
    // MUST: 身份不可冒充——上报 user.id 必须 ≡ 该连接 onAuthenticate 已认证的 uid
    if s.user?.id !== context.user.id: reject this awareness update
    // MUST: color 必须匹配 ^#[0-9a-fA-F]{6}$（防注入 CSS style 造成 CSS 注入）
    if !/^#[0-9a-fA-F]{6}$/.test(s.user?.color): reject
    // MUST: name 必须是 string 且长度 <= 64（超长则截断到 64 或拒绝）
    if typeof s.user?.name !== 'string' || s.user.name.length > 64: reject (或截断到 64)
    // 可选：avatar 若使用，须为合法 URL 且 scheme 限定（如仅 https）
```

- **身份校验（防 presence 冒充）**：服务端在 `onAwarenessUpdate` 中比对上报的 `state.user.id` 是否 **≡ 该连接 `onAuthenticate` 已认证的 uid**；**不一致即拒绝该 awareness 更新**（防止用户 A 冒充用户 B 的在线状态/光标）。
- **字段约束（类型/长度/格式）**：`user.color` **必须为合法 hex 颜色**（`^#[0-9a-fA-F]{6}$`），拒绝任意字符串；`user.name` **必须为 string 且长度 ≤ 64**（超长截断或拒绝）；`avatar` 若使用须校验为合法 URL（限定 scheme，如仅 `https`）。

> **职责边界（写死）**：awareness 是**客户端广播**，**后端只能校验长度/类型/身份并拒绝非法帧**——后端**不负责 HTML 转义，也无法替代前端转义**；**真正防 XSS 的 HTML 转义责任在前端渲染层**（前端 `collaboration-cursor` 渲染显示名时做 escape）。即：**后端校验类型/长度/身份 + 前端负责渲染转义**，两者各司其职，不可相互替代。

非法的 awareness 字段予以拒绝（服务端按上面 MUST 契约拒帧，前端渲染前再 escape），awareness 仅承载 presence/cursor，**不承载权限**（见 §8.2 / §9.6）。

### 8.4 文档元数据 API 契约（REST）

元数据操作走标准 REST（非 WebSocket）。所有接口需带 **octo 登录态**（同源场景下 octo-web 的 apiClient 自动注入 `token` 头，见 §4.7（c）），后端按 §4.2（doc_member + owner）校验权限。

> 说明：**业务/元数据 REST 接口用 octo 登录态鉴权**（同源 `token` 头）；**协作 ws 连接用后端签发的短期 collab 专用 token**（见 4.4，由 `POST /api/v1/docs/collab-token` 签发）。两者职责分离，不可混用。下文示例中的 `Authorization: Bearer <token>` 为通用占位写法；同源集成下实际由 apiClient 注入 octo `token` 头。

**创建文档**

```
POST /api/v1/docs
Authorization: Bearer <token>
Content-Type: application/json

Request:
{ "spaceId": "s_001", "folderId": "f_888", "title": "需求评审纪要", "docType": "doc" }
# folderId 可选；省略则归入空间保留默认文件夹 `f_default`（非空，见 §3.4 DDL）。spaceId/folderId 仅组织维度，不决定权限。
# documentName 第 3 段恒等于落库的 folder_id（省略时即 `f_default`），键与 folder_id 始终一致（见 §8.1）。
# 创建者自动成为 owner（doc_meta.owner_id），隐含 admin（见 §4.2），无需额外写 doc_member。

Response 201:
{
  "docId": "d_abc123",
  "documentName": "octo:s_001:f_888:d_abc123",
  "title": "需求评审纪要",
  "spaceId": "s_001",
  "folderId": "f_888",
  "ownerId": "u_12345",
  "role": "admin",
  "createdAt": "2026-06-13T08:00:00.000Z"
}
```

**文档列表**

```
GET /api/v1/docs?spaceId=s_001&folderId=f_888&page=1&pageSize=20&sort=updatedAt:desc
Authorization: Bearer <token>

Response 200:
{
  "total": 42,
  "items": [
    { "docId": "d_abc123", "title": "需求评审纪要", "ownerId": "u_12345",
      "role": "writer", "updatedAt": "2026-06-13T09:30:00.000Z" }
  ]
}
```

**重命名**

```
PATCH /api/v1/docs/{docId}
Authorization: Bearer <token>
{ "title": "需求评审纪要(终稿)" }

Response 200: { "docId": "d_abc123", "title": "需求评审纪要(终稿)" }
```
> 注意：title 是**元数据**，改名走此 REST，不经 Y.Doc。若 title 也需在正文显示，前端可把标题节点同时纳入 Y.Doc（由 Boris 方案决定），但元数据 title 始终是列表/搜索的权威字段。

**删除（软删）**

```
DELETE /api/v1/docs/{docId}
Authorization: Bearer <token>
Response 200: { "docId": "d_abc123", "status": "deleted" }
```

**成员管理（doc_member，需 admin）**

```
GET  /api/v1/docs/{docId}/members                  # 列出成员（需 admin）
Response 200: { "items": [ { "uid": "u_67890", "role": "writer", "source": "direct", "grantedBy": "u_12345" } ] }

PUT  /api/v1/docs/{docId}/members                  # 直接添加/改 role（按 uid upsert）
{ "uid": "u_67890", "role": "writer" }          # role ∈ reader|writer|admin；写 doc_member 并 epoch+1
# 服务端**必先校验 uid 是真实存在的 octo 用户**（经 octo 身份查询：单条 GET /v1/users/:uid，
#   或服务层批量 GetUsers，见 §4.7（a）/（b））；uid 不存在 => 404（不向 doc_member 写入幽灵成员）。
# 与链接邀请「仅已注册 octo 用户可接受」（§4.6）一致——两条入会路径都保证 doc_member.uid 为真实 octo 身份。
Response 200: { "ok": true }
Response 404: { "error": "user_not_found" }     # 目标 uid 非注册 octo 用户，拒绝直加/改 role

DELETE /api/v1/docs/{docId}/members/{uid}          # 移除成员（owner 不可被移除）；epoch+1，实时踢连接（§4.5）
Response 200: { "ok": true }
```

**链接邀请（doc_invite，需 admin；接受见 §4.6）**

```
POST   /api/v1/docs/{docId}/invites                # 创建邀请链接（需 admin）
{ "role": "writer", "expiresAt": "2026-06-20T00:00:00.000Z", "maxUses": 0 }   # role 默认 writer；maxUses=0 不限次
Response 201: { "inviteToken": "<token>", "url": "https://<host>/docs/invite/<token>", "role": "writer" }

GET    /api/v1/docs/{docId}/invites                # 列出本文档的有效邀请（需 admin）
DELETE /api/v1/docs/{docId}/invites/{inviteToken}  # 撤销邀请（status=revoked，立即失效）

POST   /api/v1/docs/invites/{inviteToken}/accept   # 受邀人接受（须带 octo 登录态；仅已注册 octo 用户，见 §4.6）
Response 200: { "docId": "d_abc123", "documentName": "octo:s_001:f_888:d_abc123", "role": "writer" }
Response 401: { "error": "login_required" }     # 未登录/无 octo 身份 → 引导先登录/注册
Response 410: { "error": "invite_invalid" }     # 已撤销/过期/用尽
```

REST 错误码：

| HTTP | 含义 |
| --- | --- |
| 200/201 | 成功 |
| 400 | 参数错误 |
| 401 | token 无效/过期（接受邀请时表示需先完成 octo 登录）|
| 403 | 权限不足（如非 admin 改成员/邀请）|
| 404 | 文档不存在 |
| 409 | 状态冲突（已删除/归档）|
| 410 | 邀请已失效（撤销/过期/用尽）|
| 429 | 限流 |
| 500 | 服务端错误 |

### 8.5 初始化时序

```
Frontend (Tiptap)            HocuspocusProvider           Hocuspocus Server          DB
   │ 先调 POST /collab-token 取短期 collab token + role     │                   │
   │ （据 role 立即设只读/可写 UI，不等服务端下发）          │                   │
   │ new Y.Doc()                    │                            │                   │
   │ Tiptap 绑定 Collaboration ext  │                            │                   │
   │ 创建 provider(url,name,token:()=>collab token)─▶│          │                   │
   │                                │ WS connect(collab token) ─▶│                   │
   │                                │                            │ onAuthenticate    │
   │                                │                            │  验签+exp+docName+epoch │
   │                                │◀──── auth ok ──────────────│  (reader→readOnly) │
   │◀── onAuthenticated ────────────│                            │ onLoadDocument    │
   │                                │                            │  fetch(name) ────▶│
   │                                │                            │◀── state(binary) ─│
   │                                │                            │  Y.applyUpdate    │
   │                                │ SyncStep1 (state vector) ─▶│                   │
   │                                │◀── SyncStep2 (diff update) │  (服务端缺失部分)  │
   │                                │── SyncStep2 (client diff) ▶│                   │
   │◀── apply update → 渲染正文 ────│                            │                   │
   │   awareness setLocalState ────▶│ ── awareness(presence) ──▶ │ broadcast 在线用户 │
   │                                │                            │                   │
   │   ===== 此后双向实时同步 =====  │                            │                   │
   │   （如会话中途 role 变更 → stateless 通知 → 翻转 UI）       │                   │
```

要点：前端**先调 `POST /api/v1/docs/collab-token` 取短期 collab token 及 `role`**，据 `role` 立即设只读/可写 UI（不依赖服务端首帧下发，见 §8.2），再建空 Y.Doc 连接。awareness 只承载 presence/cursor（见 8.3）。正文不是通过 REST 拉取 JSON，而是通过 Yjs sync 协议注水（保证 CRDT 一致性）。首屏渲染等待 SyncStep2 应用完成。会话中途的 role 变更经 stateless 通道通知前端翻转 UI。

### 8.6 离线重连与冲突合并语义

| 场景 | 行为 |
| --- | --- |
| 短暂断网 | provider 自动重连；重连后用 state vector 计算缺口，只补传增量，无需全量 |
| 离线编辑 | 前端可启用 `y-indexeddb` 本地缓存离线编辑；重连时把离线产生的 update 推送服务端，与他人编辑**自动 CRDT 合并** |
| 冲突合并 | Yjs CRDT 保证**无冲突弹窗**：并发编辑按 CRDT 规则确定性收敛（如同位置插入按 client id/clock 定序），不会丢失任一方的字符 |
| 长时间离线后回归 | 同样走增量补齐；若服务端已快照压缩，注水后的最新状态与本地离线 update 合并，结果确定且一致 |
| 重连鉴权 | 重连仍走 onAuthenticate；若 token 已过期 → 4401，前端重新调签发接口刷新 collab token 再连 |
| 同一用户多端 | 各端独立连接、独立 awareness（不同 client id），编辑互相实时可见并合并 |

冲突合并语义对前端的承诺：**前端无需实现任何手动合并/冲突解决逻辑**，CRDT 收敛由 Yjs 保证。前端只需保证离线 update 不丢（y-indexeddb）并在重连时交给 provider。

---

## 9. Production-ready 考量

### 9.1 部署拓扑

```
                       ┌──────────────┐
   Clients ── wss ────▶│  API Gateway │── REST ──▶ Meta API 服务（无状态，可水平扩展）
                       │  / LB (WS)   │
                       └──────┬───────┘
                              │ 按 documentName 一致性哈希 (sticky)
              ┌───────────────┼───────────────┐
              ▼               ▼               ▼
        ┌───────────┐  ┌───────────┐  ┌───────────┐
        │Hocuspocus │  │Hocuspocus │  │Hocuspocus │   (有状态，N 实例)
        │  node-1   │  │  node-2   │  │  node-3   │
        └─────┬─────┘  └─────┬─────┘  └─────┬─────┘
              └──── Redis Pub/Sub (协作总线) ┘
              └──── MySQL/PG (权威存储, 主从) ─┘
              └──── COS/S3 (附件) ───────────┘
```

| 组件 | 形态 | 扩展方式 |
| --- | --- | --- |
| API Gateway / LB | 支持 WS Upgrade、长连接、一致性哈希 | 多副本 |
| Meta API 服务 | 无状态 REST（**仅承载不触碰活文档的元数据操作**）| 水平扩展 |
| Hocuspocus 节点 | 有状态（内存活文档）| 水平扩展 + documentName 亲和 |
| Agent 写端点 `/internal/agent/docs/*` | **非纯无状态**：需触碰活文档（openDirectConnection），按 documentName 亲和到属主 Hocuspocus 节点，或由 Meta 节点代理转发 | 随 Hocuspocus 节点 |
| Redis | 协作总线（pub/sub）| 主从 / 哨兵 / 集群 |
| MySQL/PG | 权威存储 | 主从 + 读写分离 |
| COS/S3 | 对象存储 | 托管 |

> **Agent 写路径不是纯无状态 Meta API（P1-A）**：`/internal/agent/docs/*` 要执行 `openDirectConnection`、会加载/触碰文档内存副本，因此它**要么在网关按 documentName 亲和路由到属主 Hocuspocus 节点，要么由收到请求的 Meta 节点代理转发到属主节点**（见 §7.3「Agent 写端点的属主节点路由」），**不能落到任意无状态 Meta API 节点直接 open**（否则注水第二份内存副本、破坏单写者）。**纯无状态、可水平扩展的 Meta API 只承载不触碰活文档的元数据操作**（如 §8.4 的文档列表/重命名/成员/邀请等 REST）。

### 9.2 容错（DB 写失败重试/降级）

| 故障 | 策略 |
| --- | --- |
| onStoreDocument DB 写失败 | 指数退避重试（3 次）；仍失败则**保留内存状态不卸载**、告警，并把状态落地本地磁盘/Redis 临时区作降级备份，待 DB 恢复补写 |
| fetch（注水）失败 | 重试；超阈值拒绝连接（4-1011）并告警，避免用空文档覆盖真实数据 |
| Redis 不可用 | 单节点仍可服务（本地广播正常），仅跨节点同步降级；恢复后自动恢复广播。**不影响权威落库** |
| 节点崩溃 | 该节点内存中未落库的最近编辑（≤ debounce/maxDebounce 窗口）可能丢失。**诚实边界**：`y-indexeddb` 只持久化**发起方自己**的本地编辑——发起者重连后可由 CRDT 把自己的离线编辑补回；但**其他在线协作者**在本节点崩溃前看到、却尚未 flush 的编辑，若发起者已关闭 tab（其 IndexedDB 不再参与重连补传），则该 ≤debounce 窗口内的这部分编辑**无恢复路径**。这是显式可接受边界，靠 `maxDebounce` 限制窗口上界 |
| 防止旧覆盖新 | **不比较状态"新旧"**（state vector 偏序无良定义，见 P0-2）。靠 §5 单写者（单内存副本单写者）避免并发落库；`store` 内 `SELECT ... FOR UPDATE` + merge-on-write 并集作兜底，保证任一份编辑都不被覆盖 |
| auth 热路径（epoch 比对 / doc_member recheck）失败 | **区分「提升类」与「降权/撤销类」**：① **降权/撤销等权限收紧路径**——当 `currentEpoch` 无法从权威源（DB）确认（Redis miss 且 DB 也抖动/不可用）、或该 `{doc}` 已知发生 `doc_member` 变更（已收到失效广播 / epoch 已知抬升）时，**一律 fail-closed**：返回 **4401（可刷新语义，让前端退避后重试）**，**绝不用旧 epoch 缓存放行写权限**——宁可拒绝也不开鉴权旁路。② **不涉权限收紧的读保持**——仅对**已建立、未涉权限收紧**的连接，允许短时读旧 epoch 的缓存容忍（窗口量级 **≤ 数秒 TTL**，配合连接注册表失效广播兜底撤销，见 §4.5），不因 Redis 瞬断拒绝全部连接；该容忍**绝不用于放行写权限、绝不用于权限收紧场景**，一旦 `{doc}` 已知 `doc_member` 变更（失效广播 / epoch 抬升）立即失效并转 fail-closed。**DB / doc_member 库不可用**（stale 分支 recheck 回源失败）同样 **fail-closed（保守拒绝）**——4401 退避重试，**绝不在复核失败时放行**；配合 singleflight + 短 TTL 缓存（见 §4.1）削减回源压力 |

核心原则：**永不用可疑数据覆盖权威存储**——注水失败宁可拒连，落库失败宁可重试+保留内存。

### 9.3 监控指标

| 类别 | 指标 |
| --- | --- |
| 连接 | 当前 WS 连接数、连接建立/断开速率、鉴权失败率（按 close code）|
| 文档 | 内存中活跃文档数、单文档平均/最大连接数、文档加载（注水）耗时 |
| 同步 | update 吞吐（条/s、字节/s）、广播延迟、awareness 更新率 |
| 持久化 | onStoreDocument 频率/耗时、DB 写失败率、快照大小分布、压缩任务耗时 |
| Redis | pub/sub 消息速率、订阅延迟、连接健康 |
| 资源 | 进程内存（活文档占用）、CPU、GC、事件循环延迟 |
| 业务 | 文档创建/删除速率、Agent 写入次数 |

埋点建议用 Prometheus 指标 + Grafana 看板；关键告警：DB 写失败率、注水失败率、内存逼近上限、事件循环延迟过高。

### 9.4 优雅重启时的文档 flush

有状态服务重启/发布时**必须先把内存中未落库的文档 flush 到 DB**，否则丢失最近编辑：

```ts
process.on('SIGTERM', async () => {
  server.enableMessageLogging = false
  // 1. 停止接收新连接（LB 摘流）
  // 2. 对所有内存中文档强制触发 store（绕过 debounce）
  await server.destroy() // Hocuspocus 在 destroy 中会 flush 并触发 onStoreDocument
  // 3. 主动释放本节点持有的全部文档锁（见 §5.3），让接管节点立即可选举为主写者，不必等 TTL 过期
  await releaseAllDocumentLocks()
  // 4. 关闭 DB/Redis 连接
  process.exit(0)
})
```

配合滚动发布：先从 LB 摘除节点（停止新连接）→ 等待存量连接迁移/落库 → `server.destroy()` flush → **主动释放该节点持有的全部文档锁**（不等 TTL，让接管节点立即选举为主写者，见 §5.3 锁生命周期语义）→ 退出。客户端 provider 自动重连到其它节点，状态无缝。

### 9.5 限流

| 层级 | 限流项 | 手段 |
| --- | --- | --- |
| 连接级 | 单 IP / 单用户连接数、连接建立速率 | onConnect 检查 + 网关限流 |
| 消息级 | 单连接 update 速率、消息体大小上限 | beforeHandleMessage 校验 + maxPayload |
| 文档级 | 单文档并发连接上限、单文档 update 体积 | onAuthenticate/onLoadDocument 检查 |
| 资源级 | 单文档大小上限（防超大文档拖垮内存 + 阻塞事件循环）| store 前体积校验，超限拒绝写并告警 |
| REST 级 | 元数据/附件 API 调用频率 | 网关 + 令牌桶 |

> **单文档体积上限与 merge/encode 成本挂钩（P1-D）**：Yjs 的 decode/encode 是**同步 CPU**，store 兜底路径（检测到并发时的 union 合并）与注水路径都需对整篇文档做全量编解码，**成本随文档体积线性增长**，且 union 发生在 `SELECT ... FOR UPDATE` 行锁内——超大文档的一次编解码即可阻塞整个 Node 事件循环、拖慢该节点所有文档。因此**单文档体积须设硬上限**（量级建议：单文档 Yjs 状态控制在 **MB 级以内**，如默认上限 ~5–10MB，按实测调整），`store` 落库前做体积校验：**超限拒绝写入并告警**，引导业务侧拆分文档。diffUpdate 旁路（§3.2）只能省掉正常路径的冗余 re-encode，**不能消除超大文档本身的编解码/注水成本**，故体积上限是必需的兜底。

### 9.6 安全

| 面向 | 风险 | 缓解 |
| --- | --- | --- |
| 鉴权 | token 伪造/重放 | JWT 验签 + 短有效期 + 与 Octo 统一身份 |
| 授权 | 越权读写 | 签发 token 时按 doc_member + owner 计算 role 并写入 claims；reader 由 `connectionConfig.readOnly` 在应用前拒写；`doc_member` 变更经 `permission_epoch` + 连接注册表实现撤销/降级**实时生效**（close(4403)/翻 readOnly），「提升」允许 ≤5min 残留窗口（显式边界，见 §4.5）|
| presence / awareness | 冒充他人在线/光标、字段注入 | **身份校验**：`onAwarenessUpdate` 比对上报 `state.user.id` ≡ 该连接 `onAuthenticate` 已认证 uid，不符即拒（防 presence 冒充）；**字段净化**：`color` 限合法 hex 白名单（`^#[0-9a-fA-F]{6}$`，防 CSS 注入）、`name` 限长（≤64）+ 渲染转义（防 XSS）；见 §8.3.1 |
| 注入 | 内容/元数据注入 | REST 参数化查询；正文是 CRDT 二进制不解释为代码；导出 HTML 时做 XSS 净化（sanitize）|
| 资源耗尽 | 超大文档/海量连接/消息洪泛 | 见 9.5 限流；maxPayload、连接/文档上限、事件循环保护 |
| 传输 | 中间人窃听 | 强制 wss/TLS；附件用签名 URL + 防盗链 |
| 附件 | 任意文件/盗链 | 预签名上传 + MIME/大小校验 + 私有桶 + 临时签名读 URL |
| 多租隔离 | 跨空间数据泄露 | documentName 含 space/folder；鉴权基线按 doc_member + owner；space 作为**补充**权限来源（仅当文档设置了分享 share_scope=anyone_in_space 时对本空间成员生效，见 #64/§4；不改变直接的 owner/doc_member 授权，`effectiveRole=max(直接角色, 分享派生角色)` 只加不减）；Redis key 前缀隔离 |

---

## 10. 技术栈与依赖一览 + License 核验

### 10.1 全链路 License 核验

**强约束：全链路依赖必须为 MIT（或与之兼容的宽松许可，如 ISC/BSD），不得引入 Copyleft（GPL/AGPL）依赖。** 下表为核心依赖的 license 核验（以发布物 license 字段为准，集成前需用 `license-checker` 类工具在 CI 中自动校验）：

| 依赖 | 建议版本 | License | 用途 |
| --- | --- | --- | --- |
| `@hocuspocus/server` | ^4.1.2 | MIT | 协作后端核心（WS、生命周期 hook、文档管理）|
| `@hocuspocus/extension-database` | ^4.1.2 | MIT | DB 持久化适配（fetch/store）|
| `@hocuspocus/extension-redis` | ^4.1.2 | MIT | 多实例 pub/sub 协作总线 + 文档锁 |
| `@hocuspocus/extension-logger` | ^4.1.2 | MIT | 结构化日志 |
| `@hocuspocus/provider` | ^4.1.2 | MIT | 前端连接器（前端依赖，契约对齐）|
| `yjs` | ^13.x | MIT | CRDT 核心 |
| `y-protocols` | ^1.x | MIT | sync/awareness 协议 |
| `y-prosemirror` | ^1.x | MIT | ProseMirror ↔ Y.Doc 转换（前端协作绑定 + 服务端无 DOM 转换）|
| `prosemirror-model` | ^1.x | MIT | ProseMirror schema/文档模型（服务端转换需要）|
| `lib0` | ^0.2.x | MIT | Yjs 依赖的编码/工具库 |
| `ioredis` | ^5.x | MIT | Redis 客户端（extension-redis 底层）|
| `ws` | ^8.x | MIT | WebSocket 实现（Hocuspocus 底层）|

> **Hocuspocus v4 API 形状须知**（本文档代码样例已按 v4 编写）：
> - 只读拦截用 `connectionConfig.readOnly`（在 `onAuthenticate` 的 payload 上设置；在**应用写消息之前**拦截），不再是 v2 的 `connection.readOnly`。
> - `onAuthenticate` payload 提供 `connectionConfig`（含 `readOnly` / `isAuthenticated`）、`documentName`、`token`、`context` 等。
> - awareness 变更钩子为 `onAwarenessUpdate`，回调形状（`added/updated/removed`、`awareness`、`states`）与 v2 不同。
> - 服务端事务来源用 `transactionOrigin`（区分 direct connection / 客户端来源），v4 形状已调整；自定义扩展读取 origin 时按 v4 字段对齐。


前端栈（Boris 方案，列此便于核验链路一致性）：

| 依赖 | License | 用途 |
| --- | --- | --- |
| `@tiptap/core` / `@tiptap/extension-collaboration` | MIT | 富文本编辑器 + 协作绑定 |
| `@tiptap/extension-collaboration-cursor` | MIT | 协作光标（依赖 awareness）|

> 说明：Tiptap 的开源核心为 MIT；其官方付费 **Tiptap Cloud / Pro Extensions** 为商业授权。本方案**仅依赖 MIT 的开源核心**，自建 Hocuspocus 后端，不引入 Tiptap 的商业云服务，从而保持全链路宽松许可。集成时需确认所选 Tiptap 扩展均属 MIT 开源部分。

### 10.2 License 合规流程

1. **CI 门禁**：在 CI 中跑 `license-checker --onlyAllow 'MIT;ISC;BSD-2-Clause;BSD-3-Clause;Apache-2.0'`，发现非白名单 license 即阻断合并。
2. **锁定版本**：用 lockfile 锁定全部传递依赖，避免次级依赖悄悄引入 Copyleft。
3. **定期审计**：依赖升级时复核 license 是否变更。
4. **白名单**：MIT / ISC / BSD / **Apache-2.0 一律放行**（Apache-2.0 的显式专利授权条款对使用方有利，与 CI 门禁 `--onlyAllow` 列表一致）；GPL/AGPL/LGPL 一律拒绝。

---

---

## 11. 白板 v1（M2）服务端权威 repair（XIN-16 契约对齐）

> 本章为白板 v1 M2 后端范围（XIN-26），按 XIN-16《Y.Doc 数据布局 + repair 归属·单一权威契约》落地，并对应契约 §9 的 BE-1~BE-5 同步点。布局与前端 binding（XIN-25）**共用同一份冻结包** `@octo/whiteboard-schema`。

### 11.1 数据布局（契约 §1/§2）

- **elements**：顶层 `ydoc.getMap('elements')`，`key = element.id`，`value = 逐元素 Y.Map<field, value>`（字段级合并，两人改同一元素不同字段无损）。z-order 走元素自带 `index`（fractional-index 字符串），删除走 tombstone（`isDeleted=true` + version 提升），版本仲裁沿用 Excalidraw CAS（`version` 高者胜，相等比 `versionNonce` 小者胜）。
- **files（BE-1）**：顶层 `ydoc.getMap('files')`，`key = fileId`，`value = Y.Map<field>`，字段 = `{ attachId, mimeType, status, createdAt, … }`。**只存引用元数据；`dataURL`/`base64`/任何二进制严禁入 Y.Doc**，二进制走对象存储 + 附件链路。image 元素的 `fileId` 是 `files` 容器的 key，其 `attachId` 字段指向对象存储；`fileId`↔`attachId` 约定写进冻结包。
- **appState / 选区 / 光标**：不入权威 Y.Doc（个人视图态走 awareness）。

### 11.2 冻结共享包 `@octo/whiteboard-schema`（BE-2，契约 §3）

类比 `@octo/docs-schema`（本仓 `src/schema/index.ts` 为其本地 stand-in），白板新建冻结共享包，**前端 binding / 后端 repair 扩展 / 后端 Agent 转换三处 import 同一份**，严禁任一侧硬编码。本仓落点 `src/whiteboard/schema/`，导出：`ELEMENTS_FIELD` / `FILES_FIELD` / `WB_SCHEMA_VERSION` / `WB_ELEMENT_TYPES` / `normalizeElement` 规则集（纯函数）/ `elementSupersedes`（CAS）/ `buildWhiteboardName` / `parseWhiteboardName` / `REPAIR_ORIGIN` / `REPAIR_CLIENT_ID`。包内不依赖 Yjs（前端可原样 vendor）；touch Yjs 的 Y.Map↔element/file 适配在 `src/whiteboard/ydoc.ts`（仅后端）。

`normalizeElement` 的悬空引用剔除覆盖 **`boundElements` / `frameId` / `containerId`** 三者（一律「指向不存活元素 → 剔除 / 置 `null`」，与 frameId 同形），其中 `containerId`（绑定文本的容器元素被删后置 `null`）是 M-5 新增规则。当前 **`WB_SCHEMA_VERSION = 2`**——M-5 将 containerId 清理纳入 normalize 规则时按冻结包策略 1→2 bump（见 §11.5）。

### 11.3 服务端权威 repair（BE-3，契约 §4）

**服务端权威 repair = Hocuspocus 后端扩展，owner 节点单一内存副本上的 `REPAIR_ORIGIN` 修正事务，是 repair 结果的唯一写回方**；前端 binding 只做本地临时 / 渲染前防御 normalize，**绝不写回 Y.Doc**。本仓 `src/whiteboard/repair.ts` 在 `afterLoadDocument`（白板键）挂载 observer 并先跑一次冷启收敛，`beforeUnloadDocument` 卸载。三道防自激闸：

1. **origin 跳过**：`transaction.origin === REPAIR_ORIGIN` 的事务 observer 直接 return（repair 自身的修正写不再触发 repair）。
2. **diff 判空**：`normalizeElement` 后与现值逐字段深比，完全相等不写；干净文档**不开任何事务**（幂等：`normalize(normalize(x)) === normalize(x)`）。
3. **只改变更键**：从 observe `event` 取本次变更元素 id 集做规整，不全量扫图。

repair 事务为服务端 origin、无 client ctx，不受 `beforeHandleMessage` epoch 复核拦截（§4.5），符合「服务端权威」语义；权限裁决只作用于客户端来源写。repair 职责含：`normalizeElement` 规则（补 / 修 version·versionNonce·index、钳制非法数值、剔除悬空 boundElements/frameId/containerId、**未知字段原样保留**）、**丢弃指向不存在 file 的 image 元素**、**GC 无元素引用的 file**（依赖 §11.1 的 `Y.Map('files')`）。`normalizeElement` 规则集与前端本地防御**共用冻结包同一份**，区别只在谁有权写回。悬空 `containerId` 清理为 M-5 新增（`WB_SCHEMA_VERSION` 1→2，见 §11.5）。

### 11.4 Agent 写入（BE-4，契约 §5）

Agent 走方式 A（owner 节点 `openDirectConnection` + Yjs 事务）写入同一 `Y.Map('elements')`/`Y.Map('files')`，经同一服务端 repair observer 规整，受同一 `resolveRole` 权限裁决（writer+），无 repair / 权限豁免。**写图**：先 `presignUpload` 拿 `attachId`，再在 `Y.Map('files')` 落引用元数据 + image 元素引用其 fileId；**严禁 Agent 往 Y.Doc 塞二进制**。acting uid 来自可信内部凭证，严禁信任请求体自带 uid。

### 11.5 版本 / 兼容（BE-5，契约 §6）

`WB_SCHEMA_VERSION` 归属冻结包，**与 PM `SCHEMA_VERSION=15` 严格隔离**；白板 `doc_version.schema_version` 走 `WB_SCHEMA_VERSION`，`gateSchema` 不与 PM 版本混用。未知字段透传三端一致（前端 binding / 服务端 repair / Agent 转换都只修已知字段、未知字段原样保留）。

**版本记录**：`WB_SCHEMA_VERSION` 历经 v1 → v2：

- **v1**：基线——id/type 校验、version/versionNonce 确定性补齐、数值钳制、fractional-index 校验、悬空 `boundElements` + `frameId` 剔除、悬空 image 丢弃、孤儿 file GC。
- **v2（M-5）**：normalize 规则新增「清理悬空 `containerId`」（绑定文本的容器元素被删 → `containerId: null`，与 v1 `frameId` 同形）。按冻结包策略 1→2 bump，FE/BE 同步发布，无新增元素类型、未知字段透传不变。

冻结包策略：**布局或 `normalizeElement` 规则变更必须 bump `WB_SCHEMA_VERSION`，FE/BE 同步发布**（不留单侧新规则的灰度窗口）。

### 11.6 auto 崩溃恢复快照（XIN-26 item 5）

v1 保留白板的 auto 快照崩溃恢复点（纯后端）。`deriveDocId` 由白板键的 board 段派生 docId（`octo:{space}:{folder}:wb:{board}` → `board`），复用既有 `doc_version` + KIND_AUTO 路径，无 schema 迁移；named / restore UI 后置。

### 11.7 测试章节

下列后端单测覆盖白板 v1 M2（与契约 §10 / XIN-15 ③ 对齐）：

- **白板键放行矩阵**：`parseDocumentName` 5 段 `:wb:` 非对称判别；鉴权 / token 签发 / recheck / 路由对白板键放行（不再 4403）。
- **`normalizeElement` 规则**：version/versionNonce 确定性补齐、数值钳制、index 校验、悬空 binding/frameId/containerId 剔除、悬空 image 丢弃、未知字段透传、幂等、不可变输入。
- **repair 防自激**：diff 判空（干净文档零事务）、`origin === REPAIR_ORIGIN` 跳过（live observer 不自激成环）、变更键 scoping、悬空 image 丢弃 + 悬空 file GC。
- **M-11 修复写回确定性单测（XIN-21，对应前端 T20）**：**同一非法态（同一份非法 Y.Doc 元素集），在 N ≥ 3 个不同 worker / Hocuspocus 实例上各自冷启跑服务端权威 repair，必须产出 byte 级一致的结果**——`encodeStateAsUpdate` 两两 byte 相等、同一 fractional-index（z-order）key 序、同一存活元素集、任两实例合并幂等（已收敛）。
  - **验证方法**：构造一份含非法字段（坏 version / NaN 数值 / 缺 index / 未知 type / 悬空 image / 孤儿 file / 悬空 containerId）的持久化 Y.Doc 二进制（一份 DB blob），在 N 个独立实例上分别 `repairWhiteboardState(blob)`，断言全部输出 byte 相等 + z-order key 序一致 + 存活元素集一致 + 悬空 containerId 被清为 null（M-5 真覆盖）+ 两两合并后规范再编码不变。
  - **确定性关键**：repair 冷启写回使用**固定保留的 `REPAIR_CLIENT_ID`**，使各实例新建 struct 的 client 归属一致——这是「服务端权威唯一写回 + 跨集群靠 diff 判空兜底」在 failover / 多 owner 场景 byte 收敛的支点。控制用例验证：不固定 client id 时两实例 repair 同输入会发散，固定后收敛。
  - 本条**不被** repair 幂等 / 防自激泛化覆盖，需独立钉死（Ken C12 判定）。
  - 落地：`test/whiteboardRepairDeterminism.test.ts`、`test/whiteboardRepair.test.ts`、`test/whiteboardSchema.test.ts`。

---

## 附录 A：关键决策摘要

| 决策点 | 结论 | 依据章节 |
| --- | --- | --- |
| 权威存储格式 | Y.Doc 二进制（非 JSON）| §3.1 |
| 元数据与二进制 | 分表存储 | §3.4 |
| 图片/附件 | 对象存储，文档只存引用 | §3.5 |
| 横向扩展 | extension-redis pub/sub（仅实时广播）+ 强制文档锁，Redis 非权威 | §5.1 / §5.3 |
| 多节点落库 | 单写者选举（documentName 亲和默认 + 强制文档锁 + unloadImmediately:false）+ store 内 merge-on-write 并集兜底 | §5.2 / §5.3 / §3.2 |
| sticky session | documentName 亲和路由为**默认且必须**（单活内存副本前提）| §5.2 |
| 权限模型 | **文档自治：resolveRole = doc_member + owner，删除群继承**；权限不耦合 octo 群 | §4.2 |
| documentName | `octo:{space}:{folder}:{doc}`，第 3 段 `{folder}` 为 docs 原生文件夹（非 group_no、不派生权限）；键格式零迁移、白板 5 段非对称判别不变 | §8.1 / 附录 B |
| 链接邀请 | doc_invite + 接受流程；仅已注册 octo 用户可接受（校验身份取可信 uid 后落 doc_member）| §4.6 |
| octo 依赖 | 身份（token→uid、单条 profile、自省端点）+ 同源挂载**零开发复用**；仅**批量 profile 端点需 octo 新增**（薄包 GetUsers）| §4.7 |
| 权限撤销 | permission_epoch + 连接注册表；按 **doc_member 变更**触发；撤销/降级实时生效，提升 ≤5min 残留窗口（显式边界）| §4.5 |
| 持久化模型 | 单行权威合并态（merge-on-write），不做 A/B 动态切换；增量日志为整体二选一备选 | §3.3 |
| WuKongIM 整合 | **v1：内容同步走 Hocuspocus 独立 WS（Yjs sync+awareness），WuKongIM 仅承载业务通知；WS 走两层令牌链（provider 握分钟级短期 collab token，octo 登录态仅用于换取，绝不直挂长效 octo 令牌，见 §4.4）**；WuKongIM 桥接 Yjs 降级为 **v2 待评估**，不进 v1 | §6 |
| Agent 写入 | openDirectConnection + Yjs 事务 + 统一广播落库 | §7.3 |
| 冲突合并 | CRDT 自动收敛，前端无需手动合并 | §8.6 |
| License | 全链路 MIT，不引入 Tiptap 商业云 | §10 |

## 附录 B：documentName 与 ID 约定

- `doc_id`：**业务主键**，由创建 API 生成的全局唯一 ID（如 `d_abc123`），是 `doc_meta` 的主键、面向前端 REST 与业务逻辑。
- `document_name`（即 provider 的 `name` / documentName）：**Hocuspocus 路由键与持久化键**，格式 `octo:{space}:{folder}:{doc}`。它是 `doc_meta.document_name` 列（唯一索引）与 `yjs_document.document_name`（唯一索引）的值。各段含义：`octo:` 为顶层命名空间前缀（为白板等其它协作内容类型预留扩展空间，如白板用 `octo:...:wb:` 形式）；`{space}` 为 space_id；`{folder}` 为 **docs 原生文件夹 id（v2.0 重定义，不再是 octo group_no、不派生权限，仅作组织/路由）**；`{doc}` 段取自 `doc_id`。
- **命名规范（全文统一，不再互相等同混用）**：业务主键一律叫 `doc_id`；Hocuspocus/持久化键一律叫 `document_name`。持久化层（`yjs_document` / `yjs_snapshot` / `yjs_update_log`）一律以 `document_name` 为键；`doc_meta` 同时持有 `doc_id`（主键）与 `document_name`（唯一索引）做映射。
- **段格式校验（防解析歧义，P2-J / P2-1 / P2-2）**：`document_name` 以 `:` 为段分隔符，故 `parseDocumentName` 必须对各段（`{space}` / `{folder}` / `{doc}`）做格式校验——**每段禁含 `:`**（也建议限定为 `[A-Za-z0-9_-]` 等安全字符集）。否则段内混入 `:` 会造成分隔歧义、解析错位，进而把请求归属到错误的 space/folder/doc。非法格式（含非法字符或段数不符）**直接拒绝**（连接路径 4403/4404，REST 路径 400/404），不做"尽力解析"。
  - **白板键非对称判别（P2-1）**：白板键 `octo:{space}:{folder}:wb:{board}`（**5 段**，第 4 段为字面量 `wb`），文档键 `octo:{space}:{folder}:{doc}`（**4 段**）。`parseDocumentName` 必须非对称判别：split 后若 `parts.length === 5 && parts[3] === 'wb'`，识别为白板键 → **文档后端拒绝**（白板不共享文档 Y.Doc/通道）。**该判别为位置型，与第 3 段语义无关，故 `{group}`→`{folder}` 重定义对它零影响（见 §8.1 迁移影响）。**
  - **可执行校验矩阵（P2-2）**：① 文档键必须 **exactly 4 段**（白板键为 5 段且 `parts[3]==='wb'`）；② **首段必须 === `'octo'`**；③ **空段拒绝**（任一段为空字符串）；④ **多余/缺段拒绝**（段数 ≠ 4 且非 5 段 wb 形式一律拒绝）；⑤ `{doc}` 禁含非法字符、禁等于字面量 `'wb'`。

```
parseDocumentName(name):
  parts = name.split(':')
  if parts.length === 5 and parts[3] === 'wb':
    reject  // 白板键，文档后端不受理白板（4403/4404）
  if parts.length !== 4: reject               // 多余/缺段
  if parts[0] !== 'octo': reject              // 首段必须 'octo'
  [_, space, folder, doc] = parts
  if space === '' or folder === '' or doc === '': reject   // 空段拒绝
  if doc === 'wb' or doc 含非法字符（含 ':'）: reject
  return { space, folder, doc }
```
- Y.Doc 共享字段名：`default`（XmlFragment，Tiptap `extension-collaboration` 默认值），前后端与 Agent 转换必须一致；应**抽进共享常量包**，前后端与 Agent 转换共用同一常量，避免各处硬编码字符串漂移。
- 附件引用：Y.Doc image 节点存 `attach_id`，读取时换发签名 URL。

## 附录 C：Allen Review 逐条处理说明

> 本附录对 Allen（测试）review 的 P0×3 / P1×7 / P2×4 逐条记录处理结论。结论分三档：**采纳**（按意见修正）、**部分采纳**（采纳核心、对边界做澄清或裁剪）、**反驳**（不修改并说明理由）。本轮 review 意见全部**采纳或部分采纳**，无反驳项。

> **（以下为 v2.0 之前的历史模型记录，仅供追溯）**：本附录的 P0 / P1 / P2 及 v1.5–v1.7 各轮处理记录**反映的是 v2.0 之前的旧模型**——其中出现的 `octo:{space}:{group}:{doc}`（第 3 段为 group_no）、`doc_acl`、群继承 / ACL 等表述均属**旧模型语义**，已被本文档正文（§4.1–§4.7 文档自治权限模型 + `{group}`→`{folder}` 重定义 + `doc_acl`→`doc_member`）取代。此处**原样保留仅作评审追溯，不代表当前合约**；当前 v2.0 结论以正文及本附录末「补充：v2.0 合约级修订」一节为准。

### P0

| 编号 | 结论 | 改动章节 | 一句话修法 |
| --- | --- | --- | --- |
| P0-1 多节点落库竞态丢数据 | 采纳 | §3.2 / §5.2 / §5.3 / §9.2 / 附录 A | 单写者选举升为强制（documentName 亲和**默认** + **强制 Redis 文档锁** + `unloadImmediately:false`，只有锁持有者 flush）；`store` 内 `SELECT ... FOR UPDATE` + merge-on-write 并集作第二层兜底；删除「version 单调递增 + 唯一约束防旧覆盖新」全部表述。 |
| P0-2 比较 state 新旧无良定义 | 采纳 | §3.2 / §5.2 / §9.2（全文）| 全文「比较新旧/乐观锁判新旧」一律改为 merge-on-write（并集）；明确 state vector 是偏序，唯一有意义的判断是「X 严格包含 Y」用 `diffUpdate(Y, encodeStateVector(X))` 为空判定；永不用「新旧比较」gate CRDT 写。 |
| P0-3 pub/sub 当成可补齐复制日志 | 采纳 | §5.3 | 明确 pub/sub 只做实时广播、不作补齐机制；新节点一致性靠 documentName 主节点路由（单活副本，默认）保证；Redis 仅承载 awareness/通知广播 + 文档锁，不承载权威更新补齐。 |

### P1

| 编号 | 结论 | 改动章节 | 一句话修法 |
| --- | --- | --- | --- |
| P1-1 token 撤销时效 vs §9.6 矛盾 | 采纳 | §4.1 / §4.4 / §4.5（新增）/ §9.6 | token claims 加 `permission_epoch`；维护 Redis 跨节点连接注册表；ACL 变更经 Redis 广播失效事件 → 对受影响 `{doc,uid}` 连接 `close(4403)` 或中途翻 `readOnly`；写路径 `beforeHandleMessage` 复查 epoch；把「新连接 ≤5min token 残留窗口」写成显式可接受边界（仅"提升"类变更）。 |
| P1-2 readOnly 拦截点写错层 | 采纳 | §4.1 / §4.2 / §8.2 | 明确写拒绝在「应用消息之前」：`onAuthenticate` 设 `connectionConfig.readOnly`（v4）+ `beforeHandleMessage` 对直写路径预检；删除所有「onChange/写阶段拒写」表述（onChange 在 update 已应用后触发）。 |
| P1-3 stateless role 冗余 + 时序无保证 | 采纳 | §8.2 / §8.3 / §8.5 | 删除「stateless 首帧下发 role」作为初始 UI 闸门；初始只读 UI 直接用 `POST /api/v1/docs/collab-token` 出参的 role；stateless 仅保留作「会话中途 role 变更」后续通知（时序不敏感）。 |
| P1-4 策略 B compact seq 边界/竞态 | 采纳 | §3.3 / §3.4 | （若启用增量日志模型）seq 由 DB 自增单一权威分配；compact 先钉 `captured_seq` 再 `DELETE WHERE seq <= captured_seq`，绝不用 version 比较，消除「快照后删除」丢数据边界。 |
| P1-5 yjs_snapshot 表缺失 + 双写 | 采纳 | §3.3 / §3.4 | v1 删除 A/B 动态切换，统一为「单行权威合并态」单一真相源（默认）；补 `yjs_snapshot` / `yjs_update_log` 完整 DDL 作整体二选一备选模型，并明确该模型不复用 stock `store`，消除与 extension-database 的双写。 |
| P1-6 Agent openDirectConnection 绕 ACL + 竞态 | 采纳 | §7.3 | REST 处理器在 `openDirectConnection` 前显式做 ACL 前置校验（给出代码）；删除方式 B（跨集群 racy），统一走方式 A（Y.Doc 事务合并）；同步语义改为「落库后才返回 200」或「返回 202」；主节点路由下与单写者一致。 |
| P1-7 doc_id vs documentName 混用 | 采纳 | §3.2 / §3.4 / §8.1 / 术语表 / 附录 B | 定规范键：`doc_meta.doc_id` 业务主键保留；新增 `document_name` 列（值 `octo:{space}:{group}:{doc}`）作为 Hocuspocus 路由键 + `yjs_document` 唯一索引；全文统一命名，不再互相等同。 |

### P2

| 编号 | 结论 | 改动章节 | 一句话修法 |
| --- | --- | --- | --- |
| P2-1 fetch() 数组 bug | 采纳 | §3.2 | 改为 `const row = (await db.query(...))[0]; return row ? new Uint8Array(row.state) : null`，避免空结果 `[]` truthy 读到 `undefined`。 |
| P2-2 Hocuspocus 版本过时 | 采纳 | 全文 / §10.1 | `@hocuspocus/*` 从 `^2.x` 改为 `^4.1.2`；代码样例 readOnly 改 `connectionConfig.readOnly`；补注 v4 的 `onAuthenticate` payload / `onAwarenessUpdate` / `transactionOrigin` 形状；第 10 章依赖表同步。 |
| P2-3 License CI 门禁自相矛盾 | 采纳 | §10.2 | Apache-2.0 政策统一为**放行**（其专利条款对使用方有利，与 `--onlyAllow` 列表一致），删除「需人工评估」的矛盾表述。 |
| P2-4 崩溃丢失窗口比暗示的窄 | 采纳 | §9.2 | 诚实写明 `y-indexeddb` 只持久化发起方自己的编辑；作者关 tab 后、节点下次 flush 前崩溃则该 ≤debounce 窗口编辑无恢复路径，作为显式可接受边界。 |

### 补充：PM/Steve 追加口径

| 编号 | 结论 | 改动章节 | 一句话修法 |
| --- | --- | --- | --- |
| WuKongIM 桥接降级（PM 统一口径）| 采纳 | §6 / 附录 A | 采纳 PM 口径：WuKongIM 桥接 Yjs 降级为 **v2 待评估、不进 v1**，方案二对比收敛进 §6.3「v2 展望/待评估」附注块；**v1 仅 Hocuspocus 独立 WS 承载内容同步（Yjs sync+awareness）+ WuKongIM 仅承载业务通知**；附录 A 决策摘要同步更新。 |
| C-3 契约一致性（Steve）| 采纳 | §7.1 | §7.1 schema import 由本地相对路径 `./tiptap-schema` 改为冻结包名 `@octo/docs-schema`（`buildSchema()` 构造 schema、`COLLAB_FIELD` 提供共享字段名常量，不再硬编码 `'default'`），与前端 §9 对齐。 |
| D-1（PM 定稿）epoch 失配语义细分 | 采纳 | §4.1 / §4.5 / §8.2 | epoch 失配区分两种：**在线降权但仍有权**走 **stateless 降级帧**实时下发新 role、**不断连**（翻 readOnly + 下发 role）；**重连时拿旧 epoch token** 在 onAuthenticate 复核仍有权 → **4401（可刷新）**前端静默刷新重连，确有无权（role=none）才 **4403**；**4403 收敛为单一「永久无权」**（彻底失权/role=none/documentName 挪用）；**不新增 close code**（4401 可刷新 / 4403 永久无权 / 4404 文档不存在）；claims 统一为 `{uid, documentName, role, permission_epoch, exp}`（契约 v2 统一结构，前端/白板补齐）。 |
| D-2 Agent 直写字段名硬编码 | 采纳 | §7.3 | §7.3 Agent 直写示例 `doc.getXmlFragment('default')` 改为 `doc.getXmlFragment(COLLAB_FIELD)`，与 §7.1 line 713/718 一致，统一取自 `@octo/docs-schema`。 |
| re-re-review 后端收口（role 真源 + 拒绝粒度） | 采纳 | §4.5 / §8.2 / §8.3 / 附录 C | 第5点初始 role 真源统一为 token 出参（stateless 仅运行期变更、降级帧带 permission_epoch 单调校验，前端丢弃 epoch 回退帧）；第6点越权写拒绝粒度写实为连接级（connectionConfig.readOnly）+ 消息级（beforeHandleMessage）、非 update 级（无逐 update 选择性拒绝，onChange 不可当闸门），明确前端需自行回滚乐观/降权窗口的本地越权编辑（UndoManager 或重载权威快照），后端不逐条对账。 |

> 综述：本轮 review 暴露的持久化/多节点一致性内核问题（P0-1/2/3）已通过「单写者选举（默认强制）+ merge-on-write 兜底」根治；鉴权撤销时效（P1-1）通过 `permission_epoch` + 连接注册表闭环并与 §9.6 对齐；其余 P1/P2 均按意见落地。据此文档状态由「契约 v1 冻结候选」推进为「契约 v2 候选（re-re-review 收口：契约第5/6点 + Allen P1×4 + P2）」。

### 补充：re-re-review 后端 P1×4 + 关键 P2（v1.5）

> 本节为 v1.5 收口记录：在已修复的 P0 内核（单写者 + merge-on-write / 偏序 / pub-sub 非补齐 / compact / fetch / license / 版本 pin）与 v1.4 已落地的契约第5/6点之上，逐条落地后端 re-re-review 暴露的 P1×4 与关键 P2。下表为 v1.5 正式结论。

| 编号 | 结论 | 改动章节 | 一句话修法 |
| --- | --- | --- | --- |
| P1-A Agent openDirectConnection 节点路由缺口 | 采纳 | §7.3 / §9.1 / §5.2 | Agent 写端点必须经与 WS 同源的 `documentName` 亲和路由到属主节点（或由非属主节点代理转发），属主未知时查文档锁/连接注册表定位；「主节点唯一内存副本」由隐含假设升为**显式硬约束**——非属主节点禁直接 open，否则注水第二份内存副本破坏单写者。 |
| P1-B per-doc epoch 粒度错配 | 采纳 | §4.5 / §4.1 | epoch 降权判定改 **per-principal**（仅看该 uid 的 epoch 视图）；per-doc epoch 仅作粗触发信号，命中 stale 后用 recheck 结果**就地刷新连接 epoch**、仅该 uid role 实际下降才拒；无关 writer 不因他人 ACL 变更受影响。 |
| P1-C onAuthenticate 自相矛盾 | 采纳 | §4.1 / §4.3 / §9.2 | 删除「连接零查库」绝对表述，改实为**本地验签 + epoch 比对**（Redis 缓存、miss 回源 DB）+ **仅 stale 才 `recheckCurrentRole` 查 ACL**；补 thundering herd 防护（recheck 缓存 + singleflight + 限流）；§9.2 增 auth 热路径失败降级（Redis/DB 抖动：缓存 TTL 容忍 + fail-closed 保守拒绝）。 |
| P1-D merge-on-write 每 flush 全量 decode+encode 阻塞 | 采纳 | §3.2 / §5.2 / §9.5 | `store` 先 `diffUpdate(existing, encodeStateVector(incoming))` 为空判 `incoming ⊇ existing`，是则直写跳过 union re-encode，仅检测到并发才 union（兜底完整保留）；§9.5 量化单文档体积上限并挂钩 merge 成本。⚠️ v1.6 修正：原写 `diffUpdate(incoming, sv(existing))` 方向写反（Allen 装真 Yjs 13.6.31 跑 test.js 实测复现 P0 丢数据），陈旧 incoming 时该式为空会误判直写、丢掉 existing 编辑；已调转为 `diffUpdate(existing, sv(incoming))` 为空才跳 union。 |
| P2-A updated_by 永远空 | 采纳 | §3.2 / §4.1 | `store` 事务内写 `doc_meta.updated_by`，取自 `onAuthenticate` 注入、经 v4 context 传入 `onStoreDocument` 的 `user.id`。 |
| P2-C stateless 降级帧 best-effort 丢失 | 采纳 | §8.2 / §4.5 | 明确「写被拒时前端显式回滚 + 提示」为契约边界（呼应第6点）；stateless 帧丢失由「写被拒 → 前端回滚」硬路径兜底，不依赖降级帧必达。 |
| P2-D awareness 身份校验 | 采纳 | §8.3 / §9.6 | `onAwarenessUpdate` 比对 `state.user.id` ≡ 已鉴权 uid，不符拒绝（防 presence 冒充）；约束 `color`=hex（`^#[0-9a-fA-F]{6}$`）、`name` 限长 + 转义（防 XSS/CSS 注入）。 |
| P2-E epoch 权威落 DB | 采纳 | §4.5 / §4.4 | `permission_epoch` 权威存 DB，Redis 仅缓存且 miss 回源（否则 Redis 重启 currentEpoch 归零 → 已撤销权限被静默恢复）；issuer/validator 同源密钥。 |
| P2-G 文档锁语义不全 | 采纳 | §5.3 / §9.4 | 补锁 TTL/续约/主动释放语义 + `server.destroy()` 释放锁；锁定位降为 **perf 优化**，真正串行化正确性点是 `FOR UPDATE` + union（merge-on-write）。 |
| P2-I on-behalf acting uid 不可自填 | 采纳 | §7.3 | acting uid 必须来自可信内部签发 / 网关注入并经服务端校验，严禁调用方请求体自填（防自选 admin 绕 ACL）；明确身份来源与授权边界。 |
| P2-J parseDocumentName 段格式校验 | 采纳 | §4.1 / 附录 B | `parseDocumentName` 各段（space/group/doc）加格式校验，限受限字符集、禁含 `:`（防解析歧义 → 错误授权 / token 挪用），非法直接拒绝。 |

> 综述（v1.5）：在 P0 内核（单写者 + merge-on-write）与契约第5/6点之上，v1.5 进一步叠加 re-re-review 后端 P1×4 + 关键 P2（P1-A 属主节点路由、P1-B per-principal epoch、P1-C onAuthenticate 实证化 + 容错、P1-D diffUpdate 旁路；P2-A/C/D/E/G/I/J），文档推进为**契约 v2 候选（含契约第5/6点 + Allen P1×4 + P2）**。

### 补充：P1-D 判据方向修正 + P1-C 收口 + P2 契约缺口（v1.6）

> 本节为 v1.6 收口记录：在 v1.5 已落地结论之上，修正 P1-D diffUpdate 判据方向（实测复现的 P0 级丢数据），收紧 P1-C 的 fail-closed 口径，并补齐 P2 契约缺口（wb 非对称解析、exactly-4 段校验、awareness MUST 契约、epoch 本地水位、currentEpoch singleflight）。下表为 v1.6 正式结论。

| 编号 | 结论 | 改动章节 | 一句话修法 |
| --- | --- | --- | --- |
| P1-D 判据方向修正（实测复现）| 采纳 | §3.2 / §5.2 / 附录 C | store 判据由 `diffUpdate(incoming, sv(existing))` 改正为 `diffUpdate(existing, encodeStateVector(incoming))` 为空才直写——前者方向反、incoming 陈旧子集时该式为空会误判直写、丢掉 existing 多出的编辑（Allen 装真 Yjs 13.6.31 跑 test.js 实测复现丢数据）。 |
| P1-C fail-closed 收紧 | 采纳 | §9.2 / §4.1 | §9.2/§4.1 区分提升类 vs 降权/撤销类：`currentEpoch` 权威源（DB）不可确认时，降权/撤销等权限收紧敏感路径一律 fail-closed（4401 退避），**绝不用旧 epoch 缓存放行写权限**；旧 epoch 缓存容忍仅限不涉权限收紧的读保持并量化窗口（≤ 数秒 TTL），`{doc}` 已知 ACL 变更即失效转 fail-closed。 |
| wb 段非对称解析 | 采纳 | §4.1 / §8.1 / 附录 B | `parseDocumentName` 对 `parts.length===5 && parts[3]==='wb'`（5 段白板键）拒绝——文档后端不受理白板（4403/4404，白板不共享文档 Y.Doc/通道）；文档键为 4 段 `octo:{space}:{group}:{doc}`。 |
| exactly-4 段校验 | 采纳 | §4.1 / §8.1 / 附录 B | `parseDocumentName` 补可执行校验矩阵——文档键 exactly 4 段、首段必须 `'octo'`、空段拒绝、多余/缺段拒绝、`{doc}` 禁含非法字符且禁等于 `'wb'`；非法直接拒绝（4403/4404），不做"尽力解析"。 |
| awareness MUST 契约 | 采纳 | §8.3.1 | §8.3.1 升 MUST 级 `onAwarenessUpdate` 校验伪代码（`user.id` ≡ 已鉴权 uid、`color` 匹配 `^#[0-9a-fA-F]{6}$`、`name` 为 string 且长度 ≤ 64）；明确职责边界——后端只校验类型/长度/身份并拒非法帧，HTML 转义责任归前端渲染层（collaboration-cursor escape），后端不负责也无法替代。 |
| epoch 本地水位 | 采纳 | §4.5 | §4.5 step4 `beforeHandleMessage` 的 epoch 比对**只读本地内存 epoch watermark**（由 step3 失效广播刷新），不 per-write 回源 Redis/DB；回源仅发生在命中 stale 后的 `recheckCurrentRole` 分支（带 singleflight + 短 TTL），避免把写热路径变成 per-write IO。 |
| currentEpoch singleflight | 采纳 | §4.1 / §4.5 | `currentEpoch` 的 Redis miss → DB 回源按 `{doc}` 维度纳入 singleflight 合并 + 进程内短 TTL 缓存，防 Redis 宕机/清空时大量连接同时回源 DB 造成 epoch 读 stampede。 |

| onAuthenticate 代码样例缺 await + fail-closed（二轮代码复核扣出，P1）| 采纳 | §4.1 | §4.1 onAuthenticate 的 `currentEpoch` / `recheckCurrentRole` 是异步 IO（Redis/DB），原样例未 `await`——`claims.permission_epoch < currentEpoch(...)` 中 `number < Promise` 恒 false，stale 分支永不进入 → 撤销/降权静默失效（P1-C 散文未落代码）。已改为 `await currentEpoch` / `await recheckCurrentRole` + try/catch，权威源不可确认时 throw 4401（代码级 fail-closed）。 |
| parseDocumentName 调用点未拒白板键（二轮代码复核，P2）| 采纳 | §4.1 | 伪代码白板分支 `return {kind:'whiteboard'}`，但调用点原直接解构 `{space,group,doc}`会得 `doc===undefined`。已在调用点加 `if (parsed.kind !== 'document') throw Forbidden`，与附录 B 口径一致（白板键稳定 4403 拒绝）。 |
> 综述（v1.7）：v1.7 在 v1.6 基础上把 P1-C 的 fail-closed 从**散文口径落到代码控制流**——§4.1 onAuthenticate 的 `currentEpoch` / `recheckCurrentRole` 加 `await` + try/catch，权威源不可确认一律 throw 4401（二轮代码复核扣出原样例 `number < Promise` 恒 false 会使 stale 分支静默失效、破 P1-C）；并修齐 parseDocumentName 调用点拒白板键。文档维持**契约 v2 候选**状态。

### 补充：v2.0 合约级修订 —— 文档自治权限模型 + octo 同源集成

> 本节如实记录 **v2.0 本轮修订**。这是一次**产品决策驱动的合约级变更**（老板定稿：权限由「依赖 octo 群」改为「文档自治」），不是又一轮 review 修复。**本轮尚未经 Allen（测试）/ Steve（契约一致性）双引擎复核——双引擎 PASS 在本轮之后进行**；故文档状态为「契约 v3 候选」，而非 PASS。本轮所有 octo 依赖判断均**基于实际阅读 octo-server / octo-web 源码**，逐条附真实文件路径（见 §4.7）。

| 变更点 | 性质 | 改动章节 | 一句话说明 |
| --- | --- | --- | --- |
| 删除群继承 | 合约级 | §4.1 / §4.2 / §4.3 | 删除「群成员 = 文档权限」映射与「`{group}`=group_no 驱动权限」语义；权限不再耦合 octo 群。 |
| 文档自治成员模型 | 合约级 | §3.4 / §4.2 | 新增 `doc_member`（doc_id, uid, role, granted_by, created_at, source）；`resolveRole` 由 max(群继承, ACL) 简化为「doc_member + owner」单表查找。 |
| doc_acl 去向 | 设计决策 | §3.4 / §4.2 | **`doc_acl` 由 `doc_member` 取代**（更干净的设计）：原 principal_type=user 行迁入 doc_member，principal_type=group 行（群继承）随产品决策删除。 |
| 链接邀请 | 新增 | §3.4 / §4.6 / §8.4 | 新增 `doc_invite`（invite_token, doc_id, role, expires_at, max_uses/used_count, created_by, status）；默认 role=writer，可邀 reader/writer/admin；**HARD：仅已注册 octo 用户可接受**——接受时校验 octo 身份取可信 uid 后落 doc_member（附 doc_invite_redemption 幂等去重）。 |
| documentName 重定义 | 合约级 | §0 / §8.1 / 附录 B | 第 3 段 `{group}`→`{folder}`（docs 原生文件夹，不派生权限）；**键格式零迁移、字节级兼容**；白板 5 段非对称判别（`parts.length===5 && parts[3]==='wb'`）**零改动**；评估并否决「删除该段」「换 owner 维度」两个替代方案。 |
| epoch 触发源 | 调整（机制保留）| §4.5 / §8.3 | epoch 实时撤销机制**保留**，触发源由「群/ACL 变更」改为「`doc_member` 变更」；per-principal 语义、本地水位、singleflight 等不变。 |
| 两层令牌链落地 | 合约级 | §4.4 / §4.7 | 明确「octo 登录态（不透明会话 token）→ POST /api/v1/docs/collab-token → 短期 collab JWT → WS 握手」；**不把长效 octo 令牌挂到 WS**。 |
| octo 依赖结论 | 新增（本轮核心交付）| §4.7（新增）| 零开发复用：token→uid（`CacheTokenParser.Parse` / `AuthMiddleware` / `POST /v1/auth/verify`）、单条 profile（`GET /v1/users/:uid`）、octo-web 同源挂载（`IModule`/`registerModule`/`APIClient.ts` token 注入）；**唯一需 octo 新增**：批量 profile 端点（薄包既有 `GetUsers`）。 |
| 契约交叉引用 | 同步 | §8.1 / §8.4 / §7.3 / §9.6 / 附录 A/B | 成员/邀请 REST 取代 ACL REST；术语表、决策摘要、安全表同步到 doc_member 口径。 |
| 端点前缀统一 | 同步 | §4.7 / §8.4 / 附录 | 端点前缀按老板拍定方案 A 统一为 /api/v1/docs/*（原 /api/docs/* 与 §4.7 /v1 挂载组不自洽，本次对齐）。 |

> **保留不动的强项**：Yjs 二进制权威持久化（§3.1-3.3）、单写者选举 + merge-on-write（§5）、permission_epoch 实时撤销机制（§4.5，仅换触发源）、Agent openDirectConnection（§7）、前后端契约骨架（§8）均**原样保留**，本轮只改权限来源与 documentName 语义。
>
> **后续（不在本轮）**：交 Allen 跑测试引擎（重点验 doc_member/doc_invite 并发、接受幂等、epoch 触发、迁移脚本）、Steve 验前后端契约一致性（成员/邀请 API、role 出参、documentName 段语义）。双引擎 PASS 后方可由「契约 v3 候选」推进为冻结。
