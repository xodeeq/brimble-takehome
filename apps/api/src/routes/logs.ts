import type { FastifyInstance } from 'fastify';
import { getDeployment, getLogs } from '../db/queries.js';
import { subscribe } from '../lib/logBus.js';

export async function logsRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get<{ Params: { id: string } }>('/api/deployments/:id/logs/stream', (req, reply) => {
    const { id } = req.params;

    const dep = getDeployment(id);
    if (!dep) {
      reply.status(404).send({ error: 'not found' });
      return;
    }

    // Attach bus listeners eagerly BEFORE getLogs() snapshot so no line published between
    // the snapshot and the for-await start is missed (gotcha §2 ordering).
    const sub = subscribe(id);
    const history = getLogs(id);

    reply.sse(
      (async function* () {
        try {
          for (const row of history) {
            yield { data: JSON.stringify(row) };
          }

          // If already terminal (closedDeployments.has(id)), the iterator returns done immediately.
          // cleanup() is called by the iterator's return() when for-await exits.
          for await (const line of sub) {
            yield { data: JSON.stringify(line) };
          }

          yield { event: 'end', data: '' };
        } finally {
          // Handles the case where the generator is aborted during history replay before
          // for-await runs, which would otherwise leave listeners attached forever.
          sub.cancel();
        }
      })(),
    );
  });
}
