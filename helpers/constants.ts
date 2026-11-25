import { Logger } from 'pino'; 
import dotenv from 'dotenv';
import fs from 'fs';
import { Commitment } from '@solana/web3.js';
import { logger } from './logger';

dotenv.config();

const retrieveEnvVariable = (variableName: string, logger: Logger) => {
  const variable = process.env[variableName] || '';
  if (!variable) {
    logger.error(`${variableName} is not set`);
    process.exit(1);
  }
  return variable;
};

const envBool = (name: string, fallback: boolean) => {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true') {
    return true;
  }
  if (normalized === 'false') {
    return false;
  }
  logger.error(`${name} must be true or false, got "${value.trim()}"`);
  process.exit(1);
};

const envNum = (name: string, fallback: number) => {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    logger.error(`${name} must be a number, got "${value.trim()}"`);
    process.exit(1);
  }
  return parsed;
};

const envStr = (name: string, fallback: string) => {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') {
    return fallback;
  }
  return value.trim();
};

// Wallet
export const PRIVATE_KEY = retrieveEnvVariable('PRIVATE_KEY', logger);

// Connection
export const NETWORK = 'mainnet-beta';
export const COMMITMENT_LEVEL: Commitment = retrieveEnvVariable('COMMITMENT_LEVEL', logger) as Commitment;
export const RPC_ENDPOINT = retrieveEnvVariable('RPC_ENDPOINT', logger);
export const RPC_WEBSOCKET_ENDPOINT = retrieveEnvVariable('RPC_WEBSOCKET_ENDPOINT', logger);

// Bot
export const LOG_LEVEL = retrieveEnvVariable('LOG_LEVEL', logger);
export const ONE_TOKEN_AT_A_TIME = retrieveEnvVariable('ONE_TOKEN_AT_A_TIME', logger) === 'true';
export const COMPUTE_UNIT_LIMIT = Number(retrieveEnvVariable('COMPUTE_UNIT_LIMIT', logger));
export const COMPUTE_UNIT_PRICE = Number(retrieveEnvVariable('COMPUTE_UNIT_PRICE', logger));
export const PRE_LOAD_EXISTING_MARKETS = retrieveEnvVariable('PRE_LOAD_EXISTING_MARKETS', logger) === 'true';
export const CACHE_NEW_MARKETS = retrieveEnvVariable('CACHE_NEW_MARKETS', logger) === 'true';
export const TRANSACTION_EXECUTOR = retrieveEnvVariable('TRANSACTION_EXECUTOR', logger);
export const CUSTOM_FEE = retrieveEnvVariable('CUSTOM_FEE', logger);

// Buy
export const AUTO_BUY_DELAY = Number(retrieveEnvVariable('AUTO_BUY_DELAY', logger));
export const QUOTE_MINT = envStr('QUOTE_MINT', 'WSOL');
export const QUOTE_AMOUNT = retrieveEnvVariable('QUOTE_AMOUNT', logger);
export const MAX_BUY_RETRIES = Number(retrieveEnvVariable('MAX_BUY_RETRIES', logger));
export const BUY_SLIPPAGE = Number(retrieveEnvVariable('BUY_SLIPPAGE', logger));

// Sell
export const AUTO_SELL = retrieveEnvVariable('AUTO_SELL', logger) === 'true';
export const AUTO_SELL_DELAY = Number(retrieveEnvVariable('AUTO_SELL_DELAY', logger));
export const MAX_SELL_RETRIES = Number(retrieveEnvVariable('MAX_SELL_RETRIES', logger));
export const TAKE_PROFIT = Number(retrieveEnvVariable('TAKE_PROFIT', logger));
export const STOP_LOSS = Number(retrieveEnvVariable('STOP_LOSS', logger));
export const PRICE_CHECK_INTERVAL = Number(retrieveEnvVariable('PRICE_CHECK_INTERVAL', logger));
export const PRICE_CHECK_DURATION = Number(retrieveEnvVariable('PRICE_CHECK_DURATION', logger));
export const SELL_SLIPPAGE = Number(retrieveEnvVariable('SELL_SLIPPAGE', logger));

