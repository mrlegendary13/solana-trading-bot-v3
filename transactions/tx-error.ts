import { SendTransactionError } from '@solana/web3.js';

export function errorText(error: unknown): string {
  if (error instanceof SendTransactionError) {
    const logs = error.logs?.slice(-12).join(' | ');
    return logs ? `${error.message} | ${logs}` : error.message;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export function simulationFailure(err: unknown, logs: string[] | null | undefined): string {
  const tail = (logs || []).slice(-15).join(' | ');
  const summary = `simulation failed: ${JSON.stringify(err)}`;
  return tail ? `${summary} | ${tail}` : summary;
}

/** Slippage can be fixed by widening the minimum. Overflow and other program errors cannot. */
export function sellFailureClass(error?: string): 'slippage' | 'fatal' | 'retry' {
  if (!error) {
    return 'retry';
  }
  if (/6003|TooLittleSolReceived/i.test(error)) {
    return 'slippage';
  }
  if (/6024|0x1788|Overflow/i.test(error)) {
    return 'retry';
  }
  if (/6004|6005|6006|6022|6023|NotEnoughTokens|BondingCurveComplete|insufficient lamports|insufficient funds/i.test(error)) {
    return 'fatal';
  }
  if (/InstructionError|custom program error/i.test(error)) {
    return 'fatal';
  }
  return 'retry';
}

/** Buy retries cannot fix these. 6042 is a buy slippage miss and is retried once with a fresh quote. */
export function buyFailureShouldStop(error?: string): boolean {
  if (!error) {
    return false;
  }
  if (/6042|BuySlippageBelowMinTokensOut/i.test(error)) {
    return false;
  }
  return /insufficient lamports|custom program error|InstructionError|AccountNotFound|insufficient funds/i.test(error);
}
