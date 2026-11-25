import assert from 'assert';
import { evaluateExit, pnlBps } from '../pump/exit';
import { buyFailureShouldStop } from '../transactions/tx-error';
import { quoteBondingCurveSell } from '../pump/quotes';

const base = {
  solIn: 10_000_000n,
  quoteSol: 9_875_000n,
  takeProfitPercent: 40,
  stopLossPercent: 20,
  belowStopStreak: 0,
  confirmations: 2,
  openedAtMs: 0,
  nowMs: 5_000,
  graceMs: 2_000,
  durationMs: 600_000,
};

assert.strictEqual(pnlBps(10_000_000n, 9_875_000n), -125);
assert.strictEqual(evaluateExit(base).decision, 'hold');
assert.strictEqual(evaluateExit({ ...base, quoteSol: 8_000_000n, nowMs: 1_000 }).decision, 'hold');
assert.strictEqual(evaluateExit({ ...base, quoteSol: 7_000_000n, nowMs: 5_000 }).streak, 1);
assert.strictEqual(evaluateExit({ ...base, quoteSol: 7_000_000n, nowMs: 5_000 }).decision, 'hold');
assert.strictEqual(evaluateExit({ ...base, quoteSol: 7_000_000n, belowStopStreak: 1, nowMs: 5_000 }).decision, 'stop-loss');
assert.strictEqual(evaluateExit({ ...base, quoteSol: 15_000_000n }).decision, 'take-profit');
assert.strictEqual(evaluateExit({ ...base, nowMs: 600_000 }).decision, 'timeout');

assert.strictEqual(buyFailureShouldStop('simulation failed: {"InstructionError":[3,{"Custom":6042}]}'), false);
assert.strictEqual(buyFailureShouldStop('BuySlippageBelowMinTokensOut'), false);
assert.strictEqual(buyFailureShouldStop('Transfer: insufficient lamports 100, need 500'), true);
assert.strictEqual(buyFailureShouldStop('simulation failed: {"InstructionError":[2,{"Custom":1}]}'), true);
assert.strictEqual(buyFailureShouldStop('blockhash expired at height 10'), false);

const mark = quoteBondingCurveSell(299674225407n, 1_000_000_000_000_000n, 30_000_000_000n, 95n, 30n);
assert.ok(mark > 0n);

console.log('exit tests passed');
