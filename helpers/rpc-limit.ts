import { AccountInfo, Connection, PublicKey } from '@solana/web3.js';
import { sleep } from './promises';
import { isTransientRpcError } from './rpc-error';

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
  'getProgramAccounts',
  'getParsedTokenAccountsByOwner',
  'sendRawTransaction',
  'simulateTransaction',
  'confirmTransaction',
]);

const HEAVY = new Set(['getTokenLargestAccounts', 'getProgramAccounts']);

export interface RpcLimitOptions {
  minIntervalMs: number;
  maxConcurrency: number;
  heavyIntervalMs: number;
  attempts: number;
  budgetMs: number;
  baseDelayMs: number;
  /** Minimum gap between sendRawTransaction calls. Reads are not delayed by this. */
  sendIntervalMs?: number;
  /** Successful reads of accounts that do not change. Bonding curves are not stored here. */
  staticCache?: Map<string, AccountInfo<Buffer>>;
}

/**
 * Spaces RPC calls, caps how many run at once, and retries transient network
 * errors. sendRawTransaction is retried only by repeating the same call, which
 * resends the same signed bytes.
 */
export function limitConnection(connection: Connection, options: number | RpcLimitOptions): Connection {
  const opts: RpcLimitOptions =
    typeof options === 'number'
      ? {
          minIntervalMs: options,
          maxConcurrency: 1,
          heavyIntervalMs: options,
          attempts: 3,
          budgetMs: 1500,
          baseDelayMs: 200,
          sendIntervalMs: 0,
        }
      : options;
  const gate = new RpcGate(Math.max(1, opts.maxConcurrency));
  const cache = opts.staticCache;
  const paceSend = createSendPacer(opts.sendIntervalMs ?? 0);

  return new Proxy(connection, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof prop !== 'string' || typeof value !== 'function' || !LIMITED.has(prop)) {
        return typeof value === 'function' ? value.bind(target) : value;
      }
      const method = value as (...args: unknown[]) => Promise<unknown>;
      const gap = HEAVY.has(prop) ? Math.max(opts.minIntervalMs, opts.heavyIntervalMs) : opts.minIntervalMs;
      return (...args: unknown[]) => {
        if (prop === 'getAccountInfo' && cache) {
          const key = accountKey(args[0]);
          if (key && cache.has(key)) {
            return Promise.resolve(cache.get(key));
          }
        }
        return withRpcRetries(
          async () => {
            if (prop === 'sendRawTransaction') {
              await paceSend();
            }
            await gate.acquire(gap);
            try {
              return await method.apply(target, args);
            } finally {
              gate.release();
            }
          },
          opts,
        );
      };
    },
  });
}

export async function withRpcRetries<T>(
  run: () => Promise<T>,
  opts: { attempts: number; budgetMs: number; baseDelayMs: number },
): Promise<T> {
  const started = Date.now();
  let last: unknown;
  const attempts = Math.max(1, opts.attempts);
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await run();
    } catch (error) {
      last = error;
      const remaining = opts.budgetMs - (Date.now() - started);
      if (!isTransientRpcError(error) || attempt === attempts - 1 || remaining <= 0) {
        throw error;
      }
      const base = opts.baseDelayMs * 2 ** attempt;
      const delay = Math.min(remaining, Math.round(base * (0.5 + Math.random())));
      await sleep(delay);
    }
  }
  throw last;
}

export function createSendPacer(intervalMs: number): () => Promise<void> {
  if (intervalMs <= 0) {
    return async () => undefined;
  }
  let lastSend = 0;
  let chain: Promise<void> = Promise.resolve();
  return () => {
    const run = chain.then(async () => {
      const wait = lastSend + intervalMs - Date.now();
      if (wait > 0) {
        await sleep(wait);
      }
      lastSend = Date.now();
    });
    chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
}

class RpcGate {
  private inFlight = 0;
  private readonly waiters: Array<() => void> = [];
  private nextAt = 0;

  constructor(private readonly maxConcurrency: number) {}

  async acquire(gapMs: number): Promise<void> {
    if (this.inFlight >= this.maxConcurrency) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    } else {
      this.inFlight += 1;
    }
    const now = Date.now();
    const start = Math.max(now, this.nextAt);
    this.nextAt = start + Math.max(0, gapMs);
    if (start > now) {
      await sleep(start - now);
    }
  }

  release() {
    const next = this.waiters.shift();
    if (next) {
      next();
      return;
    }
    this.inFlight = Math.max(0, this.inFlight - 1);
  }
}

function accountKey(value: unknown): string | null {
  if (value instanceof PublicKey) {
    return value.toBase58();
  }
  return null;
}
