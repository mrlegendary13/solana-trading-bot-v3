export type ExitDecision = 'hold' | 'take-profit' | 'stop-loss' | 'timeout';

export interface ExitState {
  solIn: bigint;
  quoteSol: bigint;
  takeProfitPercent: number;
  stopLossPercent: number;
  belowStopStreak: number;
  confirmations: number;
  openedAtMs: number;
  nowMs: number;
  graceMs: number;
  durationMs: number;
}

export function pnlBps(solIn: bigint, quoteSol: bigint): number {
  if (solIn <= 0n) {
    return 0;
  }
  return Number(((quoteSol - solIn) * 10_000n) / solIn);
}

/**
 * Stop loss needs `confirmations` reads in a row, and only after `graceMs`.
 * One bad quote cannot sell. Take profit can fire on a single read.
 * A duration of 0 disables the timeout.
 */
export function evaluateExit(state: ExitState): { decision: ExitDecision; streak: number; pnlBps: number } {
  const pnl = pnlBps(state.solIn, state.quoteSol);
  const age = state.nowMs - state.openedAtMs;
  if (state.durationMs > 0 && age >= state.durationMs) {
    return { decision: 'timeout', streak: state.belowStopStreak, pnlBps: pnl };
  }

  const take = state.solIn + (state.solIn * BigInt(Math.max(0, Math.floor(state.takeProfitPercent)))) / 100n;
  if (state.quoteSol > take) {
    return { decision: 'take-profit', streak: 0, pnlBps: pnl };
  }

  const loss = (state.solIn * BigInt(Math.max(0, Math.floor(state.stopLossPercent)))) / 100n;
  const stop = state.solIn - loss;
  const below = state.quoteSol < stop;
  if (!below || age < state.graceMs) {
    return { decision: 'hold', streak: below ? state.belowStopStreak : 0, pnlBps: pnl };
  }
  const streak = state.belowStopStreak + 1;
  const need = Math.max(1, state.confirmations);
  if (streak >= need) {
    return { decision: 'stop-loss', streak, pnlBps: pnl };
  }
  return { decision: 'hold', streak, pnlBps: pnl };
}
