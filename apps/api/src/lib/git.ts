import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export async function cloneRepo(url: string, destPath: string): Promise<void> {
  await exec('git', ['clone', '--depth=1', url, destPath]);
}
