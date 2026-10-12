/**
 * M1 Project 隔离：一题一图、命令、迁移、改图必须有活动 Project。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { apply as applyPlugin } from '../index.js';
import { ProjectRegistry } from '../controller/projects.js';
import { callRoute, ensureActiveProject, makeFakeAgent, makeFakeHost, projectGraphPath, tmpDir, wireServices } from './helpers.mjs';

const FIXTURE = path.join(import.meta.dirname, '..', 'fixtures', 'origin-only.yaml');

function boot(overrides = {}) {
  const host = makeFakeHost();
  const services = wireServices(host);
  host.ctx.services = { ...host.ctx.services, ...services };
  applyPlugin(host.ctx, { stateDir: '.fgs', verifyMode: 'regex', ...overrides });
  const cwd = tmpDir();
  const agent = makeFakeAgent('sess-proj', cwd);
  host.emit('agent/created', { agent });
  const command = host.commands.find((item) => item.name === 'fgs');
  const fgs = (raw) => command.handler({ agent, rawInput: raw });
  return { host, agent, cwd, command, fgs };
}

async function seed(host, agent, brief) {
  const result = await host.callTool('fgs_seed', { brief }, agent);
  assert.equal(result.ok, true, result.text);
  return result;
}

test('ProjectRegistry：建 3 题互不覆盖，slug 化，重复 id 拒', () => {
  const root = path.join(tmpDir(), '.fgs');
  const registry = new ProjectRegistry(root);
  const a = registry.create({ id: 'Alpha', title: '题 A' });
  const b = registry.create({ id: 'beta_2' });
  const c = registry.create({ id: 'My Problem!' });
  assert.equal(a.id, 'alpha');
  assert.equal(b.id, 'beta_2');
  assert.equal(c.id, 'my_problem_');
  assert.equal(registry.list().length, 3);
  assert.equal(registry.getActive(), null, 'create 本身不切换活动题');
  for (const id of ['alpha', 'beta_2', 'my_problem_']) {
    const dir = registry.projectRoot(id);
    assert.equal(fs.existsSync(path.join(dir, 'workspace')), true);
    assert.equal(fs.existsSync(path.join(dir, 'meta.json')), true);
    const meta = registry.readMeta(id);
    assert.equal(meta.id, id);
    assert.equal(meta.state, 'created');
    assert.equal(meta.roundSeq, 0);
    assert.equal(fs.existsSync(path.join(dir, 'graph.yaml')), false, '建题不种图');
  }
  assert.throws(() => registry.create({ id: 'ALPHA' }), /已存在/);
  assert.throws(() => registry.create({ id: '' }), /非法/);
  assert.throws(() => registry.create({ id: '   ' }), /非法/);
  registry.setActive('beta_2');
  assert.equal(registry.getActive(), 'beta_2');
  assert.throws(() => registry.setActive('missing'), /不存在/);

  const sneaky = registry.normalizeId('../etc/passwd');
  assert.match(sneaky, /^[a-z0-9_-]+$/);
  assert.equal(sneaky.includes('/'), false);
  assert.equal(sneaky.includes('..'), false);
  const parked = registry.create({ id: '../etc/passwd' });
  const parkedRoot = registry.projectRoot(parked.id);
  assert.equal(parkedRoot.startsWith(path.resolve(root, 'projects') + path.sep), true);
  const index = JSON.parse(fs.readFileSync(registry.indexPath, 'utf8'));
  assert.equal(index.activeProblemId, 'beta_2');
  assert.equal(index.problems.length, 4);
});

test('/fgs new|switch|list：活动题切换后 status 指向该题', async () => {
  const { host, agent, cwd, fgs } = boot();
  const listedEmpty = fgs('list');
  assert.equal(listedEmpty.kind, 'success');
  assert.match(listedEmpty.text, /无 Project/);

  const created = fgs('new alpha');
  assert.equal(created.kind, 'success', JSON.stringify(created));
  assert.match(created.text, /alpha/);
  assert.equal(fs.existsSync(path.join(cwd, '.fgs', 'projects', 'alpha', 'workspace')), true);
  assert.equal(fs.existsSync(path.join(cwd, '.fgs', 'competition.json')), true);
  const titled = fgs('new titled 端口扫描题');
  assert.equal(titled.kind, 'success', JSON.stringify(titled));
  assert.match(fs.readFileSync(path.join(cwd, '.fgs', 'projects', 'titled', 'meta.json'), 'utf8'), /端口扫描题/);
  fgs('switch alpha');

  await seed(host, agent, 'alpha-brief');
  await host.callTool('fgs_commit', {
    operations: [{ op: 'open_step', action: '扫 alpha', from: ['fact_origin'] }],
  }, agent);

  const beta = fgs('new beta');
  assert.equal(beta.kind, 'success', JSON.stringify(beta));
  await seed(host, agent, 'beta-brief');

  const list = fgs('list');
  assert.match(list.text, /\* beta/);
  assert.match(list.text, /alpha/);
  assert.match(list.text, /role=/);
  assert.match(list.text, /open=/);
  assert.match(list.text, /satisfied=/);
  assert.match(list.text, /Execute/);
  assert.match(list.text, /Decide/);

  const statusBeta = fgs('status');
  assert.match(statusBeta.text, /Project beta/);
  assert.match(statusBeta.text, /open=0/);

  const switched = fgs('switch alpha');
  assert.equal(switched.kind, 'success');
  const statusAlpha = fgs('status');
  assert.match(statusAlpha.text, /Project alpha/);
  assert.match(statusAlpha.text, /open=1/);
  const missing = fgs('switch nope');
  assert.equal(missing.kind, 'error');
  assert.match(missing.text, /不存在/);
});

test('两题隔离：图、草稿、workspace、同一 turn 下的 commit_step 互不串', async () => {
  const { host, agent, cwd, fgs } = boot();
  fgs('new alpha');
  await seed(host, agent, 'brief-a');
  const drafted = await host.callTool('fgs_open_step', { action: '只属于 A', from: ['fact_origin'] }, agent);
  assert.equal(drafted.ok, true, drafted.text);
  const drafted2 = await host.callTool('fgs_open_step', { action: 'A 的第二步', from: ['fact_origin'] }, agent);
  assert.equal(drafted2.ok, true, drafted2.text);

  fgs('new beta');
  await seed(host, agent, 'brief-b');
  const betaStatus = await host.callTool('fgs_status', {}, agent);
  assert.match(betaStatus.text, /Project: beta/);
  assert.doesNotMatch(betaStatus.text, /草稿/);
  const betaCommit = await host.callTool('fgs_commit', {}, agent);
  assert.equal(betaCommit.ok, false);
  assert.match(betaCommit.text, /草稿为空/);

  fgs('switch alpha');
  const alphaCommit = await host.callTool('fgs_commit', {}, agent);
  assert.equal(alphaCommit.ok, true, alphaCommit.text);
  fgs('new gamma');
  await seed(host, agent, 'brief-g');
  await host.callTool('fgs_commit', {
    operations: [{ op: 'open_step', action: '只属于 C', from: ['fact_origin'] }],
  }, agent);

  const alphaYaml = fs.readFileSync(projectGraphPath(cwd, 'alpha'), 'utf8');
  const betaYaml = fs.readFileSync(projectGraphPath(cwd, 'beta'), 'utf8');
  const gammaYaml = fs.readFileSync(projectGraphPath(cwd, 'gamma'), 'utf8');
  assert.match(alphaYaml, /只属于 A/);
  assert.doesNotMatch(alphaYaml, /只属于 C/);
  assert.doesNotMatch(betaYaml, /step_001/);
  assert.match(gammaYaml, /只属于 C/);
  assert.doesNotMatch(gammaYaml, /只属于 A/);
  assert.notEqual(
    path.join(cwd, '.fgs', 'projects', 'alpha', 'workspace'),
    path.join(cwd, '.fgs', 'projects', 'gamma', 'workspace'),
  );

  host.ctx.setTurn(7);
  fgs('switch alpha');
  assert.equal((await host.callTool('fgs_submit_fact', { title: 'a-fact', content: 'a' }, agent)).ok, true);
  assert.equal((await host.callTool('fgs_commit_step', {}, agent)).ok, true);
  const second = await host.callTool('fgs_commit_step', {}, agent);
  assert.equal(second.ok, false);
  assert.match(second.text, /一轮只吃一个 open step/);

  fgs('switch gamma');
  assert.equal((await host.callTool('fgs_submit_fact', { title: 'g-fact', content: 'g' }, agent)).ok, true);
  const satisfy = await host.callTool('fgs_satisfy_goal', {
    goalId: 'goal_final', reason: 'r', satisfiedBy: ['fact_001'],
  }, agent);
  assert.equal(satisfy.ok, false);
  assert.match(satisfy.text, /Execute 轮不得调用/);
  const gammaClose = await host.callTool('fgs_commit_step', {}, agent);
  assert.equal(gammaClose.ok, true, gammaClose.text);
  assert.doesNotMatch(fs.readFileSync(projectGraphPath(cwd, 'alpha'), 'utf8'), /g-fact/);
  assert.doesNotMatch(fs.readFileSync(projectGraphPath(cwd, 'gamma'), 'utf8'), /a-fact/);

  fgs('switch beta');
  const betaAgain = await host.callTool('fgs_status', {}, agent);
  assert.match(betaAgain.text, /Project: beta/);
  assert.doesNotMatch(betaAgain.text, /草稿/);
  assert.match(betaAgain.text, /Decide/);
});

test('旧 .fgs/graph.yaml 在首次访问时迁到 projects/default 并留 .bak', async () => {
  const cwd = tmpDir();
  const fgsRoot = path.join(cwd, '.fgs');
  fs.mkdirSync(fgsRoot, { recursive: true });
  const original = fs.readFileSync(FIXTURE, 'utf8');
  fs.writeFileSync(path.join(fgsRoot, 'graph.yaml'), original);
  fs.writeFileSync(path.join(fgsRoot, 'graph.json'), '{"facts":[],"goals":[],"steps":[]}\n');

  const host = makeFakeHost();
  wireServices(host);
  host.ctx.services = { ...host.ctx.services, ...{ systemPrompt: host.ctx.systemPrompt, commands: host.ctx.commands, webServer: host.ctx.webServer } };
  applyPlugin(host.ctx, { stateDir: '.fgs' });
  const agent = makeFakeAgent('sess-migrate', cwd);
  const command = host.commands.find((item) => item.name === 'fgs');
  const listed = command.handler({ agent, rawInput: 'list' });
  assert.equal(listed.kind, 'success', JSON.stringify(listed));
  assert.match(listed.text, /\* default/);
  assert.match(listed.text, /fact_origin|Decide|satisfied=no/);

  const migrated = fs.readFileSync(projectGraphPath(cwd), 'utf8');
  assert.equal(migrated, original);
  assert.equal(fs.readFileSync(path.join(fgsRoot, 'graph.yaml.bak'), 'utf8'), original);
  assert.equal(fs.existsSync(path.join(fgsRoot, 'graph.yaml')), false);
  assert.equal(fs.existsSync(path.join(fgsRoot, 'graph.json.bak')), true);
  const index = JSON.parse(fs.readFileSync(path.join(fgsRoot, 'competition.json'), 'utf8'));
  assert.equal(index.activeProblemId, 'default');
  assert.equal(fs.existsSync(path.join(cwd, '.fgs', 'projects', 'default', 'workspace')), true);
  assert.equal(fs.existsSync(path.join(cwd, '.fgs', 'projects', 'default', 'meta.json')), true);

  const again = command.handler({ agent, rawInput: 'list' });
  assert.equal(fs.readFileSync(projectGraphPath(cwd), 'utf8'), original, '重复访问不得覆盖已迁移的图');
  assert.match(again.text, /default/);
});

test('没有活动 Project 时改图被拒（fgs_seed / open_step / commit）', async () => {
  const { host, agent, fgs } = boot();
  for (const [name, args] of [
    ['fgs_seed', { brief: 'x' }],
    ['fgs_open_step', { action: 'a', from: ['fact_origin'] }],
    ['fgs_commit', {}],
    ['fgs_submit_fact', { title: 't' }],
  ]) {
    const denied = await host.callTool(name, args, agent);
    assert.equal(denied.ok, false, name);
    assert.match(denied.text, /没有活动 Project/, name);
  }
  const status = await host.callTool('fgs_status', {}, agent);
  assert.equal(status.ok, true);
  assert.match(status.text, /没有活动 Project/);

  const created = fgs('new lone');
  assert.equal(created.kind, 'success');
  const beforeSeed = await host.callTool('fgs_open_step', { action: 'a', from: ['fact_origin'] }, agent);
  assert.equal(beforeSeed.ok, false);
  assert.match(beforeSeed.text, /fgs_seed|种题/);
  await seed(host, agent, 'now-active');
  const opened = await host.callTool('fgs_open_step', { action: 'a', from: ['fact_origin'] }, agent);
  assert.equal(opened.ok, true, opened.text);
});

test('/fgs init 是 new default 的兼容别名', async () => {
  const { cwd, fgs } = boot();
  const missing = fgs('init');
  assert.equal(missing.kind, 'error');
  const init = fgs('init 目标 http://x 拿 FLAG');
  assert.equal(init.kind, 'success', JSON.stringify(init));
  assert.match(init.text, /graph\.yaml/);
  assert.equal(fs.existsSync(projectGraphPath(cwd, 'default')), true);
  assert.match(fs.readFileSync(projectGraphPath(cwd, 'default'), 'utf8'), /fact_origin/);
  const again = fgs('init 再来一次');
  assert.equal(again.kind, 'error');
  assert.match(again.text, /已经种过题/);
});

test('HTTP /fgs/state 支持 ?problemId=，无参回退活动 Project', async () => {
  const { host, agent, cwd, fgs } = boot();
  ensureActiveProject(host, agent, 'alpha');
  await seed(host, agent, 'alpha-brief');
  await host.callTool('fgs_commit', {
    operations: [{ op: 'open_step', action: 'alpha-step', from: ['fact_origin'] }],
  }, agent);
  fgs('new beta');
  await seed(host, agent, 'beta-brief');

  const active = await callRoute(host.routes[0], '/fgs/state');
  assert.equal(active.json.problemId, 'beta');
  assert.equal(active.json.role, 'decide');
  assert.equal(active.json.root, path.join(cwd, '.fgs', 'projects', 'beta'));

  const alpha = await callRoute(host.routes[0], '/fgs/state?problemId=alpha');
  assert.equal(alpha.json.active, true);
  assert.equal(alpha.json.problemId, 'alpha');
  assert.equal(alpha.json.role, 'execute');
  assert.equal(alpha.json.counts.open, 1);
  assert.equal(alpha.json.steps[0].action, 'alpha-step');

  const bySession = await callRoute(host.routes[0], '/fgs/state?sessionId=sess-proj&problemId=alpha');
  assert.equal(bySession.json.problemId, 'alpha');
  const other = await callRoute(host.routes[0], '/fgs/state?sessionId=someone-else&problemId=alpha');
  assert.equal(other.json.active, false);

  assert.equal(active.json.pluginGeneration, 6);
  assert.match(active.json.buildTag, /\+project/);
  assert.match(active.json.buildTag, /\+attach/);
  assert.match(active.json.buildTag, /\+fgs-project-tool/);
  assert.match(active.json.buildTag, /\+lowercase-flag/);
  assert.doesNotMatch(active.json.buildTag, /clean-session/);
});

/* ---------------------------- 认领（attach）：重启后不要求重新种题 ---------------------------- */

