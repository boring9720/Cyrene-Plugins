"use strict";

// src/core/store.ts
var import_node_crypto = require("node:crypto");
var import_node_path2 = require("node:path");

// src/util/jsonl.ts
var import_promises = require("node:fs/promises");
var import_node_path = require("node:path");
async function appendJsonl(path, obj) {
  await (0, import_promises.mkdir)((0, import_node_path.dirname)(path), { recursive: true });
  await (0, import_promises.appendFile)(path, `${JSON.stringify(obj)}
`, "utf8");
}
async function readJsonl(path, log) {
  let raw;
  try {
    raw = await (0, import_promises.readFile)(path, "utf8");
  } catch (err) {
    if (err?.code === "ENOENT") return [];
    throw err;
  }
  const out = [];
  const lines = raw.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === "") continue;
    try {
      out.push(JSON.parse(line));
    } catch (err) {
      log.warn(`JSONL 第 ${i + 1} 行解析失败，已跳过`, err);
    }
  }
  return out;
}

// src/core/attributes.ts
var CANONICAL_ATTRS = [
  "所在地",
  "居住地",
  "工作地点",
  "职位",
  "雇主",
  "日程",
  "行程",
  "偏好",
  "关系",
  "健康状况",
  "姓名",
  "联系方式"
];
var ATTR_ALIASES = /* @__PURE__ */ new Map([
  // 生产实测案例（v0.2.0 线上出现的两处字面量漂移）
  ["工作所在地", "工作地点"],
  ["出差行程", "行程"],
  // 居住地系
  ["住址", "居住地"],
  ["家庭住址", "居住地"],
  ["现居地", "居住地"],
  ["现居住地", "居住地"],
  // 所在地系
  ["当前位置", "所在地"],
  ["现所在地", "所在地"],
  // 雇主系
  ["工作单位", "雇主"],
  ["公司", "雇主"],
  // 职位系
  ["职务", "职位"],
  // 日程/行程系
  ["日程安排", "日程"],
  ["行程安排", "行程"],
  // 偏好/健康系
  ["喜好", "偏好"],
  ["健康", "健康状况"],
  ["健康状态", "健康状况"],
  ["身体状态", "健康状况"],
  // 姓名/关系系
  ["名字", "姓名"],
  ["关系状态", "关系"]
]);
function canonicalAttr(attr) {
  if (typeof attr !== "string") return "";
  let cleaned = "";
  for (const ch of attr) {
    const code = ch.codePointAt(0) ?? 0;
    if (code === 12288) {
      cleaned += " ";
    } else if (code >= 65281 && code <= 65374) {
      cleaned += String.fromCharCode(code - 65248);
    } else {
      cleaned += ch;
    }
  }
  cleaned = cleaned.trim().replace(/\s+/g, "");
  return ATTR_ALIASES.get(cleaned) ?? cleaned;
}

// src/core/store.ts
function dedupKeyOf(record) {
  if (!record.content) return void 0;
  return (0, import_node_crypto.createHash)("sha256").update(record.content).digest("hex").slice(0, 16);
}
var HEAT_NEUTRAL = 0.5;
var HEAT_DECAY_PER_DAY = 0.05;
var HEAT_BUMP = 0.15;
var HEAT_WEIGHT = 0.5;
var MIN_BUMP_INTERVAL_MS = 30 * 60 * 1e3;
function clampHeat(value) {
  if (Number.isNaN(value)) return HEAT_NEUTRAL;
  return Math.min(1, Math.max(0, value));
}
function effectiveHeatOf(record, decayPerDay, now) {
  const stored = typeof record.heat === "number" ? clampHeat(record.heat) : HEAT_NEUTRAL;
  const anchor = typeof record.lastTouchedAt === "number" ? record.lastTouchedAt : record.createdAt;
  if (typeof anchor !== "number" || now <= anchor) return stored;
  const days = (now - anchor) / 864e5;
  return clampHeat(stored * Math.exp(-decayPerDay * days));
}
function tokenizeText(text) {
  const tokens = [];
  const cleaned = text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ");
  for (const chunk of cleaned.split(" ")) {
    if (chunk === "") continue;
    for (const piece of chunk.split(/([㐀-䶿一-鿿])/)) {
      if (piece === "") continue;
      tokens.push(piece);
    }
  }
  return tokens;
}
var MemoryStore = class {
  /** 追加日志文件路径（存储根目录下固定文件名）。 */
  filePath;
  log;
  /** 内存索引：id -> record，保持插入（重放）顺序即时间顺序。 */
  byId = /* @__PURE__ */ new Map();
  /** 去重索引：dedupKeyOf(record) -> record。删除时移除。 */
  byDedupKey = /* @__PURE__ */ new Map();
  /** 已摄入过的轮次标记：append 后永久保留，删除记忆也不清除，防止同轮重复摄入复活。 */
  turnEventIds = /* @__PURE__ */ new Set();
  /**
   * 串行写链：所有 JSONL 追加都挂在这条 promise 链上按序落盘。
   * bumpHeat 的节流写是 fire-and-forget，若与 await 中的 claim 闭合写
   * 并发乱序，重放时旧快照会覆盖闭合结果——统一入链杜绝乱序。
   */
  writeChain = Promise.resolve();
  /** load 只重放一次；并发调用复用同一个 promise。 */
  loadPromise = null;
  constructor(storage, log) {
    this.filePath = (0, import_node_path2.join)(storage.rootDir(), "memories.jsonl");
    this.log = log;
  }
  /**
   * 把一条 op 追加到串行写链末尾，返回本次写入的 promise。
   * 链条本身吞掉失败继续走（后续写入不受前一次失败影响），
   * 错误交还给各调用方按自己的降级策略处理。
   */
  enqueueAppend(op) {
    const write = this.writeChain.then(() => appendJsonl(this.filePath, op));
    this.writeChain = write.catch(() => {
    });
    return write;
  }
  /** 等待全部挂起写入完成。生产路径无需调用；测试据此确认 fire-and-forget 的节流写已落盘。 */
  awaitPendingWrites() {
    return this.writeChain;
  }
  /** 从 JSONL 重放全部操作，构建内存索引。幂等，可安全多次调用。 */
  load() {
    this.loadPromise ??= this.replay();
    return this.loadPromise;
  }
  async replay() {
    let ops;
    try {
      ops = await readJsonl(this.filePath, this.log);
    } catch (err) {
      this.log.warn("记忆日志读取失败，按空库启动", err);
      return;
    }
    for (const entry of ops) {
      if (!entry || typeof entry !== "object") continue;
      if (entry.op === "put") {
        const record = entry.record;
        if (!record || typeof record.id !== "string" || record.id === "") {
          this.log.warn("跳过非法的 put 记录");
          continue;
        }
        this.byId.set(record.id, record);
        const dedupKey = dedupKeyOf(record);
        if (dedupKey) this.byDedupKey.set(dedupKey, record);
        const turnEventId = record.turn?.turnEventId;
        if (turnEventId) this.turnEventIds.add(turnEventId);
      } else if (entry.op === "del") {
        if (typeof entry.id !== "string") continue;
        const record = this.byId.get(entry.id);
        if (!record) continue;
        record.deleted = true;
        const dedupKey = dedupKeyOf(record);
        if (dedupKey && this.byDedupKey.get(dedupKey) === record) {
          this.byDedupKey.delete(dedupKey);
        }
      }
    }
  }
  /**
   * 追加一条记忆（put op）。id / createdAt 缺失时自动补齐；
   * conversationId 缺失时从 turn 反规范化兜底。
   * 带 entityClaims 时先把 attribute 归一化成 canonical 形式（LLM 选词
   * 不稳定，比较与落库一律在 canonical 口径上，见 core/attributes.ts），
   * 再去掉与既有活跃 claim 完全相同的条目（重述同一属性不制造时间轴
   * 噪音，别名变体也算同属性），落盘后再闭合旧的活跃 claim。
   * 返回是否成功落盘；失败已 warn，不抛异常。
   */
  async append(record) {
    await this.load();
    if (!record.id) record.id = (0, import_node_crypto.randomUUID)();
    if (typeof record.createdAt !== "number") record.createdAt = Date.now();
    if (!record.conversationId && record.turn?.conversationId) {
      record.conversationId = record.turn.conversationId;
    }
    if (record.entityClaims?.length) {
      for (const claim of record.entityClaims) {
        claim.attribute = canonicalAttr(claim.attribute);
        if (typeof claim.validFrom !== "number") claim.validFrom = record.createdAt;
        if (claim.validUntil === void 0) claim.validUntil = null;
      }
      const fresh = record.entityClaims.filter(
        (claim) => !this.hasActiveClaim(claim.entity, claim.attribute, claim.value)
      );
      if (fresh.length === 0) {
        delete record.entityClaims;
      } else {
        record.entityClaims = fresh;
      }
    }
    try {
      await this.enqueueAppend({ op: "put", record });
    } catch (err) {
      this.log.warn("记忆写入失败", record.id, err);
      return false;
    }
    this.byId.set(record.id, record);
    const dedupKey = dedupKeyOf(record);
    if (dedupKey) this.byDedupKey.set(dedupKey, record);
    const turnEventId = record.turn?.turnEventId;
    if (turnEventId) this.turnEventIds.add(turnEventId);
    await this.closeConflictingClaims(record);
    this.bumpMentionedEntities(record);
    return true;
  }
  /**
   * 是否存在同 (entity, attribute, value) 且仍活跃的 claim（软删记录不算）。
   * attribute 两侧都按 canonical 口径比较：入参已在 append 侧归一化，存量
   * claim 可能还是 v0.2.0 的旧字面量，比较时现归一——老数据不迁移也能判重。
   */
  hasActiveClaim(entity, attribute, value) {
    const want = canonicalAttr(attribute);
    for (const existing of this.byId.values()) {
      if (existing.deleted || !existing.entityClaims?.length) continue;
      for (const claim of existing.entityClaims) {
        if (claim.entity === entity && canonicalAttr(claim.attribute) === want && claim.value === value && claim.validUntil == null) {
          return true;
        }
      }
    }
    return false;
  }
  /**
   * 属性时间轴闭合：新记录的每条 claim 会把同 (entity, attribute) 的
   * 旧活跃 claim 的 validUntil 置为新记录的 createdAt。
   * 冲突比较一律在 canonical 口径上（两侧都归一）：存量 claim 的旧字面量
   * （如「工作所在地」）与新 claim 的 canonical 词条（如「工作地点」）
   * 视为同一属性，v0.2.0 的历史数据不迁移也能被正确闭合。
   * 更新已有记录 = 追加一个 put op（重放时同 id 覆盖）；失败只 warn，
   * 时间轴查询按「最新者为准」兜底，绝不因此抛异常或回滚新记录。
   */
  async closeConflictingClaims(record) {
    const newClaims = record.entityClaims;
    if (!newClaims?.length) return;
    const newPairs = newClaims.map((c) => ({
      entity: c.entity,
      attr: canonicalAttr(c.attribute)
    }));
    const targets = /* @__PURE__ */ new Map();
    for (const existing of this.byId.values()) {
      if (existing.deleted || existing.id === record.id) continue;
      if (!existing.entityClaims?.length) continue;
      for (let i = 0; i < existing.entityClaims.length; i += 1) {
        const claim = existing.entityClaims[i];
        if (claim.validUntil != null) continue;
        const conflicted = newPairs.some(
          (c) => c.entity === claim.entity && c.attr === canonicalAttr(claim.attribute)
        );
        if (!conflicted) continue;
        let target = targets.get(existing.id);
        if (!target) {
          target = { record: existing, indexes: /* @__PURE__ */ new Set() };
          targets.set(existing.id, target);
        }
        target.indexes.add(i);
      }
    }
    for (const { record: oldRecord, indexes } of targets.values()) {
      const closedClaims = oldRecord.entityClaims.map(
        (claim, i) => indexes.has(i) && claim.validUntil == null ? { ...claim, validUntil: record.createdAt } : claim
      );
      const updated = { ...oldRecord, entityClaims: closedClaims };
      try {
        await this.enqueueAppend({ op: "put", record: updated });
      } catch (err) {
        this.log.warn("闭合旧属性声明失败:", oldRecord.id, err);
        continue;
      }
      this.byId.set(oldRecord.id, updated);
    }
  }
  /** 追加删除标记（del op），并把内存中的记录标记为软删。 */
  async delete(id) {
    await this.load();
    const record = this.byId.get(id);
    if (!record) {
      this.log.warn("删除了未知的记忆", id);
      return;
    }
    try {
      await this.enqueueAppend({ op: "del", id });
    } catch (err) {
      this.log.warn("记忆删除失败", id, err);
      return;
    }
    record.deleted = true;
    const dedupKey = dedupKeyOf(record);
    if (dedupKey && this.byDedupKey.get(dedupKey) === record) {
      this.byDedupKey.delete(dedupKey);
    }
  }
  /**
   * 访问/提及加权：把这批 id 的有效热度向 1 靠拢一档，并刷新触碰时间。
   * bumped = effective + amount * (1 - effective)，落盘快照即 bumped
   * （put op 覆盖同 id，与 claim 闭合同一模式，重放一致）。
   *
   * 落盘节流（抖动抑制）：距 lastTouchedAt 不足 MIN_BUMP_INTERVAL_MS 的
   * 重复 bump 只更新内存索引（本轮排序立刻受益），不追加日志——
   * 否则每次检索命中都写一行，JSONL 会暴涨；重启后损失的只是节流窗口
   * 内的增量，heat 是主观信号，最终一致即可。
   *
   * 写入走 fire-and-forget（挂到串行写链，失败只 warn）：本方法保持同步、
   * 绝不抛异常——热度只是排序信号，任何故障不得波及检索主流程。
   * 注意：不等待 load()（同步约束），调用方须先完成 load——现有调用点
   * （hot-context / recall / search）都在检索之后，天然满足。
   */
  bumpHeat(ids, options) {
    try {
      const now = options?.now ?? Date.now();
      const decayPerDay = options?.decayPerDay ?? HEAT_DECAY_PER_DAY;
      const amount = options?.amount ?? HEAT_BUMP;
      for (const id of ids) {
        const record = this.byId.get(id);
        if (!record || record.deleted) continue;
        const effective = effectiveHeatOf(record, decayPerDay, now);
        const bumped = clampHeat(effective + amount * (1 - effective));
        const throttled = typeof record.lastTouchedAt === "number" && now - record.lastTouchedAt < MIN_BUMP_INTERVAL_MS;
        record.heat = bumped;
        record.lastTouchedAt = now;
        if (throttled) continue;
        const snapshot = { ...record };
        void this.enqueueAppend({ op: "put", record: snapshot }).catch(
          (err) => {
            this.log.warn("热度落盘失败:", id, err);
          }
        );
      }
    } catch (err) {
      this.log.warn("热度更新失败（已忽略）", err);
    }
  }
  /**
   * 被提及加权：新记忆落库后，与新记忆 entities 有交集的既有记录 bump 一次
   * （同 bumpHeat 的抖动抑制）——用户又提到这批记忆关联的人/事，是「被想起」
   * 的信号。实体名按原文精确匹配（与 claim 闭合同口径），归一化由抽取侧负责。
   */
  bumpMentionedEntities(record) {
    const mentioned = record.entities;
    if (!mentioned?.length) return;
    const wanted = new Set(mentioned);
    const ids = [];
    for (const existing of this.byId.values()) {
      if (existing.deleted || existing.id === record.id) continue;
      if (!existing.entities?.length) continue;
      if (existing.entities.some((entity) => wanted.has(entity))) ids.push(existing.id);
    }
    if (ids.length > 0) this.bumpHeat(ids);
  }
  /**
   * 全量记录（按时间顺序）。注意：调用前应先 await load()，
   * 否则拿到的是已重放部分的数据。
   */
  all(options) {
    const includeDeleted = options?.includeDeleted ?? false;
    const conversationId = options?.conversationId;
    const out = [];
    for (const record of this.byId.values()) {
      if (!includeDeleted && record.deleted) continue;
      if (conversationId !== void 0 && record.conversationId !== conversationId) continue;
      out.push(record);
    }
    return out;
  }
  /** 该轮次是否已摄入过（append 后永久标记，删除记忆不清除）。 */
  hasTurnEvent(turnEventId) {
    return this.turnEventIds.has(turnEventId);
  }
  /** 该去重键是否已有存活记录（软删会移除键，允许事后重写）。 */
  hasDedupKey(key) {
    return this.byDedupKey.has(key);
  }
  /** 简单关键词检索：匹配的查询词个数当分数，多者在前，同分新者在前。 */
  searchKeyword(query) {
    const queryTokens = [...new Set(tokenizeText(query))];
    if (queryTokens.length === 0) return [];
    const hits = [];
    for (const record of this.byId.values()) {
      if (record.deleted) continue;
      const contentTokens = new Set(tokenizeText(record.content));
      let score = 0;
      for (const token of queryTokens) {
        if (contentTokens.has(token)) score += 1;
      }
      if (score > 0) hits.push({ record, score });
    }
    hits.sort(
      (a, b) => b.score - a.score || b.record.createdAt - a.record.createdAt
    );
    return hits.map((hit) => hit.record);
  }
  /**
   * 实体属性时间轴：按 validFrom 升序返回该实体（可选限定单一属性）的
   * 全部 claim。只含未软删记录；某属性的「当前值」由调用方取时间序
   * 最新一条判断 validUntil 是否为空——这样即使闭合落盘失败过，
   * 查询侧也能容忍「多条同时活跃」的脏状态。
   *
   * 属性过滤按 canonical 口径（两侧都归一）：存量旧字面量与词表变体
   * （「出差行程」/「行程」）并入同一 track；返回的 claim 保留原始
   * attribute 字面量，面板展示不丢真。
   */
  getEntityTimeline(entity, attribute) {
    const wantAttr = attribute === void 0 ? void 0 : canonicalAttr(attribute);
    const entries = [];
    for (const record of this.byId.values()) {
      if (record.deleted || !record.entityClaims?.length) continue;
      for (const claim of record.entityClaims) {
        if (claim.entity !== entity) continue;
        if (wantAttr !== void 0 && canonicalAttr(claim.attribute) !== wantAttr) continue;
        entries.push({ record, claim });
      }
    }
    entries.sort(
      (a, b) => (a.claim.validFrom ?? a.record.createdAt) - (b.claim.validFrom ?? b.record.createdAt)
    );
    return entries;
  }
  /** 统计信息：total 含已软删，active 不含；byConversation 只统计活跃记录。 */
  getStats() {
    let active = 0;
    const byConversation = {};
    for (const record of this.byId.values()) {
      if (record.deleted) continue;
      active += 1;
      if (record.conversationId) {
        byConversation[record.conversationId] = (byConversation[record.conversationId] ?? 0) + 1;
      }
    }
    return { total: this.byId.size, active, byConversation };
  }
};

