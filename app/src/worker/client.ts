/**
 * ML Worker のクライアント（メインスレッド側）。
 *
 * Application Layer はここを通してのみ Worker に依頼する。
 * ジョブは投入順に1件ずつ実行され、複数の依頼が重なっても Worker 側は
 * 直列に処理する（論点19）。
 *
 * Worker のバンドルは Vite の `new Worker(new URL(...), { type: 'module' })`
 * 形式で行う。外部URLを渡さないこと（論点36・39）。
 */
import type { JobId, JobRequest, JobResponse } from './protocol';

type Pending = {
  readonly resolve: (response: JobResponse) => void;
  readonly reject: (error: Error) => void;
};

export class MlWorkerClient {
  readonly #worker: Worker;
  readonly #pending = new Map<JobId, Pending>();
  #seq = 0;

  constructor() {
    this.#worker = new Worker(new URL('./mlWorker.ts', import.meta.url), { type: 'module' });
    this.#worker.addEventListener('message', (event: MessageEvent<JobResponse>) => {
      const response = event.data;
      // progress は完了ではないため、待っているジョブを解決しない。
      if (response.type === 'progress') return;
      const pending = this.#pending.get(response.jobId);
      if (!pending) return;
      this.#pending.delete(response.jobId);
      if (response.type === 'failed') {
        pending.reject(new Error(response.message));
        return;
      }
      pending.resolve(response);
    });
  }

  /** ジョブを投入し、対応する応答を待つ。 */
  request(build: (jobId: JobId) => JobRequest, transfer: Transferable[] = []): Promise<JobResponse> {
    const jobId = `job-${++this.#seq}`;
    const message = build(jobId);
    return new Promise<JobResponse>((resolve, reject) => {
      this.#pending.set(jobId, { resolve, reject });
      this.#worker.postMessage(message, transfer);
    });
  }

  terminate(): void {
    this.#worker.terminate();
    for (const pending of this.#pending.values()) {
      pending.reject(new Error('ML Worker を終了した'));
    }
    this.#pending.clear();
  }
}
