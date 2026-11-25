import {
  BONDING_CURVE_CREATOR_FEE_BPS,
  BONDING_CURVE_PROTOCOL_FEE_BPS,
  PUMPSWAP_CREATOR_FEE_BPS,
  PUMPSWAP_LP_FEE_BPS,
  PUMPSWAP_PROTOCOL_FEE_BPS,
} from './constants';

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
}

/**
 * SOL → tokens quote from the buy_exact_sol_in docs in pump-public-docs:
 * net quote is the spendable amount after protocol and creator fees,
 * then tokens_out = floor((net - 1) * virtualToken / (virtualQuote + net - 1)).
 */
export function quoteBondingCurveBuy(
  spendableQuoteIn: bigint,
  virtualTokenReserves: bigint,
  virtualQuoteReserves: bigint,
  protocolFeeBps = BONDING_CURVE_PROTOCOL_FEE_BPS,
  creatorFeeBps = BONDING_CURVE_CREATOR_FEE_BPS,
): bigint {
  const totalFeeBps = protocolFeeBps + creatorFeeBps;
  if (spendableQuoteIn <= 0n || virtualTokenReserves <= 1n || virtualQuoteReserves <= 0n || totalFeeBps < 0n) {
    return 0n;
  }

  let net = (spendableQuoteIn * 10_000n) / (10_000n + totalFeeBps);
  const fees = ceilDiv(net * protocolFeeBps, 10_000n) + ceilDiv(net * creatorFeeBps, 10_000n);
  if (net + fees > spendableQuoteIn) {
    net -= net + fees - spendableQuoteIn;
  }
  if (net <= 1n) {
    return 0n;
  }

  return ((net - 1n) * virtualTokenReserves) / (virtualQuoteReserves + net - 1n);
}

const U64_MAX = (1n << 64n) - 1n;

/**
 * Largest raw token amount whose product with the quote reserve fits in a u64.
 * SellV3 does `amount * virtual_quote_reserves` with checked_mul and returns
 * Overflow (6024) when that product exceeds u64::MAX.
 */
export function maxSafeSellAmount(quoteReserve: bigint): bigint {
  if (quoteReserve <= 0n) {
    return 0n;
  }
  const cap = U64_MAX / quoteReserve;
  return cap > 1n ? cap - 1n : cap;
}

/** Split a balance into sells that stay under the u64 multiply cap. */
export function sellChunkAmounts(balance: bigint, cap: bigint, maxChunks: number): bigint[] {
  if (balance <= 0n || cap <= 0n || maxChunks <= 0) {
    return [];
  }
  const chunks: bigint[] = [];
  let left = balance;
  while (left > 0n && chunks.length < maxChunks) {
    const size = left > cap ? cap : left;
    chunks.push(size);
    left -= size;
  }
  return chunks;
}

/** Tokens → quote. Fees are taken out of the constant-product output. */
export function quoteBondingCurveSell(
  tokenAmountIn: bigint,
  virtualTokenReserves: bigint,
  virtualQuoteReserves: bigint,
  protocolFeeBps = BONDING_CURVE_PROTOCOL_FEE_BPS,
  creatorFeeBps = BONDING_CURVE_CREATOR_FEE_BPS,
): bigint {
  if (tokenAmountIn <= 0n || virtualTokenReserves <= 0n || virtualQuoteReserves <= 0n) {
    return 0n;
  }

  const gross = (tokenAmountIn * virtualQuoteReserves) / (virtualTokenReserves + tokenAmountIn);
  const fee = ceilDiv(gross * protocolFeeBps, 10_000n) + ceilDiv(gross * creatorFeeBps, 10_000n);
  return gross > fee ? gross - fee : 0n;
}

export function quotePumpSwapBuy(
  spendableQuoteIn: bigint,
  baseReserve: bigint,
  quoteReserve: bigint,
  totalFeeBps = PUMPSWAP_LP_FEE_BPS + PUMPSWAP_PROTOCOL_FEE_BPS + PUMPSWAP_CREATOR_FEE_BPS,
): bigint {
  if (spendableQuoteIn <= 0n || baseReserve <= 0n || quoteReserve <= 0n) {
    return 0n;
  }
  const net = (spendableQuoteIn * 10_000n) / (10_000n + totalFeeBps);
  if (net <= 0n) {
    return 0n;
  }
  return (baseReserve * net) / (quoteReserve + net);
}

export function quotePumpSwapSell(
  baseAmountIn: bigint,
  baseReserve: bigint,
  quoteReserve: bigint,
  totalFeeBps = PUMPSWAP_LP_FEE_BPS + PUMPSWAP_PROTOCOL_FEE_BPS + PUMPSWAP_CREATOR_FEE_BPS,
): bigint {
  if (baseAmountIn <= 0n || baseReserve <= 0n || quoteReserve <= 0n) {
    return 0n;
  }
  const gross = (quoteReserve * baseAmountIn) / (baseReserve + baseAmountIn);
  const fee = ceilDiv(gross * totalFeeBps, 10_000n);
  return gross > fee ? gross - fee : 0n;
}

export function applySlippage(amount: bigint, slippagePercent: number): bigint {
  const pct = Math.min(100, Math.max(0, Math.floor(slippagePercent)));
  return (amount * BigInt(100 - pct)) / 100n;
}

/** Last attempt accepts any output. Earlier attempts step up from the configured sell slippage. */
export function sellSlippageForAttempt(attempt: number, maxAttempts: number, base: number, step: number): number {
  if (maxAttempts > 0 && attempt >= maxAttempts - 1) {
    return 100;
  }
  return Math.min(99, base + attempt * Math.max(0, step));
}

export function marketCapLamports(virtualQuote: bigint, virtualToken: bigint, supply: bigint): bigint {
  if (virtualToken <= 0n || supply <= 0n) {
    return 0n;
  }
  return (virtualQuote * supply) / virtualToken;
}

export function curveProgressPercent(initialRealToken: bigint, realToken: bigint, complete: boolean): number {
  if (complete) {
    return 100;
  }
  if (initialRealToken <= 0n || realToken >= initialRealToken) {
    return 0;
  }
  return Number(((initialRealToken - realToken) * 10_000n) / initialRealToken) / 100;
}

export function solToLamports(sol: number): bigint {
  if (!Number.isFinite(sol) || sol <= 0) {
    return 0n;
  }
  return BigInt(Math.round(sol * 1_000_000_000));
}

export function lamportsToSol(lamports: bigint): number {
  return Number(lamports) / 1_000_000_000;
}

export function higherFee(configured: bigint, floor: bigint): bigint {
  return configured > floor ? configured : floor;
}