// src/config.ts
var CONFIG_KEY = "config";
var DEFAULT_CONSOLIDATION_ENABLED = true;
var DEFAULT_CONSOLIDATION_IDLE_MINUTES = 30;
var DEFAULT_CONSOLIDATION_MAX_RECORDS = 80;
var DEFAULT_RERANK_ENABLED = true;
var DEFAULT_CONFIG = {
  embeddingProvider: "none",
  embeddingBaseUrl: "https://api.openai.com/v1",
  embeddingModel: "text-embedding-3-small",
  embeddingApiKeyName: "embedding_api_key",
  hotContextBudgetChars: 900,
  maxMemoriesPerTurn: 3,
  heatDecayPerDay: HEAT_DECAY_PER_DAY,
  heatWeight: HEAT_WEIGHT,
  heatBump: HEAT_BUMP,
  consolidationEnabled: DEFAULT_CONSOLIDATION_ENABLED,
  consolidationIdleMinutes: DEFAULT_CONSOLIDATION_IDLE_MINUTES,
  consolidationMaxRecords: DEFAULT_CONSOLIDATION_MAX_RECORDS,
  rerankEnabled: DEFAULT_RERANK_ENABLED
};
function loadConfig(storage) {
  const saved = storage.get(CONFIG_KEY) ?? {};
  return { ...DEFAULT_CONFIG, ...saved };
}
function saveConfig(storage, config) {
  storage.set(CONFIG_KEY, config);
}

// src/core/insights.ts
var INSIGHTS_KEY = "insights";
function emptyInsights() {
  return { version: 1, lastRunAt: 0, clusters: [], conflicts: [] };
}
function sanitizeCluster(item) {
  if (typeof item !== "object" || item === null) return null;
  const { id, label, recordIds, createdAt } = item;
  if (typeof id !== "string" || id === "") return null;
  if (typeof label !== "string") return null;
  if (typeof createdAt !== "number" || !Number.isFinite(createdAt)) return null;
  if (!Array.isArray(recordIds) || recordIds.length === 0) return null;
  if (!recordIds.every((rid) => typeof rid === "string" && rid !== "")) return null;
  return { id, label, recordIds: [...recordIds], createdAt };
}
function sanitizeConflict(item) {
  if (typeof item !== "object" || item === null) return null;
  const { id, note, recordIds, createdAt } = item;
  if (typeof id !== "string" || id === "") return null;
  if (typeof note !== "string") return null;
  if (typeof createdAt !== "number" || !Number.isFinite(createdAt)) return null;
  if (!Array.isArray(recordIds) || recordIds.length !== 2) return null;
  if (!recordIds.every((rid) => typeof rid === "string" && rid !== "")) return null;
  return { id, note, recordIds: [recordIds[0], recordIds[1]], createdAt };
}
function loadInsights(storage) {
  try {
    const raw = storage.get(INSIGHTS_KEY);
    if (typeof raw !== "object" || raw === null) return emptyInsights();
    const obj = raw;
    if (obj.version !== 1) return emptyInsights();
    if (typeof obj.lastRunAt !== "number" || !Number.isFinite(obj.lastRunAt)) {
      return emptyInsights();
    }
    if (!Array.isArray(obj.clusters) || !Array.isArray(obj.conflicts)) return emptyInsights();
    const clusters = obj.clusters.map(sanitizeCluster).filter((item) => item !== null);
    const conflicts = obj.conflicts.map(sanitizeConflict).filter((item) => item !== null);
    return { version: 1, lastRunAt: obj.lastRunAt, clusters, conflicts };
  } catch {
    return emptyInsights();
  }
}
function saveInsights(storage, next, log) {
  try {
    storage.set(INSIGHTS_KEY, next);
  } catch (err) {
    log.warn("洞察写入失败（保留旧数据）:", err);
  }
}

