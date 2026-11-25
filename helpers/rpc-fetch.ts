import dns from 'dns';
import { Agent, fetch as undiciFetch } from 'undici';
import { logger } from './logger';
import { describeRpcError, enrichRpcError } from './rpc-error';

// Node 18+ tries IPv6 first and can sit on a dead AAAA record until the connect timeout.
dns.setDefaultResultOrder('ipv4first');

/**
 * One agent for every RPC call. web3.js passes a node `agent` option, which
 * Node's built-in fetch ignores, so each request was opening a new socket.
 */
export const rpcAgent = new Agent({
  keepAliveTimeout: 30_000,
  keepAliveMaxTimeout: 60_000,
  connections: 32,
  pipelining: 1,
  connect: {
    timeout: 10_000,
    autoSelectFamily: true,
    autoSelectFamilyAttemptTimeout: 300,
  },
});

function hostnameOf(input: RequestInfo | URL): string {
  try {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    return new URL(raw).hostname;
  } catch {
    return '';
  }
}

export async function rpcFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const hostname = hostnameOf(input);
  const rest = { ...(init ?? {}) } as RequestInit & { agent?: unknown };
  delete rest.agent;
  try {
    return (await undiciFetch(input as Parameters<typeof undiciFetch>[0], {
      ...(rest as object),
      dispatcher: rpcAgent,
    })) as unknown as Response;
  } catch (error) {
    const details = describeRpcError(error, hostname);
    logger.warn(
      { code: details.code, errno: details.errno, hostname: details.hostname },
      `RPC fetch failed: ${details.message}`,
    );
    throw enrichRpcError(error, details);
  }
}
