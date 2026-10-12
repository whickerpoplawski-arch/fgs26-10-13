/**
 * 离线 replay（CONTRACT §10）：固定 Decide/Execute JSON 轨迹 → 断言图 diff。
 *
 * 不接真模型：每一步都是一条写死的 tool call，跑完后比对 canonical YAML/JSON。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { apply as applyPlugin } from '../index.js';
import { load } from '../yaml.js';
import { ensureActiveProject, makeFakeAgent, makeFakeHost, projectGraphPath, projectJsonPath, tmpDir, wireServices } from './helpers.mjs';

/** 固定轨迹：Decide(open×2) → Execute×2 → Decide(satisfy) → Decide(reopen)。 */
const TRAJECTORY = [
  { role: 'decide', name: 'fgs_seed', args: { brief: '{"target":"http://10.0.0.8:8080","hint":"拿到并提交 FLAG"}', target: 'http://10.0.0.8:8080' } },
  {
    role: 'decide',
    name: 'fgs_commit',
    args: {
      operations: [
        { op: 'open_step', action: '对目标做全端口探测', from: ['fact_origin'], priority: 'high' },
        { op: 'open_step', action: '取 admin 备份文件并拿 FLAG', from: ['fact_origin'], priority: 'normal' },
      ],
    },
  },
  { role: 'execute', name: 'fgs_submit_fact', args: { title: '端口扫描: 仅 80/tcp 开放', content: 'nmap -sT -p-：仅 80 开放。原始输出见 workspace/step001_nmap.txt' } },
  { role: 'execute', name: 'fgs_commit_step', args: {} },
  { role: 'execute', name: 'fgs_submit_fact', args: { title: 'FLAG 提交: FLAG{demo_01_ok} 赛方确认有效', content: 'submit_flag ok=true correct_flag_count=1 FLAG{demo_01_ok}' } },
  { role: 'execute', name: 'fgs_commit_step', args: {} },
  {
    role: 'decide',
    name: 'fgs_satisfy_goal',
    args: { goalId: 'goal_final', reason: 'fact_002 记录 FLAG{demo_01_ok} 提交且赛方 ACK 有效', satisfiedBy: ['fact_002'] },
  },
  { role: 'decide', name: 'fgs_commit', args: {} },
];

function boot() {
  const host = makeFakeHost();
  const services = wireServices(host);
  host.ctx.services = services;
  applyPlugin(host.ctx, { stateDir: '.fgs' });
  const cwd = tmpDir();
  const agent = makeFakeAgent('replay-session', cwd);
  host.emit('agent/created', { agent });
  const created = ensureActiveProject(host, agent);
  if (created.kind !== 'success') throw new Error(created.text);
  return { host, agent, cwd };
}

function canonical(graph) {
  return {
    facts: graph.facts.map((f) => ({
      id: f.id,
      title: f.title,
      content: f.content ?? null,
      producedBy: f.producedBy ?? null,
    })),
    goals: graph.goals.map((g) => ({
      id: g.id,
      kind: g.kind,
      criterion: g.criterion,
      satisfiedBy: g.satisfiedBy ?? null,
      satisfiedReason: g.satisfiedReason ?? null,
      satisfied: Boolean(g.satisfiedAt),
    })),
    steps: graph.steps.map((s) => ({
      id: s.id,
      action: s.action,
      from: s.from,
      priority: s.priority,
      state: s.state,
      to: s.to ?? null,
      reason: s.reason ?? null,
    })),
  };
}

async function replay(host, agent) {
  const transcript = [];
  for (const step of TRAJECTORY) {
    const result = await host.callTool(step.name, step.args, agent);
    transcript.push({ name: step.name, ok: result.ok, text: result.text });
    assert.equal(result.ok, true, `${step.name} 应成功: ${result.text}`);
  }
  return transcript;
}

