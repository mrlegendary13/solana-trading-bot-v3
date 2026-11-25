import { Connection } from '@solana/web3.js';
import { sleep } from './promises';

const LIMITED = new Set([
  'getAccountInfo',
  'getMultipleAccountsInfo',
  'getBalance',
  'getTokenAccountBalance',
  'getLatestBlockhash',
  'getSignatureStatuses',
  'getBlockHeight',
  'getTransaction',
  'getSignaturesForAddress',
  'getTokenLargestAccounts',
  'getParsedTokenAccountsByOwner',
  'sendRawTransaction',
  'simulateTransaction',
  'confirmTransaction',
]);

/**
 * Serializes RPC calls and backs off when Chainstack returns 429.
 * Websocket subscriptions are left alone.
 */
export function limitConnection(connection: Connection, minIntervalMs = 80): Connection {
  let chain: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(run: () => Promise<T>): Promise<T> => {
    const next = chain.then(async () => {
      if (minIntervalMs > 0) {
        await sleep(minIntervalMs);
      }
      return with429Retry(run);
    });
    chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  return new Proxy(connection, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof prop !== 'string' || typeof value !== 'function' || !LIMITED.has(prop)) {
        return typeof value === 'function' ? value.bind(target) : value;
      }
      return (...args: unknown[]) => enqueue(() => (value as (...a: unknown[]) => Promise<unknown>).apply(target, args));
    },
  });
}

async function with429Retry<T>(run: () => Promise<T>): Promise<T> {
  let wait = 400;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await run();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/429|too many requests/i.test(message) || attempt === 4) {
        throw error;
      }
      await sleep(wait);
      wait *= 2;
    }
  }
  throw new Error('RPC retry exhausted');
}