// src/pipeline/queue.ts
var TaskQueue = class {
  signal;
  log;
  concurrency;
  queue = [];
  running = 0;
  handleAbort = () => {
    if (this.queue.length === 0) return;
    const dropped = this.queue.splice(0, this.queue.length);
    for (const item of dropped) item.settle();
    this.log.log(`队列已中止，丢弃 ${dropped.length} 个排队任务`);
    this.detachAbortListener();
  };
  constructor(options) {
    this.signal = options.signal;
    this.log = options.log;
    this.concurrency = Math.max(1, Math.floor(options.concurrency ?? 1));
    this.signal.addEventListener("abort", this.handleAbort);
  }
  /**
   * 入队一个任务。返回的 Promise 在任务结束（成功、失败被吞掉或
   * 因中止被丢弃）时 resolve，不会 reject。
   */
  enqueue(task, processor) {
    if (this.signal.aborted) {
      this.log.log("队列已中止，直接丢弃任务:", task);
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.queue.push({ task, processor, settle: resolve });
      this.pump();
    });
  }
  stats() {
    return { pending: this.queue.length, running: this.running };
  }
  /** 派发排队任务直到占满并发额度；空闲时摘掉 abort 监听，避免泄漏。 */
  pump() {
    while (!this.signal.aborted && this.running < this.concurrency && this.queue.length > 0) {
      const item = this.queue.shift();
      if (!item) break;
      this.running += 1;
      void this.run(item);
    }
    this.detachAbortListener();
  }
  async run(item) {
    try {
      await item.processor(item.task, this.signal);
    } catch (err) {
      this.log.warn("任务处理失败（已忽略）:", err);
    } finally {
      this.running -= 1;
      item.settle();
      this.pump();
    }
  }
  detachAbortListener() {
    if (this.signal.aborted || this.running > 0 || this.queue.length > 0) return;
    this.signal.removeEventListener("abort", this.handleAbort);
  }
};

// src/core/remember.ts
async function remember(store, record, log) {
  await store.load();
  const dedupKey = dedupKeyOf(record);
  if (dedupKey && store.hasDedupKey(dedupKey)) {
    log.warn("相同内容的事实已存在，跳过写入", dedupKey);
    return false;
  }
  try {
    return await store.append(record);
  } catch (err) {
    log.warn("记忆写入失败", err);
    return false;
  }
}

// src/pipeline/extractor.ts
var EMPTY_TURN = { facts: [], claims: [] };
var MAX_TRANSCRIPT_CHARS = 16e3;
var MAX_CLAIMS_PER_TURN = 8;
var CLAIM_FIELD_MAX_CHARS = 80;
function buildSystemPrompt(maxFacts) {
  return [
    "你是对话记忆抽取器。从对话中找出值得长期记住的事实，以及其中会随时间变化的实体属性，供日后回忆和时间轴查询使用。",
    "要求：",
    "- facts：只保留稳定、可复用的信息（身份、偏好、项目、约定、结论、重要背景），忽略寒暄和一次性过程。",
    `- 每条 facts 改写成独立自包含的第三人称陈述句，脱离上下文也能读懂，最多 ${maxFacts} 条；没有值得记的就输出空数组。`,
    "- claims：从 facts 里挑出「会随时间变化的属性」的当前值，例如居住地、正在做的事、养了什么宠物、关系状态；明显恒定、永不变化的属性（生日等）不要写。",
    // 固定属性词表：LLM 选词不稳定会让时间轴按字面量分裂成多条（生产实测
    // 「工作所在地」vs「工作地点」），先用封闭词表从源头收敛；漏网变体由
    // 存储侧 canonicalAttr 兜底。词表是静态文本，与对话内容无关。
    `- attribute 优先从固定词表里选一个：${CANONICAL_ATTRS.join("、")}。同一个属性每轮都用词表里的同一个词（写「工作地点」不写「工作所在地」，写「行程」不写「出差行程」）；词表实在覆盖不了时才自拟最简短的属性名。`,
    "- 每条 claim 是一个对象：entity 是属性所属的主体名（如「用户」「月饼」），attribute 是属性名（如「居住地」），value 是当前值，fact 是该 claim 来源事实在 facts 数组中的下标（从 0 开始）。最多 8 条；没有就输出空数组。",
    '- 只输出一个 JSON 对象，格式：{"facts": ["..."], "claims": [{"entity": "...", "attribute": "...", "value": "...", "fact": 0}]}，不要任何解释或 Markdown。'
  ].join("\n");
}
function buildTranscript(messages) {
  const transcript = messages.map((m) => `${m.role === "user" ? "用户" : "助手"}：${m.text.trim()}`).join("\n");
  if (transcript.length <= MAX_TRANSCRIPT_CHARS) return transcript;
  return `${transcript.slice(0, MAX_TRANSCRIPT_CHARS)}
…（后文已截断）`;
}
function sanitizeFacts(raw, maxFacts) {
  return raw.filter((item) => typeof item === "string").map((item) => item.trim()).filter((item) => item.length > 0).slice(0, maxFacts);
}
function sanitizeClaims(raw, factCount) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const { entity, attribute, value, fact } = item;
    if (typeof entity !== "string" || typeof attribute !== "string" || typeof value !== "string") {
      continue;
    }
    const trimmedEntity = entity.trim();
    const trimmedValue = value.trim();
    const canonical = canonicalAttr(attribute);
    if (!trimmedEntity || !canonical || !trimmedValue) continue;
    const index = typeof fact === "number" ? fact : typeof fact === "string" ? Number(fact) : NaN;
    if (!Number.isInteger(index) || index < 0 || index >= factCount) continue;
    out.push({
      entity: trimmedEntity.slice(0, CLAIM_FIELD_MAX_CHARS),
      attribute: canonical.slice(0, CLAIM_FIELD_MAX_CHARS),
      value: trimmedValue.slice(0, CLAIM_FIELD_MAX_CHARS),
      factIndex: index
    });
    if (out.length >= MAX_CLAIMS_PER_TURN) break;
  }
  return out;
}
function parseTurn(raw, maxFacts) {
  let text = raw.trim();
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) text = fenced[1].trim();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    const brace = text.match(/\{[\s\S]*\}/);
    if (brace) {
      try {
        parsed = JSON.parse(brace[0]);
      } catch {
        parsed = void 0;
      }
    }
    if (parsed === void 0) {
      const bracket = text.match(/\[[\s\S]*\]/);
      if (!bracket) return null;
      try {
        parsed = JSON.parse(bracket[0]);
      } catch {
        return null;
      }
    }
  }
  if (Array.isArray(parsed)) {
    return { facts: sanitizeFacts(parsed, maxFacts), claims: [] };
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed;
  if (!Array.isArray(obj.facts)) return null;
  const facts = sanitizeFacts(obj.facts, maxFacts);
  return { facts, claims: sanitizeClaims(obj.claims, facts.length) };
}
async function extractTurn(llm, messages, options) {
  const { maxFacts, log, signal } = options;
  if (maxFacts <= 0 || messages.length === 0) return EMPTY_TURN;
  if (signal?.aborted) return EMPTY_TURN;
  const requestMessages = [
    { role: "system", content: buildSystemPrompt(maxFacts) },
    { role: "user", content: buildTranscript(messages) }
  ];
  try {
    const raw = await llm.generateText(requestMessages, {
      maxTokens: 512,
      signal,
      purpose: "extract-facts"
    });
    if (signal?.aborted) return EMPTY_TURN;
    const turn = parseTurn(raw, maxFacts);
    if (turn === null) {
      log.warn("事实抽取输出无法解析，本轮跳过:", raw.slice(0, 200));
      return EMPTY_TURN;
    }
    if (turn.facts.length === 0) log.log("本轮没有抽取到事实");
    return turn;
  } catch (err) {
    log.warn("事实抽取失败（降级为不写入）:", err);
    return EMPTY_TURN;
  }
}

// src/pipeline/ingest.ts
var PAGE_SIZE = 50;
var MAX_MESSAGES = 200;
async function readFrozenRange(conversations, task, signal) {
  const messages = [];
  let cursor;
  do {
    if (signal?.aborted) break;
    const page = await conversations.getMessages({
      conversationId: task.conversationId,
      fromMessageId: task.inputMessageId,
      throughMessageId: task.finalMessageId,
      limit: PAGE_SIZE,
      cursor
    });
    messages.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor && messages.length < MAX_MESSAGES);
  return messages;
}
function createTurnIngestor(deps) {
  const { conversations, llm, embedder, store, config, log } = deps;
  return async function handle(task, signal) {
    if (signal?.aborted) return;
    try {
      const messages = await readFrozenRange(conversations, task, signal);
      if (messages.length === 0 || signal?.aborted) return;
      const { facts, claims } = await extractTurn(llm, messages, {
        maxFacts: config.maxMemoriesPerTurn,
        log,
        signal
      });
      if (facts.length === 0 || signal?.aborted) return;
      const vectors = await embedder.embed(facts).catch((err) => {
        log.warn("向量获取失败，本轮降级为纯关键词:", err);
        return null;
      });
      if (signal?.aborted) return;
      for (let i = 0; i < facts.length; i += 1) {
        if (signal?.aborted) return;
        const createdAt = Date.now();
        const record = {
          id: "",
          createdAt,
          content: facts[i],
          turn: {
            conversationId: task.conversationId,
            turnEventId: task.turnEventId,
            runId: task.runId
          },
          conversationId: task.conversationId,
          embedding: vectors?.[i],
          embeddingModel: vectors ? embedder.id : void 0
        };
        const factClaims = claims.filter((claim) => claim.factIndex === i).map((claim) => ({
          entity: claim.entity,
          attribute: claim.attribute,
          value: claim.value,
          validFrom: createdAt,
          validUntil: null
        }));
        if (factClaims.length > 0) record.entityClaims = factClaims;
        await remember(store, record, log);
      }
    } catch (err) {
      log.warn("turn 摄入失败（已忽略）:", err);
    }
  };
}

