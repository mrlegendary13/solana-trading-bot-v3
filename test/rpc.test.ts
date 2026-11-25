import assert from 'assert';
import dns from 'dns';
import { createHash } from 'crypto';
import { AccountInfo, Connection, PublicKey } from '@solana/web3.js';
import { describeRpcError, enrichRpcError, isTransientRpcError } from '../helpers/rpc-error';
import { rpcAgent, rpcFetch } from '../helpers/rpc-fetch';
import { createSendPacer, limitConnection, withRpcRetries } from '../helpers/rpc-limit';
import { decodeBondingCurve } from '../pump/layout';
import { eventAuthorityPda, pumpFeeConfigPda, pumpGlobalPda } from '../pump/pda';
import { PUMP_PROGRAM_ID } from '../pump/constants';

const cause = Object.assign(new Error('connect ECONNRESET'), {
  code: 'ECONNRESET',
  errno: -104,
  hostname: 'mainnet.helius-rpc.com',
});
const fetchFailed = new TypeError('fetch failed');
(fetchFailed as { cause?: unknown }).cause = cause;

const details = describeRpcError(fetchFailed);
assert.strictEqual(details.code, 'ECONNRESET');
assert.strictEqual(details.errno, -104);
assert.strictEqual(details.hostname, 'mainnet.helius-rpc.com');
assert.strictEqual(isTransientRpcError(fetchFailed), true);
assert.strictEqual(isTransientRpcError(new Error('429 Too Many Requests')), true);
assert.strictEqual(isTransientRpcError(new Error('InstructionError custom 6000')), false);

const wrapped = new Error(
  'failed to get info about account 4wHYM1nhQMPB42n47JZQwX6oVMg4kfazrw6PiQin9ghJ: ' +
    enrichRpcError(fetchFailed, details),
);
const fromWrap = describeRpcError(wrapped);
assert.strictEqual(fromWrap.code, 'ECONNRESET');
assert.strictEqual(fromWrap.hostname, 'mainnet.helius-rpc.com');

async function testRetries() {
  let attempts = 0;
  const sent = await withRpcRetries(
    async () => {
      attempts += 1;
      if (attempts < 3) {
        throw fetchFailed;
      }
      return 'same-signature';
    },
    { attempts: 3, budgetMs: 1000, baseDelayMs: 5 },
  );
  assert.strictEqual(sent, 'same-signature');
  assert.strictEqual(attempts, 3);

  let rejected = 0;
  await assert.rejects(
    () =>
      withRpcRetries(
        async () => {
          rejected += 1;
          throw new Error('Blockhash not found');
        },
        { attempts: 3, budgetMs: 1000, baseDelayMs: 5 },
      ),
    /Blockhash not found/,
  );
  assert.strictEqual(rejected, 1, 'a rejected send is not resent');
}

assert.strictEqual(dns.getDefaultResultOrder(), 'ipv4first');
assert.strictEqual(rpcAgent, rpcAgent);

const globalKey = pumpGlobalPda();
const cache = new Map<string, AccountInfo<Buffer>>();
cache.set(globalKey.toBase58(), {
  executable: false,
  owner: PUMP_PROGRAM_ID,
  lamports: 1,
  data: Buffer.alloc(8),
  rentEpoch: 0,
});
let fetches = 0;
const cachedConnection = limitConnection(
  new Connection('https://api.mainnet-beta.solana.com', {
    commitment: 'confirmed',
    fetch: async () => {
      fetches += 1;
      throw new Error('cached account was fetched');
    },
    disableRetryOnRateLimit: true,
  }),
  {
    minIntervalMs: 0,
    maxConcurrency: 1,
    heavyIntervalMs: 0,
    attempts: 1,
    budgetMs: 100,
    baseDelayMs: 0,
    staticCache: cache,
  },
);
async function testSendPace() {
  const pace = createSendPacer(40);
  const started = Date.now();
  await pace();
  await pace();
  assert.ok(Date.now() - started >= 35, 'sendTransaction calls stay 5 per second apart on the Developer plan');
  const readPace = createSendPacer(0);
  const readStarted = Date.now();
  await readPace();
  await readPace();
  assert.ok(Date.now() - readStarted < 30, 'a zero send gap does not delay reads');
}

async function testCache() {
  const cached = await cachedConnection.getAccountInfo(globalKey);
  assert.strictEqual(fetches, 0);
  assert.strictEqual(cached?.lamports, 1);
}

async function testLiveReads() {
const endpoint = 'https://api.mainnet-beta.solana.com';
let liveFetches = 0;
const flaky = limitConnection(
  new Connection(endpoint, {
    commitment: 'confirmed',
    disableRetryOnRateLimit: true,
    fetch: async (input, init) => {
      liveFetches += 1;
      if (liveFetches === 1) {
        const error = new TypeError('fetch failed');
        (error as { cause?: unknown }).cause = Object.assign(new Error('connect ECONNRESET'), {
          code: 'ECONNRESET',
          errno: -104,
          hostname: 'api.mainnet-beta.solana.com',
        });
        throw error;
      }
      return rpcFetch(input, init);
    },
  }),
  {
    minIntervalMs: 0,
    maxConcurrency: 1,
    heavyIntervalMs: 0,
    attempts: 3,
    budgetMs: 4000,
    baseDelayMs: 20,
  },
);
const globalInfo = await flaky.getAccountInfo(globalKey);
assert.ok(globalInfo && globalInfo.data.length > 100, 'public RPC returned pump global after a simulated socket reset');
assert.ok(liveFetches >= 2, 'the failed fetch was retried');

const curveKey = new PublicKey('4wHYM1nhQMPB42n47JZQwX6oVMg4kfazrw6PiQin9ghJ');
const curveInfo = await flaky.getAccountInfo(curveKey);
assert.ok(curveInfo);
assert.ok(curveInfo.owner.equals(PUMP_PROGRAM_ID));
const discriminator = createHash('sha256').update('account:BondingCurve').digest().subarray(0, 8);
assert.ok(Buffer.from(curveInfo.data.subarray(0, 8)).equals(discriminator));
assert.ok(decodeBondingCurve(Buffer.from(curveInfo.data)));
assert.ok(!curveKey.equals(pumpGlobalPda()));
assert.ok(!curveKey.equals(pumpFeeConfigPda()));
assert.ok(!curveKey.equals(eventAuthorityPda(PUMP_PROGRAM_ID)));
assert.strictEqual(cache.has(curveKey.toBase58()), false);

console.log(`rpc tests passed after ${liveFetches} public RPC reads, no send`);
}

testRetries()
  .then(() => testSendPace())
  .then(() => testCache())
  .then(() => testLiveReads())
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
