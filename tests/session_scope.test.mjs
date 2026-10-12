/**
 * 多会话作用域（D1 / D2 / D6 / D3）。
 *
 * 黑板仍是共享真源；活动题和 open step 的持有者按会话绑定。
 * 角色每轮从「本会话是否还持有 open step」推导，不信任 run.role 缓存。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { apply as applyPlugin } from '../index.js';
import { Controller, GraphStore } from '../controller/index.js';
import { submitFactOp } from '../controller/ops.js';
import {
  callRoute,
  ensureActiveProject,
  makeFakeAgent,
  makeFakeHost,
  projectGraphPath,
  tmpDir,
  wireServices,
} from './helpers.mjs';

function boot(overrides = {}) {
  const host = makeFakeHost();
  const services = wireServices(host);
  for (const name of ['bash', 'read', 'web_fetch', 'subagent']) {
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
  applyPlugin(host.ctx, { stateDir: '.fgs', verifyMode: 'regex', ...overrides });
  const cwd = tmpDir();
  const agent = makeFakeAgent('sess-a', cwd);
  host.emit('agent/created', { agent });
  const command = host.commands.find((item) => item.name === 'fgs');
  const fgs = (who, raw) => command.handler({ agent: who, rawInput: raw });
  return { host, agent, cwd, fgs };
}

function bootAt(cwd, sessionId) {
  const host = makeFakeHost();
  const services = wireServices(host);
  host.ctx.services = { ...host.ctx.services, ...services };
  applyPlugin(host.ctx, { stateDir: '.fgs', verifyMode: 'regex' });
  const agent = makeFakeAgent(sessionId, cwd);
  host.emit('agent/created', { agent });
  return { host, agent };
}

async function seed(host, agent, brief = 'brief') {
  const created = ensureActiveProject(host, agent, 'shared');
  assert.equal(created.kind, 'success', JSON.stringify(created));
  const result = await host.callTool('fgs_seed', { brief }, agent);
  assert.equal(result.ok, true, result.text);
}

test('D1：两个会话不能继承同一活动题，也不能绑定对方的 open step', async () => {
  const { host, agent, cwd, fgs } = boot();
  const other = makeFakeAgent('sess-b', cwd);
  host.emit('agent/created', { agent: other });
  await seed(host, agent, 'shared-brief');

  const index = JSON.parse(fs.readFileSync(path.join(cwd, '.fgs', 'competition.json'), 'utf8'));
  assert.equal(index.activeProblemId, 'shared');
  const bindings = JSON.parse(fs.readFileSync(path.join(cwd, '.fgs', 'session-bindings.json'), 'utf8'));
  assert.equal(bindings.bindings['sess-a'], 'shared');
  assert.equal(bindings.bindings['sess-b'], undefined);

  const statusB = await host.callTool('fgs_status', {}, other);
  assert.match(statusB.text, /没有活动 Project/, '子会话不得继承工作区 activeProblemId');
  const stolenOpen = await host.callTool('fgs_open_step', { action: '偷开', from: ['fact_origin'] }, other);
  assert.equal(stolenOpen.ok, false);
  assert.match(stolenOpen.text, /没有活动 Project/);

  assert.equal(fgs(other, 'switch shared').kind, 'success');
  const opened = await host.callTool('fgs_commit', {
    operations: [{ op: 'open_step', action: 'A 的步骤', from: ['fact_origin'] }],
  }, agent);
  assert.equal(opened.ok, true, opened.text);
  assert.match(fs.readFileSync(projectGraphPath(cwd, 'shared'), 'utf8'), /ownerSession: "sess-a"/);

  const bashA = await host.callTool('bash', {}, agent);
  assert.equal(bashA.ok, true, '持有 open step 的会话可以执行');
  const bashB = await host.callTool('bash', {}, other);
  assert.equal(bashB.ok, false, '没持有 open step 的会话即使板上有别人的 step 也仍是 Decide');
  assert.match(bashB.text, /CONTRACT §4/);

  const submitB = await host.callTool('fgs_submit_fact', { title: 'B 想绑 A', content: 'no' }, other);
  assert.equal(submitB.ok, false);
  assert.match(submitB.text, /Decide 轮不得调用/);
  const commitStepB = await host.callTool('fgs_commit_step', {}, other);
  assert.equal(commitStepB.ok, false);
  assert.match(commitStepB.text, /Decide 轮不得调用/);

  const drop = await host.callTool('fgs_drop_step', { stepId: 'step_001', reason: 'B 想丢掉' }, other);
  assert.equal(drop.ok, true, drop.text);
  const dropCommit = await host.callTool('fgs_commit', {}, other);
  assert.equal(dropCommit.ok, false, dropCommit.text);
  assert.match(dropCommit.text, /跨会话绑定被拒/);
  assert.match(fs.readFileSync(projectGraphPath(cwd, 'shared'), 'utf8'), /state: "open"/);

  const bOpen = await host.callTool('fgs_commit', {
    operations: [{ op: 'open_step', action: 'B 的步骤', from: ['fact_origin'] }],
  }, other);
  assert.equal(bOpen.ok, true, bOpen.text);
  const cross = await host.callTool('fgs_submit_fact', {
    title: '绑错 step', content: 'no', stepId: 'step_001',
  }, other);
  assert.equal(cross.ok, false, cross.text);
  assert.match(cross.text, /跨会话/);

  assert.equal((await host.callTool('fgs_submit_fact', { title: 'B 的事实', content: 'b' }, other)).ok, true);
  assert.equal((await host.callTool('fgs_commit_step', {}, other)).ok, true);
  const yaml = fs.readFileSync(projectGraphPath(cwd, 'shared'), 'utf8');
  assert.match(yaml, /ownerSession: "sess-a"/);
  assert.match(yaml, /ownerSession: "sess-b"/);
  assert.match(yaml, /B 的事实/);
  assert.match(yaml, /producedBy: "step_002"/);
  assert.match(yaml, /A 的步骤/);
  assert.match(yaml, /state: "open"/, 'A 的 step 不能被 B 收束');

  const statusA = await host.callTool('fgs_status', {}, agent);
  assert.match(statusA.text, /Execute/);
  assert.match(statusA.text, /owner=sess-a/);
  const ctxA = host.contexts[0].text({ scope: agent });
  assert.match(ctxA, /step_001/);
  const ctxB = host.contexts[0].text({ scope: other });
  assert.match(ctxB, /Decide/);
  assert.doesNotMatch(ctxB, /本轮必须收束的 step】step_001/);
});

test('D2/D6：别人把 step 收束后，角色回到 Decide，环境工具禁令仍生效，currentStepId 为空', async () => {
  const { host, agent, cwd } = boot();
  await seed(host, agent);
  assert.equal((await host.callTool('fgs_commit', {
    operations: [{ op: 'open_step', action: '会被外部收束', from: ['fact_origin'] }],
  }, agent)).ok, true);
  assert.equal((await host.callTool('fgs_submit_fact', {
    title: '还在草稿里', content: '尚未定稿',
  }, agent)).ok, true);
  assert.equal((await host.callTool('bash', {}, agent)).ok, true);

  const root = path.dirname(projectGraphPath(cwd, 'shared'));
  const store = new GraphStore(root);
  const ctl = new Controller(store, { verifyHook: null });
  ctl.commit(ctl.apply(submitFactOp({
    title: '外部收束',
    content: '图被别的写入者收束，本 run 的缓存还停在 execute',
    producedBy: 'step_001',
    callerSession: 'sess-a',
  })));

  const snap = await callRoute(host.routes[0], '/fgs/state?sessionId=sess-a');
  assert.equal(snap.json.derivedRole, 'decide');
  assert.equal(snap.json.role, 'decide');
  assert.equal(snap.json.runRole, 'execute', '缓存角色要单独暴露，不能盖掉推导结果');
  assert.equal(snap.json.currentStepId, null);
  assert.equal(snap.json.counts.open, 0);
  assert.match(snap.json.draftNotice, /僵尸草稿/);
  assert.equal(snap.json.draft, '');

  const bash = await host.callTool('bash', {}, agent);
  assert.equal(bash.ok, false, 'Decide 环境工具禁令必须按推导角色生效');
  assert.match(bash.text, /CONTRACT §4/);
  const preview = await host.callTool('fgs_preview', {}, agent);
  assert.equal(preview.ok, true, preview.text);
  const submit = await host.callTool('fgs_submit_fact', { title: '不该还能交', content: 'x' }, agent);
  assert.equal(submit.ok, false);
  assert.match(submit.text, /Decide 轮不得调用/);

  const reopened = await host.callTool('fgs_commit', {
    operations: [{ op: 'open_step', action: '重新规划', from: ['fact_origin'] }],
  }, agent);
  assert.equal(reopened.ok, true, reopened.text);
  const again = await callRoute(host.routes[0], '/fgs/state?sessionId=sess-a');
  assert.equal(again.json.derivedRole, 'execute');
  assert.equal(again.json.currentStepId, 'step_002');
  assert.equal((await host.callTool('bash', {}, agent)).ok, true);

  const status = await host.callTool('fgs_status', {}, agent);
  assert.match(status.text, /Execute/);
  assert.doesNotMatch(status.text, /还在草稿里/);
});

test('D3：本回合新开的 step 可以在本回合收束；更早的第二步仍然一轮只吃一个', async () => {
  const { host, agent, cwd } = boot();
  await seed(host, agent);
  assert.equal((await host.callTool('fgs_commit', {
    operations: [{ op: 'open_step', action: '先做', from: ['fact_origin'] }],
  }, agent)).ok, true);
  host.ctx.setTurn(4);
  assert.equal((await host.callTool('fgs_submit_fact', { title: '第一事实', content: 'a' }, agent)).ok, true);
  assert.equal((await host.callTool('fgs_commit_step', {}, agent)).ok, true);

  assert.equal((await host.callTool('fgs_commit', {
    operations: [{ op: 'open_step', action: '同回合再开', from: ['fact_origin'] }],
  }, agent)).ok, true);
  assert.equal((await host.callTool('fgs_submit_fact', { title: '同回合事实', content: 'b' }, agent)).ok, true);
  const closed = await host.callTool('fgs_commit_step', {}, agent);
  assert.equal(closed.ok, true, closed.text);
  const yaml = fs.readFileSync(projectGraphPath(cwd, 'shared'), 'utf8');
  assert.match(yaml, /同回合事实/);
  assert.doesNotMatch(yaml, /state: "open"/);

  assert.equal((await host.callTool('fgs_commit', {
    operations: [
      { op: 'open_step', action: '留下的甲', from: ['fact_origin'] },
      { op: 'open_step', action: '留下的乙', from: ['fact_origin'] },
    ],
  }, agent)).ok, true);
  host.ctx.setTurn(9);
  assert.equal((await host.callTool('fgs_submit_fact', { title: '只吃一个', content: 'c' }, agent)).ok, true);
  assert.equal((await host.callTool('fgs_commit_step', {}, agent)).ok, true);
  const second = await host.callTool('fgs_commit_step', {}, agent);
  assert.equal(second.ok, false);
  assert.match(second.text, /一轮只吃一个 open step/);
  assert.match(fs.readFileSync(projectGraphPath(cwd, 'shared'), 'utf8'), /state: "open"/);
});

test('D1：重启后只恢复本会话的绑定，另一个会话不会自动认领', async () => {
  const first = boot();
  await seed(first.host, first.agent, 'persist');
  const second = bootAt(first.cwd, 'sess-a');
  const status = await second.host.callTool('fgs_status', {}, second.agent);
  assert.match(status.text, /facts=1/);
  assert.doesNotMatch(status.text, /尚未种题|没有活动 Project/);

  const stranger = bootAt(first.cwd, 'sess-stranger');
  const denied = await stranger.host.callTool('fgs_status', {}, stranger.agent);
  assert.match(denied.text, /没有活动 Project/);
  const open = await stranger.host.callTool('fgs_open_step', {
    action: '不该继承', from: ['fact_origin'],
  }, stranger.agent);
  assert.equal(open.ok, false);
  assert.match(open.text, /没有活动 Project/);
});
