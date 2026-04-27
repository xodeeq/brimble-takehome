import { docker } from '../lib/docker.js';
import { record } from '../db/queries.js';
import { addDeploymentRoute } from './caddy.js';

const APP_PORT = 3000;
const DOCKER_NETWORK = process.env.DOCKER_NETWORK ?? 'brimble_net';

async function pollReady(url: string, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (res.ok) return true;
    } catch { /* not ready yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

export async function runDeploy(deploymentId: string, imageTag: string): Promise<void> {
  record(deploymentId, 'system', 'starting container');

  const container = await docker.createContainer({
    Image: imageTag,
    name: `app-${deploymentId}`,
    // Dictate the port so Caddy always knows where to dial (gotcha §7).
    Env: [`PORT=${APP_PORT}`],
    HostConfig: {
      RestartPolicy: { Name: 'unless-stopped' },
      // No port bindings to host — Caddy reaches the container by name on brimble_net.
    },
    // Use EndpointsConfig rather than HostConfig.NetworkMode to avoid dockerode ambiguity.
    NetworkingConfig: {
      EndpointsConfig: {
        [DOCKER_NETWORK]: {},
      },
    },
  });

  await container.start();
  record(deploymentId, 'system', `container app-${deploymentId} started`);

  const appUrl = `http://app-${deploymentId}:${APP_PORT}/`;
  const ready = await pollReady(appUrl);
  if (!ready) {
    record(deploymentId, 'system', 'readiness check timed out — proceeding anyway');
  } else {
    record(deploymentId, 'system', 'readiness check passed');
  }

  await addDeploymentRoute({
    deploymentId,
    hostname: `${deploymentId}.brimble.localhost`,
    upstream: `app-${deploymentId}:${APP_PORT}`,
  });

  record(deploymentId, 'system', `caddy route registered`);
}
