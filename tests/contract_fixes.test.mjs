/**
 * 对抗性审计发现项的回归测试（每一条都对应一个真实被证伪过的契约点）。
 *
 * 这些用例是「审计用哪招打进来，就用哪招锁回去」。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { apply as applyPlugin } from '../index.js';
import { Controller, GraphStore } from '../controller/index.js';
import { seedOriginOp, submitFactOp } from '../controller/ops.js';
import { preflight, preflightStats } from '../hooks/validate_write.js';
import { dropStepOp } from '../controller/ops.js';
import {
  callRoute,
  ensureActiveProject,
  makeFakeAgent,
  makeFakeHost,
  projectGraphPath,
  projectJsonPath,
  tmpDir,
  wireServices,
} from './helpers.mjs';

function boot(overrides = {}) {
  const host = makeFakeHost();
  const services = wireServices(host);
  for (const name of ['bash', 'read', 'web_fetch', 'web_search', 'subagent', 'workflow', 'todo_write', 'skill']) {
    host.ctx.tools.register({
      name,
      description: `fake ${name}`,
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: { schema: { type: 'object' }, render: () => [] },
      async execute() {
        return { ok: true, text: `${name} RAN` };
      },
    });
  }
  host.ctx.services = { ...host.ctx.services, ...services };
  applyPlugin(host.ctx, { stateDir: '.fgs', ...overrides });
  const cwd = tmpDir();
  const agent = makeFakeAgent('sess-audit', cwd);
  host.emit('agent/created', { agent });
  return { host, agent, cwd, services };
}

async function seed(host, agent) {
  const created = ensureActiveProject(host, agent);
  assert.equal(created.kind, 'success', JSON.stringify(created));
  const result = await host.callTool('fgs_seed', { brief: '{"target":"http://x"}' }, agent);
  assert.equal(result.ok, true, result.text);
}

/* ------------------------------------------------------- §4 Decide 白名单 */

test('§4：Decide 轮白名单生效——web/subagent/workflow 也一律被拒（不只是 bash）', async () => {
  const { host, agent } = boot();
  await seed(host, agent);
  for (const name of ['bash', 'read', 'web_fetch', 'web_search', 'subagent', 'workflow']) {
    const result = await host.callTool(name, {}, agent);
    assert.equal(result.ok, false, `${name} 在 Decide 轮必须被拒`);
    assert.match(result.text, /CONTRACT §4/);
  }
  // 白名单里的只读/元工具仍然可用
  for (const name of ['todo_write', 'skill']) {
    const result = await host.callTool(name, {}, agent);
    assert.equal(result.ok, true, `${name} 应仍在 Decide 白名单里`);
  }
});

test('§4：进入 Execute 轮后环境工具恢复（白名单只在 Decide 生效）', async () => {
  const { host, agent } = boot();
  await seed(host, agent);
  await host.callTool('fgs_commit', {
    operations: [{ op: 'open_step', action: 'a', from: ['fact_origin'] }],
  }, agent);
  const bash = await host.callTool('bash', {}, agent);
  assert.equal(bash.ok, true);
  const read = await host.callTool('read', {}, agent);
  assert.equal(read.ok, true);
});

test('§4：decideAllowTools 可配置扩展白名单', async () => {
  const { host, agent } = boot({ decideAllowTools: ['web_search'] });
  await seed(host, agent);
  const allowed = await host.callTool('web_search', {}, agent);
  assert.equal(allowed.ok, true);
  const stillDenied = await host.callTool('web_fetch', {}, agent);
  assert.equal(stillDenied.ok, false);
});

/* ------------------------------------------------ §5 回合语义（强制收束） */

test('§5：一轮只吃一个 open step——同回合第二次 commit_step 被拒', async () => {
  const { host, agent } = boot();
  await seed(host, agent);
  await host.callTool('fgs_commit', {
    operations: [
      { op: 'open_step', action: '第一步', from: ['fact_origin'] },
      { op: 'open_step', action: '第二步', from: ['fact_origin'] },
    ],
  }, agent);
  host.ctx.setTurn(7);

  assert.equal((await host.callTool('fgs_submit_fact', { title: 'a', content: 'c' }, agent)).ok, true);
  assert.equal((await host.callTool('fgs_commit_step', {}, agent)).ok, true);
  const second = await host.callTool('fgs_commit_step', {}, agent);
  assert.equal(second.ok, false);
  assert.match(second.text, /一轮只吃一个 open step/);

  // 新回合 → 可以继续
  host.ctx.setTurn(8);
  const nextTurn = await host.callTool('fgs_submit_fact', { title: 'b', content: 'c' }, agent);
  assert.equal(nextTurn.ok, true, nextTurn.text);
  assert.equal((await host.callTool('fgs_commit_step', {}, agent)).ok, true);
});

