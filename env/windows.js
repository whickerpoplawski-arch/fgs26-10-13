/**
 * Windows env 层规范化（CONTRACT §9）：统一 WSL / PowerShell 用法。
 *
 * 业务代码不散落平台分支；路径、shell 选择、命令包装统一在此。
 * Host 侧默认走 DSH 自带 bash 工具，本模块为 env 工具的宿主无关规范化层。
 */
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

/** 优先 WSL bash，缺则 PowerShell（Windows），否则本机 bash。 */
export function pickShell(platform = process.platform, which = defaultWhich) {
  if (platform !== 'win32') return 'bash';
  if (which('wsl')) return 'wsl';
  if (which('powershell') || which('pwsh')) return 'powershell';
  return 'bash';
}

function defaultWhich(cmd) {
  const probe = spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd], {
    stdio: 'ignore',
  });
  return probe.status === 0;
}

/** Windows 路径 → WSL 可用 `/mnt/<drive>/...`；非 Windows 路径原样返回。 */
export function toPosix(input) {
  const raw = String(input ?? '');
  if (raw.startsWith('/')) return raw;
  const resolved = path.resolve(raw);
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(resolved);
  if (!m) return resolved.split(path.sep).join('/');
  return `/mnt/${m[1].toLowerCase()}/${m[2].split(/[\\/]/).join('/')}`;
}

/** 组装 shell 调用参数；`cwd` 为工作目录。返回可直接 spawn 的 argv。 */
export function shellArgv(cmd, cwd, shell = pickShell()) {
  const cwdText = String(cwd);
  if (shell === 'wsl') return ['wsl', 'bash', '-c', `cd '${toPosix(cwdText)}' && ${cmd}`];
  if (shell === 'powershell') return ['powershell', '-NoProfile', '-Command', `Set-Location '${cwdText}'; ${cmd}`];
  return ['bash', '-c', cmd];
}

/** 同步执行命令并返回 { stdout, stderr, status, shell }。 */
export function wrapCommand(cmd, cwd, { shell = pickShell(), timeout = 60_000 } = {}) {
  const argv = shellArgv(cmd, cwd, shell);
  const result = spawnSync(argv[0], argv.slice(1), {
    cwd: existsSync(String(cwd)) ? String(cwd) : undefined,
    timeout,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  return {
    shell,
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

/** env 工具输出截断（io-specs filter）。 */
export function truncateOutput(text, maxChars = 32_000) {
  const s = String(text ?? '');
  if (s.length <= maxChars) return s;
  return `${s.slice(0, maxChars)}…(truncated)`;
}
