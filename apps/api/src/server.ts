import { createServer } from 'node:http';
import { env } from './config/env';
import { logger } from './config/logger';
import { prisma } from './config/prisma';
import { createApp } from './app';
import { initRealtime, shutdownRealtime } from './sockets/realtime';
import { startJobs, stopJobs } from './jobs/queue';
import { ensureTallyDefaults } from './modules/tally/tally.config';

async function bootstrap(): Promise<void> {
  // Verify DB connectivity before accepting traffic.
  await prisma.$queryRaw`SELECT 1`;
  logger.info('database connection ok');

  const app = createApp();
  const server = createServer(app);

  await initRealtime(server);
  await startJobs();
  // Pre-fill the Tally ledger map with the recommended defaults (idempotent).
  await ensureTallyDefaults();

  // Bind host is configurable so a reverse-proxied deployment can keep the API
  // off every public interface (API_HOST=127.0.0.1) while container setups, whose
  // networking needs an externally reachable bind, keep the 0.0.0.0 default.
  server.listen(env.API_PORT, env.API_HOST, () => {
    logger.info(`🚀 API listening on http://${env.API_HOST}:${env.API_PORT} (${env.NODE_ENV})`);
  });

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'shutting down...');
    server.close();
    await Promise.allSettled([stopJobs(), shutdownRealtime(), prisma.$disconnect()]);
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

bootstrap().catch((err) => {
  logger.error({ err }, 'failed to start server');
  process.exit(1);
});
