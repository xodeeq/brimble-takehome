import { PassThrough } from 'node:stream';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { docker } from '../lib/docker.js';
import { record } from '../db/queries.js';

const exec = promisify(execFile);

const WORKSPACES_VOLUME = process.env.WORKSPACES_VOLUME ?? 'brimble_workspaces';

// Accumulates stream chunks into complete lines, flushing the final partial line on end().
function lineify(onLine: (line: string) => void): { write(chunk: Buffer | string): void; end(): void } {
  let buf = '';
  return {
    write(chunk) {
      buf += chunk.toString('utf8');
      let idx: number;
      while ((idx = buf.indexOf('\n')) !== -1) {
        onLine(buf.slice(0, idx));
        buf = buf.slice(idx + 1);
      }
    },
    end() {
      if (buf.length) {
        onLine(buf);
        buf = '';
      }
    },
  };
}

// Returns the built image tag on success; throws on failure.
// workspaceDir is the path inside the API container (e.g. /workspaces/dep-abc123).
export async function runBuild(deploymentId: string, workspaceDir: string): Promise<string> {
  const { stdout: shaOut } = await exec('git', ['-C', workspaceDir, 'rev-parse', '--short', 'HEAD']);
  const shortSha = shaOut.trim();
  const imageTag = `brimble-${deploymentId}:${shortSha}`;

  record(deploymentId, 'system', `building image ${imageTag}`);

  const container = await docker.createContainer({
    Image: 'brimble-builder:latest',
    // ENTRYPOINT is "railpack"; CMD provides the subcommand args.
    Cmd: ['build', `/workspace/${deploymentId}`, '--name', imageTag, '--progress', 'plain'],
    Tty: false,  // must be false so dockerode demuxes stdout/stderr separately (gotcha §1)
    // Railpack v0.23+ requires BUILDKIT_HOST; point it at the buildkitd sidecar.
    Env: ['BUILDKIT_HOST=docker-container://buildkitd'],
    HostConfig: {
      Binds: [
        `${WORKSPACES_VOLUME}:/workspace`,
        '/var/run/docker.sock:/var/run/docker.sock',
      ],
      AutoRemove: false,  // we remove explicitly in finally so we can read the exit code
    },
  });

  const stdoutPt = new PassThrough();
  const stderrPt = new PassThrough();
  const stdoutLiner = lineify((line) => record(deploymentId, 'stdout', line));
  const stderrLiner = lineify((line) => record(deploymentId, 'stderr', line));

  stdoutPt.on('data', (chunk: Buffer) => stdoutLiner.write(chunk));
  stdoutPt.on('end', () => stdoutLiner.end());
  stderrPt.on('data', (chunk: Buffer) => stderrLiner.write(chunk));
  stderrPt.on('end', () => stderrLiner.end());

  // Resolves once both PassThrough streams end, ensuring all log lines are persisted.
  const logsDone = new Promise<void>((resolve) => {
    let ended = 0;
    const onEnd = (): void => { if (++ended === 2) resolve(); };
    stdoutPt.on('end', onEnd);
    stderrPt.on('end', onEnd);
  });

  try {
    // Start container before attaching logs so the logs() call doesn't block.
    // since: 0 retrieves all output from container start, even if we attach slightly late.
    await container.start();

    const logStream = await container.logs({ follow: true, stdout: true, stderr: true, since: 0 });
    // demuxStream calls .end() on both PassThrough streams when logStream closes (gotcha §1).
    docker.modem.demuxStream(logStream, stdoutPt, stderrPt);

    const { StatusCode: exitCode } = await container.wait();

    // Docker's follow=true log stream does not auto-close when the container
    // exits in a DooD setup — the HTTP response body stays open. Explicitly
    // end both PassThrough streams so logsDone resolves instead of hanging.
    if (!stdoutPt.writableEnded) stdoutPt.end();
    if (!stderrPt.writableEnded) stderrPt.end();

    await logsDone;  // ensure all buffered log lines are persisted before we evaluate the result

    if (exitCode !== 0) {
      throw new Error(`builder exited with code ${exitCode}`);
    }

    record(deploymentId, 'system', `image built: ${imageTag}`);
    return imageTag;
  } finally {
    await container.remove({ force: true }).catch(() => { /* already gone */ });
  }
}
