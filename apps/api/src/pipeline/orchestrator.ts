import { docker } from '../lib/docker.js';
import { cloneSource } from '../lib/git.js';
import { getDeployment, record, setImageTag, setStatus } from '../db/queries.js';
import { runBuild } from './build.js';
import { runDeploy } from './deploy.js';

async function safeCleanup(deploymentId: string): Promise<void> {
  try {
    const container = docker.getContainer(`app-${deploymentId}`);
    await container.remove({ force: true });
  } catch { /* container may not exist */ }
}

export async function runDeployment(deploymentId: string): Promise<void> {
  const dep = getDeployment(deploymentId);
  if (!dep) throw new Error(`deployment ${deploymentId} not found`);

  try {
    record(deploymentId, 'system', 'starting pipeline');

    // Clone
    const gitUrl = dep.source_url;
    if (!gitUrl) throw new Error('source_url is required for git deployments');
    const workspaceDir = await cloneSource(deploymentId, gitUrl);

    // Build
    setStatus(deploymentId, 'building');
    record(deploymentId, 'system', 'build started');
    const imageTag = await runBuild(deploymentId, workspaceDir);
    setImageTag(deploymentId, imageTag);

    // Deploy
    setStatus(deploymentId, 'deploying');
    record(deploymentId, 'system', 'deploying container');
    await runDeploy(deploymentId, imageTag);

    // Done — record final line BEFORE setStatus so SSE subscribers see it before iterator closes.
    record(deploymentId, 'system', `live at http://${deploymentId}.brimble.localhost`);
    setStatus(deploymentId, 'running');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    record(deploymentId, 'system', `FAILED: ${message}`);
    setStatus(deploymentId, 'failed', message);
    await safeCleanup(deploymentId);
  }
}