// Filters
export const FILTER_CHECK_INTERVAL = Number(retrieveEnvVariable('FILTER_CHECK_INTERVAL', logger));
export const FILTER_CHECK_DURATION = Number(retrieveEnvVariable('FILTER_CHECK_DURATION', logger));
export const CONSECUTIVE_FILTER_MATCHES = Number(retrieveEnvVariable('CONSECUTIVE_FILTER_MATCHES', logger));
export const CHECK_IF_MUTABLE = retrieveEnvVariable('CHECK_IF_MUTABLE', logger) === 'true';
export const CHECK_IF_SOCIALS = retrieveEnvVariable('CHECK_IF_SOCIALS', logger) === 'true';
export const CHECK_IF_MINT_IS_RENOUNCED = retrieveEnvVariable('CHECK_IF_MINT_IS_RENOUNCED', logger) === 'true';
export const CHECK_IF_FREEZABLE = retrieveEnvVariable('CHECK_IF_FREEZABLE', logger) === 'true';
export const CHECK_IF_BURNED = retrieveEnvVariable('CHECK_IF_BURNED', logger) === 'true';
export const MIN_POOL_SIZE = retrieveEnvVariable('MIN_POOL_SIZE', logger);
export const MAX_POOL_SIZE = retrieveEnvVariable('MAX_POOL_SIZE', logger);
export const USE_SNIPE_LIST = retrieveEnvVariable('USE_SNIPE_LIST', logger) === 'true';
export const SNIPE_LIST_REFRESH_INTERVAL = Number(retrieveEnvVariable('SNIPE_LIST_REFRESH_INTERVAL', logger));

// Execution and venues. Missing values keep the defaults so an older .env still loads.
export const DRY_RUN = envBool('DRY_RUN', false);
export const ENABLE_RAYDIUM = envBool('ENABLE_RAYDIUM', true);
// Off unless set, so an older .env does not start buying pump.fun tokens.
export const ENABLE_PUMPFUN = envBool('ENABLE_PUMPFUN', false);
export const ENABLE_PUMPSWAP = envBool('ENABLE_PUMPSWAP', false);
export const CLOSE_EMPTY_TOKEN_ACCOUNTS = envBool('CLOSE_EMPTY_TOKEN_ACCOUNTS', true);
export const PRICE_CHECK_WEBSOCKET = envBool('PRICE_CHECK_WEBSOCKET', true);
export const RETRY_BACKOFF_MS = envNum('RETRY_BACKOFF_MS', 400);
export const SELL_SLIPPAGE_STEP = envNum('SELL_SLIPPAGE_STEP', 10);

// pump.fun filters. 0 disables a numeric bound, except curve progress max which defaults to 100.
export const PUMP_MIN_CURVE_PROGRESS = envNum('PUMP_MIN_CURVE_PROGRESS', 0);
export const PUMP_MAX_CURVE_PROGRESS = envNum('PUMP_MAX_CURVE_PROGRESS', 100);
export const PUMP_MIN_MARKET_CAP_SOL = envNum('PUMP_MIN_MARKET_CAP_SOL', 0);
export const PUMP_MAX_MARKET_CAP_SOL = envNum('PUMP_MAX_MARKET_CAP_SOL', 0);
export const PUMP_MIN_DEV_BUY_SOL = envNum('PUMP_MIN_DEV_BUY_SOL', 0);
export const PUMP_MAX_DEV_BUY_SOL = envNum('PUMP_MAX_DEV_BUY_SOL', 0);
export const PUMP_MAX_CREATOR_HOLD_PERCENT = envNum('PUMP_MAX_CREATOR_HOLD_PERCENT', 0);
export const PUMP_MIN_UNIQUE_BUYERS = envNum('PUMP_MIN_UNIQUE_BUYERS', 0);
export const PUMP_BUYER_WAIT_MS = envNum('PUMP_BUYER_WAIT_MS', 0);
export const PUMP_MAX_REAL_SOL = envNum('PUMP_MAX_REAL_SOL', 0);
export const PUMP_SKIP_MAYHEM = envBool('PUMP_SKIP_MAYHEM', true);
// Token-2022 pump coins do not use Metaplex metadata. The Raydium mutable check
// rejects them, so pump has its own switch and it defaults off.
export const PUMP_CHECK_IF_MUTABLE = envBool('PUMP_CHECK_IF_MUTABLE', false);
export const PUMP_ALLOW_NON_SOL_QUOTE = envBool('PUMP_ALLOW_NON_SOL_QUOTE', false);
export const PUMP_CREATOR_BLACKLIST = envStr('PUMP_CREATOR_BLACKLIST', 'pump-creator-blacklist.txt');

