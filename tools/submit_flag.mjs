#!/usr/bin/env node
/**
 * 赛方 FLAG 提交校验器（CONTRACT §8 的「赛方 ACK」路径）。
 *
 * 用作 `verifyMode: command` 的 verifyCommand：插件在 satisfy_goal 提交前，
 * 把待校验内容写到本脚本的 stdin；退出码 0 = 通过，非 0 = 拒绝。
 *
 * stdin（插件写入）:
 *   { goalId, reason, satisfiedBy: [...], facts: [{ id, title, content }] }
 *
 * 行为:
 *   1) 从 facts 文本里抽出所有 flag 形态（默认 flag{...}，大小写不敏感）
 *   2) 逐个 POST 到赛方提交接口
 *   3) 200/201 = 正确；409 = 重复提交（说明此前已判对）→ 也按通过
 *   4) 全部通过才 exit 0；任一失败 exit 1，并在 stdout 打出 {"ok":false,"reason":...}
 *
 * 环境变量:
 *   BENCHMARK_BASE_URL | PLATFORM_BASE_URL   赛方基址（必填）
 *   BENCHMARK_TOKEN                          赛方 token（必填）
 *   FGS_UNIQUE_CODE | BENCHMARK_UNIQUE_CODE  题目编号，如 b-02（必填，或从 payload 文本里找）
 *   FGS_FLAG_PATTERN                         覆盖 flag 抽取正则（默认 flag\{[^}\s]{4,}\}）
 *   FGS_VERIFY_DRY_RUN=1                     不真提交，只回显将要提交的内容（调试用）
 *
 * 设计取向：**fail-closed**。环境变量缺失、接口不可达、响应无法判定，一律按拒绝。
 * 宁可挡住一次真 FLAG，也不让假 FLAG 过门。
 */

const SUBMIT_PATH = '/openapi/v1/challenges/submit';
const DEFAULT_FLAG_PATTERN = 'flag\\{[^}\\s]{4,}\\}';

function readStdin() {
  return new Promise((resolve) => {
    let buf = '';
    if (process.stdin.isTTY) {
      resolve('');
      return;
    }
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { buf += chunk; });
    process.stdin.on('end', () => resolve(buf));
  });
}

/** 收集 facts 的全部文本（title + content）。 */
function blobOf(payload) {
  const facts = Array.isArray(payload?.facts) ? payload.facts : [];
  return facts.map((f) => `${f?.title ?? ''}\n${f?.content ?? ''}`).join('\n');
}

function extractFlags(text, pattern) {
  let re;
  try {
    re = new RegExp(pattern, 'gi');
  } catch (error) {
    throw new Error(`flag 正则非法: ${error.message}`);
  }
  const found = new Set();
  for (const match of String(text).matchAll(re)) found.add(match[0]);
  return [...found];
}

/** unique_code：环境变量优先，其次从 payload 文本里找 "unique_code": "xxx"。 */
function resolveUniqueCode(text) {
  const fromEnv = process.env.FGS_UNIQUE_CODE || process.env.BENCHMARK_UNIQUE_CODE;
  if (fromEnv && String(fromEnv).trim() !== '') return String(fromEnv).trim();
  const match = String(text).match(/"unique_code"\s*:\s*"([A-Za-z0-9_-]{1,64})"/);
  return match ? match[1] : null;
}

function baseUrl() {
  const raw = process.env.BENCHMARK_BASE_URL || process.env.PLATFORM_BASE_URL || '';
  return String(raw).trim().replace(/\/+$/, '');
}

function reject(reason) {
  process.stdout.write(`${JSON.stringify({ ok: false, reason })}\n`);
  process.exit(1);
}

async function submit(base, token, uniqueCode, flag) {
  const url = `${base}${SUBMIT_PATH}`;
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
        'x-benchmark-token': token,
      },
      body: JSON.stringify({ unique_code: uniqueCode, flag }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    return { accepted: false, note: `提交请求失败: ${error.message}` };
  }
  const bodyText = await response.text().catch(() => '');
  const snippet = bodyText.slice(0, 200).replace(/\s+/g, ' ');
  // 200/201 = 判对；409 = 重复提交（此前已判对）→ 也视为已达成
  if (response.ok) return { accepted: true, note: `${response.status}` };
  if (response.status === 409) return { accepted: true, note: '409 duplicate（此前已判对）' };
  return { accepted: false, note: `HTTP ${response.status} ${snippet}` };
}

async function main() {
  const raw = await readStdin();
  let payload = {};
  try {
    payload = raw.trim() === '' ? {} : JSON.parse(raw);
  } catch {
    reject('stdin 不是合法 JSON（插件应传入 {goalId, reason, satisfiedBy, facts[]}）');
  }

  const text = blobOf(payload);
  const pattern = process.env.FGS_FLAG_PATTERN || DEFAULT_FLAG_PATTERN;
  let flags;
  try {
    flags = extractFlags(text, pattern);
  } catch (error) {
    reject(error.message);
  }
  if (flags.length === 0) {
    reject(`satisfiedBy 引用的 fact 里没有 flag 形态（pattern=${pattern}）`);
  }

  const uniqueCode = resolveUniqueCode(text);
  if (!uniqueCode) reject('缺 unique_code（设 FGS_UNIQUE_CODE 或在 fact 文本里给出 "unique_code"）');
  const token = String(process.env.BENCHMARK_TOKEN || '').trim();
  if (!token) reject('缺 BENCHMARK_TOKEN（fail-closed：没有 token 就不放行）');
  const base = baseUrl();
  if (!base) reject('缺 BENCHMARK_BASE_URL / PLATFORM_BASE_URL（fail-closed）');

  if (process.env.FGS_VERIFY_DRY_RUN === '1') {
    process.stderr.write(`[dry-run] 将提交 ${flags.length} 枚 flag 到 ${base}${SUBMIT_PATH} (unique_code=${uniqueCode})\n`);
    process.stdout.write(`${JSON.stringify({ ok: true, reason: 'dry-run' })}\n`);
    return;
  }

  const failed = [];
  for (const flag of flags) {
    const result = await submit(base, token, uniqueCode, flag);
    process.stderr.write(`[submit] ${uniqueCode} ${flag} -> ${result.accepted ? 'ACCEPT' : 'REJECT'} (${result.note})\n`);
    if (!result.accepted) failed.push(`${flag}: ${result.note}`);
  }
  if (failed.length > 0) reject(`赛方未全部判对：${failed.join(' | ')}`);

  process.stdout.write(`${JSON.stringify({ ok: true, reason: `${flags.length} 枚 flag 全部被赛方接受` })}\n`);
}

main().catch((error) => reject(`校验器异常: ${error?.message ?? error}`));