/** 在既有 workspace 上重新 apply —— 等价于「进程重启」：内存 runs/registries 全空，磁盘保留。 */
function bootAt(cwd, overrides = {}) {
  const host = makeFakeHost();
  const services = wireServices(host);
  host.ctx.services = { ...host.ctx.services, ...services };
  applyPlugin(host.ctx, { stateDir: '.fgs', verifyMode: 'regex', ...overrides });
  const agent = makeFakeAgent('sess-proj', cwd);
  host.emit('agent/created', { agent });
  const command = host.commands.find((item) => item.name === 'fgs');
  return { host, agent, cwd, command, fgs: (raw) => command.handler({ agent, rawInput: raw }) };
}

test('认领：重启后内存无 run，已种题的 Project 不得被报成「尚未种题」', async () => {
  const first = boot();
  await ensureActiveProject(first.host, first.agent, 'restart');
  await seed(first.host, first.agent, 'restart-brief');

  // 模拟重启：同一 workspace 重新 apply，内存里的 run 全部为空
  const second = bootAt(first.cwd);

  const status = await second.host.callTool('fgs_status', {}, second.agent);
  assert.equal(status.ok, true, status.text);
  assert.doesNotMatch(status.text, /尚未种题/, '磁盘已种题，不能报「尚未种题」');
  assert.match(status.text, /facts=1/);

  // 关键：图工具必须直接可用，不需要先 fgs_seed（旧实现在这里自相矛盾、互相锁死）
  const opened = await second.host.callTool(
    'fgs_open_step', { action: '重启后继续', from: ['fact_origin'] }, second.agent,
  );
  assert.equal(opened.ok, true, opened.text);
});