test('§5：回合收口时没调用 commit_step，也会强制落一条观察 Fact', async () => {
  const { host, agent, cwd } = boot();
  await seed(host, agent);
  await host.callTool('fgs_commit', {
    operations: [{ op: 'open_step', action: '探路', from: ['fact_origin'] }],
  }, agent);
  host.ctx.setTurn(3);
  await host.callTool('fgs_submit_fact', { title: '半成品草稿', content: '还没定稿' }, agent);

  // 模型直接结束回合（没有 commit_step）
  host.emit('agent/turn-stopping', { agent, turn: 3 });

  const graph = fs.readFileSync(projectGraphPath(cwd), 'utf8');
  assert.match(graph, /半成品草稿/, '草稿里的内容应被强制收束，而不是丢掉');
  assert.doesNotMatch(graph, /state: "open"/, 'step 必须被收束');

  // 同一回合再触发一次不会重复写
  const before = fs.readFileSync(projectGraphPath(cwd), 'utf8');
  host.emit('agent/turn-stopping', { agent, turn: 3 });
  assert.equal(fs.readFileSync(projectGraphPath(cwd), 'utf8'), before);
});

test('§5：完全没有 submit_fact 时，回合收口强制写观察 Fact', async () => {
  const { host, agent, cwd } = boot();
  await seed(host, agent);
  await host.callTool('fgs_commit', {
    operations: [{ op: 'open_step', action: '探路', from: ['fact_origin'] }],
  }, agent);
  host.ctx.setTurn(11);
  host.emit('agent/turn-stopping', { agent, turn: 11 });
  assert.match(fs.readFileSync(projectGraphPath(cwd), 'utf8'), /观察/);
});

test('§5：显式 stepId 换 step 会被拒，不再静默改到别的 step', async () => {
  const { host, agent } = boot();
  await seed(host, agent);
  await host.callTool('fgs_commit', {
    operations: [
      { op: 'open_step', action: '第一步', from: ['fact_origin'] },
      { op: 'open_step', action: '第二步', from: ['fact_origin'] },
    ],
  }, agent);
  const first = await host.callTool('fgs_submit_fact', { title: 't', content: 'c' }, agent);
  assert.equal(first.ok, true, first.text);
  assert.match(first.text, /producedBy=step_001/);
  const retarget = await host.callTool('fgs_submit_fact', { title: 't2', content: 'c2', stepId: 'step_999' }, agent);
  assert.equal(retarget.ok, false);
  assert.match(retarget.text, /不是本轮的 open step/);
  const other = await host.callTool('fgs_submit_fact', { title: 't3', content: 'c3', stepId: 'step_002' }, agent);
  assert.equal(other.ok, false);
  assert.match(other.text, /不是本轮的 open step/);
});

/* ------------------------------------------------------------- §7 蒸馏门 */

test('§7：超阈值 content 必须是「单个路径」，路径+大段正文 / 无空白长串都拒', () => {
  const store = new GraphStore(tmpDir(), { factContentMaxBytes: 100 });
  const ctl = new Controller(store, { verifyHook: null });
  ctl.commit(ctl.apply(seedOriginOp({ title: '题目信息:', content: '{"target":"http://x"}' })));
  ctl.commit(ctl.apply({
    type: 'open_step',
    action: '取产物',
    from: ['fact_origin'],
    actor: 'agent',
    priority: 'normal',
    stepId: null,
  }));

  const auditProbe = `${'中'.repeat(4094)}/`; // 审计用过的绕过串
  assert.throws(
    () => ctl.apply(submitFactOp({ title: 't', content: auditProbe, producedBy: 'step_001' })),
    /不是单个文件路径/,
  );
  assert.throws(
    () => ctl.apply(submitFactOp({
      title: 't',
      content: `/workspace/out.txt ${'中'.repeat(4000)}`,
      producedBy: 'step_001',
    })),
    /不是单个文件路径/,
  );
  // 真·路径放行
  const okGraph = ctl.apply(submitFactOp({
    title: 't',
    content: 'workspace/artifacts/nmap_full.txt',
    producedBy: 'step_001',
  }));
  assert.equal(okGraph.facts[1].content, 'workspace/artifacts/nmap_full.txt');
});

/* ----------------------------------------------------- §1/§2 ID 与 Goal */

