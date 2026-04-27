import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { record } from '../db/queries.js';

const exec = promisify(execFile);

export async function cloneSource(deploymentId: string, gitUrl: string): Promise<string> {
  const workspaceDir = `/workspaces/${deploymentId}`;
  record(deploymentId, 'system', `cloning ${gitUrl}`);
  await exec('git', ['clone', '--depth=1', gitUrl, workspaceDir]);
  record(deploymentId, 'system', 'clone complete');
  return workspaceDir;
}

export async function getShortSha(workspaceDir: string): Promise<string> {
  const { stdout } = await exec('git', ['-C', workspaceDir, 'rev-parse', '--short', 'HEAD']);
  return stdout.trim();
}
