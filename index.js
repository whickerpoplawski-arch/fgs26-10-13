/**
 * fgs-deepseek — DSH 原生插件（Host 半）。
 *
 * 把 CONTRACT.md 的 FGS 黑板接进 DeepSeek Harness：
 *   - 单写者 Controller + YAML 图持久化（controller/）
 *   - 写图强制过 hooks（hooks/validate_write）+ FLAG 外部校验（hooks/flag_verify）
 *   - Decide / Execute 双 toolset，按图状态自动切换角色并物理隔离（CONTRACT §4、§5）
 *   - 每步运行时上下文注入最新图投影（hooks/sync_context，CONTRACT §9）
 *
 * 会话 ≠ 项目：一场比赛落在 workspace 的 `.fgs/`，每道题一个
 * `.fgs/projects/<problemId>/`（独立图、workspace、run）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { readFileSync } from 'node:fs';

import {
  Controller,
  GraphStore,
  WriteRejected,
} from './controller/index.js';
import { ProjectRegistry } from './controller/projects.js';
import {
  changePriorityOp,
  dropStepOp,
  openStepOp,
  reopenOp,
  satisfyGoalOp,
  seedOriginOp,
  submitFactOp,
} from './controller/ops.js';
import { makeVerifyHook } from './hooks/flag_verify.js';
import { roleContextText, roleLabel } from './hooks/sync_context.js';
import { preflight } from './hooks/validate_write.js';
import { truncateOutput } from './env/windows.js';
import { load as loadYaml } from './yaml.js';

/** 稳定 Loader 身份。 */
export const name = 'fgs-deepseek';

/**
 * 运行代次标记：只用于确认「磁盘上的新代码是否已被 Host 真正加载」。
 * 改代码后如果 /fgs/state 报的还是旧代次，说明进程仍跑着旧模块（需要重启/重载）。
 */
export const PLUGIN_GENERATION = 6;

/**
 * 面向人的构建标识：每次改动都必须往上滚一格。
 * 只用 PLUGIN_GENERATION 不够——重启会把当时代次加载成「当前」，
 * 之后再改代码，重启前后代次相同就区分不出新旧了（本项目踩过一次）。
 * `/fgs/state` 会原样返回 buildTag，重启后 curl 一眼即可确认新代码生效。
 */
export const BUILD_TAG = '6+fgs-draft-visible+stepsOpened-guard+snapshot-role+project+attach+fgs-project-tool+switch-msg+lowercase-flag+submit-tool+session-bind+owner-step+derived-role';

/** 本插件只硬依赖 tools；其余服务可选接入。 */
export const inject = ['tools'];

/* ------------------------------------------------------------- 常量 / 配置 */

const CONTROL_TOOLS = ['fgs_seed', 'fgs_status'];
/**
 * Project 控制面（建题 / 换题 / 列题）。
 * 它不能进 GRAPH_TOOL_NAMES 的「没有活动 Project 就拒」分支——没有活动 Project 时
 * 恰恰是唯一需要调用它的时刻。所以 guard 对它无条件放行（任何角色、任何状态）。
 */
const PROJECT_TOOLS = ['fgs_project'];
const DECIDE_TOOLS = [
  'fgs_open_step',
  'fgs_drop_step',
  'fgs_change_step_priority',
  'fgs_preview',
  'fgs_commit',
  'fgs_satisfy_goal',
  'fgs_reopen',
];
const EXECUTE_TOOLS = ['fgs_submit_fact', 'fgs_commit_step'];
const GRAPH_TOOL_NAMES = [...CONTROL_TOOLS, ...DECIDE_TOOLS, ...EXECUTE_TOOLS];

/** 角色可见 toolset（CONTRACT §4、§5）。 */
const ROLE_TOOLS = {
  decide: [...CONTROL_TOOLS, ...DECIDE_TOOLS],
  execute: [...CONTROL_TOOLS, ...EXECUTE_TOOLS],
};

/** Decide 会话禁止的环境执行工具（CONTRACT §4：禁止 bash 及一切环境执行工具）。 */
const DEFAULT_DENIED_ENV_TOOLS = [
  'bash',
  'pwsh',
  'bash_persistent',
  'pwsh_persistent',
  'read',
  'write',
  'edit',
  'glob',
  'grep',
  'ls',
  'find',
  'read_image',
  'lsp',
  'terminal_open',
];

/**
 * Decide 轮**白名单**（CONTRACT §4：只做规划/改图）。
 *
 * 用白名单而不是「列举已知环境工具」：DSH 的工具面随 profile 变化，
 * 枚举永远漏（subagent/workflow 能间接起 bash，web_fetch/web_search 能出网）。
 * 这里列出的是「规划时仍然合理」的只读/元工具；其余一律在 Decide 被拒。
 * 环境执行需要先 fgs_open_step + fgs_commit 进 Execute 轮。
 */
const DEFAULT_DECIDE_ALLOW_TOOLS = [
  'todo_write',
  'skill',
  'ask_user_question',
  'exit_plan_mode',
  'cordis_inspect_list',
  'cordis_inspect_query',
];

const DEFAULT_CONFIG = Object.freeze({
  stateDir: '.fgs',
  factContentMaxBytes: 8 * 1024,
  factTitleMaxChars: 120,
  verifyMode: 'regex',
  // 真实竞赛（百度）用小写 flag{...}；早期默认是全大写且无 i，导致真 flag 也被硬门拒收。
  flagPattern: 'flag\\{[^}\\s]{4,}\\}',
  flagFlags: 'i',
  expectedFlag: '',
  verifyCommand: '',
  deniedEnvTools: DEFAULT_DENIED_ENV_TOOLS,
  decideAllowTools: DEFAULT_DECIDE_ALLOW_TOOLS,
  maxResultChars: 8_000,
  exposeHttpState: true,
  httpPath: '/fgs/state',
});

const PRIORITY_ORDER = { high: 0, normal: 1, low: 2 };

const FGS_RULES = [
  '## FGS 黑板（fgs-deepseek）',
  '',
  '本项目使用 FGS 黑板：事实(Fact) → 步骤(Step) → 新事实(Fact)。Goal 不连边，只被 satisfy_goal 引用。',
  '图是唯一真记忆，按题隔离在 workspace 的 .fgs/projects/<problemId>/graph.yaml；顶层键只有 facts/goals/steps。',
  '建题/换题用 fgs_project（action=new|switch|list；new 时给 brief 就直接种题），人也可以打 /fgs new <problemId> [brief]。',
  '活动题按会话绑定：本会话 new/switch 过的 Project 重启后自动认领；',
  '别的会话（含子代理）不会继承本会话的活动题，要上同一块黑板必须自己 fgs_project action=switch。',
  '没有绑定 Project 时不能改图。',
  '',
  '角色由「本会话是否持有 open step」决定，每轮按图重算，不看缓存标签，也不看别人的 step：',
  '- 本会话没有持有的 open step → Decide：只做规划/改图。除规划类工具与少量元工具外一律被拒，',
  '  包括 bash/read/write/edit/glob/grep 以及 web_fetch/web_search/subagent/workflow。',
  '  用 fgs_open_step / fgs_drop_step / fgs_change_step_priority / fgs_satisfy_goal / fgs_reopen 记草稿，',
  '  最后用 fgs_commit 一次性提交（草稿为空时 commit 可传 operations[] 批量）。',
  '- 本会话持有 open step → Execute：只收束自己的 step。用 fgs_submit_fact 落新 Fact，',
  '  再用 fgs_commit_step 收束；无产出也必须落一条显式失败/观察 Fact。',
  '  submit_fact / commit_step 绑定别人的 open step 会被拒。',
  '',
  '硬约束：',
  '- open_step 必须给 from（存在的 fact id）；step.from 为空直接拒写。',
  '- drop_step 必须给 reason；satisfy_goal 必须给 {goalId, reason, satisfiedBy}，缺一拒收。',
  '- Fact title ≤ 120 字；content 超过 8KiB 时必须写成产物文件路径（禁止把整页 HTML / nmap 全文塞进 fact）。',
  '- satisfy_goal 提交前必须过外部 FLAG 校验 hook，不过则不写 satisfied*。',
  '- reopen 清空 satisfied* 并追加 feedback Fact，永不删除历史。',
].join('\n');

/* --------------------------------------------------------------- 小工具 */

function normalizeConfig(raw) {
  const cfg = { ...DEFAULT_CONFIG, ...(raw ?? {}) };
  cfg.deniedEnvTools = Array.isArray(cfg.deniedEnvTools) && cfg.deniedEnvTools.length > 0
    ? cfg.deniedEnvTools
    : DEFAULT_DENIED_ENV_TOOLS;
  return cfg;
}

function sessionIdOf(agent) {
  return agent?.id ?? agent?.session?.id ?? agent?.session?.header?.id ?? 'unknown';
}

function cwdOf(agent) {
  return agent?.session?.header?.cwd ?? agent?.cwd ?? process.cwd();
}

function text(value) {
  return [{ type: 'text', text: String(value) }];
}

function ok(body) {
  return { ok: true, text: body };
}

function fail(body) {
  return { ok: false, text: body };
}

function toolResultSchema() {
  return {
    type: 'object',
    properties: { ok: { type: 'boolean' }, text: { type: 'string' } },
    required: ['ok', 'text'],
    additionalProperties: false,
  };
}

/* ---------------------------------------------------------- run 状态管理 */

function fgsRootOf(agent, cfg) {
  return path.resolve(cwdOf(agent), cfg.stateDir);
}