test('§2：validate 拒绝非 goal_final 的 goal、kind=sub、以及非法 step id', () => {
  const store = new GraphStore(tmpDir());
  store.ensureDir();
  fs.writeFileSync(store.graphPath, [
    'facts:',
    '- id: "fact_origin"',
    '  title: "题目信息:"',
    '  createdAt: "2026-01-01T00:00:00.000Z"',
    'goals:',
    '- id: "goal_final"',
    '  kind: "final"',
    '  criterion: "c"',
    '  createdAt: "2026-01-01T00:00:00.000Z"',
    '- id: "goal_sub"',
    '  kind: "sub"',
    '  criterion: "c"',
    '  createdAt: "2026-01-01T00:00:00.000Z"',
    'steps:',
    '- id: "step_abc"',
    '  action: "a"',
    '  from: ["fact_origin"]',
    '  actor: "agent"',
    '  priority: "normal"',
    '  state: "open"',
    '  createdAt: "2026-01-01T00:00:00.000Z"',
    '',
  ].join('\n'), 'utf8');
  const errs = store.validate(store.load());
  assert.ok(errs.some((e) => /goal id 非法/.test(e)), `应拒 goal_sub: ${errs.join(' | ')}`);
  assert.ok(errs.some((e) => /step id 非法/.test(e)), `应拒 step_abc: ${errs.join(' | ')}`);
  assert.throws(() => store.save(store.load()), /拒写/);
});

/* --------------------------------------------------------- §3 预检真的跑 */

test('§3：Controller.apply 确实调用了 hooks/validate_write.preflight', () => {
  const store = new GraphStore(tmpDir());
  const ctl = new Controller(store, { verifyHook: null });
  ctl.commit(ctl.apply(seedOriginOp({ title: '题目信息:', content: '{"target":"http://x"}' })));
  const before = preflightStats.calls;
  assert.throws(() => ctl.apply(dropStepOp({ stepId: 'step_001', reason: '' })), /reason/);
  assert.ok(preflightStats.calls > before, 'preflight 必须被调用（计数器证明路径）');
  // 直接调 preflight 也拒
  assert.throws(() => preflight(dropStepOp({ stepId: 'step_001', reason: '  ' })), /reason/);
});

/* ------------------------------------------------- §9 io-specs 真的进上下文 */

test('§9：io-specs/<role>.io.yaml 的内容真的被注入运行时上下文', async () => {
  const { host, agent } = boot();
  await seed(host, agent);
  const provider = host.contexts[0].text;
  const decideText = provider({ scope: agent });
  assert.match(decideText, /I\/O 预制规范/);
  assert.match(decideText, /io-specs\/decide\.io\.yaml/);
  assert.match(decideText, /fgs_commit/);

  await host.callTool('fgs_commit', {
    operations: [{ op: 'open_step', action: 'a', from: ['fact_origin'] }],
  }, agent);
  const executeText = provider({ scope: agent });
  assert.match(executeText, /io-specs\/execute\.io\.yaml/);
  assert.match(executeText, /一轮只吃一个 open step/);
});

test('§9：工具出参按 maxResultChars 截断（噪声不进模型）', async () => {
  const { host, agent } = boot({ maxResultChars: 120 });
  await seed(host, agent);
  const preview = await host.callTool('fgs_preview', {}, agent);
  assert.equal(preview.ok, true);
  assert.match(preview.content[0].text, /truncated/);
});

/* ------------------------------------------------------ §9 跨会话不泄漏 */

test('§9：/fgs/state 按 sessionId 取图，不会把别的会话黑板给当前面板', async () => {
  const { host, agent } = boot();
  const other = makeFakeAgent('sess-other', tmpDir());
  await seed(host, agent);
  const mine = await callRoute(host.routes[0], '/fgs/state?sessionId=sess-audit');
  assert.equal(mine.json.active, true);
  assert.equal(mine.json.sessionId, 'sess-audit');
  const theirs = await callRoute(host.routes[0], '/fgs/state?sessionId=sess-other');
  assert.equal(theirs.json.active, false, '别的会话不得看到本会话的黑板');
  // 不带 sessionId 时保留 lastRun 回退（curl/运维方便）
  const fallback = await callRoute(host.routes[0], '/fgs/state');
  assert.equal(fallback.json.active, true);
});

/* ---------------------------------------------- §5 刚打开的 step 不被吞 */

