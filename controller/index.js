/**
 * 单写者 Controller + GraphStore（CONTRACT §2、§3、§5、§6、§7、§8）。
 *
 * - 磁盘主真相：YAML，顶层键仅 `facts` → `goals` → `steps`。
 * - 校验通过才 commit；校验失败拒写、不落盘。
 * - 写图路径强制过 hooks/validate_write（双保险，见 apply()）。
 */
import fs from 'node:fs';
import path from 'node:path';

import { dump, load as parseYaml } from '../yaml.js';
import { preflight } from '../hooks/validate_write.js';
import {
  OP,
  WriteRejected,
  isValidPriority,
} from './ops.js';

export const FACT_CONTENT_MAX_BYTES = 8 * 1024;
export const FACT_TITLE_MAX_CHARS = 120;
export const ALLOWED_TOP_KEYS = Object.freeze(['facts', 'goals', 'steps']);

export function nowIsoZ() {
  return new Date().toISOString();
}

export function emptyGraph() {
  return { facts: [], goals: [], steps: [] };
}

/** 固定顶层顺序 facts → goals → steps，并省略 undefined 字段。 */
export function graphToDoc(graph) {
  const facts = graph.facts.map((f) => {
    const d = { id: f.id, title: f.title };
    if (f.content !== undefined && f.content !== null) d.content = f.content;
    if (f.createdAt !== undefined) d.createdAt = f.createdAt;
    if (f.producedBy !== undefined && f.producedBy !== null) d.producedBy = f.producedBy;
    return d;
  });
  const goals = graph.goals.map((g) => {
    const d = { id: g.id, kind: g.kind, criterion: g.criterion, createdAt: g.createdAt };
    if (g.satisfiedBy !== undefined && g.satisfiedBy !== null) d.satisfiedBy = g.satisfiedBy;
    if (g.satisfiedReason !== undefined && g.satisfiedReason !== null) d.satisfiedReason = g.satisfiedReason;
    if (g.satisfiedAt !== undefined && g.satisfiedAt !== null) d.satisfiedAt = g.satisfiedAt;
    return d;
  });
  const steps = graph.steps.map((s) => {
    const d = {
      id: s.id,
      action: s.action,
      from: s.from ?? [],
      actor: s.actor,
      priority: s.priority,
      state: s.state,
      createdAt: s.createdAt,
    };
    if (s.to !== undefined && s.to !== null) d.to = s.to;
    if (s.reason !== undefined && s.reason !== null) d.reason = s.reason;
    return d;
  });
  return { facts, goals, steps };
}

