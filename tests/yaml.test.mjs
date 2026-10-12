/** yaml.js：FGS 图 YAML 子集读写（CONTRACT §2）。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { dump, load } from '../yaml.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, '..', 'fixtures');
const FIXTURES = ['origin-only.yaml', 'mid-graph.yaml', 'post-satisfy.yaml'];

test('三个 golden fixture 都能解析出 facts/goals/steps', () => {
  for (const name of FIXTURES) {
    const doc = load(fs.readFileSync(path.join(fixturesDir, name), 'utf8'));
    assert.ok(Array.isArray(doc.facts), `${name} facts`);
    assert.ok(Array.isArray(doc.goals), `${name} goals`);
    assert.ok(Array.isArray(doc.steps), `${name} steps`);
    assert.equal(doc.facts[0].id, 'fact_origin');
    assert.equal(doc.goals[0].id, 'goal_final');
  }
});

test('fixture 里的块标量、时间串、流式空数组都按预期解析', () => {
  const origin = load(fs.readFileSync(path.join(fixturesDir, 'origin-only.yaml'), 'utf8'));
  assert.equal(origin.steps.length, 0);
  assert.equal(typeof origin.facts[0].content, 'string');
  assert.match(origin.facts[0].content, /baidu-demo-01/);
  assert.equal(origin.facts[0].createdAt, '2026-10-11T09:00:00.000Z');
  assert.equal(origin.goals[0].kind, 'final');
});

test('mid-graph 的 from 序列与 producedBy 解析正确', () => {
  const doc = load(fs.readFileSync(path.join(fixturesDir, 'mid-graph.yaml'), 'utf8'));
  const step2 = doc.steps.find((s) => s.id === 'step_002');
  assert.deepEqual(step2.from, ['fact_001']);
  assert.equal(step2.state, 'open');
  assert.equal(doc.facts.find((f) => f.id === 'fact_001').producedBy, 'step_001');
});

test('post-satisfy 的 satisfied* 解析正确', () => {
  const doc = load(fs.readFileSync(path.join(fixturesDir, 'post-satisfy.yaml'), 'utf8'));
  const goal = doc.goals[0];
  assert.deepEqual(goal.satisfiedBy, ['fact_002']);
  assert.equal(goal.satisfiedAt, '2026-10-11T09:21:00.000Z');
  assert.match(goal.satisfiedReason, /FLAG\{demo_01_ok\}/);
});

test('dump → load 往返对三个 fixture 保持结构一致', () => {
  for (const name of FIXTURES) {
    const text = fs.readFileSync(path.join(fixturesDir, name), 'utf8');
    const doc = load(text);
    assert.deepEqual(load(dump(doc)), doc, `${name} 往返`);
  }
});

test('dump 是合法 YAML 形态：顶层键顺序 facts → goals → steps', () => {
  const text = dump({ facts: [], goals: [], steps: [] });
  assert.equal(text, 'facts: []\ngoals: []\nsteps: []\n');
});

test('需要转义的字符串不会破坏往返', () => {
  const doc = {
    facts: [
      {
        id: 'fact_origin',
        title: '带 "引号" 与: 冒号 和 #井号',
        content: '多行\n  缩进行\n\t制表符\n末行',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
      { id: 'fact_001', title: '中文标题 emoji 🚩', producedBy: 'step_001' },
    ],
    goals: [{ id: 'goal_final', kind: 'final', criterion: 'c', createdAt: '2026-01-01T00:00:00.000Z' }],
    steps: [
      {
        id: 'step_001',
        action: 'a: b',
        from: ['fact_origin'],
        actor: 'agent',
        priority: 'high',
        state: 'done',
        createdAt: '2026-01-01T00:00:00.000Z',
        to: 'fact_001',
      },
    ],
  };
  assert.deepEqual(load(dump(doc)), doc);
});

test('单引号、数字、布尔、null 都能读', () => {
  const doc = load([
    "a: 'it''s ok'",
    'b: 42',
    'c: true',
    'd: null',
    'e: [x, y, 3]',
  ].join('\n'));
  assert.equal(doc.a, "it's ok");
  assert.equal(doc.b, 42);
  assert.equal(doc.c, true);
  assert.equal(doc.d, null);
  assert.deepEqual(doc.e, ['x', 'y', 3]);
});

test('注释与空行被忽略', () => {
  const doc = load('# 头注释\n\nfacts: []\n\n# 中间注释\ngoals: []\n');
  assert.deepEqual(doc, { facts: [], goals: [] });
});

test('带前导注释的顶层序列不会被重复解析（cordis.patch.yml 形态）', () => {
  const text = [
    '# 说明注释',
    '- insert:',
    '    - id: fgs-deepseek',
    "      name: '@local/fgs-deepseek-dsh'",
    '      config:',
    '        stateDir: .fgs',
    "        flagPattern: 'FLAG\\{[^}\\s]{4,}\\}'",
    '',
  ].join('\n');
  const doc = load(text);
  assert.equal(doc.length, 1, `应只有一个顶层元素，实际 ${doc.length}`);
  assert.equal(doc[0].insert.length, 1);
  assert.equal(doc[0].insert[0].id, 'fgs-deepseek');
  assert.equal(doc[0].insert[0].config.stateDir, '.fgs');
  assert.equal(doc[0].insert[0].config.flagPattern, 'FLAG\\{[^}\\s]{4,}\\}');
});

test('真实的 cordis.patch.yml 解析成单条 insert', () => {
  const text = fs.readFileSync(path.join(here, '..', 'cordis.patch.yml'), 'utf8');
  const doc = load(text);
  assert.equal(doc.length, 1);
  assert.equal(doc[0].insert[0].name, '@local/fgs-deepseek-dsh');
});

test('真实 cordis.patch.yml 里的 flag 配置能匹配竞赛真题的小写 flag{...}', () => {
  // 回归 b-02 真题素材暴露的问题：patch 里显式写死过大写 pattern +
  // 且没有 i，导致真 flag 也被 §8 硬门拒收。patch 是实际生效的配置，
  // 所以必须直接对着文件断言，光改 DEFAULT_CONFIG 不够。
  const text = fs.readFileSync(path.join(here, '..', 'cordis.patch.yml'), 'utf8');
  const config = load(text)[0].insert[0].config;
  assert.equal(config.verifyMode, 'regex');
  const flags = String(config.flagFlags ?? '').replace(/g/g, '');
  const re = new RegExp(config.flagPattern, flags);
  assert.ok(re.test('flag{abc12345}'), `patch 的 flag 配置匹配不了真题形态: ${config.flagPattern}`);
  assert.ok(re.test('FLAG{abc12345}'), '全大写也要兼容');
});
