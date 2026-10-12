/** Controller / GraphStore：CONTRACT §3、§5、§6、§7、§8 的拒写与提交语义。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Controller, GraphStore } from '../controller/index.js';
import {
  WriteRejected,
  changePriorityOp,
  dropStepOp,
  openStepOp,
  reopenOp,
  satisfyGoalOp,
  seedOriginOp,
  submitFactOp,
} from '../controller/ops.js';
import { makeCommandVerify, makeRegexFlagVerify, makeVerifyHook } from '../hooks/flag_verify.js';
import { safeApply } from '../hooks/validate_write.js';
import { tmpDir } from './helpers.mjs';

function newStore(options = {}) {
  return new GraphStore(tmpDir(), options);
}

function seeded(options = {}) {
  const store = newStore(options.store);
  const ctl = new Controller(store, { verifyHook: options.verifyHook ?? null });
  ctl.commit(ctl.apply(seedOriginOp({ title: '题目信息:', content: '{"target":"http://10.0.0.8:8080"}' })));
  return { store, ctl };
}

function seededWithOpenStep(options = {}) {
  const { store, ctl } = seeded(options);
  ctl.commit(ctl.apply(openStepOp({ action: '对目标做全端口探测', from: ['fact_origin'], priority: 'high' })));
  return { store, ctl };
}

test('seed_origin 落盘 graph.yaml：顶层键仅 facts/goals/steps', () => {
  const { store } = seeded();
  const raw = fs.readFileSync(store.graphPath, 'utf8');
  const topKeys = raw.split('\n').filter((l) => /^[A-Za-z_]+:/.test(l)).map((l) => l.split(':')[0]);
  assert.deepEqual(topKeys, ['facts', 'goals', 'steps']);
  assert.ok(fs.existsSync(store.jsonPath));
  assert.ok(!fs.existsSync(store.lockPath), '写锁应已释放');
});

test('graph.yaml 出现非法顶层键（Intent/Hint/findings）时 load 直接拒绝', () => {
  const store = newStore();
  store.ensureDir();
  fs.writeFileSync(store.graphPath, 'Intent: []\nfacts: []\ngoals: []\nsteps: []\n', 'utf8');
  assert.throws(() => store.load(), /顶层键非法/);
});

test('open_step 空 from 因果拒写（CONTRACT §8）', () => {
  const { ctl } = seeded();
  assert.throws(() => ctl.apply(openStepOp({ action: 'x', from: [] })), WriteRejected);
  assert.throws(() => ctl.apply(openStepOp({ action: 'x', from: [] })), /from/);
});

test('open_step 引用不存在的 fact 拒写', () => {
  const { ctl } = seeded();
  assert.throws(() => ctl.apply(openStepOp({ action: 'x', from: ['fact_999'] })), /不存在 fact/);
});

test('drop_step 缺 reason 拒收；空白 reason 同样拒收', () => {
  const { ctl } = seededWithOpenStep();
  assert.throws(() => ctl.apply(dropStepOp({ stepId: 'step_001', reason: '' })), /reason/);
  assert.throws(() => ctl.apply(dropStepOp({ stepId: 'step_001', reason: '   ' })), /reason/);
  const graph = ctl.apply(dropStepOp({ stepId: 'step_001', reason: '目标不可达' }));
  assert.equal(graph.steps[0].state, 'dropped');
  assert.equal(graph.steps[0].reason, '目标不可达');
});

test('change_step_priority 只作用于 open step', () => {
  const { ctl } = seededWithOpenStep();
  const graph = ctl.apply(changePriorityOp({ stepId: 'step_001', priority: 'low' }));
  assert.equal(graph.steps[0].priority, 'low');
  assert.throws(() => ctl.apply(changePriorityOp({ stepId: 'step_404', priority: 'low' })), /step 不存在/);
});

test('satisfy_goal 缺 goalId/reason/satisfiedBy 任一字段拒收（CONTRACT §4）', () => {
  const { ctl } = seeded();
  assert.throws(() => ctl.apply(satisfyGoalOp({ goalId: '', reason: 'r', satisfiedBy: ['fact_origin'] })), /拒收/);
  assert.throws(() => ctl.apply(satisfyGoalOp({ goalId: 'goal_final', reason: '   ', satisfiedBy: ['fact_origin'] })), /拒收/);
  assert.throws(() => ctl.apply(satisfyGoalOp({ goalId: 'goal_final', reason: 'r', satisfiedBy: [] })), /拒收/);
});

test('satisfy_goal 引用不存在的 fact 拒写', () => {
  const { ctl } = seeded();
  assert.throws(
    () => ctl.apply(satisfyGoalOp({ goalId: 'goal_final', reason: 'ok', satisfiedBy: ['fact_777'] })),
    /不存在 fact/,
  );
});

test('FLAG verify hook 失败时不写 satisfied*，且磁盘图不变', () => {
  const { store, ctl } = seeded({ verifyHook: makeRegexFlagVerify() });
  const before = fs.readFileSync(store.graphPath, 'utf8');
  assert.throws(
    () => ctl.apply(satisfyGoalOp({ goalId: 'goal_final', reason: '以为拿到了', satisfiedBy: ['fact_origin'] })),
    /verify hook 拒绝/,
  );
  assert.equal(fs.readFileSync(store.graphPath, 'utf8'), before);
  assert.equal(store.load().goals[0].satisfiedAt, null);
});

test('FLAG verify hook 通过后才写 satisfied*', () => {
  const { store, ctl } = seeded({ verifyHook: makeRegexFlagVerify() });
  ctl.commit(ctl.apply(openStepOp({ action: '取 flag', from: ['fact_origin'] })));
  ctl.commit(ctl.apply(submitFactOp({
    title: 'FLAG 提交: FLAG{demo_ok} 赛方确认',
    content: 'submit_flag ok=true FLAG{demo_ok}',
    producedBy: 'step_001',
  })));
  const graph = ctl.apply(satisfyGoalOp({ goalId: 'goal_final', reason: 'FLAG 已确认', satisfiedBy: ['fact_001'] }));
  ctl.commit(graph);
  const reloaded = store.load();
  assert.equal(reloaded.goals[0].satisfiedAt !== null, true);
  assert.deepEqual(reloaded.goals[0].satisfiedBy, ['fact_001']);
});

test('submit_fact 无 producedBy 拒写（origin 除外，CONTRACT §8）', () => {
  const { ctl } = seededWithOpenStep();
  assert.throws(
    () => ctl.apply(submitFactOp({ title: 't', content: 'c', producedBy: '' })),
    /producedBy/,
  );
});

test('submit_fact 指向非 open step 拒写（一轮只吃一个 open step）', () => {
  const { ctl } = seededWithOpenStep();
  ctl.commit(ctl.apply(submitFactOp({ title: 't', content: 'c', producedBy: 'step_001' })));
  assert.throws(
    () => ctl.apply(submitFactOp({ title: 't2', content: 'c2', producedBy: 'step_001' })),
    /非 open step/,
  );
});

test('submit_fact 收束会把 step 置 done 并回填 to', () => {
  const { ctl } = seededWithOpenStep();
  const graph = ctl.apply(submitFactOp({ title: '开放 80', content: '仅 80 开放', producedBy: 'step_001' }));
  assert.equal(graph.steps[0].state, 'done');
  assert.equal(graph.steps[0].to, 'fact_001');
  assert.equal(graph.facts[1].producedBy, 'step_001');
});

test('fact 蒸馏：title 超 120 字拒写（CONTRACT §7）', () => {
  const { ctl } = seededWithOpenStep();
  assert.throws(
    () => ctl.apply(submitFactOp({ title: 'x'.repeat(121), content: 'c', producedBy: 'step_001' })),
    /title 超/,
  );
});

test('fact 蒸馏：content 超阈值且不是文件路径拒写；是路径则放行', () => {
  const { ctl } = seededWithOpenStep();
  ctl.store.factContentMaxBytes = 10; // 只收紧蒸馏阈值，不动已种好的图
  assert.throws(
    () => ctl.apply(submitFactOp({ title: 't', content: 'y'.repeat(64), producedBy: 'step_001' })),
    /不是单个文件路径/,
  );
  const graph = ctl.apply(submitFactOp({
    title: 't',
    content: 'workspace/out.txt',
    producedBy: 'step_001',
  }));
  assert.equal(graph.facts[1].content, 'workspace/out.txt');
});

test('reopen 清空 satisfied*、追加 feedback Fact，且不删历史（CONTRACT §6）', () => {
  const { ctl } = seeded({ verifyHook: makeRegexFlagVerify() });
  ctl.commit(ctl.apply(openStepOp({ action: '取 flag', from: ['fact_origin'] })));
  ctl.commit(ctl.apply(submitFactOp({
    title: 'FLAG{demo_ok} 有效',
    content: 'FLAG{demo_ok}',
    producedBy: 'step_001',
  })));
  ctl.commit(ctl.apply(satisfyGoalOp({ goalId: 'goal_final', reason: '拿到 flag', satisfiedBy: ['fact_001'] })));

  const before = ctl.store.load();
  const reopened = ctl.apply(reopenOp({ goalId: 'goal_final', reason: '裁判打回：FLAG 无效' }));
  ctl.commit(reopened);
  const after = ctl.store.load();

  const goal = after.goals[0];
  assert.equal(goal.satisfiedBy, null);
  assert.equal(goal.satisfiedReason, null);
  assert.equal(goal.satisfiedAt, null);
  assert.equal(goal.kind, 'final');
  assert.equal(after.facts.length, before.facts.length + 1);
  assert.equal(after.steps.length, before.steps.length);
  const feedback = after.facts[after.facts.length - 1];
  assert.match(feedback.title, /裁判打回/);
  assert.equal(feedback.content, '裁判打回：FLAG 无效');
});

test('reopen 缺 reason 拒写，空白 reason 也拒', () => {
  const { ctl } = seeded();
  assert.throws(() => ctl.apply(reopenOp({ goalId: 'goal_final', reason: '' })), /reason/);
  assert.throws(() => ctl.apply(reopenOp({ goalId: 'goal_final', reason: '  ' })), /reason/);
});

test('ID 规则：fact_NNN / step_NNN 递增（CONTRACT §2）', () => {
  const { ctl } = seededWithOpenStep();
  ctl.commit(ctl.apply(openStepOp({ action: 'b', from: ['fact_origin'] })));
  const graph = ctl.store.load();
  assert.deepEqual(graph.steps.map((s) => s.id), ['step_001', 'step_002']);
  assert.equal(ctl.store.nextFactId(graph), 'fact_001');
});

test('非法 stepId 拒写', () => {
  const { ctl } = seeded();
  assert.throws(
    () => ctl.apply(openStepOp({ action: 'x', from: ['fact_origin'], stepId: 'step_x' })),
    /step id 非法/,
  );
});

test('store.save 是公共 API，但非法图同样拒写（不能绕过校验）', () => {
  const store = newStore();
  assert.throws(() => store.save({ facts: [], goals: [], steps: [] }), WriteRejected);
  assert.ok(!fs.existsSync(store.graphPath));
});

test('safeApply 返回错误而不是抛异常', () => {
  const { ctl } = seeded();
  const result = safeApply(ctl, openStepOp({ action: 'x', from: [] }));
  assert.equal(result.graph, null);
  assert.match(result.error, /from/);
});

test('写图路径强制过 hooks/validate_write 预检（CONTRACT §3）', () => {
  const { ctl } = seededWithOpenStep();
  const appliedBefore = ctl.applied.length;
  assert.throws(() => ctl.apply(dropStepOp({ stepId: 'step_001', reason: '' })), /drop_step 缺 reason/);
  assert.equal(ctl.applied.length, appliedBefore, '预检拒写的 op 不得进入 applied');
});

test('validate 不通过时记入 rejected 并拒写', () => {
  const { store, ctl } = seededWithOpenStep();
  store.validate = () => ['boom'];
  assert.throws(() => ctl.apply(changePriorityOp({ stepId: 'step_001', priority: 'low' })), /boom/);
  assert.equal(ctl.rejected.length, 1);
});

test('fact 蒸馏：title 按码点计数（120 个 emoji 是 120 字，不是 240 字，CONTRACT §7）', () => {
  const { ctl } = seededWithOpenStep();
  const okTitle = '🚩'.repeat(120);
  const graph = ctl.apply(submitFactOp({ title: okTitle, content: 'c', producedBy: 'step_001' }));
  assert.equal([...graph.facts[1].title].length, 120);
  assert.throws(
    () => ctl.apply(submitFactOp({ title: '🚩'.repeat(121), content: 'c', producedBy: 'step_001' })),
    /title 超/,
  );
});

test('verifyMode=command：外部校验命令的退出码 / JSON 判定决定通过与否', () => {
  const graph = { facts: [{ id: 'fact_001', title: 't', content: 'FLAG{x}' }] };
  const op = { goalId: 'goal_final', reason: 'r', satisfiedBy: ['fact_001'] };
  assert.equal(makeCommandVerify('node -e "process.exit(0)"')(graph, op), null);
  assert.match(makeCommandVerify('node -e "process.exit(3)"')(graph, op), /退出码 3/);
  assert.match(
    makeCommandVerify('node -e "process.stdout.write(JSON.stringify({ok:false,reason:\'赛方不认\'}))"')(graph, op),
    /赛方不认/,
  );
  assert.match(makeCommandVerify('definitely-not-a-real-command-fgs')(graph, op), /失败|退出码/);
});

test('verifyMode=command 拒绝时不写 satisfied*', () => {
  const store = newStore();
  const ctl = new Controller(store, { verifyHook: makeCommandVerify('node -e "process.exit(1)"') });
  ctl.commit(ctl.apply(seedOriginOp({ title: '题目信息:', content: '{"target":"http://x"}' })));
  assert.throws(
    () => ctl.apply(satisfyGoalOp({ goalId: 'goal_final', reason: '假装过了', satisfiedBy: ['fact_origin'] })),
    /verify hook 拒绝/,
  );
  assert.equal(store.load().goals[0].satisfiedAt, null);
});

test('makeVerifyHook 各模式：regex 默认 / local / command，且永不返回 null（门不可关）', () => {
  assert.equal(typeof makeVerifyHook({}), 'function');
  assert.equal(typeof makeVerifyHook({ verifyMode: 'local', expectedFlag: 'FLAG{x}' }), 'function');
  assert.equal(typeof makeVerifyHook({ verifyMode: 'command', verifyCommand: 'true' }), 'function');
  // CONTRACT §8：不存在「关掉硬门」的配置；none/未知一律 fail-closed 回退 regex
  assert.equal(typeof makeVerifyHook({ verifyMode: 'none' }), 'function');
  assert.equal(typeof makeVerifyHook({ verifyMode: 'nonsense' }), 'function');
  assert.throws(() => makeVerifyHook({ verifyMode: 'local' }), /expectedFlag/);
  assert.throws(() => makeVerifyHook({ verifyMode: 'command' }), /verifyCommand/);
});

test('三个 golden fixture 全部通过 validate', () => {
  const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
  for (const name of ['origin-only.yaml', 'mid-graph.yaml', 'post-satisfy.yaml']) {
    const store = newStore();
    store.ensureDir();
    fs.writeFileSync(store.graphPath, fs.readFileSync(path.join(fixturesDir, name), 'utf8'), 'utf8');
    assert.deepEqual(store.validate(store.load()), [], `${name} 应无校验错误`);
  }
});
