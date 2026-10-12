/**
 * 上下文同步 hook（CONTRACT §9）。
 *
 * 图变 → 下一轮 Decide/Execute 看到最新 YAML/投影。
 * 每次 Decide/Execute 会话干净上下文：system 规则 + 本轮 user（整图 YAML + 角色附录）。
 */

/** Decide 轮 user 消息：整图 YAML + 工作目录附录。 */
export function decideUserMessage(store, graph, workspaceSummary = '') {
  const parts = [store.toYaml(graph)];
  if (workspaceSummary) parts.push(`【工作目录里的文件】\n${workspaceSummary}`);
  parts.push('请判断下一步,操作记入草稿后 commit。');
  return parts.join('\n\n');
}

/** Execute 轮 user 消息：整图 YAML + 负责的 step。 */
export function executeUserMessage(store, graph, stepId, stepAction) {
  return `${store.toYaml(graph)}\n\n【你负责的 step】${stepId}\n${stepAction}`;
}

/** 当前角色 + 当前 step + 图投影，作为每步的运行时上下文注入。 */
export function roleContextText({
  role, store, graph, currentStep = null, draftSummary = '', ioSpec = null,
}) {
  if (!graph || !store) return '';
  const lines = [`【FGS 当前角色】${roleLabel(role)}`];
  const openSteps = (graph.steps ?? []).filter((s) => s.state === 'open');
  if (role === 'execute') {
    if (currentStep) lines.push(`【本轮必须收束的 step】${currentStep.id}: ${currentStep.action}`);
    lines.push('【本轮可用图工具】fgs_submit_fact → fgs_commit_step（fgs_status 只读）。');
    lines.push('结束时必须调用 fgs_commit_step 落一条新 Fact（无产出也要落显式失败/观察 Fact）。');
    lines.push('规划类工具（fgs_open_step / fgs_drop_step / fgs_satisfy_goal / fgs_reopen / fgs_commit）本轮会被拒。');
  } else if (role === 'decide') {
    lines.push(`【open steps】${openSteps.length === 0 ? '（无）' : openSteps.map((s) => `${s.id}[${s.priority}]`).join(', ')}`);
    lines.push('【本轮可用图工具】fgs_preview（只读）、fgs_open_step / fgs_drop_step / fgs_change_step_priority / fgs_satisfy_goal / fgs_reopen（记草稿）、fgs_commit（提交）。');
    lines.push('用 fgs_open_step / fgs_drop_step / fgs_satisfy_goal / fgs_reopen 记草稿，最后 fgs_commit 一次性提交。');
    lines.push('环境执行工具（bash/文件/网络/委派类）本轮会被拒。');
  }
  if (draftSummary) lines.push(`【未提交草稿】${draftSummary}`);
  if (ioSpec && (ioSpec.notes.length > 0 || ioSpec.forbidden.length > 0)) {
    const parts = [];
    if (ioSpec.forbidden.length > 0) parts.push(`禁止: ${ioSpec.forbidden.join(', ')}`);
    if (ioSpec.notes.length > 0) parts.push(ioSpec.notes.join('；'));
    lines.push(`【I/O 预制规范（${role}，io-specs/${role}.io.yaml）】${parts.join(' | ')}`);
  }
  lines.push('');
  lines.push(role === 'execute' ? store.toYaml(graph) : store.preview(graph));
  return lines.join('\n');
}

export function roleLabel(role) {
  if (role === 'decide') return 'Decide（只做规划/改图，禁止环境执行工具）';
  if (role === 'execute') return 'Execute（只推进一个 open step，禁止规划类改图工具）';
  return 'off（未启动 FGS 运行）';
}
