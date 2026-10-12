# CONTRACT.md — FGS 黑板 · DeepSeek Harness 插件（冻结契约）

> **冻结方**：群聊「FGS黑板·DeepSeek插件」— learn sth new + Halo + 用户补充  
> **日期**：2026-10-11（AST）  
> **真源**：250 会话实测 FGS；文章叙事仅作背景，不驱动实现。  
> **用途**：vibecode 先过本文件；与 `DeepSeek_FGS_harness_plugin_design.md` 冲突时以本契约为准。

---

## 1. MVP 范围（冻结）

**做**：单 `goal_final` + FGS 图（`facts` / `goals` / `steps`）+ Decide/Execute 双 toolset + `satisfy_goal` 硬门 + `reopen` + Fact 蒸馏拒写。

**不做**：独立 `findings[]` / `submit_finding`；`kind: sub` SubGoal；Fact–Intent 旧命名；Hint 一等公民；多 worker 租约（claim/heartbeat）；文章 Finding→SubGoal 中间态兼容。

---

## 2. 图序列化（唯一真源）

- 磁盘主真相：YAML，顶层键**仅** `facts` → `goals` → `steps`。
- ID 规则：`fact_origin` | `fact_NNN`；`goal_final`；`step_NNN`。
- **禁止**键：`Intent` / `Hint` / `findings`（及同义一等公民节点）。
- 因果：`Fact(s) --from--> Step --to/producedBy--> 新 Fact`；Goal 不连边，靠 `satisfy_goal` 引用 fact id。

---

## 3. 单写者 Controller

- **只有 Controller** 改图；Decide/Execute 模型只调 tool。
- Tool 返回经**校验**后才 commit；校验失败拒写，不落盘。
- 写图路径强制过 **hooks**（见 §8）；不得靠 prompt 自觉。

---

## 4. Decide 工具白名单

| 工具 | 约束 |
|---|---|
| `open_step` | `from` 非空；预分配 `stepId` 可选（batch commit） |
| `drop_step` | **必须** `reason` |
| `change_step_priority` | `reason` 可选 |
| `preview` | 只读投影（fact 仅 id+title） |
| `commit` | 一次性提交草稿，或 `operations[]` 批量 |
| `satisfy_goal` | **必填** `{goalId, reason, satisfiedBy[]}`；缺任一字段**拒收** |
| `reopen` | 清空目标 `satisfied*` + 追加 feedback Fact；**禁止**删历史 Fact/Step |

Decide 会话**禁止**注册/调用 bash 及一切环境执行工具。

---

## 5. Execute 工具与收束

- 工具 = 环境工具（bash/read/write/edit/ls/grep/find 等，经 env 层规范化）+ `submit_fact` + `commit_step`。
- 一轮只吃 **一个** `open` step。
- 必须以 **一条新 Fact** 收束（成功或显式失败 Fact）；无 submit 也强制观察 Fact。
- Execute **禁止** `satisfy_goal` / `open_step` / `drop_step` / `reopen`（角色物理隔离）。

---

## 6. `reopen` 语义

触发：假 FLAG、裁判打回、外部反馈「未过」。

行为：

1. 清空对应 goal 的 `satisfiedBy` / `satisfiedReason` / `satisfiedAt`；
2. 追加一条 feedback Fact（标题点明打回原因，content 可落文件）；
3. **永不**删除历史 Fact/Step；结束不等于锁死。

Orchestrator：`satisfiedAt` 存在视为可停；若随后 `reopen`，必须继续 Decide，不得当作终态。

---

## 7. Fact 硬约束（蒸馏）

- `title` ≤ **120** 字（字符）。
- `content` 超过阈值 **N** 字节（实现常量，建议默认 8–16 KiB，可配）时，content 内必须是**文件路径**（产物落 workspace），否则 Controller **拒写**。
- 禁止把 nmap 全文 / 整页 HTML 直接塞进 fact。

---

## 8. 因果与 satisfy 硬门

**因果拒写**：

- `submit_fact` 无 `producedBy`（**origin 种题种子除外**）→ 拒；
- `step.from` 空数组 → 拒。

**FLAG / `satisfy_goal`**：

- commit 前必须过 **外部校验 hook**（提交成功 / 正则 / 赛方 ACK）；不过则**不**写入 `satisfied*`。
- 契约层拦，不靠 prompt。

---

## 9. 上下文与 I/O（用户补充）

- 每次 Decide/Execute 会话：**干净上下文**，只啃一个小问题（Decide=整图规划；Execute=单 step）。
- 写图与 planner/subagent **上下文同步**（图变 → 下一轮 user 塞最新 YAML/投影）。
- 给 LLM **预制 I/O 规范**（`io-specs/`）；过滤工具进出，裁掉噪声再进模型。
- Windows：env 层统一 **WSL / PowerShell** 用法（路径、shell 选择、命令包装），业务代码不散落平台分支。

---

## 10. 必须交付的测试资产（Halo）

- `fixtures/`：至少 3 个 golden — `origin-only` / `mid-graph` / `post-satisfy` YAML。
- `controller` 单测：非法 `satisfy_goal`、缺 reason 的 drop、超长 fact、reopen 后 `satisfied*` 清空、因果拒写、FLAG verify hook 失败不 commit。
- 离线 replay：固定 Decide/Execute JSON 轨迹 → 断言图 diff（不接真模型）。

脚手架可以丑；**拒写规则不能丑完再补**。

---

## 11. 目录落点（相对插件根）

```
CONTRACT.md                 # 本文件（拷贝进仓库根）
fixtures/                   # golden YAML
controller/                 # 校验 + commit 单写者
hooks/                      # 写图 / FLAG verify / 同步
io-specs/                   # LLM 工具 I/O 预制 schema
env/windows.*               # WSL/PS 规范化
```

实现细节见 `DeepSeek_FGS_harness_plugin_design.md`；本契约只冻结「必须如此」。