// Stop loss must be seen this many polls in a row, and only after the grace window.
export const SL_CONFIRMATIONS = envNum('SL_CONFIRMATIONS', 2);
export const SL_GRACE_MS = envNum('SL_GRACE_MS', 2000);
// After MAX_SELL_RETRIES, wait this long and try the sell again.
export const SELL_RETRY_INTERVAL_MS = envNum('SELL_RETRY_INTERVAL_MS', 15000);
// How often an open position logs its PnL at info. 0 disables the line.
export const PNL_LOG_INTERVAL_MS = envNum('PNL_LOG_INTERVAL_MS', 10000);
// Gap between RPC starts. 20ms is 50 requests per second, the Helius Developer cap.
export const RPC_MIN_INTERVAL_MS = envNum('RPC_MIN_INTERVAL_MS', 20);
// In-flight reads. Eight covers a ~160ms round trip without going past 50 starts per second.
export const RPC_MAX_CONCURRENCY = envNum('RPC_MAX_CONCURRENCY', 8);
// getProgramAccounts is capped at 25/s on Developer. getTokenLargestAccounts shares the 50/s RPC cap.
export const RPC_HEAVY_INTERVAL_MS = envNum('RPC_HEAVY_INTERVAL_MS', 40);
// sendTransaction is capped at 5/s on Developer. This gap applies only to sends.
export const RPC_SEND_INTERVAL_MS = envNum('RPC_SEND_INTERVAL_MS', 200);
export const RPC_RETRY_ATTEMPTS = envNum('RPC_RETRY_ATTEMPTS', 3);
export const RPC_RETRY_BUDGET_MS = envNum('RPC_RETRY_BUDGET_MS', 1500);
// Optional send-only RPC, such as a Helius staked or sender URL. Empty uses RPC_ENDPOINT.
export const SEND_RPC_ENDPOINT = envStr('SEND_RPC_ENDPOINT', '');

// Pre-buy quality checks for pump.fun and PumpSwap. A percent or count of 0 disables that one check.
export const QUALITY_FILTERS = envBool('QUALITY_FILTERS', true);
export const QUALITY_CHECK_SELLABLE = envBool('QUALITY_CHECK_SELLABLE', true);
export const MAX_TRANSFER_FEE_BPS = envNum('MAX_TRANSFER_FEE_BPS', 0);
export const MAX_SINGLE_HOLDER_PCT = envNum('MAX_SINGLE_HOLDER_PCT', 25);
export const MAX_TOP10_PCT = envNum('MAX_TOP10_PCT', 60);
export const MAX_DEV_BUY_PCT = envNum('MAX_DEV_BUY_PCT', 15);
export const MAX_CREATOR_LAUNCHES = envNum('MAX_CREATOR_LAUNCHES', 3);
export const QUALITY_WAIT_MS = envNum('QUALITY_WAIT_MS', 3000);
export const QUALITY_MIN_TRADES = envNum('QUALITY_MIN_TRADES', 3);
export const QUALITY_MIN_UNIQUE_BUYERS = envNum('QUALITY_MIN_UNIQUE_BUYERS', 3);
export const QUALITY_MIN_BUY_SELL_RATIO = envNum('QUALITY_MIN_BUY_SELL_RATIO', 1);
export const QUALITY_MAX_SAME_SLOT_BUYS = envNum('QUALITY_MAX_SAME_SLOT_BUYS', 2);
export const QUALITY_MIN_REAL_SOL = envNum('QUALITY_MIN_REAL_SOL', 2);
export const RUGCHECK_ENABLED = envBool('RUGCHECK_ENABLED', false);
export const RUGCHECK_MAX_SCORE = envNum('RUGCHECK_MAX_SCORE', 1000);
export const RUGCHECK_TIMEOUT_MS = envNum('RUGCHECK_TIMEOUT_MS', 8000);
export const RUGCHECK_FAIL_OPEN = envBool('RUGCHECK_FAIL_OPEN', true);

