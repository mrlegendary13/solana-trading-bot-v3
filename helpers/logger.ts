import fs from 'fs';
import path from 'path';
import pino from 'pino';

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
      error: pino.stdSerializers.err,
    },
    base: undefined,
  },
  transport,
);

export const logFilePath = logFile;
