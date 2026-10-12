# fgs-deepseek — DSH 原生插件（FGS 黑板）

把 `CONTRACT.md` 冻结的 **FGS 黑板**（Fact → Step → Fact）做成 DeepSeek Harness 的**原生插件**：
Host 半提供单写者 Controller、Decide/Execute 双 toolset、FLAG 硬门与 reopen；Client 半在
composer 上方渲染一条只读黑板条。

> 契约最高优先级：与 `DeepSeek_FGS_harness_plugin_design.md` 冲突时以 `CONTRACT.md` 为准。
> 本仓库是**原生 DSH 移植**（`fgs-deepseek/` 是上一版 Python harness 适配层）。

## 装

```bash
# 在 DSH 里（Web GUI 或 CLI 会话）
plugin_manager install_bundle /mnt/d/XunLei/med-lora/fgs-deepseek-DSH
```

装完即生效（live profile），无需重启。`cordis.patch.yml` 插入一行 Host 行；
Client 半由 `package.json` 的 `dsh.client` 自动装载。

## 用

### 人类命令

| 命令 | 作用 |
|---|---|
| `/fgs new <problemId> [brief]` | 建一道题的 Project（独立图 + `workspace/`）。给了 brief 就同时种题，并切为活动题 |
| `/fgs switch <problemId>` | 切换活动题。之后的图工具、`/fgs status` 和 `/fgs/state` 都走这道题 |
| `/fgs list` | 列出全部题：id / title / 派生角色 / open / satisfied / state。`*` 是活动题 |
| `/fgs init <brief>` | 兼容别名：等价 `/fgs new default <brief>` |
| `/fgs status` | 活动题的角色 / facts / steps / open 数 / satisfied |
| `/fgs graph` | 打印活动题的图投影（fact 仅 id+title） |
| `/fgs path` | 打印活动题的 `graph.yaml` 路径 |
| `/fgs reopen <原因>` | 打回活动题：清空 `satisfied*` + 追加 feedback Fact |
| `/fgs off` | 退出本会话在活动题上的运行（图文件保留）。会被记住，不会被自动认领拉回来；`/fgs switch <id>` 可重新进入 |

### 模型工具（角色自动切换 + 隔离）

角色由图状态推导：**有 open step → Execute，否则 Decide**。没有活动 Project 时，
改图工具（含 `fgs_seed`）被 guard 拒，只放只读 `fgs_status`。先 `fgs_project action=new`
（或人的 `/fgs new`）。活动题已建但还没种题时，只有 `fgs_seed` / `fgs_status` 可用。

- **控制面**：`fgs_project`（`action=new|switch|list`，建题/换题/列题）、`fgs_seed`、`fgs_status`
  - `fgs_project` 在任何角色、任何状态下都放行——没有活动 Project 时正是唯一要用它的时刻，
    所以它不能进「没有活动 Project 就拒」那条分支。这是模型自主跑多题的前提。
- Decide：`fgs_open_step`、`fgs_drop_step`、`fgs_change_step_priority`、`fgs_preview`、
  `fgs_commit`、`fgs_satisfy_goal`、`fgs_reopen` + `decideAllowTools` 里的元工具
- Execute：`fgs_submit_fact`、`fgs_commit_step` + 宿主提供的环境工具
  （`bash`/`read`/`write`/`edit`/`glob`/`grep` 等，本插件不注册它们）

### 认领（attach）：磁盘上的图说了算

run 只在 `fgs_seed` / `fgs_project action=new <brief>` 时创建。重启或换会话后内存里没有 run，
但磁盘上的 Project 已经种好题——这时**按磁盘自动认领**（建 run + 按图推导角色），
而不是拿「内存里有没有 run」当「有没有种题」。否则会自相矛盾：

```
guard    → 「FGS 未启动：先 fgs_seed 种题，再使用图工具」
fgs_seed → 「已经种过题」并报错
```

只看错误信息的自主 agent 会卡死在这个循环里。回归用例见 `tests/projects.test.mjs`
的「认领」两例（用「同一 workspace 重新 apply」模拟重启）。

隔离是**在 dispatch 层硬拦**：`tools.guard` 顺序无关、单调。Decide 轮用**白名单**——
不在 `ROLE_TOOLS.decide ∪ decideAllowTools` 里的工具一律拒（含 `bash`/文件/`web_*`/
`subagent`/`workflow`，因为它们能间接执行环境动作）。Execute 轮拒 Decide 的规划类工具。

> 为什么不用 `tools.restrict` 做 schema 级隐藏：实测（DSH 0.2.0-rc.2）对同一 agent scope
> 连续 `restrict` 时后一次不会解除前一次的限制（限制取交集）。角色随图状态变化，一旦
> 为「未启动」隐藏了规划工具，进入 Decide 后它们就再也不可见了。所以 schema 层永远保留
> 全部 `fgs_*` 工具，越权由 guard 硬拒。`tests/plugin.test.mjs` 有回归用例锁住这一点。