test('§5：本轮刚打开的 step 不会在回合收口被吞成观察 Fact（live E2E 实测缺陷）', async () => {
  const { host, agent, cwd } = boot();
  await seed(host, agent);
  host.ctx.setTurn(5);
  await host.callTool('fgs_commit', {
    operations: [{ op: 'open_step', action: '还没轮到执行的第一步', from: ['fact_origin'] }],
  }, agent);

  // 同一回合收口：不得写任何 Fact，step 必须保持 open 留给下一回合
  host.emit('agent/turn-stopping', { agent, turn: 5 });
  const graphPath = projectGraphPath(cwd);
  let graph = fs.readFileSync(graphPath, 'utf8');
  assert.match(graph, /state: "open"/, '刚打开的 step 必须留给下一回合，不能被吞掉');
  assert.doesNotMatch(graph, /观察/, '不得为「刚打开、还没执行」的 step 写观察 Fact');
  assert.doesNotMatch(graph, /无有效产出/);

  // 下一回合它仍然可以被正常推进并收束
  host.ctx.setTurn(6);
  assert.equal((await host.callTool('fgs_submit_fact', { title: 't', content: 'c' }, agent)).ok, true);
  assert.equal((await host.callTool('fgs_commit_step', {}, agent)).ok, true);
  graph = fs.readFileSync(graphPath, 'utf8');
  assert.match(graph, /state: "done"/);
  assert.match(graph, /title: "t"/);
});

test('§5：跨回合后仍然会为「没人做」的旧 step 补观察 Fact（修复不得关掉这条硬规则）', async () => {
  const { host, agent, cwd } = boot();
  await seed(host, agent);
  host.ctx.setTurn(5);
  await host.callTool('fgs_commit', {
    operations: [{ op: 'open_step', action: '探路', from: ['fact_origin'] }],
  }, agent);

  // 回合 5 放过它（刚打开），回合 6 结束还没人做 → 必须补观察 Fact
  host.emit('agent/turn-stopping', { agent, turn: 5 });
  host.ctx.setTurn(6);
  host.emit('agent/turn-stopping', { agent, turn: 6 });
  const graph = fs.readFileSync(projectGraphPath(cwd), 'utf8');
  assert.match(graph, /无有效产出（观察）/);
  assert.doesNotMatch(graph, /state: "open"/);
});

/* ------------------------------------- §9 面板快照：空图与角色一致性 */

test('§9：图文件被移除后快照报 active:false，不再渲染成 execute + 0/0/0', async () => {
  const { host, agent, cwd } = boot();
  await seed(host, agent);
  await host.callTool('fgs_commit', {
    operations: [{ op: 'open_step', action: 'x', from: ['fact_origin'] }],
  }, agent);
  const before = await callRoute(host.routes[0], '/fgs/state?sessionId=sess-audit');
  assert.equal(before.json.active, true);
  assert.equal(before.json.role, 'execute');
  assert.ok(before.json.buildTag, '快照必须带 buildTag，重启后一眼确认代码生效');

  // 绕过插件删掉图文件（本轮 live 实测就是这一步让面板陷入矛盾状态）
  fs.rmSync(projectGraphPath(cwd), { force: true });
  fs.rmSync(projectJsonPath(cwd), { force: true });

  const after = await callRoute(host.routes[0], '/fgs/state?sessionId=sess-audit');
  assert.equal(after.json.active, false, '空图必须按「未启动」上报，而不是 execute + 0/0/0');
  assert.equal(after.json.counts, undefined);
  assert.equal(after.json.role, undefined);

  const status = await host.callTool('fgs_status', {}, agent);
  assert.match(status.text, /未启动/);
  assert.doesNotMatch(status.text, /Execute/);
});

test('§9：快照角色从图推导，不报内存缓存值', async () => {
  const { host, agent, cwd } = boot();
  await seed(host, agent);
  await host.callTool('fgs_commit', {
    operations: [{ op: 'open_step', action: 'x', from: ['fact_origin'] }],
  }, agent);
  // 绕过插件直接改图：把唯一的 open step 标成 done（模拟图被外部改动）
  const graphPath = projectGraphPath(cwd);
  fs.writeFileSync(
    graphPath,
    fs.readFileSync(graphPath, 'utf8').replace('state: "open"', 'state: "done"'),
  );
  const res = await callRoute(host.routes[0], '/fgs/state?sessionId=sess-audit');
  assert.equal(res.json.counts.open, 0);
  assert.equal(res.json.role, 'decide', '角色必须跟着图走，不能停在缓存里的 execute');
});