function hasCwd(agent) {
  return Boolean(agent?.session?.header?.cwd || agent?.cwd);
}

/** run 以 (sessionId, problemId) 为键，题与题的草稿/角色/回合互不共享。 */
function runKey(sessionId, problemId) {
  return `${sessionId}::${problemId}`;
}

function registryFor(agent, cfg, registries) {
  if (!hasCwd(agent)) return null;
  const root = fgsRootOf(agent, cfg);
  let registry = registries.get(root);
  if (!registry) {
    registry = new ProjectRegistry(root);
    registry.migrateLegacy();
    registries.set(root, registry);
  }
  return registry;
}

/** 磁盘上的图是否已种题。认领判断必须看磁盘，不能看内存里有没有 run。 */
function projectSeeded(registry, problemId, cfg) {
  try {
    const graph = new GraphStore(registry.projectRoot(problemId), cfg).load();
    return graph.facts.length > 0 || graph.goals.length > 0 || graph.steps.length > 0;
  } catch {
    return false;
  }
}

/**
 * 认领（attach）：图工具 / 状态查询 / 运行时上下文的统一入口。
 *
 * 活动题是会话绑定（`.fgs/session-bindings.json`），不是工作区的 activeProblemId。
 * 同一 cwd 下的子代理会话不会继承 Lead 的题；重启后只恢复「这个 sessionId」自己绑过的题。
 * 这样磁盘上已种题的 Project 仍能被原会话直接认领，又不会让所有会话抢同一条 open step。
 *
 * reason 取值：no-cwd | no-project | detached | unseeded | attached | live
 * detached 只由 /fgs off 打上，用来挡住 /fgs off 之后的自动再认领。
 */
function attachRun(agent, cfg, runs, registries, detached, problemId = undefined) {
  const registry = registryFor(agent, cfg, registries);
  if (!registry) return { registry: null, problemId: null, run: null, reason: 'no-cwd' };
  const explicit = problemId !== undefined && problemId !== null && String(problemId) !== '';
  const id = explicit ? registry.normalizeId(problemId) : registry.getSessionProblem(sessionIdOf(agent));
  if (!id || !registry.isValidId(id) || !registry.exists(id)) {
    return { registry, problemId: id ?? null, run: null, reason: 'no-project' };
  }
  const key = runKey(sessionIdOf(agent), id);
  const live = runs.get(key) ?? null;
  if (live) {
    live.touchedAt = Date.now();
    return { registry, problemId: id, run: live, reason: 'live' };
  }
  if (detached?.has?.(key)) return { registry, problemId: id, run: null, reason: 'detached' };
  if (!projectSeeded(registry, id, cfg)) {
    return { registry, problemId: id, run: null, reason: 'unseeded' };
  }
  const run = runFor(agent, cfg, runs, registries, true, id);
  return { registry, problemId: id, run, reason: 'attached' };
}

/* ------------------------------------------- Project 控制面（命令 + 工具共用） */

/** 建立 Project；给了 brief 就顺带种题。命令 /fgs new 与 fgs_project 共用。 */
function projectNew(agent, cfg, runs, registries, detached, rawId, brief, extra = {}) {
  const registry = registryFor(agent, cfg, registries);
  if (!registry) return { ok: false, text: '无法定位 workspace（agent 没有 cwd）。' };
  const id = registry.normalizeId(rawId);
  if (!registry.isValidId(id)) {
    return { ok: false, text: `problemId 非法: ${rawId ?? ''}（须为 [a-z0-9_-]{1,64}）` };
  }
  const existed = registry.exists(id);
  try {
    if (!existed) {
      const title = brief ? String(brief).split('\n')[0].slice(0, 120) : id;
      registry.create({ id, title });
    } else if (!brief) {
      return { ok: false, text: `Project 已存在: ${id}（换题用 fgs_project action=switch，或 /fgs switch ${id}）` };
    }
    registry.setActive(id);
    registry.bindSession(sessionIdOf(agent), id);
  } catch (error) {
    return { ok: false, text: error.message };
  }
  detached?.delete?.(runKey(sessionIdOf(agent), id));
  if (!brief) return { ok: true, text: `已建立 Project ${id} → ${registry.projectRoot(id)}` };

  const fresh = runFor(agent, cfg, runs, registries, true, id);
  if (!fresh) return { ok: false, text: `无法启动 Project ${id}。` };
  fresh.reachable = true;
  const graph = fresh.store.load();
  if (graph.facts.some((f) => f.id === 'fact_origin')) {
    // 保留「同一个 Project 只种一次」的失败语义（/fgs init 重复调用依赖它）；
    // 关键是把出路写清楚：这时 run 已经认领，直接开 step 就行。
    refreshRole(fresh);
    return {
      ok: false,
      text: `已经种过题：${path.join(fresh.root, 'graph.yaml')} 已存在 fact_origin。`
        + `\nProject ${id} 已认领，直接用 fgs_open_step 继续推进即可。`,
    };
  }
  const content = extra.target ? JSON.stringify({ target: extra.target, brief }, null, 2) : brief;
  try {
    const next = fresh.controller.apply(
      seedOriginOp({
        title: '题目信息:',
        content,
        ...(extra.criterion ? { criterion: extra.criterion } : {}),
      }),
      graph,
    );
    fresh.controller.commit(next);
    syncProjectMeta(registry, fresh, next);
  } catch (error) {
    return { ok: false, text: `种题失败: ${error.message}` };
  }
  refreshRole(fresh);
  return { ok: true, text: `已种题 → ${path.join(fresh.root, 'graph.yaml')}` };
}

/** 切换活动 Project（磁盘已种题则顺带认领）。 */
function projectSwitch(agent, cfg, runs, registries, detached, rawId) {
  const registry = registryFor(agent, cfg, registries);
  if (!registry) return { ok: false, text: '无法定位 workspace（agent 没有 cwd）。' };
  const id = registry.normalizeId(rawId);
  if (!id || !registry.exists(id)) return { ok: false, text: `Project 不存在: ${id}` };
  try {
    registry.setActive(id);
    registry.bindSession(sessionIdOf(agent), id);
  } catch (error) {
    return { ok: false, text: error.message };
  }
  detached?.delete?.(runKey(sessionIdOf(agent), id));
  const { run } = attachRun(agent, cfg, runs, registries, detached, id);
  const seeded = projectSeeded(registry, id, cfg);
  const tail = seeded
    ? (run ? `已认领，角色 ${run.role === 'execute' ? 'Execute' : 'Decide'}` : '已种题')
    : '尚未种题，用 fgs_seed 种题';
  return { ok: true, text: `已切换活动 Project → ${id}（${tail}）。` };
}

/** 列出全部 Project 及其角色/进度。 */
function projectList(agent, cfg, runs, registries) {
  const registry = registryFor(agent, cfg, registries);
  if (!registry) return { ok: false, text: '无法定位 workspace（agent 没有 cwd）。' };
  const items = registry.list();
  if (items.length === 0) {
    return { ok: true, text: '（无 Project）用 fgs_project action=new problemId=<id> brief=<题目> 建立。' };
  }
  const boundId = registry.getSessionProblem(sessionIdOf(agent));
  const activeId = boundId || registry.getActive();
  const sid = sessionIdOf(agent);
  const lines = items.map((item) => {
    const mark = item.id === activeId ? '*' : ' ';
    try {
      const store = new GraphStore(registry.projectRoot(item.id), cfg);
      const graph = store.load();
      const seeded = graph.facts.length > 0 || graph.goals.length > 0 || graph.steps.length > 0;
      const role = seeded ? roleLabel(sessionRole(graph, sid)) : 'unseeded';
      const open = openStepsOf(graph).length;
      const satisfied = goalSatisfied(graph) ? 'yes' : 'no';
      return `${mark} ${item.id}  title=${item.title}  role=${role}  open=${open}  satisfied=${satisfied}  state=${item.state}`;
    } catch (error) {
      return `${mark} ${item.id}  [读取失败: ${error.message}]`;
    }
  });
  return { ok: true, text: lines.join('\n') };
}

function createRun(agent, cfg, registry, problemId) {
  const root = registry.projectRoot(problemId);
  fs.mkdirSync(path.join(root, 'workspace'), { recursive: true });
  const store = new GraphStore(root, cfg);
  const controller = new Controller(store, { verifyHook: makeVerifyHook(cfg) });
  return {
    sid: sessionIdOf(agent),
    problemId,
    root,
    fgsRoot: registry.root,
    workspaceDir: path.join(root, 'workspace'),
    store,
    controller,
    role: 'decide',
    derivedRole: 'decide',
    graphSeeded: false,
    decideDraft: [],
    execDraft: null,
    draftNotice: null,
    currentStepId: null,
    reachable: false,
    touchedAt: Date.now(),
    roundSeq: 0,
    roundTurn: null,
    lastCommitRound: null,
    stepsOpenedRound: null,
    stepsOpenedIds: null,
  };
}

/**
 * problemId 省略时取活动 Project。没有活动 Project 返回 null
 * （改图必须先 /fgs new 或 /fgs switch）。
 */
