/**
 * FGS 图 YAML 子集读写（CONTRACT §2）。
 *
 * 主真相是 YAML，顶层键仅 `facts` → `goals` → `steps`。
 * 本模块只实现 FGS 文档用到的 YAML 子集，避免引入外部依赖：
 *   - 块映射 / 块序列（序列与父键同缩进，匹配 PyYAML 默认输出）
 *   - `|` `|-` `|+` 与 `>` 折叠块标量
 *   - 双引号 / 单引号标量、普通标量（string|number|bool|null）
 *   - 空流式 `[]` `{}` 与简单流式序列 `[a, b]`
 *
 * 不支持锚点/别名/多文档/复杂键/流式映射 —— FGS 文档不产生这些形态。
 */

const NUM_RE = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

function sp(n) {
  return ' '.repeat(n);
}

/* ------------------------------------------------------------------ dump */

/** 把普通对象渲染成 YAML 文本（键顺序即对象插入顺序，不做排序）。 */
export function dump(doc) {
  const out = [];
  emitMap(doc, 0, out);
  return `${out.join('\n')}\n`;
}

function emitMap(obj, indent, out) {
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined) continue;
    emitEntry(key, value, indent, out, null);
  }
}

/**
 * 输出一条 `key: value`。`firstPrefix` 用于序列项的内联首键（`- key: value`）。
 */
function emitEntry(key, value, indent, out, firstPrefix) {
  const head = (firstPrefix ?? sp(indent)) + key;
  if (Array.isArray(value)) {
    if (value.length === 0) {
      out.push(`${head}: []`);
      return;
    }
    out.push(`${head}:`);
    emitSeq(value, indent, out);
    return;
  }
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value);
    if (keys.length === 0) {
      out.push(`${head}: {}`);
      return;
    }
    out.push(`${head}:`);
    emitMap(value, indent + 2, out);
    return;
  }
  if (typeof value === 'string' && value.includes('\n')) {
    const trailingNl = value.endsWith('\n');
    out.push(`${head}: ${trailingNl ? '|' : '|-'}`);
    const body = trailingNl ? value.slice(0, -1).split('\n') : value.split('\n');
    for (const line of body) out.push(line === '' ? '' : sp(indent + 2) + line);
    return;
  }
  out.push(`${head}: ${scalar(value)}`);
}

function emitSeq(arr, indent, out) {
  for (const item of arr) {
    if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
      const keys = Object.keys(item).filter((k) => item[k] !== undefined);
      if (keys.length === 0) {
        out.push(`${sp(indent)}- {}`);
        continue;
      }
      keys.forEach((key, i) => {
        if (i === 0) {
          emitEntry(key, item[key], indent + 2, out, `${sp(indent)}- `);
        } else {
          emitEntry(key, item[key], indent + 2, out, null);
        }
      });
      continue;
    }
    if (Array.isArray(item)) {
      out.push(`${sp(indent)}-`);
      emitSeq(item, indent + 2, out);
      continue;
    }
    out.push(`${sp(indent)}- ${scalar(item)}`);
  }
}

function scalar(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : JSON.stringify(String(value));
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') return JSON.stringify(value);
  return JSON.stringify(String(value));
}

/* ------------------------------------------------------------------ load */

/** 解析 YAML 子集文本为普通对象。空文档返回 null。 */
export function load(text) {
  const cursor = new Cursor(String(text ?? ''));
  const value = cursor.parseBlock(0);
  return value;
}

class Cursor {
  constructor(text) {
    this.lines = text.split(/\r?\n/).map((raw) => ({
      raw,
      indent: raw.length - raw.trimStart().length,
      trimmed: raw.trim(),
    }));
    this.pos = 0;
  }

  /** 跳过空行与整行注释，返回下一个有效行（不前进）。 */
  peek() {
    let i = this.pos;
    while (i < this.lines.length) {
      const line = this.lines[i];
      if (line.trimmed !== '' && !line.trimmed.startsWith('#')) return line;
      i += 1;
    }
    return null;
  }

  /** 跳过空行与注释。 */
  skip() {
    while (this.pos < this.lines.length) {
      const line = this.lines[this.pos];
      if (line.trimmed !== '' && !line.trimmed.startsWith('#')) break;
      this.pos += 1;
    }
  }

  /**
   * 消费当前有效行。
   *
   * 必须先 skip()：peek() 是「逻辑上跳过空行/注释但不移动 pos」，
   * 若直接 pos++ 会在有前导注释/空行时把同一行当成下一项重新解析。
   */
  advance() {
    this.skip();
    this.pos += 1;
  }

  parseBlock(minIndent) {
    const line = this.peek();
    if (line === null || line.indent < minIndent) return null;
    const t = line.raw.trimStart();
    if (t === '-' || t.startsWith('- ')) return this.parseSeq(line.indent);
    return this.parseMap(line.indent);
  }

  parseMap(indent) {
    const obj = {};
    for (;;) {
      const line = this.peek();
      if (line === null || line.indent < indent) break;
      if (line.indent > indent) throw new Error(`YAML 缩进异常（第 ${this.pos + 1} 行）: ${line.raw}`);
      const t = line.raw.trimStart();
      if (t === '-' || t.startsWith('- ')) break;
      const kv = splitKey(t);
      if (kv === null) throw new Error(`YAML 非法映射行（第 ${this.pos + 1} 行）: ${line.raw}`);
      this.advance();
      obj[kv.key] = this.readValue(kv.rest, indent);
    }
    return obj;
  }