export function graphFromDoc(doc) {
  const src = doc ?? {};
  return {
    facts: (src.facts ?? []).map((f) => ({
      id: f.id,
      title: f.title ?? '',
      content: f.content ?? null,
      createdAt: f.createdAt === undefined || f.createdAt === null ? null : String(f.createdAt),
      producedBy: f.producedBy ?? null,
    })),
    goals: (src.goals ?? []).map((g) => ({
      id: g.id,
      kind: g.kind ?? 'final',
      criterion: g.criterion ?? '',
      createdAt: g.createdAt === undefined || g.createdAt === null ? '' : String(g.createdAt),
      satisfiedBy: g.satisfiedBy ?? null,
      satisfiedReason: g.satisfiedReason ?? null,
      satisfiedAt: g.satisfiedAt === undefined || g.satisfiedAt === null ? null : String(g.satisfiedAt),
    })),
    steps: (src.steps ?? []).map((s) => ({
      id: s.id,
      action: s.action ?? '',
      from: Array.isArray(s.from) ? s.from : [],
      actor: s.actor ?? 'agent',
      priority: s.priority ?? 'normal',
      state: s.state ?? 'open',
      createdAt: s.createdAt === undefined || s.createdAt === null ? '' : String(s.createdAt),
      to: s.to ?? null,
      reason: s.reason ?? null,
    })),
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function nextId(prefix, ids) {
  let n = 0;
  const pat = `${prefix}_`;
  for (const id of ids) {
    if (typeof id === 'string' && id.startsWith(pat)) {
      const parsed = Number.parseInt(id.slice(pat.length), 10);
      if (Number.isFinite(parsed)) n = Math.max(n, parsed);
    }
  }
  return `${prefix}_${String(n + 1).padStart(3, '0')}`;
}

/* ------------------------------------------------------------- GraphStore */

export class GraphStore {
  /** @param {string} root 运行目录；graph.yaml / graph.json / graph.lock 落此。 */
  constructor(root, options = {}) {
    this.root = root;
    this.graphPath = path.join(root, 'graph.yaml');
    this.jsonPath = path.join(root, 'graph.json');
    this.lockPath = path.join(root, 'graph.lock');
    this.factContentMaxBytes = options.factContentMaxBytes ?? FACT_CONTENT_MAX_BYTES;
    this.factTitleMaxChars = options.factTitleMaxChars ?? FACT_TITLE_MAX_CHARS;
  }

  ensureDir() {
    fs.mkdirSync(this.root, { recursive: true });
  }

  /** 契约 §2：顶层键只允许 facts / goals / steps。 */
  load() {
    if (!fs.existsSync(this.graphPath)) return emptyGraph();
    const doc = parseYaml(fs.readFileSync(this.graphPath, 'utf8'));
    if (doc === null || doc === undefined) return emptyGraph();
    if (typeof doc !== 'object' || Array.isArray(doc)) {
      throw new Error('graph.yaml 顶层必须是键值映射');
    }
    const extra = Object.keys(doc).filter((k) => !ALLOWED_TOP_KEYS.includes(k));
    if (extra.length > 0) {
      throw new Error(
        `graph.yaml 顶层键非法: ${extra.join(', ')}（CONTRACT §2 只允许 facts/goals/steps，`
        + '禁止 Intent/Hint/findings 等同义一等公民节点）',
      );
    }
    return graphFromDoc(doc);
  }

  /** 校验通过才落盘（storage 边界也拦一道）。 */
  save(graph) {
    const errs = this.validate(graph);
    if (errs.length > 0) throw new WriteRejected(`save 校验不过，拒写: ${errs.join('; ')}`);
    this.ensureDir();
    this.withLock(() => this.saveUnlocked(graph));
  }

  withLock(fn) {
    const deadline = Date.now() + 5_000;
    let acquired = false;
    for (;;) {
      try {
        const fd = fs.openSync(this.lockPath, 'wx');
        fs.writeSync(fd, String(process.pid));
        fs.closeSync(fd);
        acquired = true;
        break;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        // 陈旧锁（进程崩了）自愈
        try {
          const age = Date.now() - fs.statSync(this.lockPath).mtimeMs;
          if (age > 10_000) {
            fs.unlinkSync(this.lockPath);
            continue;
          }
        } catch {
          continue;
        }
        if (Date.now() > deadline) throw new Error(`获取写锁超时: ${this.lockPath}`);
        sleep(20);
      }
    }
    try {
      return fn();
    } finally {
      if (acquired) {
        try {
          fs.unlinkSync(this.lockPath);
        } catch {
          /* 已被清理 */
        }
      }
    }
  }

  saveUnlocked(graph) {
    const doc = graphToDoc(graph);
    const text = dump(doc);
    const tmp = `${this.graphPath}.tmp`;
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeFileSync(fd, text, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.writeFileSync(this.jsonPath, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, this.graphPath);
  }

  nextFactId(graph) {
    return nextId('fact', graph.facts.map((f) => f.id));
  }

  nextStepId(graph) {
    return nextId('step', graph.steps.map((s) => s.id));
  }

  toYaml(graph) {
    return dump(graphToDoc(graph));
  }

  /** fact 仅 id+title；goals/steps 完整（decide 的只读投影）。 */
  preview(graph) {
    const doc = graphToDoc(graph);
    doc.facts = doc.facts.map((f) => ({ id: f.id, title: f.title }));
    return dump(doc);
  }

  validate(graph) {
    const errs = [];
    const origins = graph.facts.filter((f) => f.id === 'fact_origin');
    if (origins.length !== 1) errs.push(`fact_origin 数量必须为 1，实际 ${origins.length}`);
    for (const f of graph.facts) {
      if (f.id !== 'fact_origin' && !(typeof f.id === 'string' && f.id.startsWith('fact_') && /^\d+$/.test(f.id.slice(5)))) {
        errs.push(`fact id 非法: ${f.id}`);
      }
    }
    // CONTRACT §1/§2：单 goal_final，不做 kind:sub SubGoal；id 只能是 goal_final
    const finals = graph.goals.filter((g) => g.id === 'goal_final');
    if (finals.length !== 1 || finals[0].kind !== 'final') {
      errs.push('goals 必须恰含一个 kind==final 的 goal_final');
    }
    for (const g of graph.goals) {
      if (g.id !== 'goal_final') {
        errs.push(`goal id 非法（CONTRACT §1 单 goal_final，不做 SubGoal）: ${g.id}`);
      } else if (g.kind !== 'final') {
        errs.push(`goal_final.kind 必须为 final: ${g.kind}`);
      }
    }
    for (const s of graph.steps) {
      if (!(typeof s.id === 'string' && s.id.startsWith('step_') && /^\d+$/.test(s.id.slice(5)))) {
        errs.push(`step id 非法（须 step_NNN，CONTRACT §2）: ${s.id}`);
      }
    }
    const factIds = new Set(graph.facts.map((f) => f.id));
    const stepIds = new Set(graph.steps.map((s) => s.id));
    for (const f of graph.facts) {
      if (f.id !== 'fact_origin' && f.producedBy && !stepIds.has(f.producedBy)) {
        errs.push(`fact ${f.id}.producedBy 引用不存在 step: ${f.producedBy}`);
      }
    }
    for (const s of graph.steps) {
      for (const fid of s.from ?? []) {
        if (!factIds.has(fid)) errs.push(`step ${s.id}.from 引用不存在 fact: ${fid}`);
      }
      if (s.state === 'done') {
        if (!s.to) errs.push(`step ${s.id} state=done 但无 to`);
        else if (!factIds.has(s.to)) errs.push(`step ${s.id}.to 引用不存在 fact: ${s.to}`);
        else {
          const f = graph.facts.find((x) => x.id === s.to);
          if (f && f.producedBy !== s.id) {
            errs.push(`step ${s.id}.to fact.producedBy 不匹配: ${f.producedBy}`);
          }
        }
      }
      if (s.state === 'dropped' && !s.reason) errs.push(`step ${s.id} state=dropped 但无 reason`);
    }
    for (const g of graph.goals) {
      for (const fid of g.satisfiedBy ?? []) {
        if (!factIds.has(fid)) errs.push(`goal ${g.id}.satisfiedBy 引用不存在 fact: ${fid}`);
      }
    }
    return errs;
  }
}

function sleep(ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    /* 同步等待极小间隔：写锁重试 */
  }
}

/* -------------------------------------------------------------- Controller */

/**
 * 单写者。只有 Controller 改图；所有写入经 validate，失败拒写不落盘。
 * @param {GraphStore} store
 * @param {{verifyHook?: (graph:object, op:object)=>string|null}} [options]
 */
export class Controller {
  constructor(store, options = {}) {
    this.store = store;
    this.verifyHook = options.verifyHook ?? null;
    this.applied = [];
    this.rejected = [];
  }

  /** 校验并应用一个 op；返回新图（未落盘）。失败抛 WriteRejected。 */
  apply(op, graph = null) {
    const current = graph ?? this.store.load();
    preflight(op); // CONTRACT §3：写图路径强制过 hooks/validate_write
    const next = clone(current);
    const desc = this.applyOp(next, op);
    const errs = this.store.validate(next);
    if (errs.length > 0) {
      this.rejected.push(desc);
      throw new WriteRejected(errs.join('; '));
    }
    this.applied.push(desc);
    return next;
  }

  /** 校验通过后落盘（CONTRACT §3：校验失败拒写、不落盘）。 */
  commit(graph) {
    const errs = this.store.validate(graph);
    if (errs.length > 0) throw new WriteRejected(`commit 校验不过，拒写: ${errs.join('; ')}`);
    this.store.save(graph);
  }

  applyAndCommit(op, graph = null) {
    const next = this.apply(op, graph);
    this.commit(next);
    return next;
  }

  /** 不抛异常版本：返回 { graph, error, desc }。 */
  safeApply(op, graph = null) {
    try {
      const next = this.apply(op, graph);
      return { graph: next, error: null };
    } catch (error) {
      if (error instanceof WriteRejected) return { graph: null, error: error.message };
      throw error;
    }
  }

  applyOp(graph, op) {
    switch (op?.type) {
      case OP.OPEN_STEP:
        return this.openStep(graph, op);
      case OP.DROP_STEP:
        return this.dropStep(graph, op);
      case OP.CHANGE_PRIORITY:
        return this.changePriority(graph, op);
      case OP.SUBMIT_FACT:
        return this.submitFact(graph, op);
      case OP.SEED_ORIGIN:
        return this.seedOrigin(graph, op);
      case OP.SATISFY_GOAL:
        return this.satisfyGoal(graph, op);
      case OP.REOPEN:
        return this.reopen(graph, op);
      default:
        throw new WriteRejected(`未知操作类型: ${op?.type}`);
    }
  }

  openStep(graph, op) {
    if (!Array.isArray(op.from) || op.from.length === 0) {
      throw new WriteRejected('open_step 无 from（因果拒写，CONTRACT §8）');
    }
    const sid = op.stepId || this.store.nextStepId(graph);
    if (!(typeof sid === 'string' && sid.startsWith('step_') && /^\d+$/.test(sid.slice(5)))) {
      throw new WriteRejected(`step id 非法（须 step_NNN）: ${sid}`);
    }
    if (graph.steps.some((s) => s.id === sid)) throw new WriteRejected(`step id 已存在: ${sid}`);
    const factIds = new Set(graph.facts.map((f) => f.id));
    for (const fid of op.from) {
      if (!factIds.has(fid)) throw new WriteRejected(`open_step.from 引用不存在 fact: ${fid}`);
    }
    if (!isValidPriority(op.priority)) throw new WriteRejected(`priority 非法: ${op.priority}`);
    graph.steps.push({
      id: sid,
      action: op.action ?? '',
      from: [...op.from],
      actor: op.actor ?? 'agent',
      priority: op.priority,
      state: 'open',
      createdAt: nowIsoZ(),
      to: null,
      reason: null,
    });
    return `open_step ${sid}`;
  }

  dropStep(graph, op) {
    if (!hasText(op.reason)) throw new WriteRejected('drop_step 缺 reason（拒收，CONTRACT §4）');
    const step = findStep(graph, op.stepId);
    if (step.state !== 'open') {
      throw new WriteRejected(`drop_step 目标非 open: ${op.stepId} state=${step.state}`);
    }
    step.state = 'dropped';
    step.reason = op.reason;
    return `drop_step ${op.stepId}`;
  }

  changePriority(graph, op) {
    if (!isValidPriority(op.priority)) throw new WriteRejected(`priority 非法: ${op.priority}`);
    const step = findStep(graph, op.stepId);
    if (step.state !== 'open') {
      throw new WriteRejected(`change_priority 目标非 open: ${op.stepId} state=${step.state}`);
    }
    step.priority = op.priority;
    return `change_priority ${op.stepId} -> ${op.priority}`;
  }

  submitFact(graph, op) {
    this.checkFactDistill(op.title, op.content);
    if (!hasText(op.producedBy)) {
      throw new WriteRejected('submit_fact 无 producedBy（origin 种子除外，拒写，CONTRACT §8）');
    }
    const step = graph.steps.find((s) => s.id === op.producedBy);
    if (!step) throw new WriteRejected(`submit_fact.producedBy 引用不存在 step: ${op.producedBy}`);
    if (step.state !== 'open') {
      throw new WriteRejected(
        `submit_fact.producedBy 指向非 open step: ${op.producedBy} state=${step.state}`,
      );
    }
    const fid = this.store.nextFactId(graph);
    if (graph.facts.some((f) => f.id === fid)) throw new WriteRejected(`fact id 已存在: ${fid}`);
    graph.facts.push({
      id: fid,
      title: op.title,
      content: op.content,
      createdAt: nowIsoZ(),
      producedBy: op.producedBy,
    });
    step.state = 'done';
    step.to = fid;
    return `submit_fact ${fid} (by ${op.producedBy})`;
  }

  seedOrigin(graph, op) {
    if (graph.facts.some((f) => f.id === 'fact_origin')) throw new WriteRejected('fact_origin 已存在');
    this.checkFactDistill(op.title, op.content);
    const now = nowIsoZ();
    graph.facts.push({ id: 'fact_origin', title: op.title, content: op.content, createdAt: now, producedBy: null });
    graph.goals.push({
      id: 'goal_final',
      kind: 'final',
      criterion: op.criterion,
      createdAt: now,
      satisfiedBy: null,
      satisfiedReason: null,
      satisfiedAt: null,
    });
    return 'seed_origin';
  }

  satisfyGoal(graph, op) {
    if (!op.goalId || !hasText(op.reason) || !Array.isArray(op.satisfiedBy) || op.satisfiedBy.length === 0) {
      throw new WriteRejected('satisfy_goal 缺 goalId/reason/satisfiedBy 任一字段，拒收（CONTRACT §4）');
    }
    const goal = graph.goals.find((g) => g.id === op.goalId);
    if (!goal) throw new WriteRejected(`goal 不存在: ${op.goalId}`);
    const factIds = new Set(graph.facts.map((f) => f.id));
    for (const fid of op.satisfiedBy) {
      if (!factIds.has(fid)) throw new WriteRejected(`satisfiedBy 引用不存在 fact: ${fid}`);
    }
    // FLAG 外部校验 hook（CONTRACT §8）：不过则不写 satisfied*
    if (this.verifyHook) {
      const err = this.verifyHook(graph, op);
      if (err) throw new WriteRejected(`satisfy_goal verify hook 拒绝: ${err}`);
    }
    goal.satisfiedBy = [...op.satisfiedBy];
    goal.satisfiedReason = op.reason;
    goal.satisfiedAt = nowIsoZ();
    return `satisfy_goal ${op.goalId}`;
  }

  reopen(graph, op) {
    if (!op.goalId || !hasText(op.reason)) {
      throw new WriteRejected('reopen 缺 goalId/reason（reason 不得为空或空白）');
    }
    const goal = graph.goals.find((g) => g.id === op.goalId);
    if (!goal) throw new WriteRejected(`goal 不存在: ${op.goalId}`);
    // 清空 satisfied*（CONTRACT §6）；永不删历史 Fact/Step
    goal.satisfiedBy = null;
    goal.satisfiedReason = null;
    goal.satisfiedAt = null;
    const title = op.feedbackTitle || truncateChars(op.reason, this.store.factTitleMaxChars);
    this.checkFactDistill(title, op.reason);
    const fid = this.store.nextFactId(graph);
    graph.facts.push({
      id: fid,
      title,
      content: op.reason,
      createdAt: nowIsoZ(),
      producedBy: null,
    });
    return `reopen ${op.goalId} + feedback ${fid}`;
  }

  /** 契约 §7：title ≤ N 字；content 超阈值时必须是文件路径。 */
  checkFactDistill(title, content) {
    const titleText = title ?? '';
    if ([...titleText].length > this.store.factTitleMaxChars) {
      throw new WriteRejected(
        `fact title 超 ${this.store.factTitleMaxChars} 字: ${[...titleText].length}（CONTRACT §7）`,
      );
    }
    if (content === undefined || content === null || content === '') return;
    const bytes = Buffer.byteLength(String(content), 'utf8');
    if (bytes <= this.store.factContentMaxBytes) return;
    // 超阈值时 content 必须整体就是一个文件路径：不能是「路径 + 大段正文」
    const text = String(content);
    const stripped = text.trim();
    const isPath = stripped.length > 0
      && text === stripped
      && !/\s/.test(stripped) // 路径里不允许空白（换行/空格/制表符一律视为塞了正文）
      // eslint-disable-next-line no-control-regex
      && !/[\u0000-\u001f]/.test(stripped)
      && Buffer.byteLength(stripped, 'utf8') < 4096
      && !'{[<'.includes(stripped[0])
      && (stripped.includes('/')
        || stripped.includes('\\')
        || /\.(txt|json|log|md|csv|tsv|yaml|yml|html|htm|xml|png|jpe?g|gif|pdf|zip|bin)$/i.test(stripped));
    if (!isPath) {
      throw new WriteRejected(
        `fact content 超 ${this.store.factContentMaxBytes} 字节且不是单个文件路径，拒写（CONTRACT §7）`,
      );
    }
  }
}

function findStep(graph, sid) {
  const step = graph.steps.find((s) => s.id === sid);
  if (!step) throw new WriteRejected(`step 不存在: ${sid}`);
  return step;
}

function hasText(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function truncateChars(text, max) {
  return [...String(text)].slice(0, max).join('');
}

export { WriteRejected };
export * from './ops.js';
