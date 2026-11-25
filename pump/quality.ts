import { Connection, Finality, PublicKey } from '@solana/web3.js';
import { ExtensionType, getExtensionData, getExtensionTypes } from '@solana/spl-token';
import { BuyerTracker } from './tracking';

const MINT_SIZE = 82;

export interface QualityConfig {
  enabled: boolean;
  checkSellable: boolean;
  maxTransferFeeBps: number;
  maxSingleHolderPct: number;
  maxTop10Pct: number;
  maxDevBuyPct: number;
  maxCreatorLaunches: number;
  waitMs: number;
  minTrades: number;
  minUniqueBuyers: number;
  minBuySellRatio: number;
  maxSameSlotBuys: number;
  minRealSol: number;
  rugcheck: boolean;
  rugcheckMaxScore: number;
  rugcheckTimeoutMs: number;
  rugcheckFailOpen: boolean;
}

export const DEFAULT_QUALITY: QualityConfig = {
  enabled: true,
  checkSellable: true,
  maxTransferFeeBps: 0,
  maxSingleHolderPct: 25,
  maxTop10Pct: 60,
  maxDevBuyPct: 15,
  maxCreatorLaunches: 3,
  waitMs: 3000,
  minTrades: 3,
  minUniqueBuyers: 3,
  minBuySellRatio: 1,
  maxSameSlotBuys: 2,
  minRealSol: 2,
  rugcheck: false,
  rugcheckMaxScore: 1000,
  rugcheckTimeoutMs: 8000,
  rugcheckFailOpen: true,
};

/** Why a mint fails the sellability scan, or null when it is fine. */
export function sellabilityReason(data: Buffer, maxTransferFeeBps: number): string | null {
  if (data.length >= 50) {
    const option = data.readUInt32LE(46);
    if (option === 1) {
      return 'freeze authority is set';
    }
  }
  if (data.length <= MINT_SIZE) {
    return null;
  }
  let types: number[];
  const tlv = data.subarray(MINT_SIZE);
  try {
    types = getExtensionTypes(tlv);
  } catch {
    return 'token extensions could not be read';
  }
  if (types.includes(ExtensionType.NonTransferable)) {
    return 'Token-2022 non-transferable extension';
  }
  if (types.includes(ExtensionType.PausableConfig)) {
    return 'Token-2022 pausable extension';
  }
  if (types.includes(ExtensionType.PermanentDelegate)) {
    const raw = getExtensionData(ExtensionType.PermanentDelegate, tlv);
    if (raw && !new PublicKey(raw.subarray(0, 32)).equals(PublicKey.default)) {
      return 'Token-2022 permanent delegate';
    }
  }
  if (types.includes(ExtensionType.TransferHook)) {
    const raw = getExtensionData(ExtensionType.TransferHook, tlv);
    if (raw && !new PublicKey(raw.subarray(0, 32)).equals(PublicKey.default)) {
      return 'Token-2022 transfer hook';
    }
  }
  if (types.includes(ExtensionType.TransferFeeConfig)) {
    const raw = getExtensionData(ExtensionType.TransferFeeConfig, tlv);
    if (raw && raw.length >= 108) {
      const bps = raw.readUInt16LE(106);
      if (bps > maxTransferFeeBps) {
        return `Token-2022 transfer fee ${bps} bps is above ${maxTransferFeeBps}`;
      }
    }
  }
  return null;
}

export function holderPercents(
  accounts: { address: string; amount: bigint }[],
  supply: bigint,
  exclude: Set<string>,
): { top: number; top10: number } {
  const rows = accounts.filter((row) => !exclude.has(row.address) && row.amount > 0n);
  rows.sort((a, b) => (a.amount === b.amount ? 0 : a.amount > b.amount ? -1 : 1));
  const pct = (amount: bigint) => (supply > 0n ? Number((amount * 10000n) / supply) / 100 : 0);
  const top = rows.length > 0 ? pct(rows[0].amount) : 0;
  const top10 = pct(rows.slice(0, 10).reduce((sum, row) => sum + row.amount, 0n));
  return { top, top10 };
}

export function momentumReason(
  stats: { buys: number; sells: number; unique: number; sameSlotBuys: number },
  config: QualityConfig,
): string | null {
  const trades = stats.buys + stats.sells;
  if (config.minTrades > 0 && trades < config.minTrades) {
    return `only ${trades} trades after create, need ${config.minTrades}`;
  }
  if (config.minUniqueBuyers > 0 && stats.unique < config.minUniqueBuyers) {
    return `only ${stats.unique} unique buyers, need ${config.minUniqueBuyers}`;
  }
  if (config.maxSameSlotBuys > 0 && stats.sameSlotBuys > config.maxSameSlotBuys) {
    return `bundled launch: ${stats.sameSlotBuys} buys in the create slot`;
  }
  if (config.minBuySellRatio > 0 && stats.sells > 0) {
    const ratio = stats.buys / stats.sells;
    if (ratio < config.minBuySellRatio) {
      return `buy/sell ratio ${ratio.toFixed(2)} is below ${config.minBuySellRatio}`;
    }
  }
  return null;
}

