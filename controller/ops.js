/**
 * 写图操作（Op）定义与拒写错误（CONTRACT §3、§4）。
 *
 * 只有 Controller 改图；模型侧只调工具，工具产出 Op。
 */

export const OP = Object.freeze({
  OPEN_STEP: 'open_step',
  DROP_STEP: 'drop_step',
  CHANGE_PRIORITY: 'change_step_priority',
  SUBMIT_FACT: 'submit_fact',
  SEED_ORIGIN: 'seed_origin',
  SATISFY_GOAL: 'satisfy_goal',
  REOPEN: 'reopen',
});

/** 校验失败拒写，不落盘（CONTRACT §3）。 */
export class WriteRejected extends Error {
  constructor(message) {
    super(message);
    this.name = 'WriteRejected';
    this.code = 'FGS_WRITE_REJECTED';
  }
}

/** open_step：`from` 非空；可预分配 stepId（batch commit）。 */
export function openStepOp({ action, from, actor = 'agent', priority = 'normal', stepId = null }) {
  return { type: OP.OPEN_STEP, action, from, actor, priority, stepId };
}

/** drop_step：必须 reason。 */
export function dropStepOp({ stepId, reason }) {
  return { type: OP.DROP_STEP, stepId, reason };
}

/** change_step_priority：reason 可选。 */
export function changePriorityOp({ stepId, priority, reason = null }) {
  return { type: OP.CHANGE_PRIORITY, stepId, priority, reason };
}

/** submit_fact：producedBy 必填（origin 种子除外）。 */
export function submitFactOp({ title, content, producedBy }) {
  return { type: OP.SUBMIT_FACT, title, content, producedBy };
}

/** origin 种题种子：唯一免 producedBy 的 fact 写入，同时种 goal_final。 */
export function seedOriginOp({
  title,
  content,
  criterion = '解决这道渗透题目，并提交全部 FLAG；多 FLAG 须全部有效提交',
}) {
  return { type: OP.SEED_ORIGIN, title, content, criterion };
}

/** satisfy_goal：必填 {goalId, reason, satisfiedBy}。 */
export function satisfyGoalOp({ goalId, reason, satisfiedBy }) {
  return { type: OP.SATISFY_GOAL, goalId, reason, satisfiedBy };
}

/** reopen：清空 satisfied* + 追加 feedback Fact，禁止删历史。 */
export function reopenOp({ goalId, reason, feedbackTitle = null }) {
  return { type: OP.REOPEN, goalId, reason, feedbackTitle };
}

const VALID_PRIORITIES = Object.freeze(['high', 'normal', 'low']);

export function isValidPriority(value) {
  return VALID_PRIORITIES.includes(value);
}

export const PRIORITIES = VALID_PRIORITIES;