const KNOWN_SETTINGS = new Set([
  'PRIVATE_KEY',
  'COMMITMENT_LEVEL',
  'RPC_ENDPOINT',
  'RPC_WEBSOCKET_ENDPOINT',
  'SEND_RPC_ENDPOINT',
  'LOG_LEVEL',
  'ONE_TOKEN_AT_A_TIME',
  'COMPUTE_UNIT_LIMIT',
  'COMPUTE_UNIT_PRICE',
  'PRE_LOAD_EXISTING_MARKETS',
  'CACHE_NEW_MARKETS',
  'TRANSACTION_EXECUTOR',
  'CUSTOM_FEE',
  'AUTO_BUY_DELAY',
  'QUOTE_MINT',
  'QUOTE_AMOUNT',
  'MAX_BUY_RETRIES',
  'BUY_SLIPPAGE',
  'AUTO_SELL',
  'AUTO_SELL_DELAY',
  'MAX_SELL_RETRIES',
  'TAKE_PROFIT',
  'STOP_LOSS',
  'PRICE_CHECK_INTERVAL',
  'PRICE_CHECK_DURATION',
  'SELL_SLIPPAGE',
  'FILTER_CHECK_INTERVAL',
  'FILTER_CHECK_DURATION',
  'CONSECUTIVE_FILTER_MATCHES',
  'CHECK_IF_MUTABLE',
  'CHECK_IF_SOCIALS',
  'CHECK_IF_MINT_IS_RENOUNCED',
  'CHECK_IF_FREEZABLE',
  'CHECK_IF_BURNED',
  'MIN_POOL_SIZE',
  'MAX_POOL_SIZE',
  'USE_SNIPE_LIST',
  'SNIPE_LIST_REFRESH_INTERVAL',
  'DRY_RUN',
  'ENABLE_RAYDIUM',
  'ENABLE_PUMPFUN',
  'ENABLE_PUMPSWAP',
  'CLOSE_EMPTY_TOKEN_ACCOUNTS',
  'PRICE_CHECK_WEBSOCKET',
  'RETRY_BACKOFF_MS',
  'SELL_SLIPPAGE_STEP',
  'PUMP_MIN_CURVE_PROGRESS',
  'PUMP_MAX_CURVE_PROGRESS',
  'PUMP_MIN_MARKET_CAP_SOL',
  'PUMP_MAX_MARKET_CAP_SOL',
  'PUMP_MIN_DEV_BUY_SOL',
  'PUMP_MAX_DEV_BUY_SOL',
  'PUMP_MAX_CREATOR_HOLD_PERCENT',
  'PUMP_MIN_UNIQUE_BUYERS',
  'PUMP_BUYER_WAIT_MS',
  'PUMP_MAX_REAL_SOL',
  'PUMP_SKIP_MAYHEM',
  'PUMP_CHECK_IF_MUTABLE',
  'PUMP_ALLOW_NON_SOL_QUOTE',
  'PUMP_CREATOR_BLACKLIST',
  'SL_CONFIRMATIONS',
  'SL_GRACE_MS',
  'SELL_RETRY_INTERVAL_MS',
  'PNL_LOG_INTERVAL_MS',
  'RPC_MIN_INTERVAL_MS',
  'RPC_MAX_CONCURRENCY',
  'RPC_HEAVY_INTERVAL_MS',
  'RPC_SEND_INTERVAL_MS',
  'RPC_RETRY_ATTEMPTS',
  'RPC_RETRY_BUDGET_MS',
  'QUALITY_FILTERS',
  'QUALITY_CHECK_SELLABLE',
  'MAX_TRANSFER_FEE_BPS',
  'MAX_SINGLE_HOLDER_PCT',
  'MAX_TOP10_PCT',
  'MAX_DEV_BUY_PCT',
  'MAX_CREATOR_LAUNCHES',
  'QUALITY_WAIT_MS',
  'QUALITY_MIN_TRADES',
  'QUALITY_MIN_UNIQUE_BUYERS',
  'QUALITY_MIN_BUY_SELL_RATIO',
  'QUALITY_MAX_SAME_SLOT_BUYS',
  'QUALITY_MIN_REAL_SOL',
  'RUGCHECK_ENABLED',
  'RUGCHECK_MAX_SCORE',
  'RUGCHECK_TIMEOUT_MS',
  'RUGCHECK_FAIL_OPEN',
]);

function failSetting(message: string): never {
  logger.error(message);
  process.exit(1);
}

function requireChoice(name: string, value: string, allowed: string[]) {
  if (!allowed.includes(value)) {
    failSetting(`${name} must be one of ${allowed.join(', ')}, got "${value}"`);
  }
}

