/**
 * `verifyMode: command` 的真实链路测试（CONTRACT §8 的「赛方 ACK」路径）。
 *
 * 这条路径此前只有单元测试、从没在真实链路上跑过。这里用一个**独立进程**的
 * stub 冒充赛方提交接口（必须独立进程：插件的 verifyCommand 走 spawnSync，
 * 会阻塞父进程事件循环，同进程 stub 永远响应不了），端到端验证
 * tools/submit_flag.mjs 与 makeCommandVerify 的配合：
 *   200 / 409 → 放行；403 → 拒收；缺 token / 接口不可达 / 抽不到 flag → fail-closed 拒收。
 * 顺带锁住「真实竞赛的小写 flag{...} 必须能过门」这条从 b-02 真题素材得出的结论。
 */
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { Controller, GraphStore } from '../controller/index.js';
import { WriteRejected, openStepOp, satisfyGoalOp, seedOriginOp, submitFactOp } from '../controller/ops.js';
import { defaultFlagRegex, makeVerifyHook } from '../hooks/flag_verify.js';
import { tmpDir } from './helpers.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, '..', 'tools', 'submit_flag.mjs');
const STUB = path.join(HERE, 'stub_platform.mjs');
const COMMAND = `node ${JSON.stringify(SCRIPT)}`;

let stub;
let stubUrl;

before(async () => {
  stub = spawn(process.execPath, [STUB], { stdio: ['ignore', 'pipe', 'inherit'] });
  stubUrl = await new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error('stub 启动超时')), 8000);
    stub.stdout.on('data', (chunk) => {
      buf += chunk;
      const match = buf.match(/PORT (\d+)/);
      if (match) {
        clearTimeout(timer);
        resolve(`http://127.0.0.1:${match[1]}`);
      }
    });
    stub.on('error', reject);
  });
});

after(() => { stub?.kill(); });

/** 造一张「已解出、fact 里带 flag」的图，返回可提交的 satisfy_goal op。 */
function graphWithFlag(flag) {
  const store = new GraphStore(tmpDir(), {});
  const ctl = new Controller(store, {});
  ctl.commit(ctl.apply(seedOriginOp({
    title: '题目信息:',
    content: '{"unique_code":"b-02","target":"http://10.0.167.146:80"}',
  })));
  ctl.commit(ctl.apply(openStepOp({ action: '打靶并取 flag', from: ['fact_origin'] })));
  ctl.commit(ctl.apply(submitFactOp({
    title: `拿到 flag：${flag}`,
    content: `exploit 成功后读到 ${flag}`,
    producedBy: 'step_001',
  })));
  return { store, ctl, op: satisfyGoalOp({ goalId: 'goal_final', reason: '已提交', satisfiedBy: ['fact_001'] }) };
}

function withEnv(env, body) {
  const saved = {};
  for (const key of Object.keys(env)) { saved[key] = process.env[key]; process.env[key] = env[key]; }
  try {
    return body();
  } finally {
    for (const key of Object.keys(env)) {
      if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
    }
  }
}

const OK_ENV = () => ({ BENCHMARK_BASE_URL: stubUrl, BENCHMARK_TOKEN: 'tok-test', FGS_UNIQUE_CODE: 'b-02' });

test('§8 command 模式：小写 flag{...} 经赛方接口判对 → 放行', () => {
  const { ctl, op } = graphWithFlag('flag{live_case_001}');
  const hook = makeVerifyHook({ verifyMode: 'command', verifyCommand: COMMAND });
  withEnv(OK_ENV(), () => {
    assert.equal(hook(ctl.store.load(), op), null, '赛方判对就必须放行');
  });
});

test('§8 command 模式：409 重复提交（此前已判对）→ 放行', () => {
  const { ctl, op } = graphWithFlag('flag{dup_0001}');
  const hook = makeVerifyHook({ verifyMode: 'command', verifyCommand: COMMAND });
  withEnv(OK_ENV(), () => {
    assert.equal(hook(ctl.store.load(), op), null, '409 = 之前已判对，必须放行');
  });
});

test('§8 command 模式：赛方 403 判错 → 拒收且不写 satisfied*', () => {
  const { ctl, op, store } = graphWithFlag('flag{bad_0001}');
  ctl.verifyHook = makeVerifyHook({ verifyMode: 'command', verifyCommand: COMMAND });
  withEnv(OK_ENV(), () => {
    assert.throws(() => ctl.apply(op), WriteRejected);
  });
  assert.equal(store.load().goals[0].satisfiedAt, null, '没过门就绝不能写 satisfied*');
});

test('§8 command 模式：fail-closed —— 缺 token / 接口不可达 / 抽不到 flag 都拒收', () => {
  const { ctl, op, store } = graphWithFlag('flag{ok_0009}');
  const hook = makeVerifyHook({ verifyMode: 'command', verifyCommand: COMMAND });

  withEnv({ BENCHMARK_BASE_URL: stubUrl, BENCHMARK_TOKEN: '', FGS_UNIQUE_CODE: 'b-02' }, () => {
    assert.match(String(hook(store.load(), op)), /BENCHMARK_TOKEN/, '没有 token 不得放行');
  });

  withEnv({ BENCHMARK_BASE_URL: 'http://127.0.0.1:1', BENCHMARK_TOKEN: 't', FGS_UNIQUE_CODE: 'b-02' }, () => {
    assert.ok(String(hook(store.load(), op)).length > 0, '接口不可达不得放行');
  });

  withEnv({ ...OK_ENV(), FGS_FLAG_PATTERN: 'NOPE\\{[0-9]+\\}' }, () => {
    assert.match(String(hook(store.load(), op)), /flag 形态/, '抽不到 flag 不得放行');
  });
});

test('verifyMode 缺 verifyCommand 时构造即抛错（硬门不允许配置不全）', () => {
  assert.throws(() => makeVerifyHook({ verifyMode: 'command' }), /verifyCommand/);
});

test('默认 flag 正则以真实竞赛的小写 flag{...} 为准，并兼容全大写', () => {
  const re = defaultFlagRegex();
  assert.ok(re.test('flag{abc12345}'), '百度竞赛真实形态必须匹配（早期默认值在这里是 NO MATCH）');
  assert.ok(re.test('FLAG{abc12345}'), '全大写也要兼容');
  assert.ok(!re.test('flag{}'), '太短不算');
  assert.ok(!re.test('flag{a b}'), '含空格不算');
});
