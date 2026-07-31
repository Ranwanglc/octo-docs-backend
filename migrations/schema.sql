-- Octo Docs collaborative document backend — database schema (§3.4)
--
-- This file copies the table DDLs EXACTLY from the FROZEN contract
-- (docs/contract/backend-design.md §3.4, MySQL 8 dialect).
--
-- Run order: doc_meta first (referenced by others conceptually, no hard FKs
-- per contract), then member/invite/redemption, then the Y.Doc binary tables.
--
-- Usage:
--   mysql -u <user> -p <database> < migrations/schema.sql
--
-- Tables:
--   doc_meta              business metadata (title/owner/space/folder/epoch)
--   doc_member            document-autonomous membership (reader/commenter/writer/admin)
--   doc_invite            link invites
--   doc_invite_redemption invite redemption ledger (idempotency / audit)
--   yjs_document          Y.Doc binary authoritative state (single merged row)
--   yjs_snapshot          OPTIONAL baseline snapshot (incremental-log model only)
--   yjs_update_log        OPTIONAL incremental log (incremental-log model only)
--   doc_attachment        OPTIONAL attachment reference table (§3.5)
--   doc_version           version history snapshots (snapshot + restore, §4 #4)
--   card_action_receipt   signed card-action callback idempotency receipts
--   doc_access_notify_card approver access-request card coordinates (decision card sync)

-- 文档元数据（业务库）
CREATE TABLE doc_meta (
  doc_id        VARCHAR(64)  NOT NULL,            -- 业务主键（如 d_abc123），由创建 API 生成
  document_name VARCHAR(256) NOT NULL,            -- 规范持久化/路由键 octo:{space}:{folder}:{doc}
  title         VARCHAR(512) NOT NULL DEFAULT '',
  owner_id      VARCHAR(64)  NOT NULL,            -- 创建者 / 拥有者（Octo user id），隐含 admin（见 §4.2）
  space_id      VARCHAR(64)  NOT NULL,            -- 所属 docs 空间（documentName 第 2 段 {space}），多租隔离维度
  folder_id     VARCHAR(64)  NOT NULL DEFAULT 'f_default', -- docs 原生文件夹（documentName 第 3 段 {folder}）；v2.0：不再是 octo group_no，仅做组织/归类，不派生权限（见 §4 / §8.1）。**非空保留默认值 `f_default`**（省略 folderId 的新建文档归此保留文件夹）；**documentName 第 3 段必须等于本列值**（键与 folder_id 恒一致，见 §8.1）
  doc_type      VARCHAR(32)  NOT NULL DEFAULT 'doc', -- doc / template ...
  octo_doc_slug VARCHAR(128) NULL DEFAULT NULL, -- octo-doc 正文 slug；doc_type='html' 时用于路由回 octo-doc
  status        TINYINT      NOT NULL DEFAULT 1,  -- 1=正常 0=已删除(软删) 2=归档
  permission_epoch BIGINT    NOT NULL DEFAULT 0,   -- 权限版本号（单调递增，权威落 DB；v2.0 按 doc_member 变更 +1，见 §4.5）
  share_scope   TINYINT      NOT NULL DEFAULT 0,   -- 分享范围：0=restricted(默认) 1=anyone_in_space（#64 空间级分享，见 §4/§5）
  share_role    TINYINT      NOT NULL DEFAULT 1,   -- anyone_in_space 生效时的角色：1=read 2=edit；restricted 时忽略（#64）
  created_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  created_by    VARCHAR(64)  NOT NULL,
  updated_by    VARCHAR(64)  NOT NULL DEFAULT '',
  PRIMARY KEY (doc_id),
  UNIQUE KEY uk_document_name (document_name),    -- document_name 全局唯一
  -- octo_doc_slug is unique PER SPACE, not globally (P0 tenant isolation): the
  -- composite key lets space A and space B each register the same slug while
  -- the per-space upsert stays deterministic. nullable octo_doc_slug (non-html
  -- rows) allows multiple NULLs, so non-html rows never collide. The
  -- 2026-07-13-add-doc-meta-octo-doc-slug upgrade adds this composite key
  -- directly, keeping fresh and upgraded DBs identical.
  UNIQUE KEY uk_octo_doc_slug (space_id, octo_doc_slug),
  KEY idx_space (space_id, status, updated_at),
  KEY idx_folder (folder_id, status, updated_at),
  KEY idx_owner (owner_id, status, updated_at),
  -- #64 defense-in-depth: keep a fresh DB's DB-level invariants identical to an
  -- upgraded one (the 2026-07-14-add-doc-share-scope upgrade adds these same two
  -- CHECKs). Authoritative validation lives in the PUT /share handler; these are
  -- the backstop so a raw UPDATE with an out-of-enum value fails on BOTH paths.
  CONSTRAINT chk_doc_meta_share_scope CHECK (share_scope IN (0, 1)),
  CONSTRAINT chk_doc_meta_share_role  CHECK (share_role  IN (1, 2))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 文档自治成员（v2.0 新增，替代 v1.x 的 doc_acl —— 见下方迁移说明）
-- 把 uid 按 role 直接授到某 doc；resolveRole 仅查此表 + owner（§4.2），不再做 octo 群继承。
CREATE TABLE doc_member (
  doc_id        VARCHAR(64)  NOT NULL,            -- 关联 doc_meta.doc_id
  uid           VARCHAR(64)  NOT NULL,            -- 被授权的 Octo user id（可信 uid，来源见 §4.4 / §4.6）
  role          TINYINT      NOT NULL,            -- 1=reader 2=writer 3=admin 4=commenter
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
  role          TINYINT      NOT NULL DEFAULT 2,  -- 授予 role：1=reader 2=writer(默认) 3=admin 4=commenter
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

-- 访问申请（屏4c「申请访问」MVP，拉取式）：无权限接收方点开文档链接被 403 后，
-- 提交一条访问申请；owner + admin 拉取 pending 列表并 approve/deny。approve 走与
-- 转发授权同一条 max-merge（只升不降）路径。PK (doc_id, uid) 单行复用 = 天然幂等
-- （同人重复申请只刷新为 pending，不刷屏多行），与 doc_member / doc_invite_redemption 同一去重范式。
CREATE TABLE doc_access_request (
  doc_id         VARCHAR(64)  NOT NULL,            -- 关联 doc_meta.doc_id
  uid            VARCHAR(64)  NOT NULL,            -- 申请人可信 uid（authMiddleware 注入，绝非请求体）
  requested_role TINYINT      NOT NULL DEFAULT 1,  -- 1=reader 2=writer 4=commenter（无 admin 申请）
  reason         VARCHAR(512) NOT NULL DEFAULT '',
  status         TINYINT      NOT NULL DEFAULT 1,  -- 1=pending 2=approved 3=denied 4=cancelled
  request_id     VARCHAR(64)  NOT NULL,            -- 高熵 id，供 approve/deny 路由寻址
  decided_by     VARCHAR(64)  NOT NULL DEFAULT '', -- 处理人 uid
  decision_note  VARCHAR(512) NOT NULL DEFAULT '', -- 处理人拒绝理由（卡片 inputs["deny_reason"] 原样传入，存前截断）
  created_at     DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at     DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (doc_id, uid),                       -- 一个 uid 对一个 doc 至多一条申请（重复申请 UPDATE 复用）
  UNIQUE KEY uk_request_id (request_id),
  KEY idx_doc_status (doc_id, status)              -- admin 拉「某文档 pending 申请」
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
  file_name     VARCHAR(512) NOT NULL DEFAULT '', -- 原始文件名（已 sanitize），用于下载 Content-Disposition
  created_by    VARCHAR(64)  NOT NULL,
  created_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (attach_id),
  KEY idx_doc (doc_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 行内评论（feature #3, inline comments）。完全独立于 Y.Doc：评论正文与定位都
-- 落在本表，不进协同文档二进制态。一个线程由一条 root（parent_id IS NULL，携带
-- 锚点）加若干 reply（parent_id 指向 root；单层嵌套，reply 不再有子级、不带锚点）
-- 组成。锚点是编码后的 Yjs RelativePosition 字节（不透明），服务端只存取不解析；
-- anchor_text 是创建时的文本快照，仅供展示/审计，绝不据此派生权限或定位。
CREATE TABLE doc_comment (
  id            BIGINT       NOT NULL AUTO_INCREMENT, -- 单一权威分配（DB 自增），禁止应用层 MAX+1
  doc_id        VARCHAR(64)  NOT NULL,            -- 关联 doc_meta.doc_id（权限以此为准）
  document_name VARCHAR(256) NOT NULL,            -- 反范式快照值；绝不据此派生权限
  parent_id     BIGINT       NULL,                -- NULL=线程根；否则指向所回复的 root id（仅单层嵌套）
  author_uid    VARCHAR(64)  NOT NULL,            -- 作者 uid，来自鉴权上下文 req.uid，绝非请求体
  body          MEDIUMTEXT   NOT NULL,            -- 评论正文
  anchor_start  BLOB         NULL,                -- 编码后的 Yjs RelativePosition 字节（不透明）
  anchor_end    BLOB         NULL,                -- 同上，区间末端
  anchor_text   VARCHAR(512) NOT NULL DEFAULT '', -- 创建时文本快照，仅展示/审计
  resolved      TINYINT      NOT NULL DEFAULT 0,  -- 仅线程根有意义：0=open 1=resolved
  resolved_by   VARCHAR(64)  NULL,                -- 解决人 uid
  resolved_at   DATETIME(3)  NULL,                -- 解决时间
  deleted       TINYINT      NOT NULL DEFAULT 0,  -- 软删
  created_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_doc_open (doc_id, resolved, deleted, id), -- 「某文档的未解决评论」列表/分页
  KEY idx_thread (parent_id, id),                   -- 拉取某 root 的回复
  -- 不变式：root（parent_id IS NULL）必须带两端锚点；reply（parent_id NOT NULL）两端锚点必须为 NULL。
  -- 代码层也强制此规则（见 docCommentRepo / comments 路由），CHECK 作为最后一道防线。
  CONSTRAINT chk_doc_comment_anchor CHECK (
    (parent_id IS NULL AND anchor_start IS NOT NULL AND anchor_end IS NOT NULL)
    OR
    (parent_id IS NOT NULL AND anchor_start IS NULL AND anchor_end IS NULL)
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 版本历史（快照 + 恢复，见 §4 feature #4）。每条记录是某一时刻文档的完整 Yjs
-- 权威态（Y.encodeStateAsUpdate），gzip 压缩落 state_blob。id 由 DB 单一权威分配
-- （AUTO_INCREMENT），即对外的 version_seq，禁止应用层 MAX+1。
--   kind: 1=auto(自动) 2=named(命名快照) 3=restore-marker(恢复前自动安全快照)
-- 恢复语义见 src/api/routes/versions.ts：前向、非破坏性地把目标版本内容 reconcile
-- 回当前 live 态（联合安全，不触发 persistence union 回退）。
CREATE TABLE doc_version (
  id             BIGINT       NOT NULL AUTO_INCREMENT,  -- DB 单一权威分配，即 version_seq
  doc_id         VARCHAR(64)  NOT NULL,                 -- 关联 doc_meta.doc_id
  document_name  VARCHAR(256) NOT NULL,                 -- 快照时的持久化/路由键（取 doc_meta.document_name）
  kind           TINYINT      NOT NULL,                 -- 1=auto 2=named 3=restore-marker
  name           VARCHAR(256) NOT NULL DEFAULT '',      -- 命名快照的用户标签
  restored_from  BIGINT       NULL DEFAULT NULL,        -- restore-marker(kind=3) 行：被恢复来源版本 version_seq；其余 NULL
  state_blob     LONGBLOB     NOT NULL,                 -- 快照时文档完整 Yjs 态（gzip(encodeStateAsUpdate)）
  compressed     TINYINT      NOT NULL DEFAULT 1,       -- 1 = state_blob 为 gzip(encodeStateAsUpdate)
  size_bytes     BIGINT       NOT NULL DEFAULT 0,       -- 未压缩态字节数（保留/度量用）
  schema_version INT          NOT NULL,                 -- 快照时的 SCHEMA_VERSION（前向兼容闸）
  created_at     DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  created_by     VARCHAR(64)  NOT NULL,
  PRIMARY KEY (id),
  KEY idx_doc_ver (doc_id, id),                         -- 列表/游标分页（按 id 倒序）
  KEY idx_doc_kind (doc_id, kind, id)                   -- 按 kind 过滤（如排除 auto）
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 每用户文档浏览记录（"最近查看"，FEAT-B）。net-new 表，无历史回填。
-- 一个 (uid, doc_id, space_id) 至多一行：同 space 重复打开走 UPSERT 刷新 viewed_at，
-- 绝不新增行（幂等去重）；同一文档从不同 space 打开各留一行，per-space 独立（P1-b）。
-- uid 恒由鉴权推导（NEVER client-supplied）。文档删除/失权由查询时 JOIN 过滤兜底
-- （见 src/db/repos/docViewHistoryRepo.ts listRecent），本表不设硬 FK、不级联删；
-- 残留行由写入时同步保留裁剪（DOC_VIEW_RETAIN_COUNT / DOC_VIEW_RETAIN_DAYS）慢慢清。
CREATE TABLE doc_view_history (
  uid        VARCHAR(64) NOT NULL,               -- 查看者 uid（鉴权推导）
  doc_id     VARCHAR(64) NOT NULL,               -- 被查看文档（doc_meta.doc_id）
  space_id   VARCHAR(64) NOT NULL,               -- 记录时所属 space（X-Space-Id 强作用域）
  viewed_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
                                    ON UPDATE CURRENT_TIMESTAMP(3), -- 最近一次查看时间
  PRIMARY KEY (uid, doc_id, space_id),            -- 去重键：每个(用户,文档,space)至多一行，per-space 独立
  KEY idx_uid_space_viewed (uid, space_id, viewed_at) -- 主查询：某用户某 space 内 viewed_at DESC + keyset
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 签名 card-action 回调（文档 approve/deny 按钮）的幂等收据表。
-- octo-server 至少投递一次（超时/崩溃/丢响应会重投同一 event_id），本表以 event_id
-- 为主键：claim 首个写入者执行域决策并 finalize 存下 response，任何重投直接 replay
-- 该 response 而不再重复状态跃迁。与 upgrade 迁移
-- migrations/upgrades/2026-07-15-add-card-action-receipt.sql 保持完全一致，
-- 供全新部署从本 schema.sql 建库时同样创建（否则签名回调全部 503）。
CREATE TABLE card_action_receipt (
  event_id   VARCHAR(32)  NOT NULL,               -- octo callback event_id（十进制字符串；不强转数字）
  response   TEXT         NULL,                    -- JSON DecisionResult；claim 到 finalize 之间为 NULL
  created_at DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (event_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Ledger of the notification cards delivered to a document's approvers
-- (owner + admins) when someone submits an access request. One row per
-- (request_id, recipient) records the IM coordinates (channel + message id) of
-- that recipient's card, so a later approve/deny can drive EVERY approver's card
-- to a terminal state — not just the one the decider clicked.
-- PRIVACY: stores only the opaque Octo uid needed to locate the card; no display
-- names or account handles (consistent with doc_member.uid etc.).
CREATE TABLE doc_access_notify_card (
  request_id    VARCHAR(64)  NOT NULL,               -- doc_access_request.request_id this card belongs to
  recipient_uid VARCHAR(64)  NOT NULL,               -- approver who received the card (owner or admin)
  channel_id    VARCHAR(64)  NOT NULL,               -- IM channel the card was delivered on (DM = recipient)
  channel_type  TINYINT      NOT NULL DEFAULT 1,     -- IM channel type (1=person)
  message_id    VARCHAR(64)  NOT NULL,               -- IM message id (string: int64 exceeds JS safe integer)
  client_msg_no VARCHAR(64)  NOT NULL DEFAULT '',    -- IM client message no (idempotency / audit)
  status        TINYINT      NOT NULL DEFAULT 1,     -- 1=active(sent) 2=terminalized
  created_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (request_id, recipient_uid)            -- leftmost prefix serves the decision-time lookup by request_id
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
