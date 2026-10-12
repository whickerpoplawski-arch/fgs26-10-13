/**
 * 写图校验 hook（CONTRACT §3、§8）。
 *
 * Tool 返回经校验后才 commit；校验失败拒写，不落盘。
 * 写图路径强制过本模块（不得靠 prompt 自觉）。
 *
 * 空白字符串视为缺失（防止 reason="   " 之类的假理由蒙混过关）。
 * 文案与 Controller 内部校验保持一致，避免同一违规出现两套说法。
 */
import { OP, WriteRejected } from '../controller/ops.js';

/** 预检调用计数：给测试断言「Controller 确实过了这道 hook」，而不是只在内部重复校验。 */
export const preflightStats = { calls: 0 };

/** apply 前快速结构检查；失败抛 WriteRejected。 */
export function preflight(op) {
  preflightStats.calls += 1;
  switch (op?.type) {
    case OP.OPEN_STEP:
      if (!Array.isArray(op.from) || op.from.length === 0) {
        throw new WriteRejected('open_step 无 from（因果拒写，CONTRACT §8）');
      }
      return;
    case OP.DROP_STEP:
      if (!hasText(op.reason)) {
        throw new WriteRejected('drop_step 缺 reason（拒收，CONTRACT §4）');
      }
      return;
    case OP.SATISFY_GOAL:
      if (!op.goalId || !hasText(op.reason) || !Array.isArray(op.satisfiedBy) || op.satisfiedBy.length === 0) {
        throw new WriteRejected('satisfy_goal 缺 goalId/reason/satisfiedBy 任一字段，拒收（CONTRACT §4）');
      }
      return;
    case OP.REOPEN:
      if (!op.goalId || !hasText(op.reason)) {
        throw new WriteRejected('reopen 缺 goalId/reason（reason 不得为空或空白）');
      }
      return;
    case OP.SUBMIT_FACT:
      if (!hasText(op.producedBy)) {
        throw new WriteRejected('submit_fact 无 producedBy（origin 种子除外，拒写，CONTRACT §8）');
      }
      return;
    case OP.CHANGE_PRIORITY:
    case OP.SEED_ORIGIN:
      return;
    default:
      throw new WriteRejected(`未知操作类型: ${op?.type}`);
  }
}

/** 包装 Controller.apply：任何 op 在 apply 前再过一道结构检查（双保险）。 */
export function makeGatedApply(controller) {
  return function gatedApply(op, graph = null) {
    preflight(op);
    return controller.apply(op, graph);
  };
}

/** 不抛异常版本：返回 { graph: object|null, error: string|null }。 */
export function safeApply(controller, op, graph = null) {
  try {
    return { graph: makeGatedApply(controller)(op, graph), error: null };
  } catch (error) {
    if (error instanceof WriteRejected) return { graph: null, error: error.message };
    throw error;
  }
}

function hasText(value) {
  return typeof value === 'string' && value.trim() !== '';
}
