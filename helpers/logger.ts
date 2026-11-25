import fs from 'fs';
import path from 'path';
import pino from 'pino';
import { describeRpcError } from './rpc-error';

const logDir = path.join(process.cwd(), 'logs');
fs.mkdirSync(logDir, { recursive: true });
const logFile = path.join(logDir, `${new Date().toISOString().slice(0, 10)}.log`);

const transport = pino.transport({
  targets: [
    { target: 'pino-pretty', options: { destination: 1 } },
    { target: 'pino/file', options: { destination: logFile, mkdir: true } },
  ],
});

export const logger = pino(
  {
    level: 'info',
    redact: ['poolKeys', 'privateKey', 'secretKey', 'mnemonic', 'seed', 'PRIVATE_KEY'],
    serializers: {
      error(error: unknown) {
        return serializeLogError(error);
      },
    },
    base: undefined,
  },
  transport,
);

export const logFilePath = logFile;

/** Strings must stay strings. Pino's error serializer otherwise copies each character as a field. */
export function serializeLogError(error: unknown): Record<string, unknown> {
  if (typeof error === 'string') {
    return { message: error };
  }
  if (!(error instanceof Error)) {
    return { message: describeRpcError(error).message || String(error) };
  }
  const details = describeRpcError(error);
  return {
    ...pino.stdSerializers.err(error),
    code: details.code,
    errno: details.errno,
    hostname: details.hostname,
  };
}