/* ==========================================================================
 * 超时场景的回归：真实跑分里唯一真正丢过数据的路径
 *
 * 背景（实测）：一道多 flag 题跑了 23 分钟，黑板停在 `state: open`、0 条 fact，
 * 真正拿到的 1/2 flag 只留在平台侧。根因不是模型"忘了"，而是 §5 的收口钩子
 * 挂在 `agent/turn-stopping` 上 —— 而 supervisor 超时是**在回合中途**发 SIGTERM，
 * 该事件永远不会触发。下面三个用例把这条路径锁死。
 * ========================================================================== */

test('§5 拒收必须给出可执行的出路（否则多 flag 题的第 2 个 flag 会静默丢失）', async () => {
  const { host, agent } = boot();
  await seed(host, agent);
  await host.callTool('fgs_commit', {
    operations: [
      { op: 'open_step', action: '第一步', from: ['fact_origin'] },
      { op: 'open_step', action: '第二步', from: ['fact_origin'] },
    ],
  }, agent);
  host.ctx.setTurn(31);

  assert.equal((await host.callTool('fgs_submit_fact', { title: 'a', content: 'c' }, agent)).ok, true);
  assert.equal((await host.callTool('fgs_commit_step', {}, agent)).ok, true);

  const second = await host.callTool('fgs_commit_step', {}, agent);
  assert.equal(second.ok, false);
  // 只报错没用 —— 实测模型收到旧文案后会**再试一次**，然后这一段的发现照样丢。
  assert.match(second.text, /结束本回合/, '必须给出"结束本回合"的出路');
  assert.match(second.text, /fgs_submit_fact/, '必须给出"先写成草稿"的出路');
  assert.match(second.text, /丢失/, '必须说清继续硬推的代价');
});

test('§5 兜底：回合被信号中断（turn-stopping 永不触发）时也必须收束黑板', async () => {
  const { host, agent, cwd } = boot();
  await seed(host, agent);
  await host.callTool('fgs_commit', {
    operations: [{ op: 'open_step', action: '探路', from: ['fact_origin'] }],
  }, agent);
  host.ctx.setTurn(41);

  // 前置条件：step 确实是 open 的（复刻实测里那个冻结状态）
  const before = fs.readFileSync(projectGraphPath(cwd), 'utf8');
  assert.match(before, /state: "open"/);

  // ⚠️ 刻意**不**触发 `agent/turn-stopping` —— 模拟 supervisor 在回合中途 SIGTERM。
  // 哨兵监听者让 listenerCount>1，从而抑制插件"摘掉自己重新触发信号"的分支
  //（否则测试进程会被真的 SIGTERM 杀掉）。
  const sentinel = () => {};
  process.on('SIGTERM', sentinel);
  try {
    process.emit('SIGTERM');
  } finally {
    process.removeListener('SIGTERM', sentinel);
  }

  const after = fs.readFileSync(projectGraphPath(cwd), 'utf8');
  assert.notEqual(after, before, '黑板必须被写入，不能留在 open');
  assert.doesNotMatch(after, /state: "open"/, 'step 必须被收束');
  // 诚实性：不能谎称"无有效产出" —— 这一轮可能已经拿到 flag，只是没来得及落盘。
  assert.match(after, /中断/, '必须标注为"被信号中断"');
  assert.doesNotMatch(after, /无有效产出/, '不得假称无产出');
});

test('§5 兜底：有草稿时落草稿内容，而不是中断占位', async () => {
  const { host, agent, cwd } = boot();
  await seed(host, agent);
  await host.callTool('fgs_commit', {
    operations: [{ op: 'open_step', action: '探路', from: ['fact_origin'] }],
  }, agent);
  host.ctx.setTurn(51);
  // 模型写下了草稿但还没来得及 commit_step 就被信号打断
  await host.callTool('fgs_submit_fact', {
    title: '已确认：/admin 需要 ?pwd=',
    content: 'robots.txt 泄露路径；/admin 无参返回 403',
  }, agent);

  const sentinel = () => {};
  process.on('SIGTERM', sentinel);
  try {
    process.emit('SIGTERM');
  } finally {
    process.removeListener('SIGTERM', sentinel);
  }

  const after = fs.readFileSync(projectGraphPath(cwd), 'utf8');
  assert.match(after, /已确认：\/admin 需要 \?pwd=/, '草稿内容必须被保住');
  assert.match(after, /robots\.txt 泄露路径/, '草稿正文必须落盘');
  assert.doesNotMatch(after, /中断/, '有草稿时不该写中断占位');
});

test('§5 兜底：每次挂载恰好注册一个 SIGTERM 监听（不重复注册）', () => {
  const n = process.listenerCount('SIGTERM');
  boot();
  assert.equal(process.listenerCount('SIGTERM'), n + 1);
});



