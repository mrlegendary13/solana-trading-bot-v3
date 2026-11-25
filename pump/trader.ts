import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import { getAssociatedTokenAddressSync, MintLayout, NATIVE_MINT, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { logger } from '../helpers/logger';
import { sleep } from '../helpers/promises';
import { watchAccountUntil } from '../helpers/price-watch';
import { TransactionExecutor } from '../transactions';
import { buyFailureShouldStop, sellFailureClass } from '../transactions/tx-error';
import {
  BONDING_CURVE_CREATOR_FEE_BPS,
  BONDING_CURVE_PROTOCOL_FEE_BPS,
  DEFAULT_INITIAL_REAL_TOKEN_RESERVES,
  isSolQuoteMint,
  orientSolPair,
  PUMPSWAP_CREATOR_FEE_BPS,
  PUMPSWAP_LP_FEE_BPS,
  PUMPSWAP_PROTOCOL_FEE_BPS,
} from './constants';
import { CreatePoolEvent, PumpCreateEvent } from './events';
import { fillFromTransaction } from './fill';
import { evaluatePumpFilters, PumpFilterConfig } from './filters';
import {
  closeBaseAtaIx,
  createBaseAtaIx,
  pumpBuyExactQuoteIx,
  pumpSellIx,
  pumpSwapBuyIx,
  pumpSwapSellIx,
  wrapSolIxs,
} from './instructions';
import { decodeBondingCurve, decodePumpAmmGlobal, decodePumpGlobal, decodePumpSwapPool, PumpGlobalAccount } from './layout';
import { tokenAccountAmount } from './static-accounts';
import { isTokenProgram, readMintFlags } from './mint-flags';
import { bondingCurvePda, canonicalPumpPoolPda, pumpAmmGlobalConfigPda, pumpGlobalPda, pumpPoolAuthorityPda } from './pda';
import { PositionBook, PumpPosition, PumpSwapPosition } from './positions';
import {
  applySlippage,
  curveProgressPercent,
  higherFee,
  lamportsToSol,
  marketCapLamports,
  maxPayableSellAmount,
  quoteBondingCurveBuy,
  quoteBondingCurveSell,
  quotePumpSwapBuy,
  quotePumpSwapSell,
  sellSlippageForAttempt,
} from './quotes';
import { QualityConfig, checkTokenQuality } from './quality';
import { BuyerTracker, CreatorBlacklist } from './tracking';

export interface PumpTradeConfig {
  wallet: Keypair;
  quoteLamports: bigint;
  buySlippage: number;
  sellSlippage: number;
  sellSlippageStep: number;
  maxBuyRetries: number;
  maxSellRetries: number;
  retryBackoffMs: number;
  unitLimit: number;
  unitPrice: number;
  takeProfit: number;
  stopLoss: number;
  priceCheckInterval: number;
  priceCheckDuration: number;
  priceCheckWebsocket: boolean;
  dryRun: boolean;
  closeEmptyTokenAccounts: boolean;
  autoSellDelay: number;
  buyerWaitMs: number;
  filters: PumpFilterConfig;
  checkRenounced: boolean;
  checkFreezable: boolean;
  checkMutable: boolean;
  quality: QualityConfig;
  staticGlobal: PumpGlobalAccount | null;
}

interface BuiltTransaction {
  transaction: VersionedTransaction;
  blockhash: { blockhash: string; lastValidBlockHeight: number };
}

/**
 * Bonding-curve and PumpSwap execution. Raydium stays in Bot; both share the
 * same transaction executor, so default / warp / jito and dry-run apply here.
 */
export class PumpTrader {
  private pumpGlobal: PumpGlobalAccount | null = null;
  private globalFetched = false;
  private pumpGlobalWarned = false;
  private cachedBuybackAta: PublicKey | null = null;

  constructor(
    private readonly connection: Connection,
    private readonly txExecutor: TransactionExecutor,
    private readonly config: PumpTradeConfig,
    private readonly positions: PositionBook,
    private readonly buyers: BuyerTracker,
    private readonly blacklist: CreatorBlacklist,
  ) {}

  async screenCreate(event: PumpCreateEvent): Promise<{
    event: PumpCreateEvent;
    tokenProgram: PublicKey;
    initialReal: bigint;
    protocolFeeBps: bigint;
    creatorFeeBps: bigint;
    expected: bigint;
    recipient: PublicKey;
    creator: PublicKey;
  } | null> {
    const mint = event.mint.toBase58();
    if (!isSolQuoteMint(event.quoteMint)) {
      logger.debug(
        { mint, quoteMint: event.quoteMint.toBase58() },
        'Skipping pump create because the quote mint is not SOL. The coin exists, but it is paired with another asset.',
      );
      return null;
    }

    const tokenProgram = await this.resolveTokenProgram(event.mint, event.tokenProgram);
    if (!tokenProgram) {
      logger.debug({ mint }, 'Skipping pump create because the token program is not SPL Token or Token-2022');
      return null;
    }

    if (this.config.buyerWaitMs > 0 && this.config.filters.minUniqueBuyers > 0) {
      const deadline = Date.now() + this.config.buyerWaitMs;
      while (this.buyers.count(mint) < this.config.filters.minUniqueBuyers && Date.now() < deadline) {
        await sleep(200);
      }
    }
    if (this.config.quality.enabled && this.config.quality.waitMs > 0) {
      await sleep(this.config.quality.waitMs);
    }

    const curvePk = bondingCurvePda(event.mint);
    const creatorAta = getAssociatedTokenAddressSync(event.mint, event.creator, true, tokenProgram);
    const [curveInfo, mintInfo, creatorInfo] = await this.connection.getMultipleAccountsInfo(
      [curvePk, event.mint, creatorAta],
      this.connection.commitment,
    );
    const curve = curveInfo ? decodeBondingCurve(Buffer.from(curveInfo.data)) : null;
    if (!curve) {
      logger.debug({ mint }, 'Skipping pump create because the bonding curve account is missing');
      return null;
    }

    const global = await this.loadPumpGlobal();
    const initialReal =
      event.realTokenReserves > 0n
        ? event.realTokenReserves
        : (global?.initialRealTokenReserves ?? DEFAULT_INITIAL_REAL_TOKEN_RESERVES);
    const creatorTokens = tokenAccountAmount(creatorInfo?.data);
    const devBuyLamports = curve.virtualTokenReserves > 0n ? (creatorTokens * curve.virtualQuoteReserves) / curve.virtualTokenReserves : 0n;
    const creatorHoldPercent = curve.tokenTotalSupply > 0n ? Number((creatorTokens * 10_000n) / curve.tokenTotalSupply) / 100 : 0;

    const decision = evaluatePumpFilters(this.config.filters, {
      creator: event.creator,
      quoteMint: curve.quoteMint,
      mayhem: curve.isMayhemMode,
      complete: curve.complete,
      progressPercent: curveProgressPercent(initialReal, curve.realTokenReserves, curve.complete),
      marketCapLamports: marketCapLamports(curve.virtualQuoteReserves, curve.virtualTokenReserves, curve.tokenTotalSupply),
      devBuyLamports,
      creatorHoldPercent,
      uniqueBuyers: this.buyers.count(mint),
      realQuoteLamports: curve.realQuoteReserves,
      blacklisted: this.blacklist.has(event.creator.toBase58()),
    });
    if (!decision.ok) {
      logger.info({ mint }, decision.message);
      return null;
    }

    const qualityReason = await checkTokenQuality(this.connection, event.mint, this.config.quality, this.buyers, {
      creator: event.creator.toBase58(),
      devBuyPct: creatorHoldPercent,
      realSol: Number(curve.realQuoteReserves) / 1_000_000_000,
      supply: curve.tokenTotalSupply,
      excludeAccounts: [getAssociatedTokenAddressSync(event.mint, curvePk, true, tokenProgram).toBase58()],
      activityAccount: curvePk,
      mintData: mintInfo ? Buffer.from(mintInfo.data) : undefined,
    });
    if (qualityReason) {
      logger.info({ mint }, `Skipping ${mint}: ${qualityReason}`);
      return null;
    }

    if (!(await this.mintAllowed(event.mint, mintInfo ? Buffer.from(mintInfo.data) : undefined))) {
      return null;
    }

    const protocolFeeBps = this.saneBps(global?.feeBasisPoints ?? 0n, BONDING_CURVE_PROTOCOL_FEE_BPS);
    const creatorFeeBps = this.saneBps(
      higherFee(curve.creatorFeeBps, global?.creatorFeeBasisPoints ?? 0n),
      BONDING_CURVE_CREATOR_FEE_BPS,
    );
    const expected = quoteBondingCurveBuy(
      this.config.quoteLamports,
      curve.virtualTokenReserves,
      curve.virtualQuoteReserves,
      protocolFeeBps,
      creatorFeeBps,
    );
    if (expected <= 0n) {
      logger.info({ mint }, 'Skipping pump buy because the quoted token output is zero');
      return null;
    }

    const recipient = this.pickRecipient(global?.buybackFeeRecipients ?? []);
    if (!recipient) {
      logger.error({ mint }, 'Pump Global has no buyback fee recipient. Buy was not sent.');
      return null;
    }

    return {
      event,
      tokenProgram,
      initialReal,
      protocolFeeBps,
      creatorFeeBps,
      expected,
      recipient,
      creator: curve.creator,
    };
  }

  async commitCreate(screened: {
    event: PumpCreateEvent;
    tokenProgram: PublicKey;
    initialReal: bigint;
    protocolFeeBps: bigint;
    creatorFeeBps: bigint;
    expected: bigint;
    recipient: PublicKey;
    creator: PublicKey;
  }): Promise<{ tokensOut: bigint; solIn?: bigint; position: PumpPosition } | null> {
    const { event, tokenProgram, initialReal, protocolFeeBps, creatorFeeBps, expected, recipient } = screened;
    const mint = event.mint.toBase58();
    const balance = BigInt(await this.connection.getBalance(this.config.wallet.publicKey));
    const needed = this.config.quoteLamports + 6_000_000n;
    if (balance < needed) {
      logger.error(
        { mint, balance: balance.toString(), needed: needed.toString() },
        'Not enough SOL for the pump buy plus token-account and volume-account rent. Buy was not sent.',
      );
      return null;
    }
    const position: PumpPosition = {
      venue: 'pump',
      mint: event.mint,
      bondingCurve: bondingCurvePda(event.mint),
      quoteMint: NATIVE_MINT,
      baseTokenProgram: tokenProgram,
      creator: screened.creator,
      initialRealTokenReserves: initialReal,
    };
    this.positions.set(position);

    const attempt = await this.execute(mint, 'buy', async (slippage) => {
      const fresh = await this.readCurve(event.mint);
      const quoted = fresh
        ? quoteBondingCurveBuy(this.config.quoteLamports, fresh.virtualTokenReserves, fresh.virtualQuoteReserves, protocolFeeBps, creatorFeeBps)
        : expected;
      const minOut = applySlippage(quoted > 0n ? quoted : expected, slippage);
      logger.debug({ mint }, `Pump buy quote ${quoted.toString()} min ${minOut.toString()}`);
      return this.compile([
        ...this.priorityFeeIxs(),
        createBaseAtaIx(this.config.wallet.publicKey, event.mint, this.config.wallet.publicKey, tokenProgram),
        pumpBuyExactQuoteIx({
          user: this.config.wallet.publicKey,
          mint: event.mint,
          baseTokenProgram: tokenProgram,
          spendableQuoteIn: this.config.quoteLamports,
          minTokensOut: minOut,
          buybackFeeRecipient: recipient,
        }),
      ]);
    });

    if (!attempt.ok) {
      const landed = await this.tokenBalance(event.mint, this.config.wallet.publicKey, tokenProgram);
      if (landed <= 0n) {
        this.positions.delete(mint);
        return null;
      }
      logger.warn({ mint, tokens: landed.toString() }, 'Buy confirmation failed but the tokens arrived. The position stays open.');
      return { tokensOut: landed, position };
    }

    const filled = await this.fillFromSignature(attempt.signature, event.mint);
    logger.info({ mint, creator: event.creator.toBase58(), tokensOut: (filled?.tokens ?? expected).toString() }, 'Pump buy transaction confirmed');
    return { tokensOut: filled?.tokens ?? expected, solIn: filled?.solIn, position };
  }

  async screenPool(event: CreatePoolEvent): Promise<{
    position: PumpSwapPosition;
    feeBps: bigint;
    expected: bigint;
    buybackAta: PublicKey;
  } | null> {
    const oriented = orientSolPair(event.baseMint, event.quoteMint);
    if (!oriented) {
      logger.debug(
        { baseMint: event.baseMint.toBase58(), quoteMint: event.quoteMint.toBase58() },
        'Skipping PumpSwap pool because neither mint is SOL',
      );
      return null;
    }
    const mint = oriented.tokenMint.toBase58();
    if (!oriented.tokenIsBase) {
      logger.debug(
        { mint, baseMint: event.baseMint.toBase58(), quoteMint: event.quoteMint.toBase58() },
        'PumpSwap pool has SOL on the base side. The token mint above is the quote.',
      );
    }

    const canonical = canonicalPumpPoolPda(oriented.tokenMint);
    const graduation =
      event.creator.equals(pumpPoolAuthorityPda(oriented.tokenMint)) || event.pool.equals(canonical);
    if (!event.pool.equals(canonical) && !graduation) {
      logger.debug({ mint }, 'Skipping PumpSwap pool that is not a pump.fun graduation');
      return null;
    }
    if (this.config.filters.skipMayhem && event.isMayhemMode) {
      logger.debug(
        { mint },
        'Skipping PumpSwap pool: mayhem mode is enabled and PUMP_SKIP_MAYHEM=true. Set PUMP_SKIP_MAYHEM=false to buy these.',
      );
      return null;
    }
    if (this.blacklist.has(event.coinCreator.toBase58()) || this.blacklist.has(event.creator.toBase58())) {
      logger.info({ mint }, `Skipping ${mint}: creator is blacklisted`);
      return null;
    }
    if (this.config.quality.enabled && this.config.quality.waitMs > 0) {
      await sleep(this.config.quality.waitMs);
    }

    const [poolInfo, prefetchedMint] = await this.connection.getMultipleAccountsInfo(
      [event.pool, oriented.tokenMint],
      this.connection.commitment,
    );
    const pool = poolInfo ? decodePumpSwapPool(Buffer.from(poolInfo.data)) : null;
    if (!pool) {
      logger.debug({ mint }, 'Skipping PumpSwap pool because the account could not be decoded');
      return null;
    }

    const poolOrient = orientSolPair(pool.baseMint, pool.quoteMint);
    if (!poolOrient) {
      logger.debug(
        { mint, baseMint: pool.baseMint.toBase58(), quoteMint: pool.quoteMint.toBase58() },
        'Skipping PumpSwap pool because the pool account is not a SOL pair',
      );
      return null;
    }
    const tokenMint = poolOrient.tokenMint;
    const tokenProgram =
      prefetchedMint && isTokenProgram(prefetchedMint.owner)
        ? prefetchedMint.owner
        : await this.resolveTokenProgram(tokenMint, TOKEN_PROGRAM_ID);
    if (!tokenProgram) {
      return null;
    }

    const [baseInfo, quoteInfo] = await this.connection.getMultipleAccountsInfo(
      [pool.poolBaseTokenAccount, pool.poolQuoteTokenAccount],
      this.connection.commitment,
    );
    const virtualQuote = pool.virtualQuoteReserves > 0n ? pool.virtualQuoteReserves : 0n;
    const reserves = {
      base: tokenAccountAmount(baseInfo?.data),
      quote: tokenAccountAmount(quoteInfo?.data) + virtualQuote,
    };
    const realSolLamports = poolOrient.tokenIsBase ? reserves.quote - virtualQuote : reserves.base;
    const qualityReason = await checkTokenQuality(this.connection, tokenMint, this.config.quality, this.buyers, {
      creator: event.coinCreator.toBase58(),
      devBuyPct: 0,
      realSol: Number(realSolLamports > 0n ? realSolLamports : 0n) / 1_000_000_000,
      supply: 0n,
      excludeAccounts: [pool.poolBaseTokenAccount.toBase58(), pool.poolQuoteTokenAccount.toBase58()],
      activityAccount: event.pool,
      mintData: prefetchedMint ? Buffer.from(prefetchedMint.data) : undefined,
    });
    if (qualityReason) {
      logger.info({ mint: tokenMint.toBase58() }, `Skipping ${tokenMint.toBase58()}: ${qualityReason}`);
      return null;
    }
    if (!(await this.mintAllowed(tokenMint, prefetchedMint ? Buffer.from(prefetchedMint.data) : undefined))) {
      return null;
    }
    const feeBps = PUMPSWAP_LP_FEE_BPS + PUMPSWAP_PROTOCOL_FEE_BPS + higherFee(pool.creatorFeeBps, PUMPSWAP_CREATOR_FEE_BPS);
    const expected = poolOrient.tokenIsBase
      ? quotePumpSwapBuy(this.config.quoteLamports, reserves.base, reserves.quote, feeBps)
      : quotePumpSwapSell(this.config.quoteLamports, reserves.base, reserves.quote, feeBps);
    if (expected <= 0n) {
      logger.info({ mint: tokenMint.toBase58() }, 'Skipping PumpSwap buy because the quoted token output is zero');
      return null;
    }

    const buybackAta = await this.pumpSwapBuybackAta();
    if (!buybackAta) {
      logger.error({ mint }, 'No existing PumpSwap buyback WSOL account. Buy was not sent.');
      return null;
    }

    const position: PumpSwapPosition = {
      venue: 'pumpswap',
      mint: tokenMint,
      pool: event.pool,
      baseMint: pool.baseMint,
      quoteMint: pool.quoteMint,
      poolBaseTokenAccount: pool.poolBaseTokenAccount,
      poolQuoteTokenAccount: pool.poolQuoteTokenAccount,
      baseTokenProgram: poolOrient.tokenIsBase ? tokenProgram : TOKEN_PROGRAM_ID,
      quoteTokenProgram: poolOrient.tokenIsBase ? TOKEN_PROGRAM_ID : tokenProgram,
      coinCreator: pool.coinCreator,
      creatorFeeBps: pool.creatorFeeBps,
      virtualQuoteReserves: pool.virtualQuoteReserves > 0n ? pool.virtualQuoteReserves : 0n,
      tokenIsBase: poolOrient.tokenIsBase,
    };
    return { position, feeBps, expected, buybackAta };
  }

  async commitPool(screened: {
    position: PumpSwapPosition;
    feeBps: bigint;
    expected: bigint;
    buybackAta: PublicKey;
  }): Promise<{ tokensOut: bigint; solIn?: bigint; position: PumpSwapPosition } | null> {
    const { position, feeBps, expected, buybackAta } = screened;
    const mint = position.mint.toBase58();
    const balance = BigInt(await this.connection.getBalance(this.config.wallet.publicKey));
    const needed = this.config.quoteLamports + 6_000_000n;
    if (balance < needed) {
      logger.error(
        { mint, balance: balance.toString(), needed: needed.toString() },
        'Not enough SOL for the PumpSwap buy plus account rent. Buy was not sent.',
      );
      return null;
    }
    this.positions.set(position);
    const tokenProgram = position.tokenIsBase ? position.baseTokenProgram : position.quoteTokenProgram;
    const attempt = await this.execute(mint, 'buy', async (slippage) => {
      const live = await this.poolReserves(
        position.poolBaseTokenAccount,
        position.poolQuoteTokenAccount,
        position.virtualQuoteReserves,
      );
      const quoted = live
        ? position.tokenIsBase
          ? quotePumpSwapBuy(this.config.quoteLamports, live.base, live.quote, feeBps)
          : quotePumpSwapSell(this.config.quoteLamports, live.base, live.quote, feeBps)
        : expected;
      const minOut = applySlippage(quoted > 0n ? quoted : expected, slippage);
      const trade = position.tokenIsBase
        ? pumpSwapBuyIx({
            user: this.config.wallet.publicKey,
            pool: position.pool,
            baseMint: position.baseMint,
            quoteMint: position.quoteMint,
            poolBase: position.poolBaseTokenAccount,
            poolQuote: position.poolQuoteTokenAccount,
            baseTokenProgram: position.baseTokenProgram,
            quoteTokenProgram: position.quoteTokenProgram,
            spendableQuoteIn: this.config.quoteLamports,
            minBaseOut: minOut,
            buybackQuoteAta: buybackAta,
          })
        : pumpSwapSellIx({
            user: this.config.wallet.publicKey,
            pool: position.pool,
            baseMint: position.baseMint,
            quoteMint: position.quoteMint,
            poolBase: position.poolBaseTokenAccount,
            poolQuote: position.poolQuoteTokenAccount,
            baseTokenProgram: position.baseTokenProgram,
            quoteTokenProgram: position.quoteTokenProgram,
            baseAmountIn: this.config.quoteLamports,
            minQuoteOut: minOut,
            buybackQuoteAta: buybackAta,
          });
      return this.compile([
        ...this.priorityFeeIxs(),
        createBaseAtaIx(this.config.wallet.publicKey, position.mint, this.config.wallet.publicKey, tokenProgram),
        ...wrapSolIxs(this.config.wallet.publicKey, this.config.quoteLamports),
        trade,
        closeBaseAtaIx(NATIVE_MINT, this.config.wallet.publicKey, TOKEN_PROGRAM_ID),
      ]);
    });

    if (!attempt.ok) {
      const landed = await this.tokenBalance(position.mint, this.config.wallet.publicKey, tokenProgram);
      if (landed <= 0n) {
        this.positions.delete(mint);
        return null;
      }
      logger.warn({ mint, tokens: landed.toString() }, 'PumpSwap confirmation failed but the tokens arrived. The position stays open.');
      return { tokensOut: landed, position };
    }
    const filled = await this.fillFromSignature(attempt.signature, position.mint);
    return { tokensOut: filled?.tokens ?? expected, solIn: filled?.solIn, position };
  }

  async sellPump(position: PumpPosition, amount: bigint, options?: { skipWatch?: boolean }): Promise<boolean> {
    if (amount <= 0n) {
      return false;
    }
    const curveNow = await this.readCurve(position.mint);
    if (curveNow?.complete) {
      logger.info({ mint: position.mint.toBase58() }, 'Bonding curve is complete. Trying the canonical PumpSwap pool.');
      const migrated = await this.positionFromCanonicalPool(position);
      if (!migrated) {
        return false;
      }
      return this.sellPumpSwap(migrated, amount, options);
    }
    if (this.config.autoSellDelay > 0 && !options?.skipWatch) {
      await sleep(this.config.autoSellDelay);
    }
    const global = await this.loadPumpGlobal();
    const protocolFeeBps = this.saneBps(global?.feeBasisPoints ?? 0n, BONDING_CURVE_PROTOCOL_FEE_BPS);
    const creatorFeeBps = this.saneBps(
      higherFee(curveNow?.creatorFeeBps ?? 0n, global?.creatorFeeBasisPoints ?? 0n),
      BONDING_CURVE_CREATOR_FEE_BPS,
    );
    const recipient = this.pickRecipient(global?.buybackFeeRecipients ?? []);
    if (!recipient) {
      logger.error({ mint: position.mint.toBase58() }, 'Pump Global has no buyback fee recipient. Sell was not sent.');
      return false;
    }
    if (!options?.skipWatch) {
      await this.holdForExit(position.bondingCurve, async () => {
        const live = await this.readCurve(position.mint);
        if (!live) {
          throw new Error('bonding curve missing');
        }
        const balance = await this.tokenBalance(position.mint, this.config.wallet.publicKey, position.baseTokenProgram);
        const selling = balance > 0n ? balance : amount;
        return quoteBondingCurveSell(selling, live.virtualTokenReserves, live.virtualQuoteReserves, protocolFeeBps, creatorFeeBps);
      });
    }
    const cleared = await this.drainBalance(position.mint, position.baseTokenProgram, async (balance, slippage) => {
      const live = await this.readCurve(position.mint);
      if (!live) {
        return null;
      }
      if (live.complete) {
        return 'migrated';
      }
      const payable = maxPayableSellAmount(live.virtualTokenReserves, live.virtualQuoteReserves, live.realQuoteReserves);
      const selling = payable < balance ? payable : balance;
      if (selling <= 0n) {
        logger.error(
          { mint: position.mint.toBase58(), balance: balance.toString(), realSol: live.realQuoteReserves.toString() },
          'The curve does not hold enough SOL to pay for any of this balance. Sell was not sent.',
        );
        return null;
      }
      if (selling < balance) {
        logger.info(
          {
            mint: position.mint.toBase58(),
            balance: balance.toString(),
            selling: selling.toString(),
            realSol: live.realQuoteReserves.toString(),
          },
          'Selling the most the curve can pay in one SellV3. The rest stays until the curve holds more SOL.',
        );
      }
      const quoted = quoteBondingCurveSell(
        selling,
        live.virtualTokenReserves,
        live.virtualQuoteReserves,
        protocolFeeBps,
        creatorFeeBps,
      );
      return {
        instructions: [
          pumpSellIx({
            user: this.config.wallet.publicKey,
            mint: position.mint,
            baseTokenProgram: position.baseTokenProgram,
            amount: selling,
            minQuoteOut: applySlippage(quoted, slippage),
            buybackFeeRecipient: recipient,
          }),
        ],
        covered: selling,
        close: selling >= balance,
      };
    });
    if (cleared === 'migrated') {
      const migrated = await this.positionFromCanonicalPool(position);
      if (!migrated) {
        return false;
      }
      const left = await this.tokenBalance(position.mint, this.config.wallet.publicKey, position.baseTokenProgram);
      return this.sellPumpSwap(migrated, left > 0n ? left : amount, { skipWatch: true });
    }
    if (cleared) {
      this.positions.delete(position.mint.toBase58());
    }
    return cleared === true;
  }

  async sellPumpSwap(position: PumpSwapPosition, amount: bigint, options?: { skipWatch?: boolean }): Promise<boolean> {
    if (amount <= 0n) {
      return false;
    }
    if (this.config.autoSellDelay > 0 && !options?.skipWatch) {
      await sleep(this.config.autoSellDelay);
    }

    const buybackAta = await this.pumpSwapBuybackAta();
    if (!buybackAta) {
      logger.error({ mint: position.mint.toBase58() }, 'No existing PumpSwap buyback WSOL account. Sell was not sent.');
      return false;
    }
    const feeBps = PUMPSWAP_LP_FEE_BPS + PUMPSWAP_PROTOCOL_FEE_BPS + higherFee(position.creatorFeeBps, PUMPSWAP_CREATOR_FEE_BPS);
    if (!position.tokenIsBase) {
      return this.sellFlippedPumpSwap(position, amount, buybackAta, feeBps, options);
    }

    if (!options?.skipWatch) {
      await this.holdForExit(position.poolQuoteTokenAccount, async () => {
        const reserves = await this.poolReserves(position.poolBaseTokenAccount, position.poolQuoteTokenAccount, position.virtualQuoteReserves);
        if (!reserves) {
          throw new Error('pool reserves missing');
        }
        return quotePumpSwapSell(amount, reserves.base, reserves.quote, feeBps);
      });
    }

    const tokenProgram = position.baseTokenProgram;
    const cleared = await this.drainBalance(position.mint, tokenProgram, async (balance, slippage) => {
      const reserves = await this.poolReserves(
        position.poolBaseTokenAccount,
        position.poolQuoteTokenAccount,
        position.virtualQuoteReserves,
      );
      if (!reserves) {
        return null;
      }
      const quoted = quotePumpSwapSell(balance, reserves.base, reserves.quote, feeBps);
      const sells = [
        createBaseAtaIx(this.config.wallet.publicKey, NATIVE_MINT, this.config.wallet.publicKey, TOKEN_PROGRAM_ID),
        pumpSwapSellIx({
          user: this.config.wallet.publicKey,
          pool: position.pool,
          baseMint: position.baseMint,
          quoteMint: position.quoteMint,
          poolBase: position.poolBaseTokenAccount,
          poolQuote: position.poolQuoteTokenAccount,
          baseTokenProgram: position.baseTokenProgram,
          quoteTokenProgram: position.quoteTokenProgram,
          baseAmountIn: balance,
          minQuoteOut: applySlippage(quoted, slippage),
          buybackQuoteAta: buybackAta,
        }),
        closeBaseAtaIx(NATIVE_MINT, this.config.wallet.publicKey, TOKEN_PROGRAM_ID),
      ];
      return { instructions: sells, covered: balance, close: true };
    });
    if (cleared === true) {
      this.positions.delete(position.mint.toBase58());
    }
    return cleared === true;
  }

  /** SOL is the pool base and the token is the quote. Spend the token to receive SOL. */
  private async sellFlippedPumpSwap(
    position: PumpSwapPosition,
    amount: bigint,
    buybackAta: PublicKey,
    feeBps: bigint,
    options?: { skipWatch?: boolean },
  ): Promise<boolean> {
    if (!options?.skipWatch) {
    await this.holdForExit(position.poolBaseTokenAccount, async () => {
      const reserves = await this.poolReserves(
        position.poolBaseTokenAccount,
        position.poolQuoteTokenAccount,
        position.virtualQuoteReserves,
      );
      if (!reserves) {
        throw new Error('pool reserves missing');
      }
      return quotePumpSwapBuy(amount, reserves.base, reserves.quote, feeBps);
    });
    }

    const cleared = await this.drainBalance(position.mint, position.quoteTokenProgram, async (balance, slippage) => {
      const reserves = await this.poolReserves(
        position.poolBaseTokenAccount,
        position.poolQuoteTokenAccount,
        position.virtualQuoteReserves,
      );
      if (!reserves) {
        return null;
      }
      const quoted = quotePumpSwapBuy(balance, reserves.base, reserves.quote, feeBps);
      const sells = [
        createBaseAtaIx(this.config.wallet.publicKey, NATIVE_MINT, this.config.wallet.publicKey, TOKEN_PROGRAM_ID),
        pumpSwapBuyIx({
          user: this.config.wallet.publicKey,
          pool: position.pool,
          baseMint: position.baseMint,
          quoteMint: position.quoteMint,
          poolBase: position.poolBaseTokenAccount,
          poolQuote: position.poolQuoteTokenAccount,
          baseTokenProgram: position.baseTokenProgram,
          quoteTokenProgram: position.quoteTokenProgram,
          spendableQuoteIn: balance,
          minBaseOut: applySlippage(quoted, slippage),
          buybackQuoteAta: buybackAta,
        }),
        closeBaseAtaIx(NATIVE_MINT, this.config.wallet.publicKey, TOKEN_PROGRAM_ID),
      ];
      return { instructions: sells, covered: balance, close: true };
    });
    if (cleared === true) {
      this.positions.delete(position.mint.toBase58());
    }
    return cleared === true;
  }

  private async positionFromCanonicalPool(position: PumpPosition): Promise<PumpSwapPosition | null> {
    const poolAddress = canonicalPumpPoolPda(position.mint);
    const info = await this.connection.getAccountInfo(poolAddress, this.connection.commitment);
    const pool = info ? decodePumpSwapPool(info.data as Buffer) : null;
    if (!pool) {
      logger.error({ mint: position.mint.toBase58() }, 'Curve is complete and the canonical PumpSwap pool is not available yet');
      return null;
    }
    return {
      venue: 'pumpswap',
      mint: position.mint,
      pool: poolAddress,
      baseMint: pool.baseMint,
      quoteMint: NATIVE_MINT,
      poolBaseTokenAccount: pool.poolBaseTokenAccount,
      poolQuoteTokenAccount: pool.poolQuoteTokenAccount,
      baseTokenProgram: position.baseTokenProgram,
      quoteTokenProgram: TOKEN_PROGRAM_ID,
      coinCreator: pool.coinCreator,
      creatorFeeBps: pool.creatorFeeBps,
      virtualQuoteReserves: pool.virtualQuoteReserves > 0n ? pool.virtualQuoteReserves : 0n,
      tokenIsBase: orientSolPair(pool.baseMint, pool.quoteMint)?.tokenIsBase ?? true,
    };
  }

  private async drainBalance(
    mint: PublicKey,
    tokenProgram: PublicKey,
    plan: (
      balance: bigint,
      slippage: number,
    ) => Promise<{ instructions: TransactionInstruction[]; covered: bigint; close: boolean } | 'migrated' | null>,
  ): Promise<boolean | 'migrated'> {
    const mintText = mint.toBase58();
    let slippage = this.config.sellSlippage;
    let failures = 0;
    const max = Math.max(1, this.config.maxSellRetries);
    while (failures < max) {
      const balance = await this.tokenBalance(mint, this.config.wallet.publicKey, tokenProgram);
      if (balance <= 0n) {
        return true;
      }
      const planned = await plan(balance, slippage);
      if (planned === 'migrated') {
        return 'migrated';
      }
      if (!planned) {
        logger.error({ mint: mintText }, 'Sell quote is unavailable. The balance was left in the wallet.');
        return false;
      }
      const units = Math.min(1_400_000, 60_000 * planned.instructions.length + 40_000);
      const built = await this.compile([
        ...this.priorityFeeIxs(units),
        ...planned.instructions,
        ...(planned.close && this.config.closeEmptyTokenAccounts
          ? [closeBaseAtaIx(mint, this.config.wallet.publicKey, tokenProgram)]
          : []),
      ]);
      logger.info(
        { mint: mintText, tokens: planned.covered.toString(), slippage, chunks: planned.instructions.length },
        `Send sell transaction (${failures + 1}/${max})`,
      );
      const result = await this.txExecutor.executeAndConfirm(built.transaction, this.config.wallet, built.blockhash);
      if (result.confirmed) {
        if (this.config.dryRun) {
          logger.info({ mint: mintText, signature: result.signature }, 'DRY_RUN sell simulated. Nothing was broadcast.');
          return true;
        }
        const left = await this.tokenBalance(mint, this.config.wallet.publicKey, tokenProgram);
        if (left <= 0n) {
          logger.info({ mint: mintText, signature: result.signature }, 'Confirmed sell tx');
          return true;
        }
        logger.info(
          { mint: mintText, signature: result.signature, remaining: left.toString() },
          'Sell landed. Reading the balance again for the next chunk.',
        );
        slippage = this.config.sellSlippage;
        failures = 0;
        continue;
      }
      logger.error(
        { mint: mintText, signature: result.signature, error: result.error, attempt: failures + 1, max },
        'sell attempt failed',
      );
      const klass = sellFailureClass(result.error);
      if (klass === 'slippage') {
        const next = Math.min(100, slippage + Math.max(0, this.config.sellSlippageStep));
        logger.info({ mint: mintText, slippage: next }, 'Sell missed the minimum output. Requoting with wider slippage.');
        slippage = next;
        failures += 1;
        continue;
      }
      if (klass === 'fatal') {
        logger.error(
          { mint: mintText, error: result.error },
          'Sell failed with a program error. It will not be sent again unchanged.',
        );
        return false;
      }
      failures += 1;
    }
    const left = await this.tokenBalance(mint, this.config.wallet.publicKey, tokenProgram);
    return left <= 0n;
  }

  private async holdForExit(account: PublicKey, currentOut: () => Promise<bigint>) {
    const entry = this.config.quoteLamports;
    const takeProfit = (entry * BigInt(100 + this.config.takeProfit)) / 100n;
    const stopLoss = (entry * BigInt(Math.max(0, 100 - this.config.stopLoss))) / 100n;
    await watchAccountUntil(
      this.connection,
      account,
      this.config.priceCheckInterval,
      this.config.priceCheckDuration,
      this.config.priceCheckWebsocket,
      async () => {
        const out = await currentOut();
        logger.debug(
          `Take profit: ${lamportsToSol(takeProfit)} SOL | Stop loss: ${lamportsToSol(stopLoss)} SOL | Current: ${lamportsToSol(out)} SOL`,
        );
        return out < stopLoss || out > takeProfit;
      },
    );
  }

  private async execute(
    mint: string,
    direction: 'buy' | 'sell',
    build: (slippage: number, attempt: number, max: number) => Promise<BuiltTransaction | null>,
  ): Promise<{ ok: boolean; signature?: string }> {
    const max = direction === 'buy' ? this.config.maxBuyRetries : this.config.maxSellRetries;
    const base = direction === 'buy' ? this.config.buySlippage : this.config.sellSlippage;
    if (max <= 0) {
      return { ok: false };
    }

    for (let attempt = 0; attempt < max; attempt++) {
      if (attempt > 0 && this.config.retryBackoffMs > 0) {
        await sleep(this.config.retryBackoffMs * attempt);
      }
      const slippage = direction === 'sell' ? sellSlippageForAttempt(attempt, max, base, this.config.sellSlippageStep) : base;
      try {
        logger.info({ mint }, `Send ${direction} transaction attempt: ${attempt + 1}/${max} (slippage ${slippage}%)`);
        const built = await build(slippage, attempt, max);
        if (!built) {
          return { ok: false };
        }
        const result = await this.txExecutor.executeAndConfirm(built.transaction, this.config.wallet, built.blockhash);
        if (result.confirmed) {
          logger.info({ mint, signature: result.signature }, `Confirmed ${direction} tx`);
          return { ok: true, signature: result.signature };
        }
        logger.error(
          { mint, signature: result.signature, error: result.error, attempt: attempt + 1, max },
          `${direction} attempt failed`,
        );
        const stop =
          result.retryable === false ||
          /insufficient lamports|insufficient funds/i.test(result.error || '') ||
          (direction === 'buy' && buyFailureShouldStop(result.error)) ||
          (direction === 'sell' && sellFailureClass(result.error) === 'fatal');
        if (stop) {
          return { ok: false, signature: result.signature };
        }
      } catch (error) {
        logger.error({ mint, error, attempt: attempt + 1, max }, `${direction} attempt threw`);
      }
    }
    return { ok: false };
  }

  private async compile(instructions: TransactionInstruction[]): Promise<BuiltTransaction> {
    const blockhash = await this.connection.getLatestBlockhash(this.connection.commitment);
    const message = new TransactionMessage({
      payerKey: this.config.wallet.publicKey,
      recentBlockhash: blockhash.blockhash,
      instructions,
    }).compileToV0Message();
    const transaction = new VersionedTransaction(message);
    transaction.sign([this.config.wallet]);
    return { transaction, blockhash };
  }

  private priorityFeeIxs(units = Math.max(this.config.unitLimit, 250_000)) {
    return [
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: this.config.unitPrice }),
      ComputeBudgetProgram.setComputeUnitLimit({ units }),
    ];
  }

  private async loadPumpGlobal(): Promise<PumpGlobalAccount | null> {
    if (this.config.staticGlobal) {
      return this.config.staticGlobal;
    }
    if (this.globalFetched) {
      return this.pumpGlobal;
    }
    try {
      const info = await this.connection.getAccountInfo(pumpGlobalPda(), this.connection.commitment);
      this.pumpGlobal = info ? decodePumpGlobal(Buffer.from(info.data)) : null;
      this.globalFetched = true;
    } catch (error) {
      if (!this.pumpGlobalWarned) {
        this.pumpGlobalWarned = true;
        logger.warn({ error }, 'Could not read pump Global. Fee quotes use the published fee schedule.');
      }
    }
    return this.pumpGlobal;
  }

  private pickRecipient(keys: PublicKey[]): PublicKey | null {
    // Buyback recipients are program-derived addresses. They are not ed25519
    // wallet keys, so an on-curve check rejects every entry in Global.
    const usable = keys.filter((key) => !key.equals(PublicKey.default));
    if (usable.length === 0) {
      return null;
    }
    return usable[Math.floor(Math.random() * usable.length)];
  }

  private async pumpSwapBuybackAta(): Promise<PublicKey | null> {
    if (this.cachedBuybackAta) {
      return this.cachedBuybackAta;
    }
    try {
      const info = await this.connection.getAccountInfo(pumpAmmGlobalConfigPda(), this.connection.commitment);
      const global = info ? decodePumpAmmGlobal(info.data as Buffer) : null;
      const recipients = (global?.buybackFeeRecipients ?? []).filter((key) => !key.equals(PublicKey.default));
      if (recipients.length === 0) {
        return null;
      }
      const atas = recipients.map((recipient) => getAssociatedTokenAddressSync(NATIVE_MINT, recipient, true, TOKEN_PROGRAM_ID));
      const accounts = await this.connection.getMultipleAccountsInfo(atas, this.connection.commitment);
      for (let i = 0; i < atas.length; i++) {
        if (accounts[i]) {
          this.cachedBuybackAta = atas[i];
          return atas[i];
        }
      }
    } catch (error) {
      logger.debug({ error }, 'Failed to resolve a PumpSwap buyback account');
    }
    return null;
  }

  private async readCurve(mint: PublicKey) {
    const info = await this.connection.getAccountInfo(bondingCurvePda(mint), this.connection.commitment);
    return info ? decodeBondingCurve(info.data as Buffer) : null;
  }

  private async poolReserves(base: PublicKey, quote: PublicKey, virtualQuote: bigint): Promise<{ base: bigint; quote: bigint } | null> {
    try {
      const [baseBalance, quoteBalance] = await Promise.all([
        this.connection.getTokenAccountBalance(base, this.connection.commitment),
        this.connection.getTokenAccountBalance(quote, this.connection.commitment),
      ]);
      const quoteReserve = BigInt(quoteBalance.value.amount) + (virtualQuote > 0n ? virtualQuote : 0n);
      return { base: BigInt(baseBalance.value.amount), quote: quoteReserve };
    } catch (error) {
      logger.debug({ error }, 'Failed to read PumpSwap reserves');
      return null;
    }
  }

  private async fillFromSignature(signature: string | undefined, mint: PublicKey) {
    if (!signature || signature === 'dry-run') {
      return null;
    }
    try {
      const tx = await this.connection.getTransaction(signature, { maxSupportedTransactionVersion: 0 });
      if (!tx) {
        return null;
      }
      return fillFromTransaction(tx, this.config.wallet.publicKey, mint);
    } catch (error) {
      logger.debug({ mint: mint.toBase58(), error }, 'Could not read the buy fill. Entry falls back to the quote.');
      return null;
    }
  }

  private async tokenBalance(mint: PublicKey, owner: PublicKey, tokenProgram: PublicKey): Promise<bigint> {
    try {
      const ata = getAssociatedTokenAddressSync(mint, owner, true, tokenProgram);
      const balance = await this.connection.getTokenAccountBalance(ata, this.connection.commitment);
      return BigInt(balance.value.amount);
    } catch {
      return 0n;
    }
  }

  private async resolveTokenProgram(mint: PublicKey, hinted: PublicKey): Promise<PublicKey | null> {
    if (isTokenProgram(hinted)) {
      return hinted;
    }
    const info = await this.connection.getAccountInfo(mint, this.connection.commitment);
    if (info && isTokenProgram(info.owner)) {
      return info.owner;
    }
    return null;
  }

  private async mintAllowed(mint: PublicKey, prefetched?: Buffer): Promise<boolean> {
    if (!this.config.checkRenounced && !this.config.checkFreezable && !this.config.checkMutable) {
      return true;
    }
    if (prefetched && prefetched.length >= MintLayout.span) {
      const decoded = MintLayout.decode(prefetched);
      if (this.config.checkRenounced && decoded.mintAuthorityOption !== 0) {
        logger.debug({ mint: mint.toBase58() }, 'Skipping because mint authority is set');
        return false;
      }
      if (this.config.checkFreezable && decoded.freezeAuthorityOption !== 0) {
        logger.debug({ mint: mint.toBase58() }, 'Skipping because the mint is freezable');
        return false;
      }
      if (!this.config.checkMutable) {
        return true;
      }
    }
    const flags = await readMintFlags(this.connection, mint);
    if (!flags) {
      logger.debug({ mint: mint.toBase58() }, 'Skipping because mint account could not be read');
      return false;
    }
    if (this.config.checkRenounced && !flags.renounced) {
      logger.debug({ mint: mint.toBase58() }, 'Skipping because mint authority is set');
      return false;
    }
    if (this.config.checkFreezable && flags.freezable) {
      logger.debug({ mint: mint.toBase58() }, 'Skipping because the mint is freezable');
      return false;
    }
    if (this.config.checkMutable && flags.mutable) {
      logger.debug({ mint: mint.toBase58() }, 'Skipping because metadata is mutable');
      return false;
    }
    return true;
  }

  private saneBps(value: bigint, floor: bigint): bigint {
    if (value < 0n || value > 2_000n) {
      return floor;
    }
    return value > floor ? value : floor;
  }
}
