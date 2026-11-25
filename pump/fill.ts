import { PublicKey, VersionedTransactionResponse } from '@solana/web3.js';
import { createHash } from 'crypto';

const TRADE_EVENT = createHash('sha256').update('event:TradeEvent').digest().subarray(0, 8);

export interface BuyFill {
  tokens: bigint;
  solIn: bigint;
}

/** SOL that actually went through the pump trade, not account rent or the transaction fee. */
export function fillFromTransaction(
  tx: VersionedTransactionResponse,
  owner: PublicKey,
  mint: PublicKey,
): BuyFill | null {
  const logs = tx.meta?.logMessages || [];
  for (const line of logs) {
    if (!line.startsWith('Program data: ')) {
      continue;
    }
    const raw = Buffer.from(line.slice('Program data: '.length), 'base64');
    if (raw.length < 8 + 32 + 8 + 8 + 1 + 32 || !raw.subarray(0, 8).equals(TRADE_EVENT)) {
      continue;
    }
    const eventMint = new PublicKey(raw.subarray(8, 40));
    const solAmount = raw.readBigUInt64LE(40);
    const tokenAmount = raw.readBigUInt64LE(48);
    const isBuy = raw[56] === 1;
    const user = new PublicKey(raw.subarray(57, 89));
    if (isBuy && eventMint.equals(mint) && user.equals(owner) && tokenAmount > 0n && solAmount > 0n) {
      return { tokens: tokenAmount, solIn: solAmount };
    }
  }

  const ownerText = owner.toBase58();
  const mintText = mint.toBase58();
  let tokens = 0n;
  for (const post of tx.meta?.postTokenBalances || []) {
    if (post.owner !== ownerText || post.mint !== mintText) {
      continue;
    }
    const pre = (tx.meta?.preTokenBalances || []).find((row) => row.accountIndex === post.accountIndex);
    const after = BigInt(post.uiTokenAmount.amount);
    const before = BigInt(pre?.uiTokenAmount.amount || '0');
    if (after > before) {
      tokens = after - before;
    }
  }
  if (tokens <= 0n || !tx.meta) {
    return null;
  }
  const spent = BigInt(tx.meta.preBalances[0] - tx.meta.postBalances[0] - tx.meta.fee);
  return { tokens, solIn: spent > 0n ? spent : 1n };
}
