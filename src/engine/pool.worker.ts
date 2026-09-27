/// <reference lib="webworker" />
import { runJob, type PoolJob } from './filters';

declare const self: DedicatedWorkerGlobalScope;

self.onmessage = (e: MessageEvent<PoolJob>) => {
  try {
    const out = runJob(e.data);
    self.postMessage({ out }, [out.buffer]);
  } catch (err) {
    self.postMessage({ error: err instanceof Error ? err.message : String(err) });
  }
};
