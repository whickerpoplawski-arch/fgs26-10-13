/**
 * Competition 题索引（方案 A / M1）。
 *
 * 一个 workspace 根 = 一场 Competition（`.fgs/`）。
 * 一道题 = 一个 Project：`.fgs/projects/<problemId>/` 里独立 graph.yaml、
 * workspace/ 与 meta.json。GraphStore 仍是「一个 root 一张图」，多题靠多个实例隔离。
 */
import fs from 'node:fs';
import path from 'node:path';

const ID_RE = /^[a-z0-9_-]{1,64}$/;

export function emptyIndex() {
  return { problems: [], activeProblemId: null };
}

function atomicWrite(filePath, text) {
  const tmp = `${filePath}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, text, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, filePath);
}

export class ProjectRegistry {
  /** @param {string} fgsRoot Competition 根（通常是 `<cwd>/.fgs`）。 */
  constructor(fgsRoot) {
    this.root = fgsRoot;
    this.indexPath = path.join(fgsRoot, 'competition.json');
  }

  /**
   * 规范化 problemId：小写，非法字符转 `_`，最长 64。
   * 空串表示非法（调用方应拒绝）。
   */
  normalizeId(raw) {
    const text = String(raw ?? '').trim().toLowerCase();
    const slug = text.replace(/[^a-z0-9_-]/g, '_').slice(0, 64);
    return slug;
  }

  isValidId(id) {
    return typeof id === 'string' && ID_RE.test(id);
  }

  /** 读 competition.json。文件不存在 → 空索引。顺带做一次旧单图迁移。 */
  load() {
    this.migrateLegacy();
    if (!fs.existsSync(this.indexPath)) return emptyIndex();
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(this.indexPath, 'utf8'));
    } catch (error) {
      throw new Error(`competition.json 无法解析: ${error.message}`);
    }
    const problems = Array.isArray(parsed?.problems) ? parsed.problems : [];
    const active = typeof parsed?.activeProblemId === 'string' ? parsed.activeProblemId : null;
    return {
      problems: problems.map((item) => ({
        id: String(item.id),
        title: typeof item.title === 'string' ? item.title : String(item.id),
        createdAt: item.createdAt ?? null,
        state: item.state ?? 'created',
      })),
      activeProblemId: active,
    };
  }

  /** 原子写索引（tmp + fsync + rename）。 */
  save(index) {
    fs.mkdirSync(this.root, { recursive: true });
    const body = {
      problems: (index?.problems ?? []).map((item) => ({
        id: item.id,
        title: item.title,
        createdAt: item.createdAt,
        state: item.state ?? 'created',
      })),
      activeProblemId: index?.activeProblemId ?? null,
    };
    atomicWrite(this.indexPath, `${JSON.stringify(body, null, 2)}\n`);
  }

  /** @returns {{id:string,title:string,state:string,createdAt:string|null}[]} */
  list() {
    return this.load().problems.map((item) => ({ ...item }));
  }

  /**
   * 建 Project：校验 slug 唯一，mkdir projects/<id>/workspace，写 meta.json 与索引。
   * 不种题、不改 activeProblemId（由 /fgs new 在创建后 setActive）。
   */
  create({ id, title } = {}) {
    const slug = this.normalizeId(id);
    if (!this.isValidId(slug)) {
      throw new Error(`problemId 非法: ${id ?? ''}（须为 [a-z0-9_-]{1,64}，非法字符会转成 _）`);
    }
    if (this.exists(slug)) throw new Error(`Project 已存在: ${slug}`);
    const root = this.projectRoot(slug);
    fs.mkdirSync(path.join(root, 'workspace'), { recursive: true });
    const createdAt = new Date().toISOString();
    const record = {
      id: slug,
      title: title && String(title).trim() ? String(title).trim() : slug,
      createdAt,
      state: 'created',
    };
    this.writeMeta(slug, {
      id: slug,
      title: record.title,
      state: 'created',
      model: null,
      budget: null,
      roundSeq: 0,
      createdAt,
    });
    const index = this.load();
    index.problems.push(record);
    this.save(index);
    return record;
  }

  exists(id) {
    const slug = this.normalizeId(id);
    if (!this.isValidId(slug)) return false;
    this.migrateLegacy();
    const index = this.readIndexFile();
    if (index.problems.some((item) => item.id === slug)) return true;
    return fs.existsSync(this.projectRoot(slug));
  }

  /** projects/<id> 绝对路径。非法 id 抛错，避免路径穿越。 */
  projectRoot(id) {
    const slug = this.normalizeId(id);
    if (!this.isValidId(slug)) {
      throw new Error(`problemId 非法: ${id ?? ''}`);
    }
    const projectsDir = path.resolve(this.root, 'projects');
    const root = path.resolve(projectsDir, slug);
    if (root !== path.join(projectsDir, slug)) {
      throw new Error(`problemId 路径越界: ${id}`);
    }
    const relative = path.relative(projectsDir, root);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`problemId 路径越界: ${id}`);
    }
    return root;
  }

  setActive(id) {
    const slug = this.normalizeId(id);
    if (!this.exists(slug)) throw new Error(`Project 不存在: ${slug}`);
    const index = this.load();
    index.activeProblemId = slug;
    this.save(index);
    return slug;
  }

  getActive() {
    const index = this.load();
    const id = index.activeProblemId;
    if (!id || !this.isValidId(id)) return null;
    if (!index.problems.some((item) => item.id === id) && !fs.existsSync(this.projectRoot(id))) {
      return null;
    }
    return id;
  }

  readMeta(id) {
    const file = path.join(this.projectRoot(id), 'meta.json');
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  }

  writeMeta(id, meta) {
    const root = this.projectRoot(id);
    fs.mkdirSync(root, { recursive: true });
    atomicWrite(path.join(root, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`);
  }

  /** 同步索引里的 state（meta.json 由调用方另写）。 */
  setProblemState(id, state) {
    const slug = this.normalizeId(id);
    const index = this.load();
    const item = index.problems.find((entry) => entry.id === slug);
    if (!item) return;
    item.state = state;
    this.save(index);
  }

  /**
   * 旧单图兼容：`.fgs/graph.yaml` 存在且还没有 `projects/` 时，
   * 迁到 `projects/default/`，原文件留 `.bak`。幂等。
   */
  migrateLegacy() {
    const legacyYaml = path.join(this.root, 'graph.yaml');
    const projectsDir = path.join(this.root, 'projects');
    if (!fs.existsSync(legacyYaml)) return false;
    if (fs.existsSync(projectsDir)) return false;

    const dest = path.resolve(projectsDir, 'default');
    fs.mkdirSync(path.join(dest, 'workspace'), { recursive: true });
    fs.copyFileSync(legacyYaml, path.join(dest, 'graph.yaml'));
    const legacyJson = path.join(this.root, 'graph.json');
    if (fs.existsSync(legacyJson)) {
      fs.copyFileSync(legacyJson, path.join(dest, 'graph.json'));
    }
    fs.renameSync(legacyYaml, path.join(this.root, 'graph.yaml.bak'));
    if (fs.existsSync(legacyJson)) {
      fs.renameSync(legacyJson, path.join(this.root, 'graph.json.bak'));
    }

    const createdAt = new Date().toISOString();
    const index = this.readIndexFile();
    if (!index.problems.some((item) => item.id === 'default')) {
      index.problems.push({
        id: 'default',
        title: 'default',
        createdAt,
        state: 'seeded',
      });
    }
    if (!index.activeProblemId) index.activeProblemId = 'default';
    this.save(index);
    const metaPath = path.join(dest, 'meta.json');
    if (!fs.existsSync(metaPath)) {
      atomicWrite(metaPath, `${JSON.stringify({
        id: 'default',
        title: 'default',
        state: 'seeded',
        model: null,
        budget: null,
        roundSeq: 0,
        createdAt,
      }, null, 2)}\n`);
    }
    return true;
  }

  /** 读索引但不触发迁移（migrate / exists 用，避免递归）。 */
  readIndexFile() {
    if (!fs.existsSync(this.indexPath)) return emptyIndex();
    try {
      const parsed = JSON.parse(fs.readFileSync(this.indexPath, 'utf8'));
      return {
        problems: Array.isArray(parsed?.problems) ? parsed.problems.map((item) => ({
          id: String(item.id),
          title: typeof item.title === 'string' ? item.title : String(item.id),
          createdAt: item.createdAt ?? null,
          state: item.state ?? 'created',
        })) : [],
        activeProblemId: typeof parsed?.activeProblemId === 'string' ? parsed.activeProblemId : null,
      };
    } catch (error) {
      throw new Error(`competition.json 无法解析: ${error.message}`);
    }
  }
}
