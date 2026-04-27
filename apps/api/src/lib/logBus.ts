import { EventEmitter } from 'node:events';

export type LogLine = { ts: number; stream: 'stdout' | 'stderr' | 'system'; line: string };

// Subscription is both an AsyncIterable (for `for await`) and has cancel() for explicit cleanup.
// Listeners are attached eagerly at subscribe() call time — not lazily in [Symbol.asyncIterator]()
// — so no line published between subscribe() and the for-await start is missed.
export type Subscription = AsyncIterable<LogLine> & { cancel(): void };

const bus = new EventEmitter();
bus.setMaxListeners(500);

// Tracks deployments whose pipelines have finished so late subscribers terminate immediately.
const closedDeployments = new Set<string>();

export function publish(deploymentId: string, line: LogLine): void {
  bus.emit(`log:${deploymentId}`, line);
}

// Called by setStatus when a deployment reaches a terminal state.
export function closeBus(deploymentId: string): void {
  closedDeployments.add(deploymentId);
  bus.emit(`end:${deploymentId}`);
}

export function subscribe(deploymentId: string): Subscription {
  const queue: LogLine[] = [];
  let pending: ((result: IteratorResult<LogLine>) => void) | null = null;
  let done = closedDeployments.has(deploymentId);
  let listenersAttached = false;

  function onLog(line: LogLine): void {
    if (pending) {
      const resolve = pending;
      pending = null;
      resolve({ value: line, done: false });
    } else {
      queue.push(line);
    }
  }

  function onEnd(): void {
    done = true;
    if (pending) {
      const resolve = pending;
      pending = null;
      resolve({ value: undefined as unknown as LogLine, done: true });
    }
  }

  function cleanup(): void {
    if (!listenersAttached) return;
    listenersAttached = false;
    bus.off(`log:${deploymentId}`, onLog);
    bus.off(`end:${deploymentId}`, onEnd);
  }

  // Eagerly attach so any line published between subscribe() and the for-await start
  // goes into the queue and isn't lost during the history replay yields.
  if (!done) {
    listenersAttached = true;
    bus.on(`log:${deploymentId}`, onLog);
    bus.on(`end:${deploymentId}`, onEnd);
  }

  // The object is both an AsyncIterable and implements AsyncIterator via [Symbol.asyncIterator]
  // returning `this`. Single-use — do not iterate the same Subscription twice.
  const sub: Subscription = {
    cancel: cleanup,

    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<LogLine>> {
          if (queue.length > 0) {
            return Promise.resolve({ value: queue.shift()!, done: false });
          }
          if (done) {
            cleanup();
            return Promise.resolve({ value: undefined as unknown as LogLine, done: true });
          }
          return new Promise<IteratorResult<LogLine>>((resolve) => {
            pending = resolve;
          });
        },
        return(): Promise<IteratorResult<LogLine>> {
          cleanup();
          done = true;
          if (pending) {
            const resolve = pending;
            pending = null;
            resolve({ value: undefined as unknown as LogLine, done: true });
          }
          return Promise.resolve({ value: undefined as unknown as LogLine, done: true });
        },
      };
    },
  };

  return sub;
}