function runFor(agent, cfg, runs, registries, create = false, problemId = undefined) {
  const registry = registryFor(agent, cfg, registries);
  if (!registry) return null;
  const explicit = problemId !== undefined && problemId !== null && String(problemId) !== '';
  const id = explicit ? registry.normalizeId(problemId) : registry.getSessionProblem(sessionIdOf(agent));
  if (!id || !registry.isValidId(id) || !registry.exists(id)) return null;
  const key = runKey(sessionIdOf(agent), id);
  let run = runs.get(key);
  if (run) {
    run.touchedAt = Date.now();
    return run;
  }
  if (!create) return null;
  run = createRun(agent, cfg, registry, id);
  // 磁盘上可能已有图（迁移 / 重启后再 seed）：角色以图为准，不停留在默认 decide。
  try {
    refreshRole(run);
  } catch {
    /* 图损坏时仍交出 run，后续读会报错 */
  }
  runs.set(key, run);
  return run;
}

/**
 * 把宿主 turn 折进「本 run 自己的 roundSeq」。
 * 比对「一轮一步」只用 roundSeq，不拿全局 turn 数字当共享轴（G8）：
 * 同一会话里两道题即使看到同一个 turn，也各有各的 roundSeq / lastCommitRound。
 * turn 不可用时 limited=false，退化为不按回合硬拦（与旧行为一致）。
 * 方案 B 会改由编排器显式 +1；M1 仍用宿主 turn 作为本 run 的时钟输入。
 */
function observeRound(run, turn) {
  if (!Number.isFinite(turn)) return { round: run.roundSeq ?? 0, limited: false };
  if (run.roundTurn === null || run.roundTurn === undefined) {
    run.roundTurn = turn;
  } else if (run.roundTurn !== turn) {
    run.roundSeq = (run.roundSeq ?? 0) + 1;
    run.roundTurn = turn;
  }
  return { round: run.roundSeq, limited: true };
}

function deriveProjectState(graph) {
  if (goalSatisfied(graph)) return 'solved';
  const facts = graph?.facts ?? [];
  const steps = graph?.steps ?? [];
  if (!facts.some((f) => f.id === 'fact_origin')) return 'created';
  if (steps.length === 0) return 'seeded';
  return 'running';
}

