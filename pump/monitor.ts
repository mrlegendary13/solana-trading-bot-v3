import { Connection, PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddressSync, NATIVE_MINT, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import fs from 'fs';
import path from 'path';
import { logger } from '../helpers/logger';
import { evaluateExit } from './exit';
import { PumpTrader } from './trader';
import { decodeBondingCurve, decodePumpSwapPool } from './layout';
import { bondingCurvePda, canonicalPumpPoolPda } from './pda';
import { PumpPosition, PumpSwapPosition } from './positions';
import { quoteBondingCurveSell, quotePumpSwapBuy, quotePumpSwapSell } from './quotes';
import { BONDING_CURVE_CREATOR_FEE_BPS, BONDING_CURVE_PROTOCOL_FEE_BPS, isSolQuoteMint, PUMPSWAP_CREATOR_FEE_BPS, PUMPSWAP_LP_FEE_BPS, PUMPSWAP_PROTOCOL_FEE_BPS } from './constants';

export interface MonitorConfig {
  takeProfitPercent: number;
  stopLossPercent: number;
  priceCheckIntervalMs: number;
  priceCheckDurationMs: number;
  graceMs: number;
  confirmations: number;
  sellRetryIntervalMs: number;
  pnlLogIntervalMs: number;
  useWebsocket: boolean;
}

interface Watched {
  mint: PublicKey;
  tokenProgram: PublicKey;
  tokens: bigint;
  solIn: bigint;
  openedAtMs: number;
  streak: number;
  pump?: PumpPosition;
  swap?: PumpSwapPosition;
  selling: boolean;
  nextSellAtMs: number;
  lastPnlLogMs: number;
}

const FILE = path.join(process.cwd(), 'data', 'positions.json');

export class PositionMonitor {
  private readonly watched = new Map<string, Watched>();
  private readonly subs = new Map<string, number>();
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly connection: Connection,
    private readonly trader: PumpTrader,
    private readonly owner: PublicKey,
    private readonly config: MonitorConfig,
  ) {}

  start() {
    const interval = Math.max(250, this.config.priceCheckIntervalMs || 1000);
    this.timer = setInterval(() => {
      void this.tickAll();
    }, interval);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
    }
    for (const sub of this.subs.values()) {
      this.connection.removeAccountChangeListener(sub).catch(() => undefined);
    }
  }

  isWatching(mint: string): boolean {
    return this.watched.has(mint);
  }

  async onBuy(input: {
    mint: PublicKey;
    tokenProgram: PublicKey;
    tokens: bigint;
    solIn: bigint;
    pump?: PumpPosition;
    swap?: PumpSwapPosition;
  }) {
    const row: Watched = {
      mint: input.mint,
      tokenProgram: input.tokenProgram,
      tokens: input.tokens,
      solIn: input.solIn > 0n ? input.solIn : 1n,
      openedAtMs: Date.now(),
      streak: 0,
      pump: input.pump,
      swap: input.swap,
      selling: false,
      nextSellAtMs: 0,
      lastPnlLogMs: 0,
    };
    this.watched.set(input.mint.toBase58(), row);
    this.persist();
    this.subscribe(row);
    this.logOpened(row);
  }

  async reconcile() {
    const programs = [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID];
    for (const program of programs) {
      const accounts = await this.connection.getParsedTokenAccountsByOwner(this.owner, { programId: program });
      for (const account of accounts.value) {
        const info = account.account.data.parsed.info;
        const amount = BigInt(info.tokenAmount.amount);
        if (amount <= 0n || info.mint === NATIVE_MINT.toBase58()) {
          continue;
        }
        await this.adopt(new PublicKey(info.mint), program, amount);
      }
    }
    logger.info({ open: this.watched.size }, 'Rebuilt open positions from the wallet');
  }

  private async adopt(mint: PublicKey, tokenProgram: PublicKey, tokens: bigint) {
    const key = mint.toBase58();
    if (this.watched.has(key)) {
      this.watched.get(key)!.tokens = tokens;
      return;
    }
    const curveInfo = await this.connection.getAccountInfo(bondingCurvePda(mint));
    const curve = curveInfo ? decodeBondingCurve(curveInfo.data as Buffer) : null;
    const poolPk = canonicalPumpPoolPda(mint);
    const poolInfo = !curve || curve.complete ? await this.connection.getAccountInfo(poolPk) : null;
    const pool = poolInfo ? decodePumpSwapPool(poolInfo.data as Buffer) : null;
    if (!curve && !pool) {
      return;
    }
    const marked = await mark(this.connection, mint, tokens, curve, pool);
    const solIn = marked > 0n ? marked : 1n;
    const row: Watched = {
      mint,
      tokenProgram,
      tokens,
      solIn,
      openedAtMs: Date.now(),
      streak: 0,
      selling: false,
      nextSellAtMs: 0,
      lastPnlLogMs: 0,
    };
    if (pool && (!curve || curve.complete)) {
      row.swap = swapFromPool(mint, poolPk, pool, tokenProgram);
    } else if (curve) {
      row.pump = {
        venue: 'pump',
        mint,
        bondingCurve: bondingCurvePda(mint),
        quoteMint: NATIVE_MINT,
        baseTokenProgram: tokenProgram,
        creator: curve.creator,
        initialRealTokenReserves: curve.realTokenReserves,
      };
    }
    this.watched.set(key, row);
    this.persist();
    this.subscribe(row);
    logger.info(
      { mint: key, tokens: tokens.toString(), entrySol: solToString(solIn) },
      'Recovered open position. Entry is marked to the current sell value so an old coin is not stop-sold immediately.',
    );
  }

  private subscribe(row: Watched) {
    if (!this.config.useWebsocket) {
      return;
    }
    const key = row.mint.toBase58();
    if (this.subs.has(key)) {
      return;
    }
    const account = row.swap ? row.swap.poolQuoteTokenAccount : bondingCurvePda(row.mint);
    try {
      const sub = this.connection.onAccountChange(account, () => {
        void this.tick(key);
      });
      this.subs.set(key, sub);
    } catch (error) {
      logger.debug({ mint: key, error }, 'Price subscription failed. Polling will continue.');
    }
  }

  private async tickAll() {
    const mints = [...this.watched.keys()];
    if (mints.length === 0) {
      return;
    }
    await Promise.all(mints.map((mint) => this.tick(mint)));
  }

  private async tick(mint: string) {
    const row = this.watched.get(mint);
    if (!row || row.selling) {
      return;
    }
    try {
      const quote = await this.quote(row);
      if (!quote) {
        return;
      }
      const decision = evaluateExit({
        solIn: row.solIn,
        quoteSol: quote.sol,
        takeProfitPercent: this.config.takeProfitPercent,
        stopLossPercent: this.config.stopLossPercent,
        belowStopStreak: row.streak,
        confirmations: this.config.confirmations,
        openedAtMs: row.openedAtMs,
        nowMs: Date.now(),
        graceMs: this.config.graceMs,
        durationMs: this.config.priceCheckDurationMs,
      });
      row.streak = decision.streak;
      const pnlPercent = (decision.pnlBps / 100).toFixed(2);
      const now = Date.now();
      const pnlEvery = Math.max(0, this.config.pnlLogIntervalMs);
      if (pnlEvery > 0 && now - row.lastPnlLogMs >= pnlEvery) {
        row.lastPnlLogMs = now;
        logger.info(
          { mint, pnlPercent, valueSol: solToString(quote.sol), entrySol: solToString(row.solIn), tokens: row.tokens.toString() },
          'Position PnL',
        );
      }
      if (decision.decision === 'hold') {
        return;
      }
      if (row.nextSellAtMs > now) {
        logger.info(
          { mint, reason: decision.decision, pnlPercent, retryInMs: row.nextSellAtMs - now },
          'Exit is due, but the last sell is still in its retry wait.',
        );
        return;
      }
      logger.info(
        { mint, reason: decision.decision, pnlPercent, valueSol: solToString(quote.sol), entrySol: solToString(row.solIn) },
        decision.decision === 'take-profit'
          ? 'Take profit triggered. Sending the sell.'
          : decision.decision === 'stop-loss'
            ? 'Stop loss triggered. Sending the sell.'
            : 'Price check timed out. Sending the sell.',
      );
      await this.sell(row, decision.decision);
    } catch (error) {
      logger.error({ mint, error }, 'Price check failed. The position stays open and polling will continue.');
    }
  }

  private async quote(row: Watched): Promise<{ sol: bigint } | null> {
    const curvePk = bondingCurvePda(row.mint);
    const curveInfo = await this.connection.getAccountInfo(curvePk);
    const curve = curveInfo ? decodeBondingCurve(curveInfo.data as Buffer) : null;
    if (curve && !curve.complete) {
      const protocol = curveFee(curve.creatorFeeBps);
      return {
        sol: quoteBondingCurveSell(row.tokens, curve.virtualTokenReserves, curve.virtualQuoteReserves, BONDING_CURVE_PROTOCOL_FEE_BPS, protocol),
      };
    }
    const poolPk = row.swap?.pool ?? canonicalPumpPoolPda(row.mint);
    const poolInfo = await this.connection.getAccountInfo(poolPk);
    const pool = poolInfo ? decodePumpSwapPool(poolInfo.data as Buffer) : null;
    if (!pool || (!isSolQuoteMint(pool.baseMint) && !isSolQuoteMint(pool.quoteMint))) {
      if (curve?.complete) {
        logger.info({ mint: row.mint.toBase58() }, 'Bonding curve graduated and the PumpSwap pool is not available yet');
      }
      return null;
    }
    if (!row.swap) {
      row.swap = swapFromPool(row.mint, poolPk, pool, row.tokenProgram);
      row.pump = undefined;
      this.persist();
      logger.info({ mint: row.mint.toBase58(), pool: poolPk.toBase58() }, 'Position graduated to PumpSwap. Price and sells now use the pool.');
    }
    const [base, quote] = await Promise.all([
      this.connection.getTokenAccountBalance(pool.poolBaseTokenAccount),
      this.connection.getTokenAccountBalance(pool.poolQuoteTokenAccount),
    ]);
    const baseReserve = BigInt(base.value.amount);
    const quoteReserve = BigInt(quote.value.amount) + (pool.virtualQuoteReserves > 0n ? pool.virtualQuoteReserves : 0n);
    const fee = PUMPSWAP_LP_FEE_BPS + PUMPSWAP_PROTOCOL_FEE_BPS + (pool.creatorFeeBps > 0n ? pool.creatorFeeBps : PUMPSWAP_CREATOR_FEE_BPS);
    const tokenIsBase = !isSolQuoteMint(pool.baseMint);
    const sol = tokenIsBase
      ? quotePumpSwapSell(row.tokens, baseReserve, quoteReserve, fee)
      : quotePumpSwapBuy(row.tokens, baseReserve, quoteReserve, fee);
    return { sol };
  }

  private async sell(row: Watched, reason: string) {
    row.selling = true;
    try {
      const balance = await this.tokenBalance(row);
      if (balance <= 0n) {
        this.forget(row.mint.toBase58(), 'balance is already zero');
        return;
      }
      row.tokens = balance;
      const sold = row.swap
        ? await this.trader.sellPumpSwap(row.swap, balance, { skipWatch: true })
        : row.pump
          ? await this.trader.sellPump(row.pump, balance, { skipWatch: true })
          : false;
      const left = await this.tokenBalance(row);
      row.tokens = left;
      if (left <= 0n) {
        logger.info({ mint: row.mint.toBase58(), reason, entrySol: solToString(row.solIn) }, 'Position sold');
        this.forget(row.mint.toBase58(), reason);
        return;
      }
      if (sold) {
        return;
      }
      row.nextSellAtMs = Date.now() + this.config.sellRetryIntervalMs;
      logger.error(
        { mint: row.mint.toBase58(), retryInMs: this.config.sellRetryIntervalMs },
        'Sell did not clear the balance. It will be retried.',
      );
    } finally {
      row.selling = false;
    }
  }

  private async tokenBalance(row: Watched): Promise<bigint> {
    try {
      const ata = getAssociatedTokenAddressSync(row.mint, this.owner, false, row.tokenProgram);
      const balance = await this.connection.getTokenAccountBalance(ata);
      return BigInt(balance.value.amount);
    } catch {
      return 0n;
    }
  }

  private forget(mint: string, reason: string) {
    const sub = this.subs.get(mint);
    if (sub !== undefined) {
      this.connection.removeAccountChangeListener(sub).catch(() => undefined);
      this.subs.delete(mint);
    }
    this.watched.delete(mint);
    this.persist();
    logger.info({ mint, reason }, 'Position closed');
  }

  private persist() {
    const dir = path.dirname(FILE);
    fs.mkdirSync(dir, { recursive: true });
    const rows = [...this.watched.values()].map((row) => ({
      mint: row.mint.toBase58(),
      tokenProgram: row.tokenProgram.toBase58(),
      tokens: row.tokens.toString(),
      solIn: row.solIn.toString(),
      openedAtMs: row.openedAtMs,
      pool: row.swap?.pool.toBase58(),
    }));
    fs.writeFileSync(FILE, JSON.stringify(rows, null, 2));
  }

  private logOpened(row: Watched) {
    const take = row.solIn + (row.solIn * BigInt(this.config.takeProfitPercent)) / 100n;
    const stop = row.solIn - (row.solIn * BigInt(this.config.stopLossPercent)) / 100n;
    logger.info(
      {
        mint: row.mint.toBase58(),
        tokens: row.tokens.toString(),
        entrySol: solToString(row.solIn),
        takeProfitSol: solToString(take),
        stopLossSol: solToString(stop),
      },
      'Position opened',
    );
  }
}

