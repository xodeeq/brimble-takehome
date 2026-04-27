import { EventEmitter } from 'node:events';

export type LogLine = { ts: number; stream: 'stdout' | 'stderr'; line: string };

const emitter = new EventEmitter();
emitter.setMaxListeners(200);

export function emitLog(deploymentId: string, line: LogLine): void {
  emitter.emit(`log:${deploymentId}`, line);
}

export function onLog(
  deploymentId: string,
  listener: (line: LogLine) => void,
): () => void {
  emitter.on(`log:${deploymentId}`, listener);
  return () => emitter.off(`log:${deploymentId}`, listener);
}