function syncProjectMeta(registry, run, graph) {
  if (!registry || !run) return;
  const state = deriveProjectState(graph);
  const prev = registry.readMeta(run.problemId) ?? {};
  registry.writeMeta(run.problemId, {
    id: run.problemId,
    title: prev.title ?? run.problemId,
    state,
    model: prev.model ?? null,
    budget: prev.budget ?? null,
    roundSeq: run.roundSeq ?? 0,
    createdAt: prev.createdAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  registry.setProblemState(run.problemId, state);
}

function lastRun(runs) {
  let best = null;
  for (const run of runs.values()) {
    if (best === null || run.touchedAt > best.touchedAt) best = run;
  }
  return best;
}

function runsForSession(runs, sid) {
  const found = [];
  for (const run of runs.values()) {
    if (run.sid === sid) found.push(run);
  }
  return found;
}

function liveRun(runs, { sid, fgsRoot, problemId }) {
  let best = null;
  for (const run of runs.values()) {
    if (problemId && run.problemId !== problemId) continue;
    if (fgsRoot && run.fgsRoot !== fgsRoot) continue;
    if (sid && run.sid !== sid) continue;
    if (best === null || run.touchedAt > best.touchedAt) best = run;
  }
  return best;
}

/** 没有内存 run 时按磁盘图做只读快照（草稿为空）。 */
function diskSnapshot(registry, problemId, cfg) {
  const store = new GraphStore(registry.projectRoot(problemId), cfg);
  const meta = registry.readMeta(problemId);
  return graphSnapshot({
    sid: null,
    problemId,
    root: store.root,
    fgsRoot: registry.root,
    workspaceDir: path.join(store.root, 'workspace'),
    roundSeq: meta?.roundSeq ?? 0,
    store,
    reachable: false,
    currentStepId: null,
    decideDraft: [],
    execDraft: null,
    role: 'decide',
  });
}

function resolveHttpSnapshot({ runs, registries, cfg, sessionId, problemId }) {
  const sid = sessionId || null;
  const sessionRuns = sid ? runsForSession(runs, sid) : [];
  if (sid && sessionRuns.length === 0) return inactivePayload();

  let registry = null;
  if (sessionRuns.length > 0) registry = registries.get(sessionRuns[0].fgsRoot) ?? null;
  if (!registry) {
    const latest = lastRun(runs);
    if (latest) registry = registries.get(latest.fgsRoot) ?? null;
  }
  if (!registry) {
    for (const candidate of registries.values()) {
      if (candidate.getActive()) registry = candidate;
    }
  }

  if (problemId) {
    if (!registry) return inactivePayload();
    const id = registry.normalizeId(problemId);
    if (!registry.isValidId(id) || !registry.exists(id)) return inactivePayload();
    const run = liveRun(runs, { sid, fgsRoot: registry.root, problemId: id });
    return run ? graphSnapshot(run) : diskSnapshot(registry, id, cfg);
  }

  const activeId = registry?.getActive() ?? null;
  if (activeId) {
    const run = liveRun(runs, { sid, fgsRoot: registry.root, problemId: activeId });
    if (run) return graphSnapshot(run);
    if (!sid) return diskSnapshot(registry, activeId, cfg);
    return inactivePayload();
  }
  const fallback = sid ? (sessionRuns.sort((a, b) => b.touchedAt - a.touchedAt)[0] ?? null) : lastRun(runs);
  return fallback ? graphSnapshot(fallback) : inactivePayload();
}

function openStepsOf(graph) {
  return (graph.steps ?? [])
    .filter((s) => s.state === 'open')
    .sort((a, b) => (PRIORITY_ORDER[a.priority] ?? 1) - (PRIORITY_ORDER[b.priority] ?? 1)
      || String(a.createdAt).localeCompare(String(b.createdAt))
      || String(a.id).localeCompare(String(b.id)));
}

function goalSatisfied(graph) {
  const goal = (graph.goals ?? []).find((g) => g.id === 'goal_final');
  return Boolean(goal?.satisfiedAt);
}

/** 本会话持有的 open step（ownerSession 必须等于 sid）。别人的 step 不算。 */
function stepsOwnedBy(graph, sessionId) {
  if (!sessionId || sessionId === 'unknown') return [];
  return openStepsOf(graph).filter((s) => s.ownerSession === sessionId);
}

/** Decide/Execute 只看本会话有没有自己的 open step，不看整张图上是否还有别人的。 */
function sessionRole(graph, sessionId) {
  return stepsOwnedBy(graph, sessionId).length > 0 ? 'execute' : 'decide';
}

/** 草稿指向的 step 已结束或不属于本会话时丢掉，并留下给 fgs_status 的告警。 */
function sweepStaleDraft(run, graph) {
  if (!run?.execDraft) return;
  const step = (graph.steps ?? []).find((s) => s.id === run.execDraft.stepId);
  const live = Boolean(step && step.state === 'open' && step.ownerSession === run.sid);
  if (!live) {
    run.execDraft = null;
    run.draftNotice = '已回收僵尸草稿：它指向的 step 已不是本会话持有的 open step。';
  }
}

/**
 * 按图重算本会话的角色与 currentStepId。
 * 守卫、上下文、写路径都走这里，不信任上一次留下的 run.role。
 */
function refreshRole(run) {
  const graph = run.store.load();
  const seeded = graph.facts.length > 0 || graph.goals.length > 0 || graph.steps.length > 0;
  run.graphSeeded = seeded;
  sweepStaleDraft(run, graph);
  const owned = stepsOwnedBy(graph, run.sid);
  const derived = owned.length > 0 ? 'execute' : 'decide';
  run.derivedRole = derived;
  run.role = derived;
  if (derived === 'execute') {
    if (!run.currentStepId || !owned.some((s) => s.id === run.currentStepId)) {
      run.currentStepId = owned[0].id;
    }
  } else {
    run.currentStepId = null;
  }
  return graph;
}

/** 打开 step / 收束 step 时盖上调用方会话，模型传进来的 owner 一律作废。 */
function stampSession(op, sid) {
  const next = { ...op, callerSession: sid };
  if (next.type === 'open_step' && sid && sid !== 'unknown') next.ownerSession = sid;
  return next;
}

/** 本回合新开的 step 允许在同一回合收束（否则先收后开会留下无主 open step）。 */
function openedThisRound(run, stepId, round, limited) {
  return Boolean(
    limited
    && stepId
    && run.stepsOpenedRound === round
    && run.stepsOpenedIds instanceof Set
    && run.stepsOpenedIds.has(stepId),
  );
}

function draftSummary(run) {
  // Execute 轮：本轮草稿是一条待写入的 Fact，必须让运行时上下文和 /fgs/state 都看得见，
  // 否则模型 submit_fact 之后在上下文里看不到自己刚落的草稿（/fgs/state 也显示 draft:""）。
  if (run.execDraft) {
    const d = run.execDraft;
    return `fact(${d.stepId}) «${truncateOutput(String(d.title ?? ''), 48)}»`;
  }
  if (!run.decideDraft.length) return '';
  return run.decideDraft.map((op, i) => `${i + 1}. ${op.type}`).join('; ');
}

/** Decide 白名单（CONTRACT §4）：FGS 规划工具 + 配置里声明的元工具，其余一律拒。 */
function decideAllows(cfg, tool) {
  return ROLE_TOOLS.decide.includes(tool) || (cfg.decideAllowTools ?? []).includes(tool);
}

/**
 * 当前回合号：读 DSH 的 `turnBoundary` 投影（dsh-tool-present 用同一入口）。
 * 服务不可用时返回 null —— 调用方退化为「不按回合限制」，绝不硬卡住会话。
 */
function turnOf(ctx, agent) {
  try {
    const projections = ctx.get?.('sessionProjections');
    const boundary = projections?.stateOf?.(agent?.session, 'turnBoundary');
    const turn = boundary?.lastTurn;
    return Number.isFinite(turn) ? turn : null;
  } catch {
    return null;
  }
}

/**
 * 读取预制 I/O 规范（CONTRACT §9）：把 io-specs/<role>.io.yaml 真的送进模型上下文，
 * 而不是只躺在仓库里当文档。
 */
function loadIoSchema(role) {
  try {
    const raw = readFileSync(new URL(`./io-specs/${role}.io.yaml`, import.meta.url), 'utf8');
    const doc = loadYaml(raw) ?? {};
    return {
      tools: Array.isArray(doc.tools) ? doc.tools.map(String) : [],
      forbidden: Array.isArray(doc.forbidden_tools) ? doc.forbidden_tools.map(String) : [],
      notes: Array.isArray(doc.notes) ? doc.notes.map(String) : [],
    };
  } catch {
    return null;
  }
}

/**
 * 角色隔离：只用 tools.guard 在 dispatch 层硬拒，不用 tools.restrict 做动态可见性。
 *
 * 实测（DSH 0.2.0-rc.2 / web profile）：对同一 agent scope 连续调用 restrict 时，
 * 后一次不会解除前一次的效果（限制是取交集的），一旦为了「未启动」隐藏了规划工具，
 * 会话进入 Decide 后那些工具就再也不可见了。角色是随图状态变化的，而 restrict
 * 无法可靠地「松开」，所以 schema 层永远保留全部 fgs_* 工具，越权调用由下面的
 * guard 硬拒并给出可执行的替代路径。契约要的是「拦」，guard 是顺序无关的硬拦。
 */

/* ------------------------------------------------------------- 图快照 */

/** 「本会话没在跑 FGS」的统一快照（Client 据此渲染「未启动」）。 */
function inactivePayload() {
  return {
    active: false,
    pluginGeneration: PLUGIN_GENERATION,
    buildTag: BUILD_TAG,
    updatedAt: new Date().toISOString(),
  };
}

function visibleStepId(graph, run) {
  const cached = run.currentStepId ?? null;
  if (!cached) return stepsOwnedBy(graph, run.sid)[0]?.id ?? null;
  const step = (graph.steps ?? []).find((s) => s.id === cached);
  if (step && step.state === 'open' && step.ownerSession === run.sid) return step.id;
  return stepsOwnedBy(graph, run.sid)[0]?.id ?? null;
}

function graphSnapshot(run) {
  const graph = run.store.load();
  const open = openStepsOf(graph);
  // 空图 = 本会话还没种题（或图文件被外部删除）：按「未启动」上报，
  // 让 Client 走它自己的「未启动」分支，而不是渲染成一条矛盾的黑板条。
  if (graph.facts.length === 0 && graph.goals.length === 0 && graph.steps.length === 0) {
    return inactivePayload();
  }
  // runRole 是刷新前的缓存。derivedRole 按「本会话持有的 open step」从图重算。
  // currentStepId 指向已 done / 别人的 step 时必须是 null，不能把陈旧指针报出去。
  const runRole = typeof run.role === 'string' ? run.role : null;
  sweepStaleDraft(run, graph);
  const role = sessionRole(graph, run.sid);
  const currentStepId = visibleStepId(graph, run);
  run.derivedRole = role;
  run.role = role;
  run.currentStepId = currentStepId;
  run.graphSeeded = true;
  return {
    active: true,
    pluginGeneration: PLUGIN_GENERATION,
    buildTag: BUILD_TAG,
    sessionId: run.sid,
    problemId: run.problemId ?? null,
    root: run.root,
    workspaceDir: run.workspaceDir ?? null,
    roundSeq: run.roundSeq ?? 0,
    role,
    derivedRole: role,
    runRole,
    roleLabel: roleLabel(role),
    reachable: run.reachable,
    satisfied: goalSatisfied(graph),
    currentStepId,
    draft: draftSummary(run),
    draftNotice: run.draftNotice ?? null,
    counts: {
      facts: graph.facts.length,
      goals: graph.goals.length,
      steps: graph.steps.length,
      open: open.length,
      owned: stepsOwnedBy(graph, run.sid).length,
    },
    facts: graph.facts.map((f) => ({ id: f.id, title: f.title })),
    goals: graph.goals.map((g) => ({
      id: g.id,
      kind: g.kind,
      satisfiedBy: g.satisfiedBy ?? null,
      satisfiedReason: g.satisfiedReason ?? null,
      satisfiedAt: g.satisfiedAt ?? null,
    })),
    steps: graph.steps.map((s) => ({
      id: s.id,
      action: s.action,
      from: s.from ?? [],
      state: s.state,
      priority: s.priority,
      to: s.to ?? null,
      ownerSession: s.ownerSession ?? null,
    })),
    updatedAt: new Date().toISOString(),
  };
}

/* --------------------------------------------------------------- 工具定义 */

function defineFgsTool({ toolName, description, parameters, run, cfg }) {
  const maxChars = cfg?.maxResultChars ?? 8_000;
  return {
    name: toolName,
    description,
    parameters,
    output: {
      schema: toolResultSchema(),
      // CONTRACT §9：工具出参先裁噪声再进模型（io-specs 的 max_result_chars）
      render: (_args, value) => text(truncateOutput(value.text, maxChars)),
    },
    async execute(args, exec) {
      return run(args ?? {}, exec);
    },
  };
}

function registerTools(ctx, cfg, runs, registries, detached) {
  const disposers = [];
  const register = (definition) => {
    disposers.push(ctx.tools.register(definition));
  };
  const makeTool = (spec) => defineFgsTool({ ...spec, cfg });

  const active = (exec) => {
    const run = runFor(exec?.agent, cfg, runs, registries, false);
    if (!run) {
      const registry = registryFor(exec?.agent, cfg, registries);
      if (!registry?.getActive()) {
        throw new Error('FGS 未启动：没有活动 Project。先 /fgs new <problemId> 或 /fgs switch <problemId>。');
      }
      throw new Error('FGS 未启动：先调用 fgs_seed（或 /fgs new <problemId> <brief> / /fgs init <brief>）种题。');
    }
    return run;
  };

  /* ---- 控制面 ---- */

  register(makeTool({
    toolName: 'fgs_seed',
    description: '在活动 Project 上种题：写入 fact_origin 与 goal_final。先 /fgs new <problemId>。同一个 Project 只种一次。',
    parameters: {
      type: 'object',
      properties: {
        brief: { type: 'string', description: '题目原始信息（target、hint、约束）。若超过 8KiB 需改为文件路径。' },
        target: { type: 'string', description: '目标地址/入口（可选，会并入 origin fact）。' },
        title: { type: 'string', description: 'origin fact 标题，默认「题目信息:」。' },
        criterion: { type: 'string', description: 'goal_final 的完成判据。' },
      },
      required: ['brief'],
      additionalProperties: false,
    },
    run: (args, exec) => {
      if (typeof args.brief !== 'string' || args.brief.trim() === '') {
        return fail('fgs_seed 需要非空 brief。');
      }
      const registry = registryFor(exec?.agent, cfg, registries);
      if (!registry?.getSessionProblem(sessionIdOf(exec?.agent))) {
        return fail('FGS 未启动：没有活动 Project。先 fgs_project action=new problemId=<id>（或 /fgs new <id>）。');
      }
      const run = runFor(exec?.agent, cfg, runs, registries, true);
      if (!run) {
        return fail('FGS 未启动：没有活动 Project。先 fgs_project action=new problemId=<id>（或 /fgs new <id>）。');
      }
      detached.delete(runKey(run.sid, run.problemId));
      run.reachable = true;
      const graph = run.store.load();
      if (graph.facts.some((f) => f.id === 'fact_origin')) {
        // 保持「只种一次」的错误语义（/fgs init 重复调用依赖它），
        // 但补上出路：这时 run 已认领，直接开 step 即可，不必再纠结种题。
        refreshRole(run);
        return fail(`已经种过题：${path.join(run.root, 'graph.yaml')} 已存在 fact_origin。`
          + `\nProject ${run.problemId} 已认领，直接用 fgs_open_step 继续推进即可。`);
      }
      const content = args.target
        ? JSON.stringify({ target: args.target, brief: args.brief }, null, 2)
        : args.brief;
      const op = seedOriginOp({
        title: args.title || '题目信息:',
        content,
        ...(args.criterion ? { criterion: args.criterion } : {}),
      });
      try {
        const next = run.controller.apply(op, graph);
        run.controller.commit(next);
        syncProjectMeta(registry, run, next);
      } catch (error) {
        if (error instanceof WriteRejected) return fail(`种题拒收: ${error.message}`);
        throw error;
      }
      refreshRole(run);
      return ok(`已种题。图: ${path.join(run.root, 'graph.yaml')}\n当前角色: ${roleLabel(run.role)}`);
    },
  }));

  register(makeTool({
    toolName: 'fgs_status',
    description: '只读查看 FGS 黑板状态：角色、目标是否满足、facts/steps 计数与 open steps。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    run: (_args, exec) => {
      // 认领（attach）：磁盘已种题的 Project 直接建 run + refreshRole，
      // 不看「内存里有没有 run」——否则重启/换会话后会误报「尚未种题」。
      const { problemId, run, reason } = attachRun(exec?.agent, cfg, runs, registries, detached);
      if (reason === 'no-project') {
        return ok('FGS 未启动（没有活动 Project：先 fgs_project action=new problemId=<id> brief=<题目>，或 /fgs new <id>「题目」）。');
      }
      if (!run) {
        return ok(reason === 'detached'
          ? `FGS 未启动（本会话已 /fgs off；Project ${problemId} 与图文件仍在磁盘，`
            + `重新进入用 fgs_project action=switch problemId=${problemId}）。`
          : `FGS 未启动（Project ${problemId} 尚未种题）。`);
      }
      const graph = refreshRole(run);
      // 图被外部删除 → 与「从未种题」同义，别报着缓存角色说自己在 Execute
      if (graph.facts.length === 0 && graph.goals.length === 0 && graph.steps.length === 0) {
        return ok('FGS 未启动（图为空：尚未种题，或图文件已被移除）。');
      }
      const role = run.role;
      const lines = [
        `Project: ${run.problemId}`,
        `角色: ${roleLabel(role)}`,
        `图: ${path.join(run.root, 'graph.yaml')}`,
        `workspace: ${run.workspaceDir}`,
        `goal_final satisfied: ${goalSatisfied(graph) ? 'yes' : 'no'}`,
        `facts=${graph.facts.length} steps=${graph.steps.length} open=${openStepsOf(graph).length} owned=${stepsOwnedBy(graph, run.sid).length}`,
      ];
      for (const step of openStepsOf(graph)) {
        const who = step.ownerSession ? ` owner=${step.ownerSession}` : '';
        lines.push(`  open ${step.id} [${step.priority}]${who} ${step.action}`);
      }
      const foreign = openStepsOf(graph).filter((s) => s.ownerSession && s.ownerSession !== run.sid);
      if (foreign.length > 0) {
        lines.push(`其他会话 open: ${foreign.map((s) => `${s.id}@${s.ownerSession}`).join(', ')}（不可绑定）`);
      }
      const draft = draftSummary(run);
      if (draft) lines.push(`草稿: ${draft}`);
      if (run.draftNotice) lines.push(`告警: ${run.draftNotice}`);
      return ok(lines.join('\n'));
    },
  }));

  /* ---- Project 控制面（建题 / 换题 / 列题）---- */

  register(makeTool({
    toolName: 'fgs_project',
    description: '建题 / 换题 / 列题：一场比赛下按 problemId 隔离每道题的图、workspace 与回合。'
      + ' action=new 需 problemId（可选 brief/target/criterion，给了就直接种题）；'
      + ' action=switch 换活动题；action=list 列全部。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['new', 'switch', 'list'], description: '要做的操作。' },
        problemId: { type: 'string', description: 'action=new/switch 必填；规范化成 [a-z0-9_-]{1,64}。' },
        brief: { type: 'string', description: 'action=new 可选：题目原文；给了就顺带种题。' },
        target: { type: 'string', description: 'action=new 可选：目标地址/入口，并入 fact_origin。' },
        criterion: { type: 'string', description: 'action=new 可选：goal_final 完成判据。' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    run: (args, exec) => {
      const action = String(args.action ?? '');
      if (action === 'list') {
        const result = projectList(exec?.agent, cfg, runs, registries);
        return result.ok ? ok(result.text) : fail(result.text);
      }
      const rawId = args.problemId;
      if (typeof rawId !== 'string' || rawId.trim() === '') {
        return fail(`action=${action} 需要 problemId。`);
      }
      const result = action === 'new'
        ? projectNew(exec?.agent, cfg, runs, registries, detached, rawId, args.brief ?? '', {
          target: args.target,
          criterion: args.criterion,
        })
        : (action === 'switch'
          ? projectSwitch(exec?.agent, cfg, runs, registries, detached, rawId)
          : { ok: false, text: `未知 action: ${action}（可选 new | switch | list）` });
      return result.ok ? ok(result.text) : fail(result.text);
    },
  }));

  /* ---- Decide ---- */

  register(makeTool({
    toolName: 'fgs_preview',
    description: '只读投影当前图（fact 只给 id+title）并附未提交草稿。规划前先看这个。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    run: (_args, exec) => {
      const run = active(exec);
      const graph = run.store.load();
      const parts = [run.store.preview(graph)];
      if (run.decideDraft.length) parts.push(`# 未提交草稿\n${draftSummary(run)}`);
      return ok(parts.join('\n\n'));
    },
  }));

  register(makeTool({
    toolName: 'fgs_open_step',
    description: '在草稿里开一个 step。from 必须是非空 fact id 列表（因果铁律）。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', description: '这一步要做什么（可执行、可验证的动作）。' },
        from: { type: 'array', items: { type: 'string' }, description: '本步骤依赖的 fact id 列表，不能为空。' },
        priority: { type: 'string', enum: ['high', 'normal', 'low'], description: '默认 normal。' },
        actor: { type: 'string', description: '默认 agent。' },
        stepId: { type: 'string', description: '可选，预分配 step_NNN（batch commit 用）。' },
      },
      required: ['action', 'from'],
      additionalProperties: false,
    },
    run: (args, exec) => {
      const run = active(exec);
      const op = openStepOp({
        action: args.action ?? '',
        from: args.from ?? [],
        actor: args.actor || 'agent',
        priority: args.priority || 'normal',
        stepId: args.stepId || null,
      });
      return stageDecideOp(run, op);
    },
  }));

  register(makeTool({
    toolName: 'fgs_drop_step',
    description: '在草稿里丢弃一个 open step。必须给 reason。',
    parameters: {
      type: 'object',
      properties: {
        stepId: { type: 'string', description: '要丢弃的 step id。' },
        reason: { type: 'string', description: '丢弃原因，不能为空。' },
      },
      required: ['stepId', 'reason'],
      additionalProperties: false,
    },
    run: (args, exec) => {
      const run = active(exec);
      return stageDecideOp(run, dropStepOp({ stepId: args.stepId, reason: args.reason }));
    },
  }));

  register(makeTool({
    toolName: 'fgs_change_step_priority',
    description: '在草稿里调整一个 open step 的优先级。',
    parameters: {
      type: 'object',
      properties: {
        stepId: { type: 'string', description: '目标 step id。' },
        priority: { type: 'string', enum: ['high', 'normal', 'low'], description: '新优先级。' },
        reason: { type: 'string', description: '可选原因。' },
      },
      required: ['stepId', 'priority'],
      additionalProperties: false,
    },
    run: (args, exec) => {
      const run = active(exec);
      return stageDecideOp(run, changePriorityOp({
        stepId: args.stepId,
        priority: args.priority,
        reason: args.reason || null,
      }));
    },
  }));

  register(makeTool({
    toolName: 'fgs_satisfy_goal',
    description: '在草稿里声明目标已被满足。必填 goalId/reason/satisfiedBy，缺一拒收；commit 时还要过 FLAG 外部校验。',
    parameters: {
      type: 'object',
      properties: {
        goalId: { type: 'string', description: '目标 id，通常 goal_final。' },
        reason: { type: 'string', description: '为什么算满足（要有证据指向）。' },
        satisfiedBy: { type: 'array', items: { type: 'string' }, description: '支撑满足的 fact id 列表，不能为空。' },
      },
      required: ['goalId', 'reason', 'satisfiedBy'],
      additionalProperties: false,
    },
    run: (args, exec) => {
      const run = active(exec);
      return stageDecideOp(run, satisfyGoalOp({
        goalId: args.goalId,
        reason: args.reason,
        satisfiedBy: args.satisfiedBy,
      }));
    },
  }));

  register(makeTool({
    toolName: 'fgs_reopen',
    description: '在草稿里打回目标：清空 satisfied* 并追加 feedback Fact（假 FLAG / 裁判打回 / 外部反馈未过时使用）。',
    parameters: {
      type: 'object',
      properties: {
        goalId: { type: 'string', description: '目标 id，通常 goal_final。' },
        reason: { type: 'string', description: '打回原因，会落成 feedback Fact 的 content。' },
        feedbackTitle: { type: 'string', description: '可选 feedback Fact 标题。' },
      },
      required: ['goalId', 'reason'],
      additionalProperties: false,
    },
    run: (args, exec) => {
      const run = active(exec);
      return stageDecideOp(run, reopenOp({
        goalId: args.goalId,
        reason: args.reason,
        feedbackTitle: args.feedbackTitle || null,
      }));
    },
  }));

  register(makeTool({
    toolName: 'fgs_commit',
    description: '一次性提交 Decide 草稿（或传 operations[] 批量），全部校验通过才落盘；任一失败整批拒写。',
    parameters: {
      type: 'object',
      properties: {
        operations: {
          type: 'array',
          description: '可选批量操作；给了就忽略草稿。每项形如 {op:"open_step", action, from}。',
          items: {
            type: 'object',
            properties: {
              op: { type: 'string', enum: ['open_step', 'drop_step', 'change_step_priority', 'satisfy_goal', 'reopen'] },
              action: { type: 'string' },
              from: { type: 'array', items: { type: 'string' } },
              priority: { type: 'string' },
              actor: { type: 'string' },
              stepId: { type: 'string' },
              reason: { type: 'string' },
              goalId: { type: 'string' },
              satisfiedBy: { type: 'array', items: { type: 'string' } },
              feedbackTitle: { type: 'string' },
            },
            required: ['op'],
            additionalProperties: false,
          },
        },
        clearDraftOnFailure: { type: 'boolean', description: '默认 false：失败时保留草稿。' },
      },
      required: [],
      additionalProperties: false,
    },
    run: (args, exec) => {
      const run = active(exec);
      let ops;
      if (Array.isArray(args.operations) && args.operations.length > 0) {
        try {
          ops = args.operations.map(opsFromJson);
        } catch (error) {
          return fail(`operations 解析失败: ${error.message}`);
        }
      } else {
        ops = run.decideDraft;
      }
      if (!ops || ops.length === 0) return fail('草稿为空，且未提供 operations[]；没有可提交的改动。');
      const graph = run.store.load();
      const applied = [];
      let working = graph;
      for (const op of ops) {
        let next;
        const stamped = stampSession(op, run.sid);
        try {
          next = run.controller.apply(stamped, working);
        } catch (error) {
          if (error instanceof WriteRejected) {
            if (args.clearDraftOnFailure === true) run.decideDraft = [];
            return fail(`第 ${applied.length + 1} 项（${op.type}）拒收，整批不落盘: ${error.message}`);
          }
          throw error;
        }
        working = next;
        applied.push(op.type);
      }
      run.controller.commit(working);
      run.decideDraft = [];
      // 记住「本回合新开了哪些 step」：回合收口时不能把这些刚打开的 step 吞成观察 Fact，
      // 否则正常的「先规划、下一回合再执行」用法会把自己的第一步立刻消耗掉。
      // 回合轴是本 run 的 roundSeq，不是全局 DSH turn（G8）。
      {
        const before = new Set(graph.steps.map((s) => s.id));
        const openedNow = working.steps.filter((s) => !before.has(s.id)).map((s) => s.id);
        const { round, limited } = observeRound(run, turnOf(ctx, exec?.agent));
        if (openedNow.length > 0 && limited) {
          run.stepsOpenedRound = round;
          run.stepsOpenedIds = new Set(openedNow);
        }
      }
      syncProjectMeta(registryFor(exec?.agent, cfg, registries), run, working);
      refreshRole(run);
      const satisfied = goalSatisfied(working);
      if (satisfied && typeof exec?.concludeTurn === 'function') exec.concludeTurn();
      const mine = stepsOwnedBy(working, run.sid);
      const tail = satisfied
        ? 'goal_final 已满足，停止。'
        : (mine.length > 0
          ? `下一步进入 Execute：${mine[0].id} [${mine[0].priority}] ${mine[0].action}`
          : '本会话没有持有的 open step：继续 Decide。');
      return ok(`已提交 ${applied.length} 项: ${applied.join(', ')}\n${tail}`);
    },
  }));

  /* ---- Execute ---- */

  register(makeTool({
    toolName: 'fgs_submit_fact',
    description: '为当前 open step 落一条新 Fact（蒸馏：title≤120 字，content 超 8KiB 必须是产物文件路径）。',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '一句话结论（≤120 字）。' },
        content: { type: 'string', description: '证据/细节；过长就写产物文件路径。' },
        stepId: { type: 'string', description: '可选，覆盖本轮 step（默认当前 open step）。' },
      },
      required: ['title'],
      additionalProperties: false,
    },
    run: (args, exec) => {
      const run = active(exec);
      refreshRole(run);
      if (run.role !== 'execute') {
        return fail('当前不是 Execute 轮（没有本会话持有的 open step）。先 Decide 开 step。');
      }
      const graph = run.store.load();
      const resolved = resolveRoundStep(run, graph, args.stepId);
      if (resolved.error) return fail(resolved.error);
      const step = resolved.step;
      const title = args.title ?? '';
      const content = args.content ?? '';
      try {
        run.controller.checkFactDistill(title, content);
      } catch (error) {
        if (error instanceof WriteRejected) return fail(`submit_fact 拒收: ${error.message}`);
        throw error;
      }
      run.execDraft = { title, content, stepId: step.id };
      run.draftNotice = null;
      return ok(`已记入本轮草稿: producedBy=${step.id}。结束时调用 fgs_commit_step 收束。`);
    },
  }));

  register(makeTool({
    toolName: 'fgs_commit_step',
    description: '收束本轮 open step：把草稿 Fact 或一条强制观察 Fact 写入图并落盘。',
    parameters: {
      type: 'object',
      properties: {
        stepId: { type: 'string', description: '可选，覆盖本轮 step。' },
      },
      required: [],
      additionalProperties: false,
    },
    run: (args, exec) => {
      const run = active(exec);
      refreshRole(run);
      const { round, limited } = observeRound(run, turnOf(ctx, exec?.agent));
      const graph = run.store.load();
      const resolved = resolveRoundStep(run, graph, args.stepId ?? run.execDraft?.stepId);
      if (resolved.error) return fail(resolved.error);
      const step = resolved.step;
      // CONTRACT §5：一轮只吃一个「先前回合留下的」open step。
      // 本回合刚刚打开的 step 允许在本回合收束，否则先收后开会把新 step 留成孤儿。
      const sameTurnOpen = openedThisRound(run, step.id, round, limited);
      if (limited && run.lastCommitRound === round && !sameTurnOpen) {
        return fail('一轮只吃一个 open step（CONTRACT §5）：本回合已经收束过 step 了。\n'
          + '⚠️ **继续在本回合硬推下一个 step 是记不进黑板的** —— 本回合后续所有 '
          + 'fgs_commit_step 都会被拒，你这一段的发现会全部丢失（实测过：多 flag 题的'
          + '第 2 个 flag 就是这样丢的）。\n'
          + '正确做法，二选一：\n'
          + '  a) 现在结束本回合：停止调用工具让本回合收口，下一回合再推进下一个 open step；\n'
          + '  b) 如果手里还有未落盘的发现，先用 fgs_submit_fact 把它写成草稿（草稿会跨回合保留），\n'
          + '     下一回合开头直接 fgs_commit_step 即可落盘。\n'
          + '本回合新开的 step 可以在本回合收束；上面这条拒绝只针对更早留下的 step。');
      }
      const draft = run.execDraft ?? {
        title: `${step.id} 无有效产出（观察）`,
        content: `step ${step.id} 结束前没有 fgs_submit_fact；按契约 §5 落一条显式观察 Fact。`,
        stepId: step.id,
      };
      const op = submitFactOp({
        title: draft.title,
        content: draft.content,
        producedBy: step.id,
        callerSession: run.sid,
      });
      try {
        const next = run.controller.apply(op, graph);
        run.controller.commit(next);
        run.execDraft = null;
        run.draftNotice = null;
        run.currentStepId = null;
        if (limited) run.lastCommitRound = round;
        syncProjectMeta(registryFor(exec?.agent, cfg, registries), run, next);
        refreshRole(run);
        const mine = stepsOwnedBy(next, run.sid);
        const others = openStepsOf(next).filter((s) => s.ownerSession !== run.sid);
        let tail;
        if (mine.length > 0) {
          tail = `本会话仍持有 ${mine.length} 个 open step；本回合到此为止，下一回合再推进 ${mine[0].id}。`;
        } else if (others.length > 0) {
          tail = `本会话的 open step 已清空，回到 Decide。板上另有 ${others.length} 个其他会话的 open step，不可绑定。`;
        } else {
          tail = 'open step 已清空，回到 Decide。';
        }
        return ok(`定稿: step ${step.id} → 新 Fact。\n${tail}`);
      } catch (error) {
        if (error instanceof WriteRejected) return fail(`commit_step 拒收: ${error.message}`);
        throw error;
      }
    },
  }));

  // 返回组合 disposer：插件卸载/HMR 时把全部图工具一起撤掉
  return () => {
    for (const dispose of disposers.reverse()) {
      try {
        dispose?.();
      } catch {
        /* 已失效 */
      }
    }
  };
}

