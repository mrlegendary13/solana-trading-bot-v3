/**
 * Read-only. Simulates the bot's SellV3 for a real holder. Nothing is broadcast.
 */
import assert from 'assert';
import {
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import { getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { pumpSellIx } from '../pump/instructions';
import { decodeBondingCurve, decodePumpGlobal } from '../pump/layout';
import { bondingCurvePda, pumpGlobalPda } from '../pump/pda';
import { maxPayableSellAmount } from '../pump/quotes';

const MINT = new PublicKey('EoaCJHj79AMqrPcnj2WE7QEwgNX9fdVqgJfrSsGzpump');
const HOLDER = new PublicKey('AwPg35FZmgcdqj4tuz7y445zS96WFeVm1X5y9GXi4JpY');
const connection = new Connection('https://api.mainnet-beta.solana.com', 'confirmed');

async function simulate(user: PublicKey, tokenProgram: PublicKey, amount: bigint, recipient: PublicKey) {
  const { blockhash } = await connection.getLatestBlockhash();
  const message = new TransactionMessage({
    payerKey: user,
    recentBlockhash: blockhash,
    instructions: [
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }),
      ComputeBudgetProgram.setComputeUnitLimit({ units: 250_000 }),
      pumpSellIx({
        user,
        mint: MINT,
        baseTokenProgram: tokenProgram,
        amount,
        minQuoteOut: 0n,
        buybackFeeRecipient: recipient,
      }),
    ],
  }).compileToV0Message();
  const simulation = await connection.simulateTransaction(new VersionedTransaction(message), {
    sigVerify: false,
    replaceRecentBlockhash: true,
  });
  return simulation.value.err;
}

async function main() {
  const mintInfo = await connection.getAccountInfo(MINT);
  assert.ok(mintInfo);
  assert.ok(mintInfo.owner.equals(TOKEN_2022_PROGRAM_ID));
  const curveInfo = await connection.getAccountInfo(bondingCurvePda(MINT));
  const curve = curveInfo ? decodeBondingCurve(Buffer.from(curveInfo.data)) : null;
  assert.ok(curve && curve.complete === false);
  const globalInfo = await connection.getAccountInfo(pumpGlobalPda());
  const global = globalInfo ? decodePumpGlobal(Buffer.from(globalInfo.data)) : null;
  const recipient = global?.buybackFeeRecipients[0];
  assert.ok(recipient);
  const payable = maxPayableSellAmount(curve.virtualTokenReserves, curve.virtualQuoteReserves, curve.realQuoteReserves);
  const balance = await connection.getTokenAccountBalance(getAssociatedTokenAddressSync(MINT, HOLDER, false, mintInfo.owner));
  const amount = BigInt(balance.value.amount);
  assert.strictEqual(amount, 384661258242n);
  assert.ok(payable < amount);
  const full = await simulate(HOLDER, mintInfo.owner, amount, recipient);
  const fullCustom = (full as { InstructionError?: [number, { Custom?: number }] })?.InstructionError?.[1]?.Custom;
  assert.strictEqual(fullCustom, 6024);
  const one = await simulate(HOLDER, mintInfo.owner, payable, recipient);
  assert.strictEqual(one, null);
  console.log(`sell simulation passed. full balance overflows, one sell of ${payable.toString()} succeeds`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