function requireRange(name: string, value: number, min: number, max: number) {
  if (!Number.isFinite(value) || value < min || value > max) {
    failSetting(`${name} must be a number from ${min} to ${max}, got "${process.env[name]}"`);
  }
}

function warnUnknownSettings() {
  if (!fs.existsSync('.env')) {
    return;
  }
  const text = fs.readFileSync('.env', 'utf8');
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }
    const eq = trimmed.indexOf('=');
    if (eq <= 0) {
      continue;
    }
    const key = trimmed.slice(0, eq).trim();
    if (!KNOWN_SETTINGS.has(key)) {
      logger.warn(`${key} is not a setting this bot reads. It is ignored.`);
    }
  }
}

requireChoice('COMMITMENT_LEVEL', COMMITMENT_LEVEL, ['processed', 'confirmed', 'finalized']);
requireChoice('LOG_LEVEL', LOG_LEVEL, ['trace', 'debug', 'info', 'warn', 'error', 'fatal']);
requireChoice('TRANSACTION_EXECUTOR', TRANSACTION_EXECUTOR, ['default', 'warp', 'jito']);
requireChoice('QUOTE_MINT', QUOTE_MINT, ['WSOL', 'USDC']);
requireRange('BUY_SLIPPAGE', BUY_SLIPPAGE, 0, 100);
requireRange('SELL_SLIPPAGE', SELL_SLIPPAGE, 0, 100);
requireRange('SELL_SLIPPAGE_STEP', SELL_SLIPPAGE_STEP, 0, 100);
requireRange('TAKE_PROFIT', TAKE_PROFIT, 0, 100000);
requireRange('STOP_LOSS', STOP_LOSS, 0, 100);
if (!Number.isFinite(COMPUTE_UNIT_LIMIT) || COMPUTE_UNIT_LIMIT <= 0) {
  failSetting('COMPUTE_UNIT_LIMIT must be a positive number');
}
if (!Number.isFinite(COMPUTE_UNIT_PRICE) || COMPUTE_UNIT_PRICE < 0) {
  failSetting('COMPUTE_UNIT_PRICE must be a number that is zero or greater');
}
if (!Number.isFinite(Number(QUOTE_AMOUNT)) || Number(QUOTE_AMOUNT) <= 0) {
  failSetting('QUOTE_AMOUNT must be a positive number');
}
for (const name of [
  'ONE_TOKEN_AT_A_TIME',
  'PRE_LOAD_EXISTING_MARKETS',
  'CACHE_NEW_MARKETS',
  'AUTO_SELL',
  'CHECK_IF_MUTABLE',
  'CHECK_IF_SOCIALS',
  'CHECK_IF_MINT_IS_RENOUNCED',
  'CHECK_IF_FREEZABLE',
  'CHECK_IF_BURNED',
  'USE_SNIPE_LIST',
]) {
  const value = (process.env[name] ?? '').trim().toLowerCase();
  if (value !== 'true' && value !== 'false') {
    failSetting(`${name} must be true or false, got "${process.env[name]}"`);
  }
}
for (const [name, value] of [
  ['AUTO_BUY_DELAY', AUTO_BUY_DELAY],
  ['MAX_BUY_RETRIES', MAX_BUY_RETRIES],
  ['AUTO_SELL_DELAY', AUTO_SELL_DELAY],
  ['MAX_SELL_RETRIES', MAX_SELL_RETRIES],
  ['PRICE_CHECK_INTERVAL', PRICE_CHECK_INTERVAL],
  ['PRICE_CHECK_DURATION', PRICE_CHECK_DURATION],
  ['FILTER_CHECK_INTERVAL', FILTER_CHECK_INTERVAL],
  ['FILTER_CHECK_DURATION', FILTER_CHECK_DURATION],
  ['CONSECUTIVE_FILTER_MATCHES', CONSECUTIVE_FILTER_MATCHES],
  ['SNIPE_LIST_REFRESH_INTERVAL', SNIPE_LIST_REFRESH_INTERVAL],
  ['MIN_POOL_SIZE', Number(MIN_POOL_SIZE)],
  ['MAX_POOL_SIZE', Number(MAX_POOL_SIZE)],
] as const) {
  if (!Number.isFinite(value) || value < 0) {
    failSetting(`${name} must be a number that is zero or greater`);
  }
}
warnUnknownSettings();