/**
 * 草稿 op：先过 hooks/validate_write 的结构预检，给出即时拒收回执。
 *
 * 只做单 op 结构检查（缺字段 / 空 reason / 空 from 当场拒），
 * 跨 op 的引用与整图一致性留到 fgs_commit 一次性校验，
 * 这样 batch commit 里后一项引用前一项产出的 step 才合法。
 */
function stageDecideOp(run, op) {
  try {
    preflight(op);
  } catch (error) {
    if (error instanceof WriteRejected) return fail(`拒收（不会进草稿）: ${error.message}`);
    throw error;
  }
  run.decideDraft.push(op);
  return ok(`已记入草稿 #${run.decideDraft.length}: ${op.type}。全部写完后调用 fgs_commit 提交。`);
}

function pickStep(run, graph, stepId) {
  const owned = stepsOwnedBy(graph, run.sid);
  if (stepId) {
    const target = (graph.steps ?? []).find((s) => s.id === stepId);
    if (target && target.ownerSession && target.ownerSession !== run.sid) {
      return {
        error: `拒收：step ${stepId} 由会话 ${target.ownerSession} 持有，本会话不得绑定（跨会话错位）。`,
      };
    }
  }
  // 本轮 step 一旦确定就不许换：显式 stepId 与当前 step 不一致 → 返回错误而不是静默替换
  if (run.currentStepId) {
    const current = owned.find((s) => s.id === run.currentStepId);
    if (current) {
      if (stepId && stepId !== current.id) {
        return {
          error: `stepId=${stepId} 不是本轮的 open step（本轮是 ${current.id}）。`
            + ' 一轮只吃一个 open step（CONTRACT §5）；要换 step 请结束本回合。',
        };
      }
      return { step: current };
    }
  }
  if (stepId) {
    const found = owned.find((s) => s.id === stepId);
    if (!found) return { error: `step ${stepId} 不是 open step，无法收束。` };
    return { step: found };
  }
  const first = owned[0] ?? null;
  if (first) return { step: first };
  const foreign = openStepsOf(graph).filter((s) => s.ownerSession && s.ownerSession !== run.sid);
  if (foreign.length > 0) {
    return {
      error: `没有本会话持有的 open step（${foreign.map((s) => `${s.id}@${s.ownerSession}`).join(', ')} 属于其他会话，拒绝跨会话绑定）。`,
    };
  }
  return { error: '没有可收束的 open step。' };
}

