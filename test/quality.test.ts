import assert from 'assert';
import { ExtensionType } from '@solana/spl-token';
import { Keypair } from '@solana/web3.js';
import { holderPercents, momentumReason, sellabilityReason, QualityConfig } from '../pump/quality';
import { BuyerTracker } from '../pump/tracking';

function tlv(type: number, data: Buffer): Buffer {
  const header = Buffer.alloc(4);
  header.writeUInt16LE(type, 0);
  header.writeUInt16LE(data.length, 2);
  return Buffer.concat([Buffer.alloc(82), header, data]);
}

const plain = Buffer.alloc(82);
assert.strictEqual(sellabilityReason(plain, 0), null);

const frozen = Buffer.alloc(82);
frozen.writeUInt32LE(1, 46);
assert.strictEqual(sellabilityReason(frozen, 0), 'freeze authority is set');

assert.match(
  sellabilityReason(tlv(ExtensionType.NonTransferable, Buffer.alloc(0)), 0) ?? '',
  /non-transferable/,
);
assert.match(sellabilityReason(tlv(ExtensionType.PausableConfig, Buffer.alloc(33)), 0) ?? '', /pausable/);

const delegate = Keypair.generate().publicKey.toBuffer();
assert.match(sellabilityReason(tlv(ExtensionType.PermanentDelegate, delegate), 0) ?? '', /permanent delegate/);
assert.strictEqual(sellabilityReason(tlv(ExtensionType.PermanentDelegate, Buffer.alloc(32)), 0), null);

const hook = Buffer.alloc(64);
Keypair.generate().publicKey.toBuffer().copy(hook, 0);
assert.match(sellabilityReason(tlv(ExtensionType.TransferHook, hook), 0) ?? '', /transfer hook/);

const fee = Buffer.alloc(108);
fee.writeUInt16LE(250, 106);
assert.match(sellabilityReason(tlv(ExtensionType.TransferFeeConfig, fee), 0) ?? '', /250 bps/);
assert.strictEqual(sellabilityReason(tlv(ExtensionType.TransferFeeConfig, fee), 250), null);

const curve = 'curve-vault';
const whale = 'whale';
const { top, top10 } = holderPercents(
  [
    { address: curve, amount: 800n },
    { address: whale, amount: 150n },
    { address: 'b', amount: 30n },
    { address: 'c', amount: 20n },
  ],
  1000n,
  new Set([curve]),
);
assert.strictEqual(top, 15);
assert.strictEqual(top10, 20);

const momentum: QualityConfig = {
  enabled: true,
  checkSellable: true,
  maxTransferFeeBps: 0,
  maxSingleHolderPct: 25,
  maxTop10Pct: 60,
  maxDevBuyPct: 15,
  maxCreatorLaunches: 3,
  waitMs: 0,
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

assert.match(
  momentumReason({ buys: 1, sells: 0, unique: 1, sameSlotBuys: 0 }, momentum) ?? '',
  /only 1 trades/,
);
assert.match(
  momentumReason({ buys: 4, sells: 0, unique: 1, sameSlotBuys: 0 }, momentum) ?? '',
  /only 1 unique buyers/,
);
assert.match(
  momentumReason({ buys: 4, sells: 0, unique: 4, sameSlotBuys: 5 }, momentum) ?? '',
  /bundled launch/,
);
assert.match(
  momentumReason({ buys: 2, sells: 4, unique: 4, sameSlotBuys: 1 }, momentum) ?? '',
  /buy\/sell ratio/,
);
assert.strictEqual(momentumReason({ buys: 4, sells: 2, unique: 4, sameSlotBuys: 2 }, momentum), null);

const tracker = new BuyerTracker();
tracker.noteCreate('mint', 'creator', 10);
tracker.record('mint', 'buyer-a', true, 10);
tracker.record('mint', 'buyer-a', true, 11);
tracker.record('mint', 'buyer-b', false, 11);
assert.strictEqual(tracker.launches('creator'), 1);
assert.deepStrictEqual(tracker.stats('mint'), {
  buys: 2,
  sells: 1,
  unique: 1,
  sameSlotBuys: 1,
  createSlot: 10,
});
tracker.noteCreate('mint-2', 'creator', 12);
tracker.noteCreate('mint-3', 'creator', 13);
tracker.noteCreate('mint-4', 'creator', 14);
assert.strictEqual(tracker.launches('creator'), 4);

console.log('quality tests passed');