> 为什么不用 `tools.restrict` 做 schema 级隐藏：实测（DSH 0.2.0-rc.2）对同一 agent scope
> 连续 `restrict` 时后一次不会解除前一次的限制（限制取交集）。角色随图状态变化，一旦
> 为「未启动」隐藏了规划工具，进入 Decide 后它们就再也不可见了。所以 schema 层永远保留
> 全部 `fgs_*` 工具，越权由 guard 硬拒。`tests/plugin.test.mjs` 有回归用例锁住这一点。

## 目录

```
CONTRACT.md                 # 冻结契约（拷贝进仓库根）
package.json                # bundle manifest + dsh.bundle.patch + dsh.client
cordis.patch.yml            # 插入 Host 行
index.js                    # Host 半：服务、12 个工具、角色门、命令、上下文、HTTP 快照
client.js                   # Client 半：conversation.input.dock 只读黑板条
yaml.js                     # FGS 图 YAML 子集读写（无外部依赖）
controller/                 # 单写者：ops.js + index.js（GraphStore/Controller）+ projects.js（ProjectRegistry）
hooks/                      # validate_write（写图预检）/ flag_verify（FLAG 硬门）/ sync_context
env/windows.js              # WSL/PowerShell 规范化（CONTRACT §11）
fixtures/                   # golden：origin-only / mid-graph / post-satisfy
io-specs/                   # LLM 工具 I/O 预制规范
schemas/tools/              # Decide/Execute 工具 JSON Schema
prompts/                    # Decide/Execute system 骨架
tests/                      # node --test（离线，无外部依赖）
```

## 数据

一场比赛 = 一个 workspace 根（CLI 可用 `stateDir` 配置改名，默认 `.fgs`）。
一道题 = 一个 Project，图和 Execute 工作目录按题隔离，不共用一张图：

```
<workspace>/.fgs/
  competition.json                 # problems[] + activeProblemId
  graph.yaml.bak                   # 仅旧布局迁移后留下的备份
  projects/<problemId>/
    graph.yaml                     # 该题主真相，顶层键仅 facts → goals → steps
    graph.json                     # 同构镜像（先写 tmp + fsync 再 rename）
    graph.lock                     # 该题写锁（陈旧锁 10s 自愈）
    meta.json                      # state / model / budget / roundSeq / createdAt
    workspace/                     # 该题 Execute 产物目录
```

`problemId` 会规范成 `[a-z0-9_-]{1,64}`（非法字符变成 `_`）。重复 id 拒绝创建。
内存里的 run 以 `(sessionId, problemId)` 为键：草稿、角色、`roundSeq` 都随题分开。
「一轮只收束一个 open step」比对的是本 run 的 `roundSeq`，不是全局 DSH turn。

若磁盘上还是旧的单图 `.fgs/graph.yaml`、且还没有 `projects/`，第一次访问会把它迁到
`projects/default/`（原文件留 `.bak`），并把 `default` 设为活动题。

## 配置（`cordis.patch.yml` 的 `config`）

```yaml
- insert:
    - id: fgs-deepseek
      name: '@local/fgs-deepseek-dsh'
      config:
        stateDir: .fgs                 # 图目录（相对会话 cwd）
        factContentMaxBytes: 8192      # content 超阈值拒写（CONTRACT §7）
                                       #   注：超过该阈值的 content 实际一律拒写——契约要求的
                                       #   「文件路径」形态本身就是短串（实测 <4 KiB），两个条件互斥，
                                       #   故「>8 KiB 且是路径」这一分支不可达。蒸馏意图不变：
                                       #   大产物落文件，fact 里只放结论与路径。
        factTitleMaxChars: 120
        verifyMode: regex              # regex | local | command（不存在关门的 none：§8 必须有硬门）
        flagPattern: 'flag\{[^}\s]{4,}\}'   # 真实竞赛（百度）用**小写** flag{...}
        flagFlags: i                   # 忽略大小写编译，同时兼容 FLAG{...}；'g' 会被剔除
        expectedFlag: ''               # verifyMode=local 时必填
        verifyCommand: ''              # verifyMode=command：读 stdin 的校验命令，退出码 0 = 通过
                                       #   stdin 收到 {goalId, reason, satisfiedBy, facts[]}；
                                       #   stdout 若是 {"ok":false,"reason":"…"} 也按拒绝
                                       #   真实比赛请用仓库自带 tools/submit_flag.mjs（见下）
        decideAllowTools: [todo_write, skill, ask_user_question, exit_plan_mode, cordis_inspect_list, cordis_inspect_query]
                                       # Decide 轮白名单：不在表里的工具（bash/文件/网络/subagent/workflow…）一律拒
        maxResultChars: 8000           # 图工具出参截断（io-specs 的 max_result_chars）
        deniedEnvTools: [bash, read, write, edit, glob, grep, ...]
        exposeHttpState: true          # 给 Web 面板的只读快照路由
        httpPath: /fgs/state
```

