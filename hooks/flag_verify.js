/**
 * FLAG 外部校验 hook（CONTRACT §8）。
 *
 * commit 前必须过外部校验（提交成功 / 正则 / 赛方 ACK）；不过则不写 satisfied*。
 * 契约层拦截，不靠 prompt。
 */
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

/**
 * 赛方 flag 正则示例。**默认按小写写，并配 `i` 编译**：
 * 真实竞赛（百度渗透竞赛实测）的 flag 形态是 `flag{...}` 小写，
 * 而本插件早期默认值是全大写 `FLAG\{...\}` 且无 `i`——
 * 结果拿到真题的真 flag 也会被 §8 硬门拒收（只有自己敲的 FLAG{} 假数据能过）。
 * 现在 `flag{...}` 与 `FLAG{...}` 都能匹配。
 */
export const DEFAULT_FLAG_PATTERN = 'flag\\{[^}\\s]{4,}\\}';

/** 默认 flags：忽略大小写。`g` 会让 RegExp.test 变有状态，一律剔除。 */
export const DEFAULT_FLAG_FLAGS = 'i';

export function defaultFlagRegex(flags = DEFAULT_FLAG_FLAGS) {
  return new RegExp(DEFAULT_FLAG_PATTERN, String(flags).replace(/g/g, ''));
}

/** 本地假 CTF 校验器：satisfiedBy 引用的 facts 里必须出现 expectedFlag。 */
export function makeLocalFlagVerify(expectedFlag) {
  return (graph, op) => {
    const byId = new Map(graph.facts.map((f) => [f.id, f]));
    for (const fid of op.satisfiedBy ?? []) {
      const fact = byId.get(fid);
      if (!fact) return `satisfiedBy 引用不存在 fact: ${fid}`;
      const blob = `${fact.title ?? ''}\n${fact.content ?? ''}`;
      if (!String(blob).includes(expectedFlag)) return `fact ${fid} 未含有效 flag 证据`;
    }
    return null;
  };
}

/** 正则校验器：satisfiedBy 引用的 facts 里必须含匹配 flagRe 的串。 */
export function makeRegexFlagVerify(flagRe = defaultFlagRegex()) {
  return (graph, op) => {
    const byId = new Map(graph.facts.map((f) => [f.id, f]));
    for (const fid of op.satisfiedBy ?? []) {
      const fact = byId.get(fid);
      if (!fact) return `satisfiedBy 引用不存在 fact: ${fid}`;
      const blob = `${fact.title ?? ''}\n${fact.content ?? ''}`;
      if (!flagRe.test(String(blob))) return `fact ${fid} 未匹配 flag 正则`;
    }
    return null;
  };
}

/** 永久拒绝校验器：verifyMode=none 时显式记录「未配置外部校验」。 */
export function makeDenyAllVerify(reason = 'verifyMode=none：未配置 FLAG 外部校验 hook') {
  return () => reason;
}

/**
 * 命令校验器：把待校验内容写到 verifyCommand 的 stdin，
 * 退出码 0 = 通过；非 0 = 拒绝（stderr/stdout 前 300 字作原因）。
 *
 * 这就是 CONTRACT §8 的「赛方 ACK / 提交成功」路径：
 * 外部校验器可以查本地 flag 文件、调赛方 API、比对提交回执。
 * stdout 收到 JSON 时，若含 {"ok": false, "reason": "..."} 也按拒绝处理。
 */
export function makeCommandVerify(command, options = {}) {
  const timeout = options.timeoutMs ?? 20_000;
  const cwd = options.cwd ?? process.cwd();
  return (graph, op) => {
    const payload = {
      goalId: op.goalId,
      reason: op.reason,
      satisfiedBy: op.satisfiedBy,
      facts: (graph.facts ?? [])
        .filter((f) => (op.satisfiedBy ?? []).includes(f.id))
        .map((f) => ({ id: f.id, title: f.title, content: f.content ?? null })),
    };
    const result = spawnSync(command, {
      shell: true,
      input: JSON.stringify(payload),
      encoding: 'utf8',
      timeout,
      cwd,
    });
    if (result.error) return `verify command 启动失败: ${result.error.message}`;
    const stderr = (result.stderr ?? '').trim();
    const stdout = (result.stdout ?? '').trim();
    if (result.status !== 0) {
      return `verify command 退出码 ${result.status}: ${(stderr || stdout || '无输出').slice(0, 300)}`;
    }
    if (stdout.startsWith('{')) {
      try {
        const verdict = JSON.parse(stdout);
        if (verdict && verdict.ok === false) {
          return `verify command 判定未过: ${String(verdict.reason ?? '未给原因').slice(0, 300)}`;
        }
      } catch {
        /* stdout 不是 JSON：只看退出码 */
      }
    }
    return null;
  };
}

/**
 * 按配置构造校验器。**永不返回 null**：CONTRACT §8 要求 satisfy_goal 提交前
 * 必须过外部校验，硬门不允许被配置关掉。
 * - regex（默认）：satisfiedBy 引用的 fact 文本须匹配 flagPattern
 * - local：须含 expectedFlag
 * - command：外部校验命令（赛方 ACK / 提交回执），退出码 0 才算过
 * - 其它/未识别/none：回退到 regex（fail-closed；要放行请把 flagPattern 显式设宽，
 *   让「本运行不做外部校验」这件事留在配置里可见，而不是把门拆掉）
 */
export function makeVerifyHook(config) {
  const mode = config?.verifyMode ?? 'regex';
  if (mode === 'local') {
    if (!config?.expectedFlag) {
      throw new Error('verifyMode=local 需要配置 expectedFlag');
    }
    return makeLocalFlagVerify(config.expectedFlag);
  }
  if (mode === 'command') {
    if (!config?.verifyCommand) {
      throw new Error('verifyMode=command 需要配置 verifyCommand（读取 stdin 的校验命令，退出码 0 = 通过）');
    }
    return makeCommandVerify(config.verifyCommand, { timeoutMs: config.verifyTimeoutMs });
  }
  const flags = String(config?.flagFlags ?? DEFAULT_FLAG_FLAGS).replace(/g/g, '');
  return makeRegexFlagVerify(new RegExp(config?.flagPattern || DEFAULT_FLAG_PATTERN, flags));
}

/** 辅助：workspace flag 文件内容（含换行清理）。 */
export function checkFlagFile(workspace, filename = 'flag.txt') {
  const p = path.join(String(workspace), filename);
  if (!existsSync(p)) return null;
  return readFileSync(p, 'utf8').trim();
}
