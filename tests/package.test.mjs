/**
 * 打包清单守卫（回归一次真实的安装失败）。
 *
 * GitHub / git / registry 安装会走 pnpm 打包，`files` 白名单会过滤文件；
 * 而本地 `link:` 安装只是软链目录，白名单根本不生效。
 * 所以「清单里声明的入口不在 files 里」这种错，本地永远看不出来，
 * 只有真装进 profile 才炸：
 *   dsh: failed to read overlay .../@local/fgs-deepseek-dsh/cordis.patch.yml: ENOENT
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

/** npm/pnpm 无论如何都会打包 package.json，不受 files 影响。 */
const ALWAYS_PACKED = new Set(['package.json']);

function norm(rel) {
  return String(rel).replace(/^\.\//, '');
}

/** 白名单项既可能是单个文件，也可能是目录前缀。 */
function covered(rel) {
  const target = norm(rel);
  return (pkg.files ?? []).some((entry) => {
    const e = norm(entry).replace(/\/$/, '');
    return target === e || target.startsWith(`${e}/`);
  });
}

/** manifest 里所有指向包内文件的相对路径。 */
function declaredFiles() {
  const out = new Set();
  if (pkg.dsh?.bundle?.patch) out.add(pkg.dsh.bundle.patch);
  if (pkg.icon) out.add(pkg.icon);
  if (pkg.main) out.add(pkg.main);
  for (const target of Object.values(pkg.exports ?? {})) {
    if (typeof target === 'string') out.add(target);
    else if (target && typeof target === 'object') {
      for (const v of Object.values(target)) if (typeof v === 'string') out.add(v);
    }
  }
  return [...out].filter((rel) => rel.startsWith('.'));
}

test('bundle patch（cordis.patch.yml）存在、在白名单里，且是合法 insert 行', () => {
  const patchRel = pkg.dsh?.bundle?.patch;
  assert.ok(patchRel, 'package.json 必须声明 dsh.bundle.patch');
  const abs = path.join(root, patchRel);
  assert.ok(fs.existsSync(abs), `${patchRel} 不存在`);
  // ← 这一条就是那次安装失败的根因：文件在，但被 files 过滤掉了
  assert.ok(covered(patchRel), `${patchRel} 不在 files 白名单里 —— 打包安装会丢它（dsh 报 ENOENT）`);
  const patch = fs.readFileSync(abs, 'utf8');
  assert.match(patch, /-\s*insert:/);
  assert.match(patch, /id:\s*fgs-deepseek/);
});

test('package.json 声明的每个入口文件都被 files 白名单覆盖', () => {
  const declared = declaredFiles();
  assert.ok(declared.length > 0, '没有解析到任何声明入口');
  for (const rel of declared) {
    if (rel.includes('*')) continue; // 通配（如 ./locale/*.json）由下一条用例覆盖
    assert.ok(fs.existsSync(path.join(root, rel)), `${rel} 不存在`);
    if (ALWAYS_PACKED.has(norm(rel))) continue;
    assert.ok(covered(rel), `${rel} 不在 files 白名单里 —— 打包安装会丢文件`);
  }
});

test('运行期用相对路径读取的资源都在白名单里', () => {
  // index.js: readFileSync(new URL(`./io-specs/${role}.io.yaml`, import.meta.url))
  for (const rel of ['io-specs/decide.io.yaml', 'io-specs/execute.io.yaml']) {
    assert.ok(fs.existsSync(path.join(root, rel)), `${rel} 不存在`);
    assert.ok(covered(rel), `${rel} 不在 files 白名单里 —— 装到 profile 后 Decide/Execute 规范读不到`);
  }
  // dsh.client 指向的客户端半
  assert.ok(covered('client.js'), 'client.js 不在 files 白名单里 —— 面板装不上');
});

test('exports 里的通配目录确实有文件', () => {
  const wildcard = Object.values(pkg.exports ?? {}).find((v) => typeof v === 'string' && v.includes('*'));
  if (!wildcard) return;
  const dir = path.dirname(norm(wildcard));
  assert.ok(fs.existsSync(path.join(root, dir)), `${dir} 不存在`);
  assert.ok(fs.readdirSync(path.join(root, dir)).length > 0, `${dir} 是空的`);
  assert.ok(covered(dir), `${dir} 不在 files 白名单里`);
});

test('files 白名单里的每一项都真实存在（防止改名后留下僵尸条目）', () => {
  for (const entry of pkg.files ?? []) {
    assert.ok(fs.existsSync(path.join(root, entry)), `files 里的 ${entry} 不存在`);
  }
});