FLAG 硬门**不可关闭**（`CONTRACT §8`）：`verifyMode` 没有 `none`，未识别/`none` 一律
fail-closed 回退到 regex。要放行请把 `flagPattern` 显式设宽——让「本运行不做外部校验」
留在配置里可见，而不是把门拆掉。

### 真实比赛用 `verifyMode: command`

`regex` 只能校验「fact 文本里出现过 flag 形态」，**不能证明这个 flag 真的对**。
真实竞赛的判对发生在赛方提交接口，所以应该改成 `command`：

```yaml
verifyMode: command
verifyCommand: 'node /path/to/fgs-deepseek-dsh/tools/submit_flag.mjs'
```

`tools/submit_flag.mjs` 会：从 `facts` 文本抽出全部 flag → 逐个 POST 到
`${BENCHMARK_BASE_URL}/openapi/v1/challenges/submit`（带 `BENCHMARK_TOKEN`）→
`200/201` 判对、**`409` 重复提交也按已判对**（说明此前已提交成功）→ 全部通过才 exit 0。

需要的环境变量：`BENCHMARK_BASE_URL`（或 `PLATFORM_BASE_URL`）、`BENCHMARK_TOKEN`、
`FGS_UNIQUE_CODE`（如 `b-02`，也可在 fact 文本里带 `"unique_code"`）。
三者缺任一、或接口不可达、或抽不到 flag → **一律 fail-closed 拒收**（宁可挡住一次真 flag）。

> 为什么 `regex` 的默认值改过：早期默认是 `FLAG\{[^}\s]{4,}\}`（全大写 + 没有 `i`），
> 而真实竞赛的 flag 是 `flag{...}` 小写——**拿到真题的真 flag 也会被硬门拒收**，
> 只有自己敲的 `FLAG{}` 假数据能过。这个问题是靠一份真实比赛会话导出（b-02）才暴露的。

## 契约对照

| CONTRACT | 落点 |
|---|---|
| §1 MVP 范围 | 单 `goal_final`（`validate` 拒 `goal_sub`/`kind:sub`），无 findings/租约 |
| §2 图序列化唯一真源 | `yaml.js` + `GraphStore.load/save`；非法顶层键直接拒读；ID 规则进 validate |
| §3 单写者 Controller | `controller/index.js`；写路径先 `hooks/validate_write.preflight`（有计数器证明调用） |
| §4 Decide 白名单 / 禁环境工具 | 白名单（`decideAllowTools`）：默认只留规划工具 + 元工具，bash/文件/网络/subagent/workflow 全拒 |
| §5 Execute 收束 | 一轮只吃一个 open step（按本 Project run 的 `roundSeq`；宿主 turn 只推进这一题的计数）；回合收口强制观察 Fact |
| §6 reopen | 清空 `satisfied*` + feedback Fact，永不删历史 |
| §7 Fact 蒸馏 | title ≤120 字；content 超阈值必须是路径 |
| §8 因果 + satisfy 硬门 | `from` 非空、`producedBy` 必填、verify hook 前置 |
| §9 干净上下文 / I/O 预制 / 上下文同步 | `hooks/sync_context` + `systemPrompt.section`/`context`（每步注入本会话图投影 + 该角色 io-spec）；图工具出参按 `maxResultChars` 截断 |
| §10 测试资产 | `fixtures/` 三份 + `tests/`（controller / role / flag / 离线 replay） |
| §11 目录落点 | 见上「目录」 |

## 测试

```bash
cd /mnt/d/XunLei/med-lora/fgs-deepseek-DSH
node --test "tests/*.test.mjs"
```

覆盖：Project 建题/切换/列表、两题图与草稿隔离、旧单图迁移、无活动 Project 时拒改图、YAML 往返与真实 `cordis.patch.yml`、Controller 全部拒写路径（空 `from` /
缺 `reason` / 缺 `satisfy_goal` 字段 / 超长 fact / 无 `producedBy` / 非 open step /
FLAG verify 失败不落盘 / reopen 清空且不删历史）、角色隔离与 Decide 白名单、回合语义
（一轮一个 step、回合收口强制观察 Fact）、显式 stepId 不许换 step、`/fgs` 命令、
运行时上下文与 io-specs 注入、出参截断、HTTP 快照按会话取图、固定 JSON 轨迹离线 replay。

`tests/contract_fixes.test.mjs` 是对抗性审计发现项的回归：审计用哪一招打进来，就用哪一招锁回去。

> ⚠️ 改动 `index.js` 后**必须重启 Harness 进程**才会加载新模块代次
> （`set_plugin` / 重装 bundle 都不会换掉已加载的 JS 模块；`/fgs/state` 返回的
> `pluginGeneration` 可用来确认当前跑的是哪一代；M1 为代次 **4**，`buildTag` 含 `+project`）。