function curveFee(creatorFeeBps: bigint): bigint {
  if (creatorFeeBps > 0n && creatorFeeBps <= 2_000n) {
    return creatorFeeBps;
  }
  return BONDING_CURVE_CREATOR_FEE_BPS;
}

function swapFromPool(mint: PublicKey, poolPk: PublicKey, pool: ReturnType<typeof decodePumpSwapPool>, tokenProgram: PublicKey): PumpSwapPosition {
  const decoded = pool!;
  const tokenIsBase = !isSolQuoteMint(decoded.baseMint);
  return {
    venue: 'pumpswap',
    mint,
    pool: poolPk,
    baseMint: decoded.baseMint,
    quoteMint: decoded.quoteMint,
    poolBaseTokenAccount: decoded.poolBaseTokenAccount,
    poolQuoteTokenAccount: decoded.poolQuoteTokenAccount,
    baseTokenProgram: tokenIsBase ? tokenProgram : TOKEN_PROGRAM_ID,
    quoteTokenProgram: tokenIsBase ? TOKEN_PROGRAM_ID : tokenProgram,
    coinCreator: decoded.coinCreator,
    creatorFeeBps: decoded.creatorFeeBps,
    virtualQuoteReserves: decoded.virtualQuoteReserves > 0n ? decoded.virtualQuoteReserves : 0n,
    tokenIsBase,
  };
}