export async function checkTokenQuality(
  connection: Connection,
  mint: PublicKey,
  config: QualityConfig,
  buyers: BuyerTracker,
  options: {
    creator: string;
    devBuyPct: number;
    realSol: number;
    supply: bigint;
    excludeAccounts: string[];
    activityAccount?: PublicKey;
  },
): Promise<string | null> {
  if (!config.enabled) {
    return null;
  }
  if (config.maxDevBuyPct > 0 && options.devBuyPct > config.maxDevBuyPct) {
    return `creator initial buy is ${options.devBuyPct.toFixed(2)}% of supply`;
  }
  if (config.maxCreatorLaunches > 0) {
    const launches = buyers.launches(options.creator);
    if (launches > config.maxCreatorLaunches) {
      return `creator has launched ${launches} tokens this session`;
    }
  }
  if (config.minRealSol > 0 && options.realSol < config.minRealSol) {
    return `curve holds ${options.realSol.toFixed(3)} SOL, need ${config.minRealSol}`;
  }

  const seen = buyers.stats(mint.toBase58());
  const activity = await withChainActivity(connection, options.activityAccount, seen, config);
  if (typeof activity === 'string') {
    return activity;
  }
  const flow = momentumReason(activity, config);
  if (flow) {
    return flow;
  }

  if (config.checkSellable || config.maxSingleHolderPct > 0 || config.maxTop10Pct > 0) {
    const mintAccount = await connection.getAccountInfo(mint, connection.commitment);
    if (!mintAccount) {
      return 'mint account is missing';
    }
    if (config.checkSellable) {
      const reason = sellabilityReason(Buffer.from(mintAccount.data), config.maxTransferFeeBps);
      if (reason) {
        return reason;
      }
    }
    if (config.maxSingleHolderPct > 0 || config.maxTop10Pct > 0) {
      const largest = await connection.getTokenLargestAccounts(mint, connection.commitment);
      const supply = options.supply > 0n ? options.supply : Buffer.from(mintAccount.data).readBigUInt64LE(36);
      const { top, top10 } = holderPercents(
        largest.value.map((row) => ({ address: row.address.toBase58(), amount: BigInt(row.amount) })),
        supply,
        new Set(options.excludeAccounts),
      );
      if (config.maxSingleHolderPct > 0 && top > config.maxSingleHolderPct) {
        return `top holder has ${top.toFixed(2)}% (limit ${config.maxSingleHolderPct}%)`;
      }
      if (config.maxTop10Pct > 0 && top10 > config.maxTop10Pct) {
        return `top 10 holders have ${top10.toFixed(2)}% (limit ${config.maxTop10Pct}%)`;
      }
    }
  }

  if (config.rugcheck) {
    return rugcheckReason(mint.toBase58(), config);
  }
  return null;
}

async function withChainActivity(
  connection: Connection,
  account: PublicKey | undefined,
  seen: { buys: number; sells: number; unique: number; sameSlotBuys: number; createSlot: number },
  config: QualityConfig,
): Promise<{ buys: number; sells: number; unique: number; sameSlotBuys: number } | string> {
  let buys = seen.buys;
  let sameSlotBuys = seen.sameSlotBuys;
  if (!account || (config.minTrades <= 0 && config.maxSameSlotBuys <= 0)) {
    return { buys, sells: seen.sells, unique: seen.unique, sameSlotBuys };
  }
  try {
    const commitment: Finality = connection.commitment === 'finalized' ? 'finalized' : 'confirmed';
    const signatures = await connection.getSignaturesForAddress(account, { limit: 25 }, commitment);
    const ok = signatures.filter((row) => row.err === null);
    buys = Math.max(buys, ok.length);
    if (seen.createSlot > 0) {
      sameSlotBuys = Math.max(sameSlotBuys, ok.filter((row) => row.slot === seen.createSlot).length);
    }
  } catch {
    if (buys + seen.sells < config.minTrades) {
      return 'could not read recent trades';
    }
  }
  return { buys, sells: seen.sells, unique: seen.unique, sameSlotBuys };
}

async function rugcheckReason(mint: string, config: QualityConfig): Promise<string | null> {
  try {
    const response = await fetch(`https://api.rugcheck.xyz/v1/tokens/${mint}/report/summary`, {
      signal: AbortSignal.timeout(config.rugcheckTimeoutMs),
    });
    if (!response.ok) {
      return config.rugcheckFailOpen ? null : `rugcheck returned HTTP ${response.status}`;
    }
    const body = (await response.json()) as { score?: number };
    if (typeof body.score === 'number' && body.score > config.rugcheckMaxScore) {
      return `rugcheck score ${body.score} is above ${config.rugcheckMaxScore}`;
    }
    return null;
  } catch {
    return config.rugcheckFailOpen ? null : 'rugcheck request failed';
  }
}
