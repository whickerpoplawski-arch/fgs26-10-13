/** Host 半集成：工具注册、角色隔离、命令、运行时上下文、HTTP 快照。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { apply as applyPlugin } from '../index.js';
import {
  callRoute,
  ensureActiveProject,
  makeFakeAgent,
  makeFakeHost,
  projectGraphPath,
  tmpDir,
  wireServices,
} from './helpers.mjs';

const FLAG = 'FLAG{dsh_native_ok}';

function boot(overrides = {}) {
  const host = makeFakeHost();
  const services = wireServices(host);
  // 假宿主里放一个环境执行工具，用来验证 Decide 轮的物理隔离
  host.ctx.tools.register({
    name: 'bash',
    description: 'fake bash',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: { schema: { type: 'object' }, render: () => [] },
    async execute() {
      return { ok: true, text: 'bash ok' };
    },
  });
  host.ctx.services = { ...host.ctx.services, ...services };
  applyPlugin(host.ctx, { stateDir: '.fgs', verifyMode: 'regex', ...overrides });
  const cwd = tmpDir();
  const agent = makeFakeAgent('sess-1', cwd);
  host.emit('agent/created', { agent });
  return { host, agent, cwd, services };
}

async function seed(host, agent, brief = '{\"target\":\"http://10.0.0.8:8080\",\"hint\":\"拿 FLAG\"}') {
  const created = ensureActiveProject(host, agent);
  assert.equal(created.kind, 'success', JSON.stringify(created));
  const result = await host.callTool('fgs_seed', { brief, target: 'http://10.0.0.8:8080' }, agent);
  assert.equal(result.ok, true, result.text);
  return result;
}

test('插件注册了全部 FGS 工具，并且都是全局注册', () => {
  const { host } = boot();
  for (const name of [
    'fgs_seed', 'fgs_status', 'fgs_preview', 'fgs_open_step', 'fgs_drop_step',
    'fgs_change_step_priority', 'fgs_satisfy_goal', 'fgs_reopen', 'fgs_commit',
    'fgs_submit_fact', 'fgs_commit_step',
  ]) {
    assert.ok(host.tools.has(name), `缺少工具 ${name}`);
  }
});

test('注册了 systemPrompt 规则段、运行时上下文、/fgs 命令与 HTTP 快照路由', () => {
  const { host, services } = boot();
  assert.ok(services.sp);
  assert.equal(host.sections.length, 1);
  assert.equal(host.sections[0].name, 'fgs-rules');
  assert.equal(host.contexts.length, 1);
  assert.equal(host.contexts[0].name, 'fgs-graph');
  assert.equal(host.commands.length, 1);
  assert.equal(host.commands[0].name, 'fgs');
  assert.equal(host.routes.length, 1);
  assert.equal(host.routes[0].path, '/fgs/state');
});

test('未启动 FGS 时 guard 拦住规划/执行工具；有活动 Project 后才放开 fgs_seed', async () => {
  const { host, agent } = boot();
  const blocked = await host.callTool('fgs_seed', { brief: 'x' }, agent);
  assert.equal(blocked.ok, false);
  assert.match(blocked.text, /没有活动 Project/);
  ensureActiveProject(host, agent);
  const seedResult = await host.callTool('fgs_seed', { brief: 'x' }, agent);
  assert.equal(seedResult.ok, true);
  const { agent: other } = { agent: makeFakeAgent('sess-2', tmpDir()) };
  const denied = await host.callTool('fgs_open_step', { action: 'a', from: ['fact_origin'] }, other);
  assert.equal(denied.ok, false);
  assert.match(denied.text, /FGS 未启动/);
});

test('无 open step → Decide：规划工具可用；execute 工具与环境工具被硬拒', async () => {
  const { host, agent } = boot();
  await seed(host, agent);

  const submitDenied = await host.callTool('fgs_submit_fact', { title: 'x' }, agent);
  assert.equal(submitDenied.ok, false);
  assert.match(submitDenied.text, /角色隔离/);
  assert.match(submitDenied.text, /Decide/);

  const bashDenied = await host.callTool('bash', {}, agent);
  assert.equal(bashDenied.ok, false);
  assert.match(bashDenied.text, /Decide 会话禁止环境执行工具/);

  const preview = await host.callTool('fgs_preview', {}, agent);
  assert.equal(preview.ok, true);
  assert.match(preview.text, /fact_origin/);

  const opened = await host.callTool('fgs_open_step', { action: 'a', from: ['fact_origin'] }, agent);
  assert.equal(opened.ok, true, opened.text);
});

test('open step 出现后 → Execute：规划工具被硬拒，环境工具与提交工具放开', async () => {
  const { host, agent } = boot();
  await seed(host, agent);
  await host.callTool('fgs_open_step', { action: '扫端口', from: ['fact_origin'], priority: 'high' }, agent);
  const committed = await host.callTool('fgs_commit', {}, agent);
  assert.equal(committed.ok, true, committed.text);

  const illegal = await host.callTool('fgs_satisfy_goal', {
    goalId: 'goal_final', reason: 'r', satisfiedBy: ['fact_origin'],
  }, agent);
  assert.equal(illegal.ok, false);
  assert.match(illegal.text, /Execute 轮不得调用/);

  const illegalOpen = await host.callTool('fgs_open_step', { action: 'x', from: ['fact_origin'] }, agent);
  assert.equal(illegalOpen.ok, false);
  assert.match(illegalOpen.text, /Execute 轮不得调用/);

  const allowed = await host.callTool('bash', {}, agent);
  assert.equal(allowed.ok, true);

  const submit = await host.callTool('fgs_submit_fact', { title: 't', content: 'c' }, agent);
  assert.equal(submit.ok, true, submit.text);
});

test('角色隔离只靠 tools.guard，不依赖 tools.restrict 的动态可见性', async () => {
  // 回归：实测 restrict 无法可靠「松开」，会让 Decide 工具永久消失，
  // 所以插件必须完全不用它（schema 层永远保留全部 fgs_* 工具）。
  const { host, agent } = boot();
  await seed(host, agent);
  await host.callTool('fgs_commit', {
    operations: [{ op: 'open_step', action: 'a', from: ['fact_origin'] }],
  }, agent);
  assert.equal(host.restrictions.length, 0, '不得注册全局 restrict');
  assert.equal(agent.restrictFilters.length, 0, '不得对 agent 注册 restrict');
});

test('Decide 草稿 → commit 批量落盘；未 commit 前磁盘不变', async () => {
  const { host, agent, cwd } = boot();
  await seed(host, agent);
  const before = fs.readFileSync(projectGraphPath(cwd), 'utf8');
  await host.callTool('fgs_open_step', { action: 'a', from: ['fact_origin'] }, agent);
  await host.callTool('fgs_open_step', { action: 'b', from: ['fact_origin'] }, agent);
  assert.equal(fs.readFileSync(projectGraphPath(cwd), 'utf8'), before, '草稿阶段不得落盘');

  const committed = await host.callTool('fgs_commit', {}, agent);
  assert.equal(committed.ok, true);
  assert.match(committed.text, /已提交 2 项/);
  const graph = fs.readFileSync(projectGraphPath(cwd), 'utf8');
  assert.match(graph, /step_001/);
  assert.match(graph, /step_002/);
});

test('批量 commit 中后一项可以引用前一项产出的 step（草稿不被逐项预检卡死）', async () => {
  const { host, agent } = boot();
  await seed(host, agent);
  const result = await host.callTool('fgs_commit', {
    operations: [
      { op: 'open_step', action: 'a', from: ['fact_origin'] },
      { op: 'open_step', action: 'b', from: ['fact_origin'], stepId: 'step_009' },
      { op: 'change_step_priority', stepId: 'step_009', priority: 'low' },
    ],
  }, agent);
  assert.equal(result.ok, true, result.text);
  assert.match(result.text, /已提交 3 项/);
});

test('satisfy_goal 缺字段在草稿阶段就拒收（不进草稿、不落盘）', async () => {
  const { host, agent } = boot();
  await seed(host, agent);
  const bad = await host.callTool('fgs_satisfy_goal', { goalId: 'goal_final', reason: '   ', satisfiedBy: [] }, agent);
  assert.equal(bad.ok, false);
  assert.match(bad.text, /拒收/);
  const commit = await host.callTool('fgs_commit', {}, agent);
  assert.equal(commit.ok, false);
  assert.match(commit.text, /草稿为空/);
});

test('drop_step 缺 reason 在草稿阶段拒收', async () => {
  const { host, agent } = boot();
  await seed(host, agent);
  const bad = await host.callTool('fgs_drop_step', { stepId: 'step_001', reason: '  ' }, agent);
  assert.equal(bad.ok, false);
  assert.match(bad.text, /reason/);
});

test('FLAG verify 失败时 satisfy_goal 整批拒写，不写 satisfied*', async () => {
  const { host, agent, cwd } = boot();
  await seed(host, agent);
  await host.callTool('fgs_commit', {
    operations: [{ op: 'open_step', action: '取 flag', from: ['fact_origin'] }],
  }, agent);
  await host.callTool('fgs_submit_fact', { title: '没拿到 flag', content: '什么都没有' }, agent);
  await host.callTool('fgs_commit_step', {}, agent);

  await host.callTool('fgs_satisfy_goal', {
    goalId: 'goal_final', reason: '假设已满足', satisfiedBy: ['fact_001'],
  }, agent);
  const committed = await host.callTool('fgs_commit', {}, agent);
  assert.equal(committed.ok, false);
  assert.match(committed.text, /verify hook 拒绝/);
  assert.doesNotMatch(fs.readFileSync(projectGraphPath(cwd), 'utf8'), /satisfiedAt/);
});

test('完整一轮：Execute 收束 → 回 Decide → satisfy → concludeTurn 且停止', async () => {
  const { host, agent } = boot();
  await seed(host, agent);
  await host.callTool('fgs_commit', {
    operations: [{ op: 'open_step', action: '取 flag', from: ['fact_origin'] }],
  }, agent);

  const submitted = await host.callTool('fgs_submit_fact', {
    title: `FLAG 提交: ${FLAG} 赛方确认`,
    content: `submit_flag ok=true ${FLAG}`,
  }, agent);
  assert.equal(submitted.ok, true, submitted.text);
  const closed = await host.callTool('fgs_commit_step', {}, agent);
  assert.equal(closed.ok, true);
  assert.match(closed.text, /定稿/);
  assert.match(closed.text, /回到 Decide/);

  await host.callTool('fgs_satisfy_goal', {
    goalId: 'goal_final', reason: `${FLAG} 已确认有效`, satisfiedBy: ['fact_001'],
  }, agent);
  const satisfied = await host.callTool('fgs_commit', {}, agent);
  assert.equal(satisfied.ok, true, satisfied.text);
  assert.match(satisfied.text, /goal_final 已满足/);
  assert.equal(agent.concluded, true, 'goal 满足后应 concludeTurn 停止');

  const status = await host.callTool('fgs_status', {}, agent);
  assert.match(status.text, /satisfied: yes/);
});

test('Execute 轮无产出也强制落一条观察 Fact（CONTRACT §5）', async () => {
  const { host, agent, cwd } = boot();
  await seed(host, agent);
  await host.callTool('fgs_commit', {
    operations: [{ op: 'open_step', action: '探路', from: ['fact_origin'] }],
  }, agent);
  const closed = await host.callTool('fgs_commit_step', {}, agent);
  assert.equal(closed.ok, true);
  const graph = fs.readFileSync(projectGraphPath(cwd), 'utf8');
  assert.match(graph, /观察/);
  assert.match(graph, /fact_001/);
});

test('reopen 走 /fgs 命令：清空 satisfied* 并追加 feedback Fact', async () => {
  const { host, agent, cwd } = boot();
  await seed(host, agent);
  await host.callTool('fgs_commit', { operations: [
    { op: 'open_step', action: '取 flag', from: ['fact_origin'] },
  ] }, agent);
  await host.callTool('fgs_submit_fact', { title: `FLAG ${FLAG}`, content: FLAG }, agent);
  await host.callTool('fgs_commit_step', {}, agent);
  await host.callTool('fgs_satisfy_goal', { goalId: 'goal_final', reason: 'ok', satisfiedBy: ['fact_001'] }, agent);
  await host.callTool('fgs_commit', {}, agent);
  assert.match(fs.readFileSync(projectGraphPath(cwd), 'utf8'), /satisfiedAt/);

  const command = host.commands[0];
  const result = command.handler({ agent, rawInput: 'reopen 裁判打回: 假 FLAG', commandId: 'c1' });
  assert.equal(result.kind, 'success', JSON.stringify(result));
  const graph = fs.readFileSync(projectGraphPath(cwd), 'utf8');
  assert.doesNotMatch(graph, /satisfiedAt/);
  assert.match(graph, /假 FLAG/);
});

test('/fgs init 与 /fgs status / path / off 子命令', async () => {
  const { host, agent } = boot();
  const command = host.commands[0];
  const init = command.handler({ agent, rawInput: 'init 目标 http://x 拿 FLAG' });
  assert.equal(init.kind, 'success', JSON.stringify(init));
  const status = command.handler({ agent, rawInput: 'status' });
  assert.match(status.text, /facts=1/);
  const p = command.handler({ agent, rawInput: 'path' });
  assert.match(p.text, /graph\.yaml$/);
  const off = command.handler({ agent, rawInput: 'off' });
  assert.equal(off.kind, 'success');
  const statusAfter = command.handler({ agent, rawInput: 'status' });
  assert.match(statusAfter.text, /未启动/);
});

test('注册全部交给 ctx.effect 持有：卸载时工具/guard/prompt/命令/路由一起撤销', async () => {
  // 回归：不持有 disposer 的注册会在插件移除后继续生效
  //（旧 HTTP 路由继续响应、旧 context 继续注入、旧监听继续收紧新会话）。
  const { host } = boot();
  assert.equal(host.effects.length, 1, '只登记一个总清理 effect');
  assert.equal(host.tools.size, 13, '12 个 fgs_* + 假宿主自带的 bash');
  assert.equal(host.guards.length, 1);
  assert.equal(host.sections.length, 1);
  assert.equal(host.contexts.length, 1);
  assert.equal(host.commands.length, 1);
  assert.equal(host.routes.length, 1);

  host.effects[0](); // 模拟插件卸载 / HMR

  assert.deepEqual([...host.tools.keys()], ['bash'], '只剩宿主自己的工具');
  assert.equal(host.guards.length, 0);
  assert.equal(host.sections.length, 0);
  assert.equal(host.contexts.length, 0);
  assert.equal(host.commands.length, 0);
  assert.equal(host.routes.length, 0);
});

test('每个会话的运行时上下文只属于它自己（已删除另一个会话的黑板污染）', async () => {
  const { host, agent } = boot();
  const other = makeFakeAgent('sess-other', tmpDir());
  await seed(host, agent);
  const provider = host.contexts[0].text;
  assert.match(provider({ scope: agent }), /fact_origin/);
  // 另一个会话没有启动 FGS：绝不能被注入别人的图
  assert.equal(provider({ scope: other }), '');
});

test('运行时上下文严格按会话注入，不回退到别的会话的图', async () => {
  const { host, agent } = boot();
  await seed(host, agent);
  const provider = host.contexts[0].text;
  const ownerText = typeof provider === 'function' ? provider({ scope: agent }) : provider;
  assert.match(ownerText, /FGS 当前角色/);
  assert.match(ownerText, /Decide/);
  assert.match(ownerText, /fact_origin/);
  assert.match(ownerText, /fgs_open_step/);

  // 别的会话 / 没有 scope：绝不注入本会话的黑板（否则会污染无关会话）
  assert.equal(provider({ scope: { id: 'someone-else' } }), '');
  assert.equal(provider({}), '');
  assert.equal(provider({ scope: { notAnAgent: true } }), '');
});

test('commit.operations[] 同时接受 op 与 type 字段（兼容旧批次格式）', async () => {
  const { host, agent } = boot();
  await seed(host, agent);
  const result = await host.callTool('fgs_commit', {
    operations: [{ type: 'open_step', action: 'a', from: ['fact_origin'] }],
  }, agent);
  assert.equal(result.ok, true, result.text);
  assert.match(result.text, /已提交 1 项/);
});

test('HTTP /fgs/state 返回给 Web 面板的快照', async () => {
  const { host, agent, cwd } = boot();
  await seed(host, agent);
  const response = await callRoute(host.routes[0]);
  assert.equal(response.statusCode, 200);
  assert.equal(response.json.active, true);
  assert.equal(response.json.role, 'decide');
  assert.equal(response.json.counts.facts, 1);
  assert.equal(response.json.root, path.join(cwd, '.fgs', 'projects', 'default'));
  assert.equal(response.json.problemId, 'default');
  assert.equal(response.headers['content-type'], 'application/json; charset=utf-8');
});

test('两个会话各自独立的图与角色', async () => {
  const { host, agent } = boot();
  const agentB = makeFakeAgent('sess-b', tmpDir());
  host.emit('agent/created', { agent: agentB });
  await seed(host, agent, '{"target":"http://a"}');
  const statusB = await host.callTool('fgs_status', {}, agentB);
  assert.match(statusB.text, /FGS 未启动/);
  await seed(host, agentB, '{"target":"http://b"}');
  await host.callTool('fgs_commit', { operations: [{ op: 'open_step', action: 'x', from: ['fact_origin'] }] }, agentB);
  const statusA = await host.callTool('fgs_status', {}, agent);
  assert.match(statusA.text, /open=0/);
  const statusB2 = await host.callTool('fgs_status', {}, agentB);
  assert.match(statusB2.text, /open=1/);
});

test('Execute 轮的待写入 Fact 草稿对运行时上下文 / fgs_status / HTTP 快照都可见', async () => {
  const { host, agent } = boot();
  await seed(host, agent);
  await host.callTool(
    'fgs_commit',
    { operations: [{ op: 'open_step', action: 'x', from: ['fact_origin'] }] },
    agent,
  );
  const submitted = await host.callTool(
    'fgs_submit_fact',
    { title: '本轮要落的结论', content: 'ok' },
    agent,
  );
  assert.equal(submitted.ok, true, submitted.text);

  // 回归：draftSummary 以前只看 decideDraft，Execute 轮草稿在上下文里完全不可见
  const provider = host.contexts[0].text;
  assert.match(provider({ scope: agent }), /未提交草稿/);
  assert.match(provider({ scope: agent }), /本轮要落的结论/);

  const status = await host.callTool('fgs_status', {}, agent);
  assert.match(status.text, /本轮要落的结论/);

  const response = await callRoute(host.routes[0], '/fgs/state?sessionId=sess-1');
  assert.match(response.json.draft, /本轮要落的结论/);
});

test('verifyMode=none 不再能关掉硬门：回退到 regex，satisfy 依然被拒', async () => {
  const { host, agent } = boot({ verifyMode: 'none' });
  await seed(host, agent);
  await host.callTool('fgs_commit', { operations: [{ op: 'open_step', action: 'x', from: ['fact_origin'] }] }, agent);
  await host.callTool('fgs_submit_fact', { title: '没有 flag', content: 'nothing' }, agent);
  await host.callTool('fgs_commit_step', {}, agent);
  await host.callTool('fgs_satisfy_goal', { goalId: 'goal_final', reason: 'r', satisfiedBy: ['fact_001'] }, agent);
  const done = await host.callTool('fgs_commit', {}, agent);
  assert.equal(done.ok, false, 'CONTRACT §8：硬门不可被配置关闭');
  assert.match(done.text, /verify hook 拒绝/);
});

test('默认配置下，竞赛真题的小写 flag{...} 必须能过 §8 硬门', async () => {
  // 回归 b-02 真题素材暴露的问题：早期默认 pattern 是全大写且无 i，
  // 真 flag 会被永远拒收（只有自己敲的 FLAG{} 假数据能过）。
  const { host, agent } = boot();
  await seed(host, agent);
  await host.callTool('fgs_commit', { operations: [{ op: 'open_step', action: 'x', from: ['fact_origin'] }] }, agent);
  await host.callTool('fgs_submit_fact', {
    title: '拿到 flag{real_case_01}',
    content: '利用链走通后从目标读到 flag{real_case_01}',
  }, agent);
  await host.callTool('fgs_commit_step', {}, agent);
  await host.callTool('fgs_satisfy_goal', {
    goalId: 'goal_final', reason: '赛方已判对', satisfiedBy: ['fact_001'],
  }, agent);
  const done = await host.callTool('fgs_commit', {}, agent);
  assert.equal(done.ok, true, `真 flag 必须过门，实际: ${done.text}`);
  assert.match(done.text, /已满足/);
});
