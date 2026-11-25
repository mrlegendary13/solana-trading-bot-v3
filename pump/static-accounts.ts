import { AccountInfo, Connection } from '@solana/web3.js';
import { logger } from '../helpers/logger';
import { PUMP_AMM_PROGRAM_ID, PUMP_PROGRAM_ID } from './constants';
import { decodePumpGlobal, PumpGlobalAccount } from './layout';
import {
  eventAuthorityPda,
  pumpAmmFeeConfigPda,
  pumpAmmGlobalConfigPda,
  pumpFeeConfigPda,
  pumpGlobalPda,
} from './pda';

export interface StaticPumpAccounts {
  global: PumpGlobalAccount | null;
}

/**
 * Reads the pump accounts that do not change per mint.
 * A bonding curve is not one of these: its reserves move on every trade.
 * 4wHYM1nhQMPB42n47JZQwX6oVMg4kfazrw6PiQin9ghJ is a bonding curve (account
 * discriminator of BondingCurve, owned by the pump program), so it stays live.
 */
export async function loadStaticPumpAccounts(
  connection: Connection,
  cache: Map<string, AccountInfo<Buffer>>,
): Promise<StaticPumpAccounts> {
  const keys = [
    ['global', pumpGlobalPda()],
    ['feeConfig', pumpFeeConfigPda()],
    ['eventAuthority', eventAuthorityPda(PUMP_PROGRAM_ID)],
    ['ammGlobal', pumpAmmGlobalConfigPda()],
    ['ammFeeConfig', pumpAmmFeeConfigPda()],
    ['ammEventAuthority', eventAuthorityPda(PUMP_AMM_PROGRAM_ID)],
  ] as const;
  const infos = await connection.getMultipleAccountsInfo(
    keys.map(([, key]) => key),
    connection.commitment,
  );
  const summary: Record<string, string> = {};
  keys.forEach(([name, key], index) => {
    const info = infos[index];
    if (info) {
      cache.set(key.toBase58(), info);
      summary[name] = `${key.toBase58()} ${info.data.length} bytes`;
    } else {
      summary[name] = `${key.toBase58()} missing`;
    }
  });
  const global = infos[0] ? decodePumpGlobal(Buffer.from(infos[0].data)) : null;
  logger.info(summary, 'Cached static pump accounts. Bonding curves are read live because reserves change.');
  return { global };
}

export function tokenAccountAmount(data: Buffer | Uint8Array | undefined | null): bigint {
  if (!data || data.length < 72) {
    return 0n;
  }
  return Buffer.from(data).readBigUInt64LE(64);
}
