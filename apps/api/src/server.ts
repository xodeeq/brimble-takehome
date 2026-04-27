import Fastify from 'fastify';
import cors from '@fastify/cors';
import { FastifySSEPlugin } from 'fastify-sse-v2';
import { initDb } from './db/queries.js';

const fastify = Fastify({ logger: true });

await fastify.register(cors, { origin: true });
await fastify.register(FastifySSEPlugin);

initDb();

fastify.get('/api/health', async () => ({ status: 'ok' }));

fastify.get('/api/caddy-check', async () => {
  try {
    const res = await fetch('http://caddy:2019/config/');
    return { caddy: res.ok ? 'ok' : 'unreachable' };
  } catch {
    return { caddy: 'unreachable' };
  }
});

await fastify.listen({ host: '0.0.0.0', port: Number(process.env.PORT ?? 3000) });