  parseSeq(indent) {
    const arr = [];
    for (;;) {
      const line = this.peek();
      if (line === null || line.indent !== indent) break;
      const t = line.raw.trimStart();
      if (!(t === '-' || t.startsWith('- '))) break;
      this.advance();
      const rest = t === '-' ? '' : t.slice(2).trim();
      if (rest === '') {
        const next = this.peek();
        arr.push(next !== null && next.indent > indent ? this.parseBlock(indent + 1) : null);
        continue;
      }
      const kv = splitKey(rest);
      if (kv === null) {
        arr.push(parseScalar(rest));
        continue;
      }
      const item = {};
      item[kv.key] = this.readValue(kv.rest, indent + 1);
      const more = this.tryPeekIndent(indent + 2);
      if (more) Object.assign(item, this.parseMap(indent + 2));
      arr.push(item);
    }
    return arr;
  }

  tryPeekIndent(indent) {
    const line = this.peek();
    return line !== null && line.indent >= indent;
  }

  /** 解析 `key:` 之后的值（rest 为去掉 `key:` 后的内容）。 */
  readValue(rest, indent) {
    if (rest === '') {
      const next = this.peek();
      if (next === null) return null;
      if (next.indent > indent) return this.parseBlock(indent + 1);
      if (next.indent === indent) {
        const t = next.raw.trimStart();
        if (t === '-' || t.startsWith('- ')) return this.parseSeq(indent);
      }
      return null;
    }
    const head = rest[0];
    if (head === '|' || head === '>') return this.readBlockScalar(rest, indent);
    return parseScalar(rest);
  }

  readBlockScalar(header, parentIndent) {
    const folded = header[0] === '>';
    const chomp = header.includes('-') ? 'strip' : header.includes('+') ? 'keep' : 'clip';
    const collected = [];
    let contentIndent = null;
    while (this.pos < this.lines.length) {
      const line = this.lines[this.pos];
      if (line.trimmed === '') {
        collected.push({ blank: true, text: '' });
        this.pos += 1;
        continue;
      }
      if (line.indent <= parentIndent) break;
      if (contentIndent === null) contentIndent = line.indent;
      collected.push({
        blank: false,
        text: line.raw.length >= contentIndent ? line.raw.slice(contentIndent) : line.raw.trimStart(),
      });
      this.pos += 1;
    }
    // 去掉尾部空行（clip/keep 再按 chomp 补回）
    while (collected.length > 0 && collected[collected.length - 1].blank) collected.pop();
    let body;
    if (folded) {
      let acc = '';
      for (const entry of collected) {
        if (entry.blank) acc += '\n';
        else acc += acc === '' || acc.endsWith('\n') ? entry.text : ` ${entry.text}`;
      }
      body = acc;
    } else {
      body = collected.map((entry) => entry.text).join('\n');
    }
    if (chomp === 'strip') return body;
    if (chomp === 'keep') return `${body}\n`;
    return `${body}\n`;
  }
}

/** 切出 `key: rest`；`:` 必须后接空格或行尾，且不在引号内。 */
function splitKey(text) {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (c === '\\' && inDouble) {
      i += 1;
      continue;
    }
    if (c === '"' && !inSingle) inDouble = !inDouble;
    else if (c === "'" && !inDouble) inSingle = !inSingle;
    else if (c === ':' && !inSingle && !inDouble && (i + 1 === text.length || text[i + 1] === ' ')) {
      const key = text.slice(0, i).trim();
      if (key === '') return null;
      return { key: unquote(key), rest: text.slice(i + 1).trim() };
    }
  }
  return null;
}

function unquote(text) {
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    try {
      return JSON.parse(text);
    } catch {
      return text.slice(1, -1);
    }
  }
  if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) {
    return text.slice(1, -1).replace(/''/g, "'");
  }
  return text;
}

function parseScalar(text) {
  const t = text.trim();
  if (t === '' || t === '~' || t === 'null' || t === 'Null' || t === 'NULL') return null;
  if (t === '[]') return [];
  if (t === '{}') return {};
  if (t.startsWith('[') && t.endsWith(']')) return splitFlow(t.slice(1, -1)).map(parseScalar);
  if (t.startsWith('{') && t.endsWith('}')) {
    const obj = {};
    for (const part of splitFlow(t.slice(1, -1))) {
      const kv = splitKey(part);
      if (kv) obj[kv.key] = parseScalar(kv.rest);
    }
    return obj;
  }
  if (t.startsWith('"') && t.endsWith('"') && t.length >= 2) {
    try {
      return JSON.parse(t);
    } catch {
      return t.slice(1, -1);
    }
  }
  if (t.startsWith("'") && t.endsWith("'") && t.length >= 2) {
    return t.slice(1, -1).replace(/''/g, "'");
  }
  if (t === 'true' || t === 'True' || t === 'TRUE') return true;
  if (t === 'false' || t === 'False' || t === 'FALSE') return false;
  if (NUM_RE.test(t)) return Number(t);
  return t;
}

function splitFlow(text) {
  const parts = [];
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (c === '\\' && inDouble) {
      i += 1;
      continue;
    }
    if (c === '"' && !inSingle) inDouble = !inDouble;
    else if (c === "'" && !inDouble) inSingle = !inSingle;
    else if (!inSingle && !inDouble) {
      if (c === '[' || c === '{') depth += 1;
      else if (c === ']' || c === '}') depth -= 1;
      else if (c === ',' && depth === 0) {
        parts.push(text.slice(start, i).trim());
        start = i + 1;
      }
    }
  }
  const tail = text.slice(start).trim();
  if (tail !== '') parts.push(tail);
  return parts;
}