test('固定轨迹 replay：图与 canonical diff 完全一致', async () => {
  const { host, agent, cwd } = boot();
  await replay(host, agent);
  const store = { graphPath: projectGraphPath(cwd), jsonPath: projectJsonPath(cwd) };
  const graph = load(fs.readFileSync(store.graphPath, 'utf8'));
  const mirror = JSON.parse(fs.readFileSync(store.jsonPath, 'utf8'));

  assert.deepEqual(canonical(graph), {
    facts: [
      {
        id: 'fact_origin',
        title: '题目信息:',
        content: '{\n  "target": "http://10.0.0.8:8080",\n  "brief": "{\\"target\\":\\"http://10.0.0.8:8080\\",\\"hint\\":\\"拿到并提交 FLAG\\"}"\n}',
        producedBy: null,
      },
      {
        id: 'fact_001',
        title: '端口扫描: 仅 80/tcp 开放',
        content: 'nmap -sT -p-：仅 80 开放。原始输出见 workspace/step001_nmap.txt',
        producedBy: 'step_001',
      },
      {
        id: 'fact_002',
        title: 'FLAG 提交: FLAG{demo_01_ok} 赛方确认有效',
        content: 'submit_flag ok=true correct_flag_count=1 FLAG{demo_01_ok}',
        producedBy: 'step_002',
      },
    ],
    goals: [
      {
        id: 'goal_final',
        kind: 'final',
        criterion: '解决这道渗透题目，并提交全部 FLAG；多 FLAG 须全部有效提交',
        satisfiedBy: ['fact_002'],
        satisfiedReason: 'fact_002 记录 FLAG{demo_01_ok} 提交且赛方 ACK 有效',
        satisfied: true,
      },
    ],
    steps: [
      {
        id: 'step_001',
        action: '对目标做全端口探测',
        from: ['fact_origin'],
        priority: 'high',
        state: 'done',
        to: 'fact_001',
        reason: null,
      },
      {
        id: 'step_002',
        action: '取 admin 备份文件并拿 FLAG',
        from: ['fact_origin'],
        priority: 'normal',
        state: 'done',
        to: 'fact_002',
        reason: null,
      },
    ],
  });
  // JSON 镜像是同一份文档（字段顺序 facts,goals,steps）
  assert.equal(Object.keys(mirror).join(','), 'facts,goals,steps');
  assert.equal(mirror.facts.length, 3);
  assert.deepEqual(mirror.steps[0].from, ['fact_origin']);
  assert.equal(mirror.goals[0].satisfiedBy[0], 'fact_002');
});

test('replay 的第二个分支：reopen 后 satisfied* 清空并追加 feedback Fact', async () => {
  const { host, agent, cwd } = boot();
  await replay(host, agent);
  const before = canonical(load(fs.readFileSync(projectGraphPath(cwd), 'utf8')));

  const reopened = await host.callTool('fgs_reopen', { goalId: 'goal_final', reason: '外部判定 FLAG 无效，重做' }, agent);
  assert.equal(reopened.ok, true);
  const committed = await host.callTool('fgs_commit', {}, agent);
  assert.equal(committed.ok, true);

  const after = canonical(load(fs.readFileSync(projectGraphPath(cwd), 'utf8')));
  assert.equal(after.goals[0].satisfied, false);
  assert.equal(after.goals[0].satisfiedBy, null);
  assert.equal(after.facts.length, before.facts.length + 1);
  assert.equal(after.steps.length, before.steps.length, 'reopen 不得删历史 step');
  assert.equal(after.facts[after.facts.length - 1].id, 'fact_003');
  assert.equal(after.facts[after.facts.length - 1].content, '外部判定 FLAG 无效，重做');
});

test('replay 后角色回到 Decide 并能再次种新 step（不锁死）', async () => {
  const { host, agent } = boot();
  await replay(host, agent);
  const status = await host.callTool('fgs_status', {}, agent);
  assert.match(status.text, /角色: Decide/);
  await host.callTool('fgs_commit', {
    operations: [{ op: 'open_step', action: '重新验证入口', from: ['fact_002'] }],
  }, agent);
  const after = await host.callTool('fgs_status', {}, agent);
  assert.match(after.text, /角色: Execute/);
});