// src/pipeline/embedder.ts
var EMBED_TIMEOUT_MS = 3e4;
function embeddingsUrl(baseUrl) {
  const base = baseUrl.trim().replace(/\/+$/, "");
  if (/\/embeddings$/i.test(base)) return base;
  return `${base}/embeddings`;
}
function isFiniteNumberArray(value) {
  return Array.isArray(value) && value.length > 0 && value.every((n) => typeof n === "number" && Number.isFinite(n));
}
function parseVectors(data, expected) {
  if (!Array.isArray(data) || data.length !== expected) return null;
  const vectors = [];
  for (const item of data) {
    const embedding = typeof item === "object" && item !== null ? item.embedding : void 0;
    if (!isFiniteNumberArray(embedding)) return null;
    vectors.push(embedding);
  }
  return vectors;
}
function createEmbedderByProvider(config, deps) {
  if (config.embeddingProvider !== "openai-compatible") {
    return {
      id: "none",
      embed: async () => null
    };
  }
  const { secrets, log } = deps;
  const url = embeddingsUrl(config.embeddingBaseUrl);
  return {
    id: `openai-compatible:${config.embeddingModel}`,
    async embed(texts) {
      if (texts.length === 0) return [];
      try {
        const apiKey = secrets ? await secrets.get(config.embeddingApiKeyName) : void 0;
        if (!apiKey) {
          log.warn(`未配置 embedding 密钥（${config.embeddingApiKeyName}），本轮降级为纯关键词检索`);
          return null;
        }
        const response = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`
          },
          body: JSON.stringify({ input: texts, model: config.embeddingModel }),
          signal: AbortSignal.timeout(EMBED_TIMEOUT_MS)
        });
        if (!response.ok) {
          const detail = (await response.text().catch(() => "")).slice(0, 200);
          log.warn(`embeddings 请求失败 HTTP ${response.status}:`, detail);
          return null;
        }
        const payload = await response.json();
        const data = typeof payload === "object" && payload !== null ? payload.data : void 0;
        const vectors = parseVectors(data, texts.length);
        if (!vectors) {
          log.warn("embeddings 响应结构异常，本轮降级为纯关键词检索");
          return null;
        }
        return vectors;
      } catch (err) {
        log.warn("embeddings 请求异常，本轮降级为纯关键词检索:", err);
        return null;
      }
    }
  };
}

// src/pipeline/consolidate.ts
var import_node_crypto2 = require("node:crypto");

// src/retrieval/hybrid.ts
var KEYWORD_WEIGHT = 0.7;
var VECTOR_WEIGHT = 1;
var DEFAULT_LIMIT = 10;
function createHybridSearcher(store, config, deps) {
  const { embedder, log } = deps;
  const heatWeight = config.heatWeight ?? HEAT_WEIGHT;
  const decayPerDay = config.heatDecayPerDay ?? HEAT_DECAY_PER_DAY;
  return async function search(query) {
    const limit = Math.max(1, Math.floor(query.limit ?? DEFAULT_LIMIT));
    await store.load();
    const candidates = store.searchKeyword(query.text).filter(
      (record) => !query.conversationId || record.conversationId === query.conversationId
    );
    if (candidates.length === 0) {
      return [];
    }
    const keywordScores = keywordScoresOf(query.text, candidates);
    const now = Date.now();
    const heatGain = (record) => (
      // 热度增益：score *= 1 + weight * effectiveHeat，常被想起的记忆上浮
      1 + heatWeight * effectiveHeatOf(record, decayPerDay, now)
    );
    const queryVector = await fetchQueryVector(query.text);
    if (!queryVector) {
      const boosted = candidates.map((record, index) => ({
        record,
        score: keywordScores[index] * heatGain(record),
        source: "keyword"
      }));
      boosted.sort((a, b) => b.score - a.score);
      return boosted.slice(0, limit);
    }
    const maxKeyword = Math.max(0, ...keywordScores);
    const fused = candidates.map((record, index) => {
      const keywordScore = maxKeyword > 0 ? keywordScores[index] / maxKeyword : 0;
      const vectorScore = vectorScoreOf(record, queryVector, config);
      return {
        record,
        score: (KEYWORD_WEIGHT * keywordScore + VECTOR_WEIGHT * vectorScore) * heatGain(record),
        source: "hybrid"
      };
    });
    fused.sort((a, b) => b.score - a.score);
    return fused.slice(0, limit);
  };
  async function fetchQueryVector(text) {
    const trimmed = text.trim();
    if (!embedder || trimmed.length === 0) {
      return null;
    }
    try {
      const vectors = await embedder.embed([trimmed]);
      return vectors?.[0] ?? null;
    } catch (err) {
      log.warn("查询向量获取失败，退化为纯关键词检索：", err);
      return null;
    }
  }
}
function keywordScoresOf(query, records) {
  const queryTokens = [...new Set(tokenizeText(query))];
  return records.map((record) => {
    if (queryTokens.length === 0) return 0;
    const contentTokens = new Set(tokenizeText(record.content));
    let score = 0;
    for (const token of queryTokens) {
      if (contentTokens.has(token)) score += 1;
    }
    return score;
  });
}
function vectorScoreOf(record, queryVector, config) {
  if (!record.embedding || record.embeddingModel !== config.embeddingModel) {
    return 0;
  }
  const cosine = cosineSimilarity(queryVector, record.embedding);
  return (cosine + 1) / 2;
}
function cosineSimilarity(a, b) {
  if (a.length === 0 || a.length !== b.length) {
    return 0;
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) {
    return 0;
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// src/pipeline/consolidate.ts
var MIN_RECORDS_FOR_RUN = 5;
var MAX_CLUSTERS = 8;
var MIN_CLUSTER_SIZE = 2;
var MAX_CANDIDATE_PAIRS = 40;
var MAX_CONFLICTS = MAX_CANDIDATE_PAIRS;
var MIN_CENTROID_COSINE = 0.5;
var NOTE_MAX_CHARS = 80;
var LABEL_MAX_CHARS = 80;
var SNIPPET_MAX_CHARS = 200;
var MAX_OUTPUT_TOKENS = 2048;
var UNNAMED_LABEL = "未命名主题";
function find(parent, i) {
  while (parent[i] !== i) {
    parent[i] = parent[parent[i]];
    i = parent[i];
  }
  return i;
}
function union(parent, a, b) {
  const ra = find(parent, a);
  const rb = find(parent, b);
  if (ra !== rb) parent[rb] = ra;
}
function entitiesOf(record) {
  const seen = /* @__PURE__ */ new Set();
  const collect = (candidates) => {
    if (!Array.isArray(candidates)) return;
    for (const entity of candidates) {
      if (typeof entity === "string" && entity !== "") seen.add(entity);
    }
  };
  collect(record.entities);
  collect((record.entityClaims ?? []).map((claim) => claim.entity));
  return [...seen];
}
var HUB_FRACTION = 0.5;
var HUB_MIN_RECORDS = 8;
function entityClustersOf(records) {
  const frequency = /* @__PURE__ */ new Map();
  for (const record of records) {
    for (const entity of entitiesOf(record)) {
      frequency.set(entity, (frequency.get(entity) ?? 0) + 1);
    }
  }
  const hubMin = Math.max(Math.ceil(records.length * HUB_FRACTION), HUB_MIN_RECORDS);
  const isHub = (entity) => (frequency.get(entity) ?? 0) >= hubMin;
  const parent = records.map((_, i) => i);
  const firstByEntity = /* @__PURE__ */ new Map();
  for (let i = 0; i < records.length; i += 1) {
    for (const entity of entitiesOf(records[i])) {
      if (isHub(entity)) continue;
      const first = firstByEntity.get(entity);
      if (first === void 0) firstByEntity.set(entity, i);
      else union(parent, first, i);
    }
  }
  const byRoot = /* @__PURE__ */ new Map();
  for (let i = 0; i < records.length; i += 1) {
    const root = find(parent, i);
    const members = byRoot.get(root);
    if (members) members.push(i);
    else byRoot.set(root, [i]);
  }
  return [...byRoot.values()].filter((members) => members.length >= MIN_CLUSTER_SIZE);
}
function centroidOf(vectors) {
  const dims = vectors[0]?.length ?? 0;
  const sum = new Array(dims).fill(0);
  let count = 0;
  for (const vector of vectors) {
    if (!Array.isArray(vector) || vector.length !== dims) continue;
    count += 1;
    for (let i = 0; i < dims; i += 1) sum[i] += vector[i];
  }
  if (count === 0) return sum;
  return sum.map((value) => value / count);
}
async function pruneClustersByCentroid(clusters, records, embedder, log) {
  const texts = clusters.flat().map((i) => {
    const content = records[i].content;
    return typeof content === "string" ? content : "";
  });
  let vectors;
  try {
    vectors = await embedder.embed(texts);
  } catch (err) {
    log.warn("整合向量获取失败，跳过簇内校验:", err);
    return clusters;
  }
  if (!vectors || vectors.length !== texts.length) {
    log.warn("整合向量响应异常，跳过簇内校验");
    return clusters;
  }
  const kept = [];
  let offset = 0;
  for (const cluster of clusters) {
    const memberVectors = vectors.slice(offset, offset + cluster.length);
    offset += cluster.length;
    const centroid = centroidOf(memberVectors);
    const survivors = cluster.filter(
      (_, k) => cosineSimilarity(memberVectors[k], centroid) >= MIN_CENTROID_COSINE
    );
    if (survivors.length >= MIN_CLUSTER_SIZE) kept.push(survivors);
  }
  return kept;
}
function candidatePairsOf(records, clusters, heatOf) {
  const seen = /* @__PURE__ */ new Set();
  const pairs = [];
  const addPair = (i, j) => {
    if (i === j) return;
    const lo = Math.min(i, j);
    const hi = Math.max(i, j);
    const key = `${lo}|${hi}`;
    if (seen.has(key)) return;
    seen.add(key);
    pairs.push([lo, hi]);
  };
  const byEntity = /* @__PURE__ */ new Map();
  for (let i = 0; i < records.length; i += 1) {
    for (const entity of entitiesOf(records[i])) {
      const indexes = byEntity.get(entity);
      if (indexes) indexes.push(i);
      else byEntity.set(entity, [i]);
    }
  }
  for (const indexes of byEntity.values()) {
    for (let a = 0; a < indexes.length; a += 1) {
      for (let b = a + 1; b < indexes.length; b += 1) addPair(indexes[a], indexes[b]);
    }
  }
  for (const cluster of clusters) {
    for (let a = 0; a < cluster.length; a += 1) {
      for (let b = a + 1; b < cluster.length; b += 1) addPair(cluster[a], cluster[b]);
    }
  }
  pairs.sort(
    (x, y) => heatOf(records[y[0]]) + heatOf(records[y[1]]) - (heatOf(records[x[0]]) + heatOf(records[x[1]]))
  );
  return pairs.slice(0, MAX_CANDIDATE_PAIRS);
}
function hasClosedTimelineOverlap(a, b) {
  const keysOf = (record) => {
    const map = /* @__PURE__ */ new Map();
    if (!Array.isArray(record.entityClaims)) return map;
    for (const claim of record.entityClaims) {
      if (typeof claim?.entity !== "string" || claim.entity === "") continue;
      const attr = canonicalAttr(claim.attribute);
      const key = `${claim.entity}\0${attr}`;
      const closed = claim.validUntil != null;
      map.set(key, (map.get(key) ?? false) || closed);
    }
    return map;
  };
  const aKeys = keysOf(a);
  const bKeys = keysOf(b);
  for (const [key, aClosed] of aKeys) {
    const bClosed = bKeys.get(key);
    if (bClosed !== void 0 && (aClosed || bClosed)) return true;
  }
  return false;
}
function snippetOf(record) {
  const content = typeof record.content === "string" ? record.content.trim() : "";
  if (content.length <= SNIPPET_MAX_CHARS) return content;
  return `${content.slice(0, SNIPPET_MAX_CHARS)}…`;
}
function buildSystemPrompt2() {
  return [
    "你是记忆整合器，根据给定的候选材料完成两件事。",
    "一、主题命名：给每个簇起一个简短的中文主题标签（不超过 12 个字），概括簇内记忆的共同主题。",
    "二、矛盾甄别：逐对检查疑似矛盾候选对，只把确实互相矛盾的对报告出来（同一事实有两种互斥说法、状态互斥等），并给一句不超过 40 字的中文矛盾摘要；不确定或不矛盾的不要输出。",
    "要求：",
    '- 只输出一个 JSON 对象，格式：{"clusters":[{"index":<簇编号>,"label":"..."}],"conflicts":[{"a":<记忆序号>,"b":<记忆序号>,"note":"..."}]}，不要任何解释或 Markdown。',
    "- index 必须是给定的簇编号，a、b 必须是给定的记忆序号，绝不编造材料里没有的编号。",
    "- 材料只列出了和任务相关的记忆，序号不连续属正常现象。",
    "- 没有矛盾就输出空的 conflicts 数组。"
  ].join("\n");
}
function buildUserPrompt(records, clusters, pairs) {
  const lines = [];
  if (clusters.length > 0) {
    lines.push("【主题候选簇】（#数字 是记忆序号）");
    clusters.forEach((cluster, ci) => {
      lines.push(`簇${ci}：`);
      for (const i of cluster) lines.push(`  #${i}. ${snippetOf(records[i])}`);
    });
  }
  if (pairs.length > 0) {
    lines.push("【疑似矛盾候选对】（只是候选，未必真的矛盾）");
    pairs.forEach(([a, b], pi) => {
      lines.push(`对${pi}：#${a}. ${snippetOf(records[a])} ←→ #${b}. ${snippetOf(records[b])}`);
    });
  }
  return lines.join("\n");
}
function parseIntegrationOutput(raw) {
  let text = raw.trim();
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) text = fenced[1].trim();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    const brace = text.match(/\{[\s\S]*\}/);
    if (!brace) return null;
    try {
      parsed = JSON.parse(brace[0]);
    } catch {
      return null;
    }
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed;
  if (!Array.isArray(obj.clusters) && !Array.isArray(obj.conflicts)) return null;
  return {
    clusters: Array.isArray(obj.clusters) ? obj.clusters : [],
    conflicts: Array.isArray(obj.conflicts) ? obj.conflicts : []
  };
}
function toIndex(value, bound) {
  const index = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isInteger(index) || index < 0 || index >= bound) return null;
  return index;
}
function sanitizeLabels(raw, clusterCount) {
  const labels = /* @__PURE__ */ new Map();
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const { index, label } = item;
    const idx = toIndex(index, clusterCount);
    if (idx === null || typeof label !== "string") continue;
    const trimmed = label.trim();
    if (!trimmed || labels.has(idx)) continue;
    labels.set(idx, trimmed.slice(0, LABEL_MAX_CHARS));
  }
  return labels;
}
function sanitizeConflicts(raw, records) {
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const { a, b, note } = item;
    const ai = toIndex(a, records.length);
    const bi = toIndex(b, records.length);
    if (ai === null || bi === null || ai === bi) continue;
    if (typeof note !== "string") continue;
    const trimmed = note.trim();
    if (!trimmed) continue;
    const lo = Math.min(ai, bi);
    const hi = Math.max(ai, bi);
    const key = `${lo}|${hi}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      recordIds: [records[lo].id, records[hi].id],
      note: trimmed.slice(0, NOTE_MAX_CHARS)
    });
    if (out.length >= MAX_CONFLICTS) break;
  }
  return out;
}
function shortRandom() {
  return (0, import_node_crypto2.randomUUID)().replace(/-/g, "").slice(0, 8);
}
function createConsolidator(deps) {
  const { store, llm, embedder, storage, maxRecords, log } = deps;
  async function run(signal) {
    try {
      if (signal.aborted) {
        log.warn("记忆整合被中止，本次跳过");
        return null;
      }
      await store.load();
      if (signal.aborted) {
        log.warn("记忆整合被中止，本次跳过");
        return null;
      }
      const now = Date.now();
      const heatOf = (record) => effectiveHeatOf(record, HEAT_DECAY_PER_DAY, now);
      const active = store.all({ includeDeleted: false });
      const selected = [...active].sort((a, b) => heatOf(b) - heatOf(a) || (b.createdAt ?? 0) - (a.createdAt ?? 0)).slice(0, Number.isFinite(maxRecords) ? Math.max(0, Math.floor(maxRecords)) : 0);
      if (selected.length < MIN_RECORDS_FOR_RUN) {
        log.warn(`活跃记忆仅 ${selected.length} 条（不足 ${MIN_RECORDS_FOR_RUN}），跳过整合`);
        return null;
      }
      let clusters = entityClustersOf(selected);
      if (embedder && clusters.length > 0) {
        clusters = await pruneClustersByCentroid(clusters, selected, embedder, log);
        if (signal.aborted) {
          log.warn("记忆整合被中止，本次跳过");
          return null;
        }
      }
      clusters = [...clusters].sort((a, b) => b.length - a.length).slice(0, MAX_CLUSTERS);
      const pairs = candidatePairsOf(selected, clusters, heatOf).filter(
        ([a, b]) => !hasClosedTimelineOverlap(selected[a], selected[b])
      );
      if (clusters.length === 0 && pairs.length === 0) {
        log.warn("没有可整合的主题簇或候选矛盾对，跳过整合");
        return null;
      }
      const requestMessages = [
        { role: "system", content: buildSystemPrompt2() },
        { role: "user", content: buildUserPrompt(selected, clusters, pairs) }
      ];
      const raw = await llm.generateText(requestMessages, {
        maxTokens: MAX_OUTPUT_TOKENS,
        signal,
        purpose: "consolidate-insights"
      });
      if (signal.aborted) {
        log.warn("记忆整合被中止，本次跳过");
        return null;
      }
      const parsed = parseIntegrationOutput(raw);
      if (parsed === null) {
        log.warn("记忆整合输出无法解析，本次跳过:", raw.slice(0, 200));
        return null;
      }
      const labels = sanitizeLabels(parsed.clusters, clusters.length);
      const conflicts = sanitizeConflicts(parsed.conflicts, selected);
      const insights = {
        version: 1,
        lastRunAt: now,
        clusters: clusters.map((cluster, ci) => ({
          id: `cluster_${now}_${shortRandom()}`,
          label: labels.get(ci) ?? UNNAMED_LABEL,
          recordIds: cluster.map((i) => selected[i].id),
          createdAt: now
        })),
        conflicts: conflicts.map((conflict) => ({
          ...conflict,
          id: `conflict_${now}_${shortRandom()}`,
          createdAt: now
        }))
      };
      saveInsights(storage, insights, log);
      if (loadInsights(storage).lastRunAt !== insights.lastRunAt) {
        log.warn("洞察落盘校验失败，本次整合结果放弃");
        return null;
      }
      log.log(`记忆整合完成：${insights.clusters.length} 个主题簇，${insights.conflicts.length} 对矛盾标注`);
      return insights;
    } catch (err) {
      log.warn("记忆整合失败（本次跳过）:", err);
      return null;
    }
  }
  return { run };
}

// src/provider/hot-context.ts
var TOP_K = 3;
var HEADER = "[岁月涟漪·记忆]";
function createHotContextProvider(deps) {
  const { store, config, log } = deps;
  const budget = Math.max(0, config.hotContextBudgetChars);
  const search = createHybridSearcher(store, config, { log });
  const provider = {
    id: "hot-context",
    // 不填 modes：缺省即覆盖全部模式（chat / work / learn / code）。
    // moments-post 为显式 opt-in（宿主 #75 起 Provider 必须声明场景才参与）：
    // 昔涟发动态时同样注入相关记忆。moments-post 的 userText 是对话摘要快照，
    // 关键词检索照常工作；记忆保持全局，不按 conversationId 过滤——
    // 跨聊天记忆正是本插件的核心能力。
    sources: ["conversation", "scheduler", "moments-post"],
    async provide(input) {
      try {
        if (input.signal.aborted) return "";
        const text = input.userText.trim();
        if (!text) return "";
        const hits = await search({ text, limit: TOP_K });
        if (input.signal.aborted) return "";
        let block = HEADER;
        let kept = 0;
        const keptIds = [];
        for (const hit of hits) {
          const content = hit.record.content.trim();
          if (!content) continue;
          const line = `- ${content}`;
          const candidate = `${block}
${line}`;
          if (candidate.length > budget) break;
          block = candidate;
          keptIds.push(hit.record.id);
          kept += 1;
        }
        if (kept > 0) {
          store.bumpHeat(keptIds);
        }
        return kept > 0 ? block : "";
      } catch (err) {
        log.warn("hot-context 记忆注入失败，本轮跳过：", err);
        return "";
      }
    }
  };
  return provider;
}

// src/retrieval/rerank.ts
var RERANK_CANDIDATES = 10;
var SNIPPET_MAX_CHARS2 = 160;
var RERANK_MAX_TOKENS = 256;
var RERANK_TIMEOUT_MS = 15e3;
function buildSystemPrompt3() {
  return [
    "你是记忆检索精排器。根据查询主题判断每条候选记忆与查询的相关度，把它们按相关度从高到低重新排序。",
    "要求：",
    '- 只输出一个 JSON 对象，格式：{"order":[2,0,1]}，不要任何解释或 Markdown。',
    "- order 数组的元素是候选编号（从 0 开始），按相关度降序排列。",
    "- 只允许使用给出的候选编号，绝不编造材料里没有的编号，每个编号最多出现一次；不必给全，只给与查询相关的。"
  ].join("\n");
}
function buildUserPrompt2(query, hits) {
  const lines = [`查询主题：${query}`, "", "【候选记忆】（行首数字即候选编号）"];
  hits.forEach((hit, index) => {
    const content = typeof hit.record.content === "string" ? hit.record.content.trim() : "";
    const snippet = content.length <= SNIPPET_MAX_CHARS2 ? content : `${content.slice(0, SNIPPET_MAX_CHARS2)}…`;
    const created = Number.isFinite(hit.record.createdAt) ? new Date(hit.record.createdAt).toISOString().slice(0, 10) : "未知时间";
    lines.push(`${index}. ${snippet}（记录于 ${created}）`);
  });
  return lines.join("\n");
}
function parseOrder(raw) {
  let text = raw.trim();
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) text = fenced[1].trim();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    const brace = text.match(/\{[\s\S]*\}/);
    if (brace) {
      try {
        parsed = JSON.parse(brace[0]);
      } catch {
        parsed = void 0;
      }
    }
    if (parsed === void 0) {
      const bracket = text.match(/\[[\s\S]*\]/);
      if (!bracket) return null;
      try {
        parsed = JSON.parse(bracket[0]);
      } catch {
        return null;
      }
    }
  }
  if (Array.isArray(parsed)) return parsed;
  if (typeof parsed === "object" && parsed !== null) {
    const order = parsed.order;
    if (Array.isArray(order)) return order;
  }
  return null;
}
function toIndex2(value, bound) {
  const index = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isInteger(index) || index < 0 || index >= bound) return null;
  return index;
}
function orderedHitsOf(rawOrder, candidates) {
  const seen = /* @__PURE__ */ new Set();
  const ordered = [];
  for (const item of rawOrder) {
    const index = toIndex2(item, candidates.length);
    if (index === null || seen.has(index)) continue;
    seen.add(index);
    ordered.push(candidates[index]);
  }
  for (let i = 0; i < candidates.length; i += 1) {
    if (!seen.has(i)) ordered.push(candidates[i]);
  }
  return ordered;
}
function createLlmReranker(llm, deps) {
  const { log } = deps;
  return {
    async rerank(hits, context) {
      if (hits.length <= 1) return hits;
      try {
        const candidates = hits.slice(0, RERANK_CANDIDATES);
        const messages = [
          { role: "system", content: buildSystemPrompt3() },
          { role: "user", content: buildUserPrompt2(context.query, candidates) }
        ];
        const raw = await llm.generateText(messages, {
          maxTokens: RERANK_MAX_TOKENS,
          timeoutMs: RERANK_TIMEOUT_MS,
          purpose: "rerank-memories"
        });
        const order = parseOrder(raw);
        if (order === null) {
          log.warn("精排输出无法解析，保持原序:", raw.slice(0, 200));
          return hits;
        }
        return orderedHitsOf(order, candidates).concat(hits.slice(RERANK_CANDIDATES));
      } catch (err) {
        log.warn("LLM 精排失败，保持原序:", err);
        return hits;
      }
    }
  };
}

// src/plugin-id.ts
var PLUGIN_ID = "ripples-of-aion";

// src/tools/shared.ts
function formatTimestamp(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function formatMemoryList(records) {
  return records.map((record, index) => `${index + 1}. [${record.id}] ${formatTimestamp(record.createdAt)} ${record.content}`).join("\n");
}
function formatHitList(hits) {
  return hits.map(
    (hit, index) => `${index + 1}. [${hit.record.id}] ${formatTimestamp(hit.record.createdAt)} ${hit.record.content}（相关度 ${hit.score.toFixed(2)}）`
  ).join("\n");
}
function readOptionalString(value) {
  if (typeof value !== "string") {
    return void 0;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : void 0;
}
function readRequiredString(value) {
  return readOptionalString(value) ?? "";
}

// src/tools/recall.ts
var RECALL_LIMIT = 20;
function recentRecords(store, limit, conversationId) {
  const records = store.all(conversationId ? { conversationId } : void 0);
  return [...records].sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
}
function createRecallTool(deps) {
  const { store, log } = deps;
  return {
    id: `${PLUGIN_ID}_recall`,
    name: "回忆",
    description: "当用户让你回忆、提到过去聊过什么、或想查看记忆库里有什么时调用。可选传 conversationId 只看指定会话；不传则返回全部最近记忆。",
    enabled: true,
    risk: "safe",
    effectKind: "read",
    inputSchema: {
      type: "object",
      properties: {
        conversationId: {
          type: "string",
          description: "可选。只回忆指定会话的记忆；不填则返回全部最近记忆。"
        }
      },
      required: []
    },
    async execute(args) {
      try {
        const conversationId = readOptionalString(args.conversationId);
        await store.load();
        const records = recentRecords(store, RECALL_LIMIT, conversationId);
        if (records.length > 0) {
          store.bumpHeat(records.map((record) => record.id));
        }
        const total = conversationId ? store.all({ conversationId }).length : store.getStats().active;
        const scope = conversationId ? `会话 ${conversationId}` : "全部会话";
        if (records.length === 0) {
          return `${scope}还没有任何记忆（共 ${total} 条）。`;
        }
        return `${scope}共 ${total} 条记忆，最近 ${records.length} 条：
${formatMemoryList(records)}`;
      } catch (err) {
        log.warn("recall 执行失败，已降级返回：", err);
        return "记忆暂时读不出来，稍后再试一次。";
      }
    }
  };
}

// src/tools/search.ts
function createSearchTool(deps) {
  const { store, log } = deps;
  const search = createHybridSearcher(deps.store, deps.config, { embedder: deps.embedder, log });
  return {
    id: `${PLUGIN_ID}_search`,
    name: "搜索记忆",
    description: "当需要查找和某主题相关的历史事实、用户提过的偏好或约定时调用。参数 query 填检索主题；可选 conversationId 限定会话范围。",
    enabled: true,
    risk: "safe",
    effectKind: "read",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "要检索的主题或关键词。" },
        conversationId: { type: "string", description: "可选。只在指定会话范围内搜索。" }
      },
      required: ["query"]
    },
    async execute(args) {
      try {
        const text = readRequiredString(args.query);
        if (text.length === 0) {
          return "请提供要搜索的主题（query）。";
        }
        const query = {
          text,
          conversationId: readOptionalString(args.conversationId)
        };
        let hits = await search(query);
        if (hits.length === 0) {
          return `没有找到与「${text}」相关的记忆。`;
        }
        if (deps.reranker && (deps.config.rerankEnabled ?? DEFAULT_RERANK_ENABLED)) {
          hits = await deps.reranker.rerank(hits, { query: text });
        }
        store.bumpHeat(hits.map((hit) => hit.record.id));
        return `找到 ${hits.length} 条相关记忆：
${formatHitList(hits)}`;
      } catch (err) {
        log.warn("search 执行失败，已降级返回：", err);
        return "记忆搜索暂时不可用，稍后再试一次。";
      }
    }
  };
}

// src/tools/timeline.ts
function formatClaimSpan(entry) {
  const from = formatTimestamp(entry.claim.validFrom ?? entry.record.createdAt);
  const until = entry.claim.validUntil == null ? "至今" : formatTimestamp(entry.claim.validUntil);
  return `${entry.claim.value}（${from} 至 ${until}）`;
}
function createTimelineTool(deps) {
  const { store, log } = deps;
  return {
    id: `${PLUGIN_ID}_timeline`,
    name: "实体时间轴",
    description: "当需要知道某个实体的属性现在是什么、过去是什么、什么时候变的时调用。entity 填主体名（如「用户」或某个具体的人/物/项目）；可选 attribute 只看单一属性（如「居住地」）。",
    enabled: true,
    risk: "safe",
    effectKind: "read",
    inputSchema: {
      type: "object",
      properties: {
        entity: { type: "string", description: "属性所属的主体名，例如「用户」。" },
        attribute: { type: "string", description: "可选。只看这一个属性，例如「居住地」。" }
      },
      required: ["entity"]
    },
    async execute(args) {
      try {
        const entity = readRequiredString(args.entity);
        if (entity.length === 0) {
          return "请提供要查询的实体（entity）。";
        }
        const attribute = readOptionalString(args.attribute);
        await store.load();
        const entries = store.getEntityTimeline(entity, attribute);
        if (entries.length === 0) {
          return attribute ? `实体「${entity}」没有属性「${attribute}」的记录。` : `没有找到实体「${entity}」的属性记录。`;
        }
        const byAttribute = /* @__PURE__ */ new Map();
        for (const entry of [...entries].reverse()) {
          const group = byAttribute.get(entry.claim.attribute) ?? [];
          group.push(entry);
          byAttribute.set(entry.claim.attribute, group);
        }
        const lines = [];
        let count = 0;
        for (const [attr, group] of byAttribute) {
          const [latest, ...history] = group;
          count += group.length;
          const attrLines = [];
          if (latest.claim.validUntil == null) {
            const from = formatTimestamp(latest.claim.validFrom ?? latest.record.createdAt);
            attrLines.push(`- 属性「${attr}」当前：${latest.claim.value}（自 ${from}）`);
          } else {
            attrLines.push(`- 属性「${attr}」当前：无（最近一次记录已变更或失效）`);
            attrLines.push(`- 属性「${attr}」历史：${formatClaimSpan(latest)}`);
          }
          for (const entry of history) {
            attrLines.push(`- 属性「${attr}」历史：${formatClaimSpan(entry)}`);
          }
          lines.push(...attrLines);
        }
        return `实体「${entity}」的属性时间轴（共 ${count} 条）：
${lines.join("\n")}`;
      } catch (err) {
        log.warn("timeline 执行失败，已降级返回：", err);
        return "时间轴查询暂时不可用，稍后再试一次。";
      }
    }
  };
}

// src/tools/forget.ts
function createForgetTool(deps) {
  const { store, log } = deps;
  return {
    id: `${PLUGIN_ID}_forget`,
    name: "遗忘",
    description: "当用户明确要求删除或忘掉某条记忆时调用。传 id 删除单条记忆，或传 conversationId 清空整个会话的记忆；用户没有明确要求删除时不要调用。",
    enabled: true,
    risk: "safe",
    effectKind: "mutation",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "要删除的单条记忆 id。" },
        conversationId: { type: "string", description: "要清空整个会话记忆时传会话 id。" }
      },
      required: []
    },
    async execute(args) {
      try {
        const id = readOptionalString(args.id);
        const conversationId = readOptionalString(args.conversationId);
        await store.load();
        if (id) {
          const existing = store.all({ includeDeleted: true }).find((record) => record.id === id);
          if (!existing) {
            return `没有找到记忆 ${id}。`;
          }
          if (existing.deleted) {
            return `记忆 ${id} 已经删过了。`;
          }
          await store.delete(id);
          return `已删除记忆 ${id}。`;
        }
        if (conversationId) {
          const targets = store.all({ conversationId });
          for (const record of targets) {
            await store.delete(record.id);
          }
          return targets.length > 0 ? `已删除会话 ${conversationId} 的 ${targets.length} 条记忆。` : `会话 ${conversationId} 没有可删除的记忆。`;
        }
        return "请提供要删除的记忆 id，或要清空的会话 conversationId。";
      } catch (err) {
        log.warn("forget 执行失败：", err);
        return "删除没有完成，出现了一点问题，请稍后再试一次。";
      }
    }
  };
}

// src/ui/bounds.ts
var MIN_VISIBLE_X = 80;
var MIN_VISIBLE_Y = 40;
function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}
function clampBounds(saved, workArea, min) {
  if (typeof saved !== "object" || saved === null) return null;
  const b = saved;
  if (!isFiniteNumber(b.x) || !isFiniteNumber(b.y) || !isFiniteNumber(b.width) || !isFiniteNumber(b.height)) {
    return null;
  }
  const width = Math.min(Math.max(b.width, min.width), workArea.width);
  const height = Math.min(Math.max(b.height, min.height), workArea.height);
  const x = Math.min(
    Math.max(b.x, workArea.x - width + MIN_VISIBLE_X),
    workArea.x + workArea.width - MIN_VISIBLE_X
  );
  const y = Math.min(Math.max(b.y, workArea.y), workArea.y + workArea.height - MIN_VISIBLE_Y);
  return { x, y, width, height };
}

// src/ui/window.ts
var WINDOW_TITLE = "岁月涟漪 · 记忆图谱";
var WINDOW_WIDTH = 1560;
var WINDOW_HEIGHT = 1e3;
var WINDOW_MIN_WIDTH = 1e3;
var WINDOW_MIN_HEIGHT = 660;
var BOUNDS_KEY = "panel-bounds";
var SAVE_DEBOUNCE_MS = 600;
function createWindowManager(deps) {
  const { log } = deps;
  let win = null;
  let boundSignal = null;
  let abortHandler = null;
  let saveTimer = null;
  const detachSignal = () => {
    if (boundSignal && abortHandler) {
      boundSignal.removeEventListener("abort", abortHandler);
    }
    boundSignal = null;
    abortHandler = null;
  };
  const clearSaveTimer = () => {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
  };
  const close = () => {
    clearSaveTimer();
    const target = win;
    win = null;
    if (!target) return;
    try {
      if (!target.isDestroyed()) target.close();
    } catch (err) {
      log.warn("关闭记忆图谱窗口失败：", err);
    }
  };
  const open = async (ctx) => {
    if (ctx.signal.aborted) return;
    detachSignal();
    abortHandler = close;
    ctx.signal.addEventListener("abort", abortHandler, { once: true });
    boundSignal = ctx.signal;
    if (win && !win.isDestroyed()) {
      try {
        if (win.isMinimized()) win.restore();
        win.focus();
      } catch (err) {
        log.warn("聚焦记忆图谱窗口失败：", err);
      }
      return;
    }
    win = null;
    try {
      const electron = require("electron");
      const workArea = electron.screen.getPrimaryDisplay().workArea;
      const centered = {
        x: Math.round(workArea.x + (workArea.width - WINDOW_WIDTH) / 2),
        y: Math.round(workArea.y + Math.max(0, workArea.height - WINDOW_HEIGHT) / 3),
        width: WINDOW_WIDTH,
        height: WINDOW_HEIGHT
      };
      const bounds = clampBounds(ctx.storage.get(BOUNDS_KEY), workArea, {
        width: WINDOW_MIN_WIDTH,
        height: WINDOW_MIN_HEIGHT
      }) ?? centered;
      const created = new electron.BrowserWindow({
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
        minWidth: WINDOW_MIN_WIDTH,
        minHeight: WINDOW_MIN_HEIGHT,
        title: WINDOW_TITLE,
        autoHideMenuBar: true,
        // 无外框：标题栏由面板自绘（拖动区 + 关闭按钮），与面板粉色 UI 一体
        frame: false,
        backgroundColor: "#fff8fb",
        // 面板加载的是随插件分发的受信静态页，panel.js 需要直接使用 ipcRenderer。
        webPreferences: { nodeIntegration: true, contextIsolation: false }
      });
      created.on("closed", () => {
        if (win === created) win = null;
      });
      const saveBounds = () => {
        if (!win || win.isDestroyed() || win.isMinimized() || win.isMaximized()) return;
        try {
          ctx.storage.set(BOUNDS_KEY, win.getBounds());
        } catch (err) {
          log.warn("保存窗口边界失败：", err);
        }
      };
      const scheduleSaveBounds = () => {
        clearSaveTimer();
        saveTimer = setTimeout(() => {
          saveTimer = null;
          saveBounds();
        }, SAVE_DEBOUNCE_MS);
      };
      created.on("resize", scheduleSaveBounds);
      created.on("move", scheduleSaveBounds);
      created.on("close", () => {
        clearSaveTimer();
        saveBounds();
      });
      win = created;
      await created.loadFile(`${__dirname}/panel/index.html`);
      if (ctx.signal.aborted) close();
    } catch (err) {
      log.warn("打开记忆图谱窗口失败：", err);
      close();
    }
  };
  return { open, close };
}

// src/core/graph.ts
var GRAPH_MAX_NODES = 40;
var NEUTRAL_HEAT = 0.5;
function entitiesOf2(record) {
  const seen = /* @__PURE__ */ new Set();
  const collect = (candidates) => {
    if (!Array.isArray(candidates)) return;
    for (const entity of candidates) {
      if (typeof entity === "string" && entity !== "") seen.add(entity);
    }
  };
  collect(record.entities);
  collect((record.entityClaims ?? []).map((claim) => claim.entity));
  return [...seen];
}
function buildEntityGraph(records, options) {
  const heatOf = options?.heatOf;
  const countByEntity = /* @__PURE__ */ new Map();
  const heatSumByEntity = /* @__PURE__ */ new Map();
  const weightByPair = /* @__PURE__ */ new Map();
  for (const record of records) {
    if (record.deleted === true) continue;
    const entities = entitiesOf2(record);
    if (entities.length === 0) continue;
    const rawHeat = typeof heatOf === "function" ? heatOf(record) : NEUTRAL_HEAT;
    const heat = Number.isFinite(rawHeat) ? rawHeat : NEUTRAL_HEAT;
    for (const entity of entities) {
      countByEntity.set(entity, (countByEntity.get(entity) ?? 0) + 1);
      heatSumByEntity.set(entity, (heatSumByEntity.get(entity) ?? 0) + heat);
    }
    for (let i = 0; i < entities.length; i += 1) {
      for (let j = i + 1; j < entities.length; j += 1) {
        const [a, b] = entities[i] < entities[j] ? [entities[i], entities[j]] : [entities[j], entities[i]];
        let inner = weightByPair.get(a);
        if (!inner) {
          inner = /* @__PURE__ */ new Map();
          weightByPair.set(a, inner);
        }
        inner.set(b, (inner.get(b) ?? 0) + 1);
      }
    }
  }
  if (countByEntity.size === 0) return { nodes: [], edges: [] };
  const neighborsByEntity = /* @__PURE__ */ new Map();
  for (const [a, inner] of weightByPair) {
    for (const b of inner.keys()) {
      if (!neighborsByEntity.has(a)) neighborsByEntity.set(a, /* @__PURE__ */ new Set());
      if (!neighborsByEntity.has(b)) neighborsByEntity.set(b, /* @__PURE__ */ new Set());
      neighborsByEntity.get(a).add(b);
      neighborsByEntity.get(b).add(a);
    }
  }
  const allNodes = [...countByEntity.entries()].map(([name, count]) => ({
    name,
    count,
    degree: neighborsByEntity.get(name)?.size ?? 0,
    heat: (heatSumByEntity.get(name) ?? 0) / count
  }));
  const kept = [...allNodes].sort(
    (x, y) => y.degree - x.degree || y.count - x.count || (x.name < y.name ? -1 : x.name > y.name ? 1 : 0)
  ).slice(0, GRAPH_MAX_NODES);
  const keptNames = new Set(kept.map((node) => node.name));
  const edges = [];
  for (const [a, inner] of weightByPair) {
    if (!keptNames.has(a)) continue;
    for (const [b, weight] of inner) {
      if (!keptNames.has(b)) continue;
      edges.push({ a, b, weight });
    }
  }
  edges.sort(
    (x, y) => y.weight - x.weight || x.a.localeCompare(y.a) || x.b.localeCompare(y.b)
  );
  return { nodes: kept, edges };
}

// src/ui/ipc.ts
var GET_STATE_CHANNEL = "get-state";
var FORGET_CHANNEL = "forget";
var DREAM_NOW_CHANNEL = "dream-now";
var GET_CONFIG_CHANNEL = "get-config";
var SAVE_CONFIG_CHANNEL = "save-config";
var BROWSE_CHANNEL = "browse-memories";
var GET_GRAPH_CHANNEL = "get-graph";
var SEARCH_MEMORIES_CHANNEL = "search-memories";
var RECENT_LIMIT = 20;
var INSIGHTS_SUMMARY_LIMIT = 8;
var CLUSTER_MEMBERS_LIMIT = 8;
var EDITABLE_CONFIG_KEYS = [
  "embeddingProvider",
  "embeddingBaseUrl",
  "embeddingModel",
  "embeddingApiKeyName",
  "embeddingDimensions",
  "hotContextBudgetChars",
  "maxMemoriesPerTurn",
  "heatDecayPerDay",
  "heatWeight",
  "heatBump",
  "consolidationEnabled",
  "consolidationIdleMinutes",
  "consolidationMaxRecords",
  // 面板检索台的精排开关；布尔键走「按现值类型校验」，类型不符自动丢弃
  "rerankEnabled"
];
var EMPTY_INSIGHTS = { lastRunAt: 0, dreaming: false, clusters: [], conflicts: [] };
var EMPTY_STATE = {
  total: 0,
  active: 0,
  memories: [],
  claims: [],
  insights: EMPTY_INSIGHTS
};
function registerUiIpc(ctx, deps) {
  const { store, storage, log } = deps;
  const hybridSearch = deps.config ? createHybridSearcher(store, deps.config, { embedder: deps.embedder, log }) : null;
  const unionEntities = (record) => [
    ...record.entities ?? [],
    ...(record.entityClaims ?? []).map((claim) => claim.entity)
  ].filter((entity, index, all) => typeof entity === "string" && entity !== "" && all.indexOf(entity) === index);
  const getState = async () => {
    try {
      await store.load();
      const stats = store.getStats();
      const activeRecords = store.all({ includeDeleted: false });
      const memories = activeRecords.slice(-RECENT_LIMIT).reverse().map((record) => ({
        id: record.id,
        content: record.content,
        createdAt: record.createdAt
      }));
      const claims = [];
      for (const record of activeRecords) {
        for (const claim of record.entityClaims ?? []) {
          claims.push({
            entity: claim.entity,
            attribute: claim.attribute,
            value: claim.value,
            validFrom: claim.validFrom ?? record.createdAt,
            validUntil: claim.validUntil ?? null
          });
        }
      }
      return {
        total: stats.total,
        active: stats.active,
        memories,
        claims,
        insights: readInsights(activeRecords)
      };
    } catch (err) {
      log.warn("get-state 失败，返回空状态：", err);
      return EMPTY_STATE;
    }
  };
  function readInsights(activeRecords) {
    const dreaming = deps.isDreaming?.() ?? false;
    try {
      const loaded = loadInsights(storage);
      const contentById = new Map(activeRecords.map((record) => [record.id, record.content]));
      const pickContent = (id) => typeof id === "string" ? contentById.get(id) ?? null : null;
      const clusters = loaded.clusters.slice(0, INSIGHTS_SUMMARY_LIMIT).map((cluster) => {
        const members = cluster.recordIds.map(pickContent).filter((c) => c !== null);
        return { label: cluster.label, size: cluster.recordIds.length, members: members.slice(0, CLUSTER_MEMBERS_LIMIT) };
      });
      const conflicts = loaded.conflicts.slice(0, INSIGHTS_SUMMARY_LIMIT).map((conflict) => ({
        note: conflict.note,
        records: conflict.recordIds.map(pickContent).filter((c) => c !== null)
      }));
      return { lastRunAt: loaded.lastRunAt, dreaming, clusters, conflicts };
    } catch (err) {
      log.warn("读取洞察失败，返回空洞察：", err);
      return { ...EMPTY_INSIGHTS, dreaming };
    }
  }
  const forget = async (id) => {
    if (typeof id !== "string" || !id) return { ok: false };
    try {
      await store.delete(id);
      return { ok: true };
    } catch (err) {
      log.warn("forget 失败：", id, err);
      return { ok: false };
    }
  };
  const dreamNow = () => {
    if (!deps.triggerDream) return { ok: false, reason: "unavailable" };
    return { ok: deps.triggerDream() };
  };
  const browseMemories = async (query) => {
    try {
      await store.load();
      const options = typeof query === "object" && query !== null ? query : {};
      const text = typeof options.text === "string" ? options.text.trim() : "";
      const limit = Math.min(Math.max(Number(options.limit) || 100, 1), 500);
      const includeDeleted = options.includeDeleted === true;
      const base = text ? store.searchKeyword(text) : store.all({ includeDeleted });
      const records = base.slice(-limit).reverse().map((record) => ({
        id: record.id,
        content: record.content,
        createdAt: record.createdAt,
        heat: effectiveHeatOf(record, HEAT_DECAY_PER_DAY, Date.now()),
        entities: unionEntities(record),
        deleted: record.deleted === true
      }));
      return { records, total: base.length };
    } catch (err) {
      log.warn("browse-memories 失败，返回空列表：", err);
      return { records: [], total: 0 };
    }
  };
  const getGraph = async () => {
    try {
      await store.load();
      const decayPerDay = deps.config?.heatDecayPerDay ?? HEAT_DECAY_PER_DAY;
      return buildEntityGraph(store.all(), {
        heatOf: (record) => effectiveHeatOf(record, decayPerDay, Date.now())
      });
    } catch (err) {
      log.warn("get-graph 失败，返回空图谱：", err);
      return { nodes: [], edges: [] };
    }
  };
  const searchMemories = async (payload) => {
    try {
      await store.load();
      const options = typeof payload === "object" && payload !== null ? payload : {};
      const text = typeof options.text === "string" ? options.text.trim() : "";
      if (text === "") return { hits: [], reranked: false };
      const limit = Math.min(Math.max(Math.floor(Number(options.limit) || 10), 1), 50);
      const wantRerank = typeof options.rerank === "boolean" ? options.rerank : deps.config?.rerankEnabled ?? true;
      let hits;
      if (hybridSearch) {
        hits = await hybridSearch({ text, limit });
      } else {
        hits = store.searchKeyword(text).slice(0, limit).map((record, index) => ({
          record,
          score: 1 / (index + 1),
          source: "keyword"
        }));
      }
      let reranked = false;
      if (deps.reranker && wantRerank && hits.length > 0) {
        try {
          const rerankedHits = await deps.reranker.rerank(hits, { query: text });
          if (Array.isArray(rerankedHits)) {
            hits = rerankedHits;
            reranked = true;
          }
        } catch (err) {
          log.warn("面板检索精排失败，使用初排结果：", err);
        }
      }
      const decayPerDay = deps.config?.heatDecayPerDay ?? HEAT_DECAY_PER_DAY;
      const now = Date.now();
      return {
        hits: hits.map((hit) => ({
          id: hit.record.id,
          content: hit.record.content,
          createdAt: hit.record.createdAt,
          heat: effectiveHeatOf(hit.record, decayPerDay, now),
          entities: unionEntities(hit.record),
          score: hit.score,
          source: hit.source
        })),
        reranked
      };
    } catch (err) {
      log.warn("search-memories 失败，返回空结果：", err);
      return { hits: [], reranked: false };
    }
  };
  const getConfig = () => loadConfig(storage);
  const saveConfigPatch = (patch) => {
    if (typeof patch !== "object" || patch === null) return { ok: false };
    try {
      const current = loadConfig(storage);
      const incoming = patch;
      for (const key of EDITABLE_CONFIG_KEYS) {
        if (!(key in incoming)) continue;
        const value = incoming[key];
        const currentType = typeof current[key];
        if (currentType === "number") {
          if (typeof value !== "number" || !Number.isFinite(value)) continue;
        } else if (currentType === "boolean") {
          if (typeof value !== "boolean") continue;
        } else if (typeof value !== "string") {
          continue;
        }
        current[key] = value;
      }
      saveConfig(storage, current);
      return { ok: true, config: current };
    } catch (err) {
      log.warn("save-config 失败：", err);
      return { ok: false };
    }
  };
  for (const channel of [GET_STATE_CHANNEL, FORGET_CHANNEL, DREAM_NOW_CHANNEL, GET_CONFIG_CHANNEL, SAVE_CONFIG_CHANNEL, BROWSE_CHANNEL, GET_GRAPH_CHANNEL, SEARCH_MEMORIES_CHANNEL]) {
    try {
      ctx.unregisterIpc(channel);
    } catch {
    }
  }
  try {
    ctx.registerIpc(GET_STATE_CHANNEL, () => getState());
    ctx.registerIpc(FORGET_CHANNEL, (id) => forget(id));
    ctx.registerIpc(DREAM_NOW_CHANNEL, () => dreamNow());
    ctx.registerIpc(GET_CONFIG_CHANNEL, () => getConfig());
    ctx.registerIpc(SAVE_CONFIG_CHANNEL, (patch) => saveConfigPatch(patch));
    ctx.registerIpc(BROWSE_CHANNEL, (query) => browseMemories(query));
    ctx.registerIpc(GET_GRAPH_CHANNEL, () => getGraph());
    ctx.registerIpc(SEARCH_MEMORIES_CHANNEL, (payload) => searchMemories(payload));
  } catch (err) {
    log.warn("注册图谱 IPC 失败：", err);
  }
  ctx.onDispose(() => {
    try {
      for (const channel of [GET_STATE_CHANNEL, FORGET_CHANNEL, DREAM_NOW_CHANNEL, GET_CONFIG_CHANNEL, SAVE_CONFIG_CHANNEL, BROWSE_CHANNEL, GET_GRAPH_CHANNEL, SEARCH_MEMORIES_CHANNEL]) {
        ctx.unregisterIpc(channel);
      }
    } catch (err) {
      log.warn("移除图谱 IPC 监听失败：", err);
    }
  });
}

// src/logger.ts
function createLogger(raw) {
  const prefix = "[岁月涟漪]";
  const log = raw.log.bind(raw);
  return {
    log: (...args) => log(prefix, ...args),
    warn: (...args) => log(prefix, "[warn]", ...args),
    error: (...args) => log(prefix, "[error]", ...args)
  };
}

// src/index.ts
var activeCtx = null;
var winManager = null;
var REGISTER_CATCHUP_DELAY_MS = 2 * 6e4;
var plugin = {
  async register(ctx) {
    const log = createLogger(ctx);
    log.log("启用");
    const config = loadConfig(ctx.storage);
    const store = new MemoryStore(ctx.storage, log);
    void store.load().catch((err) => log.warn("记忆日志预热失败:", err));
    const embedder = createEmbedderByProvider(config, { secrets: ctx.deps.secrets, log });
    let triggerDream;
    let isDreaming;
    const { conversations, llm } = ctx.deps;
    const reranker = llm ? createLlmReranker(llm, { log }) : void 0;
    ctx.registerTool(createRecallTool({ store, log }));
    ctx.registerTool(createSearchTool({ store, config, embedder, reranker, log }));
    ctx.registerTool(createTimelineTool({ store, log }));
    ctx.registerTool(createForgetTool({ store, log }));
    ctx.registerPromptProvider(
      createHotContextProvider({ store, config, log })
    );
    if (!conversations || !llm) {
      log.warn("宿主服务缺失（conversations/llm），摄入管线与空闲整合停用");
    } else {
      const ingest = createTurnIngestor({
        conversations,
        llm,
        embedder,
        store,
        config,
        log
      });
      const queue = new TaskQueue({ signal: ctx.signal, log });
      const consolidationEnabled = config.consolidationEnabled ?? DEFAULT_CONSOLIDATION_ENABLED;
      const consolidationIdleMinutes = config.consolidationIdleMinutes ?? DEFAULT_CONSOLIDATION_IDLE_MINUTES;
      const consolidator = createConsolidator({
        store,
        llm,
        embedder,
        storage: ctx.storage,
        maxRecords: config.consolidationMaxRecords ?? DEFAULT_CONSOLIDATION_MAX_RECORDS,
        log
      });
      let consolidationTimer = null;
      let catchupTimer = null;
      let consolidationInFlight = false;
      const runConsolidation = () => {
        if (!consolidationEnabled || consolidationInFlight || ctx.signal.aborted) return false;
        consolidationInFlight = true;
        void queue.enqueue("autoDream", async (_task, signal) => {
          try {
            await consolidator.run(signal);
          } finally {
            consolidationInFlight = false;
          }
        });
        return true;
      };
      triggerDream = runConsolidation;
      isDreaming = () => consolidationInFlight;
      const scheduleConsolidation = () => {
        if (consolidationTimer !== null) clearTimeout(consolidationTimer);
        consolidationTimer = setTimeout(runConsolidation, consolidationIdleMinutes * 6e4);
      };
      ctx.events.on("host:turn:finished", (event) => {
        if (event.source !== "desktop" || event.status !== "success") return;
        if (!event.finalMessageId || !event.inputMessageId) return;
        void queue.enqueue(
          {
            conversationId: event.conversationId,
            turnEventId: event.eventId,
            inputMessageId: event.inputMessageId,
            finalMessageId: event.finalMessageId,
            runId: event.runId
          },
          async (task, signal) => {
            try {
              if (typeof task !== "string") await ingest(task, signal);
            } finally {
              scheduleConsolidation();
            }
          }
        );
      });
      try {
        const insights = loadInsights(ctx.storage);
        const idleMs = consolidationIdleMinutes * 6e4;
        if (insights.lastRunAt === 0 || Date.now() - insights.lastRunAt > idleMs) {
          catchupTimer = setTimeout(runConsolidation, REGISTER_CATCHUP_DELAY_MS);
        }
      } catch (err) {
        log.warn("启动补跑判定失败（跳过补跑）:", err);
      }
      ctx.signal.addEventListener(
        "abort",
        () => {
          if (consolidationTimer !== null) {
            clearTimeout(consolidationTimer);
            consolidationTimer = null;
          }
          if (catchupTimer !== null) {
            clearTimeout(catchupTimer);
            catchupTimer = null;
          }
          consolidationInFlight = false;
        },
        { once: true }
      );
    }
    registerUiIpc(ctx, {
      store,
      storage: ctx.storage,
      config,
      embedder,
      reranker,
      log,
      triggerDream,
      isDreaming
    });
    winManager = createWindowManager({ log });
    ctx.onDispose(() => {
      winManager?.close();
      winManager = null;
    });
    activeCtx = ctx;
  },
  async unregister() {
    winManager?.close();
    winManager = null;
    activeCtx = null;
  },
  async open() {
    if (activeCtx && winManager) {
      await winManager.open(activeCtx);
    }
  }
};
module.exports = plugin;
