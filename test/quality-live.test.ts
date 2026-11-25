/**
 * Read-only checks against live mints. No transaction is built or sent.
 * getTokenLargestAccounts is rejected by the public RPC, so holder rows fall back
 * to the RugCheck report and then go through the same holderPercents function.
 * Sellability uses the mint account from getAccountInfo.
 */
import assert from 'assert';
import { Connection, PublicKey } from '@solana/web3.js';
import { limitConnection } from '../helpers/rpc-limit';
import { DEFAULT_QUALITY, checkTokenQuality, holderPercents, sellabilityReason } from '../pump/quality';
import { BuyerTracker } from '../pump/tracking';

const endpoint = process.env.RPC_ENDPOINT || 'https://api.mainnet-beta.solana.com';
const connection = limitConnection(new Connection(endpoint, 'confirmed'), 250);

const GOOD = 'B34nXKzCgsJb9ChLuSHPRpXLE3WFSWyeT8Cqkzzmpump';
const HELD = 'J8foaqMPCwnGLyQoqdQNjeyc86g4zjkv2MLMPGE6pump';
const COPYCAT = 'BSBeyEMoy44xeSM1XchA4tgH39BE8E3MhoevXe1vpump';
const SERIAL = 'DC1vy25nn2U6CDYD9LuaMWmxrmH6PQQVd6BrgAMFpump';
const THIN = 'fLvNrmTdTgL5ingJVthh1wSxBw32EQhSk73heEQpump';

interface HolderRow {
  address: string;
  amount: number;
  pct: number;
  owner: string;
}

interface Report {
  score: number;
  topHolders: HolderRow[];
  knownAccounts: Record<string, { type?: string }>;
  risks: { name: string; score: number }[];
}

async function report(mint: string): Promise<Report> {
  const response = await fetch(`https://api.rugcheck.xyz/v1/tokens/${mint}/report`, {
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) {
    throw new Error(`rugcheck report ${response.status} for ${mint}`);
  }
  return (await response.json()) as Report;
}

function asAmount(value: number): bigint {
  return BigInt(Math.round(value));
}

function supplyFrom(rows: HolderRow[]): bigint {
  const row = rows.find((item) => item.pct > 0);
  if (!row) {
    return 0n;
  }
  return BigInt(Math.round((row.amount * 100) / row.pct));
}

function walletHolders(body: Report): { address: string; amount: bigint }[] {
  const known = body.knownAccounts ?? {};
  return (body.topHolders ?? [])
    .filter((row) => {
      const kind = known[row.owner]?.type ?? known[row.address]?.type;
      return kind !== 'AMM' && kind !== 'LOCKER';
    })
    .map((row) => ({ address: row.address, amount: asAmount(row.amount) }));
}

async function main() {
  for (const mint of [GOOD, HELD]) {
    const info = await connection.getAccountInfo(new PublicKey(mint));
    assert.ok(info, `mint account missing for ${mint}`);
    const reason = sellabilityReason(Buffer.from(info.data), 0);
    assert.strictEqual(reason, null, `${mint} sellability: ${reason}`);
    console.log(`${mint} sellability ok, mint bytes ${info.data.length}`);
  }

  const good = await report(GOOD);
  const goodWallets = walletHolders(good);
  const goodPct = holderPercents(goodWallets, supplyFrom(good.topHolders ?? []), new Set());
  console.log(`good ${GOOD} score ${good.score} top ${goodPct.top.toFixed(2)}% top10 ${goodPct.top10.toFixed(2)}%`);
  assert.ok(goodPct.top <= 25, `good mint top holder ${goodPct.top}`);
  assert.ok(goodPct.top10 <= 60, `good mint top 10 ${goodPct.top10}`);
  assert.ok((good.risks ?? []).length === 0, 'good mint should have no RugCheck risks');

  const held = await report(HELD);
  const heldAll = (held.topHolders ?? []).map((row) => ({ address: row.address, amount: asAmount(row.amount) }));
  const heldSupply = supplyFrom(held.topHolders ?? []);
  const amm = new Set(
    Object.entries(held.knownAccounts ?? {})
      .filter(([, value]) => value.type === 'AMM' || value.type === 'LOCKER')
      .map(([key]) => key),
  );
  const ammAccounts = new Set(
    (held.topHolders ?? []).filter((row) => amm.has(row.owner) || amm.has(row.address)).map((row) => row.address),
  );
  const includingCurve = holderPercents(heldAll, heldSupply, new Set());
  const excludingCurve = holderPercents(heldAll, heldSupply, ammAccounts);
  console.log(
    `held ${HELD} including curve top10 ${includingCurve.top10.toFixed(2)}% excluding curve top ${excludingCurve.top.toFixed(2)}% top10 ${excludingCurve.top10.toFixed(2)}%`,
  );
  assert.ok(includingCurve.top10 > 80, 'the curve itself is the concentration Jupiter reports');
  assert.ok(excludingCurve.top <= 25, 'excluding the curve, this bag is under the single-holder cap');

  const rugcheckOnly = {
    ...DEFAULT_QUALITY,
    checkSellable: false,
    maxSingleHolderPct: 0,
    maxTop10Pct: 0,
    maxDevBuyPct: 0,
    maxCreatorLaunches: 0,
    waitMs: 0,
    minTrades: 0,
    minUniqueBuyers: 0,
    minBuySellRatio: 0,
    maxSameSlotBuys: 0,
    minRealSol: 0,
    rugcheck: true,
    rugcheckMaxScore: 1000,
    rugcheckFailOpen: false,
  };
  const buyers = new BuyerTracker();
  const idle = {
    creator: PublicKey.default.toBase58(),
    devBuyPct: 0,
    realSol: 10,
    supply: 0n,
    excludeAccounts: [],
  };
  const decide = async (mint: string) => {
    const first = await checkTokenQuality(connection, new PublicKey(mint), rugcheckOnly, buyers, idle);
    if (first !== 'rugcheck request failed') {
      return first;
    }
    return checkTokenQuality(connection, new PublicKey(mint), rugcheckOnly, buyers, idle);
  };
  const goodDecision = await decide(GOOD);
  const copycatDecision = await decide(COPYCAT);
  const serialDecision = await decide(SERIAL);
  const thinDecision = await decide(THIN);
  console.log(`rugcheck good=${goodDecision ?? 'pass'} copycat=${copycatDecision} serial=${serialDecision} thin=${thinDecision}`);
  assert.strictEqual(goodDecision, null);
  assert.match(copycatDecision ?? '', /rugcheck score/);
  assert.match(serialDecision ?? '', /rugcheck score/);
  assert.match(thinDecision ?? '', /rugcheck score/);
  console.log('live quality checks passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