function solToString(lamports: bigint): string {
  return (Number(lamports) / 1_000_000_000).toFixed(6);
}

async function mark(
  connection: Connection,
  mint: PublicKey,
  tokens: bigint,
  curve: ReturnType<typeof decodeBondingCurve>,
  pool: ReturnType<typeof decodePumpSwapPool>,
): Promise<bigint> {
  if (curve && !curve.complete) {
    return quoteBondingCurveSell(tokens, curve.virtualTokenReserves, curve.virtualQuoteReserves);
  }
  if (!pool) {
    return 0n;
  }
  const [base, quote] = await Promise.all([
    connection.getTokenAccountBalance(pool.poolBaseTokenAccount),
    connection.getTokenAccountBalance(pool.poolQuoteTokenAccount),
  ]);
  const fee = PUMPSWAP_LP_FEE_BPS + PUMPSWAP_PROTOCOL_FEE_BPS + PUMPSWAP_CREATOR_FEE_BPS;
  const baseReserve = BigInt(base.value.amount);
  const quoteReserve = BigInt(quote.value.amount);
  return isSolQuoteMint(pool.baseMint)
    ? quotePumpSwapBuy(tokens, baseReserve, quoteReserve, fee)
    : quotePumpSwapSell(tokens, baseReserve, quoteReserve, fee);
}
