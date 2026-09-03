import pino from 'pino';
import { env, isDev } from './env';

export const logger = pino({
  level: isDev ? 'debug' : 'info',
  base: { service: 'mumbai-erp-api' },
  transport: isDev
    ? {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname' },
      }
    : undefined,
});

logger.debug({ env: env.NODE_ENV, port: env.API_PORT }, 'logger initialised');
