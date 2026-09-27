/// <reference lib="webworker" />
import { resampleBand, type BandJob } from './resample';

declare const self: DedicatedWorkerGlobalScope;

self.onmessage = (e: MessageEvent<BandJob>) => {
  const out = resampleBand(e.data);
  self.postMessage({ out }, [out.buffer]);
};
