const CODE_RE =
  /\b(EAI_AGAIN|ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|ENOTFOUND|EPIPE|EHOSTUNREACH|UND_ERR_[A-Z0-9_]+)\b/;

export interface RpcErrorDetails {
  message: string;
  code?: string;
  errno?: number | string;
  hostname?: string;
}

/** Walks error.cause. Node's fetch failure hides the socket reason there. */
export function describeRpcError(error: unknown, hostnameHint?: string): RpcErrorDetails {
  const messages: string[] = [];
  let code: string | undefined;
  let errno: number | string | undefined;
  let hostname = hostnameHint;
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    const row = current as {
      message?: string;
      code?: string | number;
      errno?: number | string;
      hostname?: string;
      cause?: unknown;
    };
    if (row.message) {
      messages.push(row.message);
    }
    if (!code && typeof row.code === 'string') {
      code = row.code;
    }
    if (errno == null && row.errno != null) {
      errno = row.errno;
    }
    if (!hostname && row.hostname) {
      hostname = row.hostname;
    }
    current = row.cause;
  }
  const message = messages.join(': ') || String(error);
  if (!code) {
    code = message.match(CODE_RE)?.[1];
  }
  const embedded = message.match(/fetch failed \(([^ )]+)(?: ([^)]+))?\)/);
  if (!code && embedded?.[1] && embedded[1] !== 'unknown') {
    code = embedded[1];
  }
  if (!hostname && embedded?.[2]) {
    hostname = embedded[2];
  }
  return { message, code, errno, hostname };
}

export function isTransientRpcError(error: unknown): boolean {
  const details = describeRpcError(error);
  if (details.code && CODE_RE.test(details.code)) {
    return true;
  }
  return /fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|UND_ERR_|socket hang up|other side closed|429|too many requests|EPIPE/i.test(
    details.message,
  );
}

/** Puts the socket code and host into the message, so a later string wrap still shows them. */
export function enrichRpcError(error: unknown, details: RpcErrorDetails): TypeError {
  const code = details.code ?? 'unknown';
  const host = details.hostname ?? '';
  const wrapped = new TypeError(`fetch failed (${code}${host ? ` ${host}` : ''})`);
  Object.assign(wrapped, {
    code: details.code,
    errno: details.errno,
    hostname: details.hostname,
    cause: error,
  });
  return wrapped;
}
