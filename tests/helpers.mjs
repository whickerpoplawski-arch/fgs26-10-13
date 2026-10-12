/**
 * 测试脚手架：最小 Cordis 假宿主 + 临时运行目录。
 *
 * 只实现插件真正用到的那种 API 子集，用来离线驱动 Host 半：
 * tools.register / tools.guard / tools.schemas、on、inject、effect。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function tmpDir(prefix = 'fgs-dsh-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** 活动 Project 的 graph.yaml（M1 起图不再落在 `.fgs/graph.yaml`）。 */
export function projectGraphPath(cwd, problemId = 'default', stateDir = '.fgs') {
  return path.join(cwd, stateDir, 'projects', problemId, 'graph.yaml');
}

export function projectJsonPath(cwd, problemId = 'default', stateDir = '.fgs') {
  return path.join(cwd, stateDir, 'projects', problemId, 'graph.json');
}

/** 建 Project 并切到它。已存在则 switch。 */
export function ensureActiveProject(host, agent, problemId = 'default') {
  const command = host.commands.find((item) => item.name === 'fgs') ?? host.commands[0];
  const created = command.handler({ agent, rawInput: `new ${problemId}` });
  if (created.kind === 'error') {
    return command.handler({ agent, rawInput: `switch ${problemId}` });
  }
  return created;
}

export function makeFakeHost() {
  const tools = new Map();
  const guards = [];
  const events = new Map();
  const commands = [];
  const routes = [];
  const sections = [];
  const contexts = [];
  const restrictions = [];
  const effects = [];
  let currentTurn = 1;

  const sessionProjections = {
    stateOf(_session, projectionName) {
      if (projectionName !== 'turnBoundary') return undefined;
      return { lastTurn: currentTurn, openTurnStartSeq: 0 };
    },
  };

  const ctx = {
    tools: {
      register(definition) {
        tools.set(definition.name, definition);
        return () => tools.delete(definition.name);
      },
      guard(guard) {
        guards.push(guard);
        return () => {
          const i = guards.indexOf(guard);
          if (i >= 0) guards.splice(i, 1);
        };
      },
      schemas() {
        return [...tools.values()].map((d) => ({
          name: d.name,
          description: d.description,
          parameters: d.parameters,
        }));
      },
      restrict(filter) {
        restrictions.push(filter);
        return () => {};
      },
    },
    on(event, listener) {
      if (!events.has(event)) events.set(event, []);
      events.get(event).push(listener);
      return () => {};
    },
    inject(_deps, callback) {
      callback(ctx);
      return () => {};
    },
    get(name) {
      return ctx.services?.[name];
    },
    effect(fn) {
      const cleanup = fn();
      effects.push(cleanup);
      return () => {
        if (typeof cleanup === 'function') cleanup();
      };
    },
    services: { sessionProjections },
  };

  ctx.setTurn = (n) => {
    currentTurn = n;
  };

  const invokeGuard = (name, args, agent) => {
    for (const guard of guards) {
      const verdict = guard({ name, arguments: args, agent });
      if (typeof verdict === 'string' && verdict !== '') return verdict;
    }
    return null;
  };

  const callTool = async (name, args, agent) => {
    const definition = tools.get(name);
    if (!definition) return { ok: false, text: `UNKNOWN_TOOL ${name}`, denied: null };
    const denied = invokeGuard(name, args, agent);
    if (denied !== null) return { ok: false, text: denied, denied };
    const value = await definition.execute(args, {
      name,
      arguments: args,
      agent,
      concludeTurn() {
        if (agent) agent.concluded = true;
      },
    });
    const content = definition.output.render(args, value);
    return { ok: value.ok, text: value.text, value, content };
  };

  const emit = (event, payload) => {
    for (const listener of events.get(event) ?? []) listener(payload);
  };

  return { ctx, tools, guards, commands, routes, sections, contexts, restrictions, effects, callTool, emit };
}

/** 假 agent：只带插件用到的字段。 */
export function makeFakeAgent(id, cwd) {
  const agent = {
    id,
    concluded: false,
    session: { header: { cwd } },
    restrictFilters: [],
    ctx: {
      tools: {
        restrict(filter) {
          agent.restrictFilters.push(filter);
          return () => {};
        },
      },
    },
  };
  return agent;
}

/** 注册假 systemPrompt / commands / webServer 到假宿主。 */
export function wireServices(host) {
  const sp = {
    section(definition) {
      host.sections.push(definition);
      return () => {
        const i = host.sections.indexOf(definition);
        if (i >= 0) host.sections.splice(i, 1);
      };
    },
    context(definition) {
      host.contexts.push(definition);
      return () => {
        const i = host.contexts.indexOf(definition);
        if (i >= 0) host.contexts.splice(i, 1);
      };
    },
  };
  const commands = {
    register(definition) {
      host.commands.push(definition);
      return () => {
        const i = host.commands.indexOf(definition);
        if (i >= 0) host.commands.splice(i, 1);
      };
    },
  };
  const webServer = {
    register(route) {
      host.routes.push(route);
      return () => {
        const i = host.routes.indexOf(route);
        if (i >= 0) host.routes.splice(i, 1);
      };
    },
  };
  host.ctx.systemPrompt = sp;
  host.ctx.commands = commands;
  host.ctx.webServer = webServer;
  host.ctx.services = {
    ...(host.ctx.services ?? {}),
    systemPrompt: sp,
    commands,
    webServer,
  };
  return { sp, commands, webServer };
}

/** 直接调用 web 路由 handler，收集响应。 */
export function callRoute(route, url = '/fgs/state') {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const res = {
      statusCode: 0,
      headers: {},
      setHeader(k, v) {
        this.headers[k.toLowerCase()] = v;
      },
      end(body) {
        chunks.push(body ?? '');
        try {
          resolve({
            statusCode: this.statusCode,
            headers: this.headers,
            body: chunks.join(''),
            json: JSON.parse(chunks.join('') || 'null'),
          });
        } catch (error) {
          reject(error);
        }
      },
    };
    Promise.resolve(route.handler({ url, method: 'GET' }, res)).catch(reject);
  });
}
