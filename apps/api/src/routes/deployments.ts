import type { FastifyInstance } from 'fastify';
import { newDeploymentId } from '../lib/ids.js';
import {
  deleteDeployment,
  getDeployment,
  getLogs,
  insertDeployment,
  listDeployments,
} from '../db/queries.js';
import { docker } from '../lib/docker.js';
import { removeDeploymentRoute } from '../pipeline/caddy.js';
import { runDeployment } from '../pipeline/orchestrator.js';

function withUrl<T extends { id: string; status: string }>(dep: T): T & { url: string | null } {
  return {
    ...dep,
    url: dep.status === 'running' ? `http://${dep.id}.brimble.localhost` : null,
  };
}

export async function deploymentsRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post('/api/deployments', async (req, reply) => {
    const body = req.body as Record<string, unknown> | null | undefined;
    const source = (body?.source ?? {}) as Record<string, unknown>;

    if (source['type'] === 'upload') {
      return reply.status(501).send({ error: 'upload source not yet supported' });
    }
    if (source['type'] !== 'git') {
      return reply.status(400).send({ error: 'source.type must be "git"' });
    }
    const url = source['url'];
    if (typeof url !== 'string' || !url) {
      return reply.status(400).send({ error: 'source.url is required for git deployments' });
    }

    const id = newDeploymentId();
    insertDeployment(id, 'git', url);

    // Fire-and-forget — HTTP response goes out before the pipeline starts.
    setImmediate(() => {
      runDeployment(id).catch((err: unknown) => {
        fastify.log.error({ deploymentId: id, err }, 'unhandled orchestrator error');
      });
    });

    return reply.status(202).send({ id, status: 'pending' });
  });

  fastify.get('/api/deployments', async (_req, reply) => {
    return reply.send(listDeployments().map(withUrl));
  });

  fastify.get<{ Params: { id: string } }>('/api/deployments/:id', async (req, reply) => {
    const dep = getDeployment(req.params.id);
    if (!dep) return reply.status(404).send({ error: 'not found' });
    return reply.send(withUrl(dep));
  });

  fastify.get<{ Params: { id: string } }>('/api/deployments/:id/logs', async (req, reply) => {
    const dep = getDeployment(req.params.id);
    if (!dep) return reply.status(404).send({ error: 'not found' });
    return reply.send(getLogs(req.params.id));
  });

  fastify.delete<{ Params: { id: string } }>('/api/deployments/:id', async (req, reply) => {
    const { id } = req.params;
    const dep = getDeployment(id);
    if (!dep) return reply.status(404).send({ error: 'not found' });

    await removeDeploymentRoute(id).catch(() => { /* already gone */ });
    await docker.getContainer(`app-${id}`).remove({ force: true }).catch(() => { /* already gone */ });
    deleteDeployment(id);

    return reply.status(204).send();
  });
}
