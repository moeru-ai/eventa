// https://github.com/vitest-dev/vitest/issues/5757#issuecomment-2146013141

import type { WorkerOptions } from 'node:worker_threads'

import { Worker } from 'node:worker_threads'

const worker = /* JavaScript */ `
  import { createRequire } from "node:module";
  import { workerData } from "node:worker_threads";

  const filename = "${import.meta.url}";
  const require = createRequire(filename);
  const { tsImport } = require("tsx/esm/api");

  tsImport(workerData.__ts_worker_filename, filename);
`

export class TypeScriptWorker extends Worker {
  constructor(filename: string | URL, options: WorkerOptions = {}) {
    options.workerData ??= {}
    options.workerData.__ts_worker_filename = filename.toString()
    super(new URL(`data:text/javascript,${worker}`), options)
  }
}