function resolveRoundStep(run, graph, stepId) {
  const result = pickStep(run, graph, stepId);
  if (result.error) return result;
  run.currentStepId = result.step.id;
  return result;
}

/**
 * CONTRACT §5：Execute 回合结束前必须有一条新 Fact。
 * 模型没调 fgs_commit_step 时，在回合收口处补一条显式观察 Fact。
 * 失败只记账不抛：收束失败绝不能阻断回合结束。
 */
function forceCloseStep(run, turn, registry) {
  const graph = refreshRole(run);
  const { round, limited } = observeRound(run, turn);
  if (run.role !== 'execute') return false;
  if (limited && run.lastCommitRound === round) return false; // 本回合已收束过
  const resolved = pickStep(run, graph, run.execDraft?.stepId ?? run.currentStepId);
  if (resolved.error || !resolved.step) return false;
  const step = resolved.step;
  // 本轮刚由 Decide 打开的 step 还没轮到 Execute，回合收口不得把它吞成观察 Fact。
  // （否则「先规划、下一回合再执行」的正常用法下，第一个 step 会被立刻消费掉。）
  if (limited && run.stepsOpenedRound === round
    && run.stepsOpenedIds instanceof Set && run.stepsOpenedIds.has(step.id)) {
    return false;
  }
  const draft = run.execDraft ?? {
    title: `${step.id} 无有效产出（观察）`,
    content: `回合结束前没有 fgs_submit_fact；按契约 §5 强制落一条显式观察 Fact。`,
    stepId: step.id,
  };
  const next = run.controller.apply(
    submitFactOp({
      title: draft.title,
      content: draft.content,
      producedBy: step.id,
      callerSession: run.sid,
    }),
    graph,
  );
  run.controller.commit(next);
  run.execDraft = null;
  run.currentStepId = null;
  if (limited) run.lastCommitRound = round;
  syncProjectMeta(registry, run, next);
  refreshRole(run);
  return true;
}