test('认领：重启后 fgs_seed 的报错必须给出出路（已认领，直接开 step）', async () => {
  const first = boot();
  await ensureActiveProject(first.host, first.agent, 'restart');
  await seed(first.host, first.agent, 'restart-brief');

  const second = bootAt(first.cwd);
  const again = await second.host.callTool('fgs_seed', { brief: '再来一次' }, second.agent);
  assert.equal(again.ok, false, '同一个 Project 仍然只种一次');
  assert.match(again.text, /已经种过题/);
  assert.match(again.text, /已认领/, '报错里必须写明已认领并给出下一步');

  const opened = await second.host.callTool(
    'fgs_open_step', { action: 'x', from: ['fact_origin'] }, second.agent,
  );
  assert.equal(opened.ok, true, opened.text);
});

test('/fgs off 之后不会被 auto-attach 立刻拉回来', async () => {
  const { host, agent, fgs } = boot();
  assert.equal(fgs('new offproj').kind, 'success');
  await seed(host, agent, 'off-brief');
  assert.doesNotMatch(fgs('status').text, /未启动/);

  assert.equal(fgs('off').kind, 'success');
  assert.match(fgs('status').text, /未启动/, 'off 之后必须保持未启动');
  assert.equal(fgs('status').kind, 'success');

  const denied = await host.callTool('fgs_open_step', { action: 'a', from: ['fact_origin'] }, agent);
  assert.equal(denied.ok, false);
  assert.match(denied.text, /fgs off/, '拒绝原因要说是 off 了，而不是「先种题」');

  // 重新进入：switch 回来即可（图与 Project 一直在磁盘上）
  assert.equal(fgs('switch offproj').kind, 'success');
  const back = await host.callTool('fgs_open_step', { action: 'a', from: ['fact_origin'] }, agent);
  assert.equal(back.ok, true, back.text);
});

