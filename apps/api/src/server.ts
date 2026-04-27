import Fastify from 'fastify';
import cors from '@fastify/cors';
import { FastifySSEPlugin } from 'fastify-sse-v2';
import { initDb } from './db/queries.js';
import { deploymentsRoutes } from './routes/deployments.js';
import { logsRoutes } from './routes/logs.js';

const fastify = Fastify({ logger: true });

await fastify.register(cors, { origin: true });
await fastify.register(FastifySSEPlugin);

initDb();

// Fail loud if Caddy admin API is unreachable — compose healthcheck should prevent this,
// but defense-in-depth catches misconfigured environments early.
const caddyUrl = process.env.CADDY_URL ?? 'http://caddy:2019';
const caddyOk = await fetch(`${caddyUrl}/config/`, { signal: AbortSignal.timeout(5000) })
  .then((r) => r.ok)
  .catch(() => false);

if (!caddyOk) {
  fastify.log.error('cannot reach Caddy admin API — check that caddy service is healthy');
  process.exit(1);
}

await fastify.register(deploymentsRoutes);
await fastify.register(logsRoutes);

fastify.get('/api/health', async () => ({ status: 'ok' }));

fastify.get('/api/caddy-check', async () => {
  const ok = await fetch(`${caddyUrl}/config/`, { signal: AbortSignal.timeout(3000) })
    .then((r) => r.ok)
    .catch(() => false);
  return { caddy: ok ? 'ok' : 'unreachable' };
});

await fastify.listen({ host: '0.0.0.0', port: Number(process.env.PORT ?? 3000) });