function opsFromJson(item) {
  const kind = item?.op ?? item?.type;
  switch (kind) {
    case 'open_step':
      return openStepOp({
        action: item.action ?? '',
        from: item.from ?? [],
        actor: item.actor || 'agent',
        priority: item.priority || 'normal',
        stepId: item.stepId || null,
      });
    case 'drop_step':
      return dropStepOp({ stepId: item.stepId, reason: item.reason });
    case 'change_step_priority':
      return changePriorityOp({ stepId: item.stepId, priority: item.priority, reason: item.reason || null });
    case 'satisfy_goal':
      return satisfyGoalOp({ goalId: item.goalId, reason: item.reason, satisfiedBy: item.satisfiedBy });
    case 'reopen':
      return reopenOp({ goalId: item.goalId, reason: item.reason, feedbackTitle: item.feedbackTitle || null });
    default:
      throw new Error(`未知 op: ${item?.op ?? item?.type}`);
  }
}

/* ------------------------------------------------------------------ apply */

export function apply(ctx, config = {}) {
  const cfg = normalizeConfig(config);
  const runs = new Map();
  const registries = new Map();
  // /fgs off 打上的「本会话不再自动认领」标记（key 同 runs：(sessionId, problemId)）。
  // 没有它的话，auto-attach 会在 off 之后立刻把 run 又建回来。
  const detached = new Set();

  // 所有注册的 disposer 都收在这里，插件卸载/HMR 时统一撤销。
  // 实测：不交给 ctx.effect 持有的注册会在插件移除后继续生效
  // （旧 HTTP 路由继续响应、旧 context 继续注入、旧监听继续收紧新会话）。
  const owned = [];
  const hold = (disposer) => {
    if (typeof disposer === 'function') owned.push(disposer);
    return disposer;
  };
  const ioSpecs = { decide: loadIoSchema('decide'), execute: loadIoSchema('execute') };
  const ioSchemaFor = (role) => ioSpecs[role] ?? null;

  hold(registerTools(ctx, cfg, runs, registries, detached));

  const activeRun = (agent) => attachRun(agent, cfg, runs, registries, detached);

  // 角色隔离硬门：顺序无关、单调，任何越权调用都在 dispatch 层被拒。
  // 没有活动 Project 时，改图工具（含 fgs_seed）一律拒；只放只读 fgs_status。
  hold(ctx.tools.guard((exec) => {
    const tool = exec?.name;
    // 控制面：建题 / 换题 / 列题。没有活动 Project 时正是要用它，所以任何状态都放行。
    if (PROJECT_TOOLS.includes(tool)) return undefined;
    const { problemId, run, reason } = activeRun(exec?.agent);
    if (run) {
      try {
        refreshRole(run);
      } catch {
        // 图读不出来时按 Decide 失败关闭：环境工具不放行，避免缓存角色把禁令绕开。
        run.role = 'decide';
        run.derivedRole = 'decide';
        run.graphSeeded = true;
        run.currentStepId = null;
      }
    }
    const role = run?.role;
    if (GRAPH_TOOL_NAMES.includes(tool)) {
      if (!problemId) {
        return tool === 'fgs_status'
          ? undefined
          : 'FGS 未启动：没有活动 Project。先 fgs_project action=new problemId=<id>（或 /fgs new <id>）。';
      }
      if (!run) {
        if (CONTROL_TOOLS.includes(tool)) return undefined;
        return reason === 'detached'
          ? 'FGS 已 /fgs off（本会话退出了 FGS）。重新进入用 fgs_project action=switch problemId=<id>。'
          : 'FGS 未启动：先 fgs_seed（或 /fgs init <brief>）种题，再使用图工具。';
      }
      if (!(ROLE_TOOLS[role] ?? []).includes(tool)) {
        return role === 'execute'
          ? `FGS 角色隔离：当前 Execute 轮不得调用 ${tool}（CONTRACT §5）。`
            + ' 本轮请用 fgs_submit_fact 落 Fact，再用 fgs_commit_step 收束。'
          : `FGS 角色隔离：当前 Decide 轮不得调用 ${tool}（CONTRACT §4）。`
            + ' 规划请用 fgs_open_step / fgs_drop_step / fgs_change_step_priority'
            + ' / fgs_satisfy_goal / fgs_reopen，再 fgs_commit；查看用 fgs_preview。';
      }
      return undefined;
    }
    // CONTRACT §4：Decide 只做规划/改图。白名单之外的工具一律拒
    //（含 bash/文件/网络/subagent/workflow —— 它们能间接执行环境动作）。
    // 空图（未种题 / 图被删）不算 Decide 会话，避免把「未启动」误伤成环境工具禁令。
    if (run && role === 'decide' && run.graphSeeded) {
      if (cfg.deniedEnvTools.includes(tool)) {
        return `FGS Decide 会话禁止环境执行工具 ${tool}（CONTRACT §4）：`
          + ' Decide 只做规划/改图；需要执行时先 fgs_open_step + fgs_commit 打开 step，'
          + '进 Execute 轮后才允许环境工具。';
      }
      if (!decideAllows(cfg, tool)) {
        return `FGS Decide 会话禁止调用 ${tool}（CONTRACT §4：Decide 只做规划/改图，`
          + '禁止 bash/文件/网络/委派等一切环境工具）。'
          + ' 需要在环境里动作时，先 fgs_open_step + fgs_commit 打开 step，进 Execute 轮再执行。';
      }
    }
    return undefined;
  }));

  // CONTRACT §5：Execute 回合收口前必须收束成一条新 Fact（无产出也要观察 Fact）
  hold(ctx.on('agent/turn-stopping', (payload) => {
    try {
      const agent = payload?.agent ?? payload;
      if (!agent) return;
      const { registry, run } = activeRun(agent);
      if (!run) return;
      forceCloseStep(run, turnOf(ctx, agent), registry);
      sweepStaleDraft(run, run.store.load());
    } catch {
      /* 收束失败不得阻断回合结束 */
    }
  }));

  // ---- §5 兜底：进程被信号中断时也强制 CONCLUDE --------------------------------
  //
  // 为什么必须有这段：上面那个收口钩子挂在 `agent/turn-stopping` 上，**只有回合正常结束
  // 才触发**。而 supervisor 超时是**在回合中途**发 SIGTERM —— 该事件永远不会到，
  // 于是"回合收口前必须有一条新 Fact"恰好在最需要它的时候失效。
  // 实测代价：一道复杂题跑了 23 分钟，黑板停在 `step: open`、0 条 fact，
  // 真正拿到的 1/2 flag 只留在平台侧；而 §5 的本意正是要避免这件事。
  //
  // 语义与 Cairn 黑板一致：**没有在指定时间内到达 Goal，也要写下结论 Fact。**
  // 这是兜底；主力是 supervisor 的超时收束回合（那个能拿到模型的完整上下文，
  // 因此能写下真正有信息量的 Fact，而不是这里的中断记录）。
  const flushOnSignal = (sig) => {
    let n = 0;
    for (const run of runs.values()) {
      try {
        if (!run) continue;
        try {
          refreshRole(run);
        } catch {
          continue;
        }
        if (run.role !== 'execute') continue;
        if (!run.currentStepId && !run.execDraft) continue;
        if (!run.execDraft) {
          // 没有草稿时**不要**假装"无有效产出"（那会误导：本轮可能已经拿到 flag）。
          // 落一条诚实的中断记录，把真相指向平台侧。
          run.execDraft = {
            title: `${run.currentStepId ?? 'step'} 被 ${sig} 中断（信号兜底收束）`,
            content: `进程收到 ${sig} 即将退出，本 step 未经模型收束。`
              + '为不让黑板留空，此处落一条显式记录；本轮真实进展以平台侧进度为准。',
            stepId: run.currentStepId,
          };
        }
        // turn 传 undefined → observeRound 返回 limited:false，跳过"一轮一步"守卫；
        // registry 传 null → syncProjectMeta 开头会直接 return，不会 NPE。
        if (forceCloseStep(run, undefined, null)) n += 1;
      } catch {
        /* 单个 Project 失败不影响其它 */
      }
    }
    if (n > 0) {
      try {
        process.stderr.write(`[fgs] ${sig}：已强制收束 ${n} 个未落盘的 step\n`);
      } catch { /* ignore */ }
    }
  };
  for (const sig of ['SIGTERM', 'SIGINT']) {
    const handler = () => {
      flushOnSignal(sig);
      // ⚠️ 注册信号监听会**取消 Node 的默认退出行为**（进程会变成"杀不死"）。
      // 若我们是唯一监听者，就摘掉自己重新触发一次信号，恢复默认语义；
      // 若宿主（DSH）自己也有监听者，说明退出由它负责，交还给它。
      try {
        if (process.listenerCount(sig) === 1) {
          process.removeListener(sig, handler);
          process.kill(process.pid, sig);
        }
      } catch { /* ignore */ }
    };
    try {
      process.on(sig, handler);
      hold(() => {
        try { process.removeListener(sig, handler); } catch { /* ignore */ }
      });
    } catch {
      /* 环境不支持信号时跳过（不能因此让插件挂载失败） */
    }
  }

  // 运行时上下文：每步注入最新图投影 + 角色规则（CONTRACT §9）
  ctx.inject(['systemPrompt'], (scoped) => {
    const sp = scoped?.systemPrompt ?? scoped;
    if (!sp?.section) return;
    hold(sp.section({ name: 'fgs-rules', order: 62, text: FGS_RULES }));
    hold(sp.context({
      name: 'fgs-graph',
      order: 62,
      text: (assembly) => {
        // 严格按 assembly 的 scope 找本会话的 run：找不到就什么都不注入。
        // 绝不回退到「最近一个 run」——那会把 A 会话的黑板塞进 B 会话的上下文。
        const scope = assembly?.scope;
        if (!scope || typeof scope !== 'object') return '';
        const sid = sessionIdOf(scope);
        if (!sid || sid === 'unknown') return '';
        // 只注入本会话 × 活动 Project 的 run，不回退到别的题或别的会话。
        const { run } = activeRun(scope);
        if (!run || run.sid !== sid) return '';
        try {
          const graph = refreshRole(run);
          const current = (graph.steps ?? []).find((s) => s.id === run.currentStepId && s.state === 'open') ?? null;
          return roleContextText({
            role: run.role,
            store: run.store,
            graph,
            currentStep: current,
            draftSummary: draftSummary(run),
            draftNotice: run.draftNotice || '',
            sessionId: run.sid,
            ioSpec: ioSchemaFor(run.role),
          });
        } catch (error) {
          return `【FGS 图读取失败】${error?.message ?? error}`;
        }
      },
    }));
  });

  // 人类命令入口
  ctx.inject(['commands'], (scoped) => {
    const commands = scoped?.commands ?? scoped;
    if (!commands?.register) return;
    // 与 fgs_project 工具共用同一套实现（projectNew），避免命令/工具两套语义漂移。
    const handleNew = (agent, rawId, brief) => {
      const result = projectNew(agent, cfg, runs, registries, detached, rawId, brief);
      return { kind: result.ok ? 'success' : 'error', text: result.text };
    };

    hold(commands.register({
      name: 'fgs',
      description: 'FGS 黑板：new <problemId> [brief] | switch <problemId> | list | init <brief> | status | graph | path | reopen <reason> | off',
      input: { hint: 'new <problemId> [brief] | switch <problemId> | list | init <brief> | status | graph | path | reopen <reason> | off' },
      handler: (invocation) => {
        const raw = String(invocation?.rawInput ?? '').trim();
        const [sub, ...rest] = raw.split(/\s+/);
        const restText = rest.join(' ').trim();
        const agent = invocation?.agent;
        // 命令路径同样走「认领」：磁盘已种题的 Project 不该被报成「未启动」。
        const { run } = attachRun(agent, cfg, runs, registries, detached);
        switch (sub) {
          case 'new': {
            const rawId = rest[0];
            const brief = rest.slice(1).join(' ').trim();
            if (!rawId) return { kind: 'error', text: '用法: /fgs new <problemId> [brief]' };
            return handleNew(agent, rawId, brief);
          }
          case 'switch': {
            const rawId = rest[0];
            if (!rawId) return { kind: 'error', text: '用法: /fgs switch <problemId>' };
            const result = projectSwitch(agent, cfg, runs, registries, detached, rawId);
            return { kind: result.ok ? 'success' : 'error', text: result.text };
          }
          case 'list': {
            const result = projectList(agent, cfg, runs, registries);
            return { kind: result.ok ? 'success' : 'error', text: result.text };
          }
          case 'init': {
            if (!restText) return { kind: 'error', text: '用法: /fgs init <题目 brief>' };
            return handleNew(agent, 'default', restText);
          }
          case 'status': {
            if (!run) return { kind: 'success', text: 'FGS 未启动。' };
            const snap = graphSnapshot(run);
            return {
              kind: 'success',
              text: `Project ${snap.problemId} | 角色 ${snap.role} | facts=${snap.counts.facts} steps=${snap.counts.steps} open=${snap.counts.open} | satisfied=${snap.satisfied}`,
            };
          }
          case 'graph': {
            if (!run) return { kind: 'error', text: 'FGS 未启动。' };
            return { kind: 'success', text: run.store.preview(run.store.load()) };
          }
          case 'path': {
            if (!run) return { kind: 'error', text: 'FGS 未启动。' };
            return { kind: 'success', text: path.join(run.root, 'graph.yaml') };
          }
          case 'reopen': {
            if (!run) return { kind: 'error', text: 'FGS 未启动。' };
            if (!restText) return { kind: 'error', text: '用法: /fgs reopen <打回原因>' };
            try {
              const graph = run.store.load();
              const next = run.controller.apply(reopenOp({ goalId: 'goal_final', reason: restText }), graph);
              run.controller.commit(next);
              syncProjectMeta(registryFor(agent, cfg, registries), run, next);
            } catch (error) {
              return { kind: 'error', text: `reopen 失败: ${error.message}` };
            }
            refreshRole(run);
            return { kind: 'success', text: '已打回：satisfied* 已清空，feedback Fact 已追加。' };
          }
          case 'off': {
            if (!run) return { kind: 'success', text: 'FGS 本就未启动。' };
            runs.delete(runKey(run.sid, run.problemId));
            // 关键：记下 detached，否则 auto-attach 会在下一句就把 run 建回来。
            detached.add(runKey(run.sid, run.problemId));
            return {
              kind: 'success',
              text: '已退出 FGS（本会话不再自动认领）；Project 与图文件保留在磁盘。'
                + ` 重新进入用 /fgs switch ${run.problemId}。`,
            };
          }
          default:
            return {
              kind: 'error',
              text: '子命令: new <problemId> [brief] | switch <problemId> | list | init <brief> | status | graph | path | reopen <reason> | off'
                + '（同能力的工具：fgs_project action=new|switch|list）',
            };
        }
      },
    }));
  });

  // 只读 HTTP 快照：给 Web 端黑板面板用
  ctx.inject(['webServer'], (scoped) => {
    if (!cfg.exposeHttpState) return;
    const server = scoped?.webServer ?? scoped;
    if (!server?.register) return;
    try {
      hold(server.register({
        kind: 'exact',
        path: cfg.httpPath,
        handler: (req, res) => {
          let body;
          try {
            // ?problemId= 看指定题；?sessionId= 看该会话的活动题；都没有则回退活动 Project
            // （没有活动 run 时再退到最近一个 run，方便 curl）。
            let sid = null;
            let problemParam = null;
            try {
              const params = new URL(req?.url ?? '/', 'http://localhost').searchParams;
              sid = params.get('sessionId');
              problemParam = params.get('problemId');
            } catch {
              sid = null;
              problemParam = null;
            }
            body = JSON.stringify(resolveHttpSnapshot({
              runs, registries, cfg, sessionId: sid, problemId: problemParam,
            }));
          } catch (error) {
            body = JSON.stringify({ active: false, error: String(error?.message ?? error) });
          }
          res.statusCode = 200;
          res.setHeader('content-type', 'application/json; charset=utf-8');
          res.setHeader('cache-control', 'no-store');
          res.end(body);
        },
      }));
    } catch {
      /* 路由已被占用或不可注册：面板降级显示 */
    }
  });

  // 插件卸载/HMR：撤销本插件登记的一切资源（工具、guard、prompt、命令、HTTP 路由）
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      for (const dispose of owned) {
        try {
          dispose();
        } catch {
          /* 已失效 */
        }
      }
    });
  }
}