/* ------------------------------- fgs_project：agent 可自主建题 / 换题 ------------------------------- */

test('fgs_project：没有活动 Project 时也能自主建题并直接种题', async () => {
  const { host, agent } = boot();
  const empty = await host.callTool('fgs_project', { action: 'list' }, agent);
  assert.equal(empty.ok, true, empty.text);
  assert.match(empty.text, /无 Project/);

  const created = await host.callTool('fgs_project', {
    action: 'new',
    problemId: 'Baidu-01',
    brief: '目标 http://x 拿 FLAG',
    target: 'http://x',
  }, agent);
  assert.equal(created.ok, true, created.text);
  assert.match(created.text, /已种题/);

  const status = await host.callTool('fgs_status', {}, agent);
  assert.match(status.text, /Project: baidu-01/, 'problemId 必须被 slug 化');

  const opened = await host.callTool('fgs_open_step', { action: 'a', from: ['fact_origin'] }, agent);
  assert.equal(opened.ok, true, opened.text);
});

test('fgs_project：switch 换题后角色跟着图换，题与题的 run 互不影响', async () => {
  const { host, agent } = boot();
  await host.callTool('fgs_project', { action: 'new', problemId: 'a1', brief: 'A 题' }, agent);
  const opened = await host.callTool('fgs_commit', {
    operations: [{ op: 'open_step', action: 'a-step', from: ['fact_origin'] }],
  }, agent);
  assert.equal(opened.ok, true, opened.text);
  assert.match((await host.callTool('fgs_status', {}, agent)).text, /Execute/);

  // Execute 轮里建第二题（PROJECT_TOOLS 无条件放行）→ 切过去是它自己的新图
  const second = await host.callTool('fgs_project', { action: 'new', problemId: 'b2', brief: 'B 题' }, agent);
  assert.equal(second.ok, true, second.text);
  let status = await host.callTool('fgs_status', {}, agent);
  assert.match(status.text, /Project: b2/);
  assert.match(status.text, /Decide/);

  const back = await host.callTool('fgs_project', { action: 'switch', problemId: 'a1' }, agent);
  assert.equal(back.ok, true, back.text);
  status = await host.callTool('fgs_status', {}, agent);
  assert.match(status.text, /Project: a1/);
  assert.match(status.text, /Execute/, 'a1 的 open step 还在，角色必须回到 Execute');

  const listed = await host.callTool('fgs_project', { action: 'list' }, agent);
  assert.match(listed.text, /a1/);
  assert.match(listed.text, /b2/);
  assert.match(listed.text, /\* a1/, '活动题要有标记');
});

test('fgs_project：problemId 非法 / 未知 action 都要被拒', async () => {
  const { host, agent } = boot();
  const bad = await host.callTool('fgs_project', { action: 'new', problemId: '   ' }, agent);
  assert.equal(bad.ok, false);
  assert.match(bad.text, /problemId/);
  const unknown = await host.callTool('fgs_project', { action: 'destroy', problemId: 'x' }, agent);
  assert.equal(unknown.ok, false);
  assert.match(unknown.text, /未知 action/);
});
