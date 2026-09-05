/**
 * ML Worker のクライアント（メインスレッド側）。
 *
 * Application Layer はここを通してのみ Worker に依頼する。
 * ジョブは投入順に1件ずつ実行される（論点19）。
 *
 * 学習のように途中経過を返すジョブがあるため、**進捗の通知を受け取る口**を
 * 持たせてある。中断は専用のメッセージで、キューに並ばず即座に届く。
 */
import type { JobId, JobRequest, JobResponse } from './protocol';

type Pending = {
  readonly resolve: (response: JobResponse) => void;
  readonly reject: (error: Error) => void;
  readonly onProgress?: (response: JobResponse) => void;
};

export class MlWorkerClient {
  readonly #worker: Worker;
  readonly #pending = new Map<JobId, Pending>();
  #seq = 0;

  constructor() {
    this.#worker = new Worker(new URL('./mlWorker.ts', import.meta.url), { type: 'module' });
    this.#worker.addEventListener('message', (event: MessageEvent<JobResponse>) => {
      const response = event.data;
      const pending = this.#pending.get(response.jobId);
      if (!pending) return;
      if (response.type === 'progress') {
        pending.onProgress?.(response);
        return;
      }
      this.#pending.delete(response.jobId);
      if (response.type === 'failed') {
        pending.reject(new Error(response.message));
        return;
      }
      pending.resolve(response);
    });
  }

  /** ジョブを投入し、対応する応答を待つ。 */
  request(
    build: (jobId: JobId) => JobRequest,
    transfer: Transferable[] = [],
    onProgress?: (response: JobResponse) => void,
  ): Promise<JobResponse> {
    const jobId = `job-${++this.#seq}`;
    const message = build(jobId);
    return new Promise<JobResponse>((resolve, reject) => {
      this.#pending.set(jobId, onProgress ? { resolve, reject, onProgress } : { resolve, reject });
      this.#worker.postMessage(message, transfer);
    });
  }

  /** 実行中のジョブに中断を要求する。Worker 側はキューに並べず即座に受ける。 */
  cancel(): void {
    this.#worker.postMessage({ type: 'cancel', jobId: 'cancel' } satisfies JobRequest);
  }

  terminate(): void {
    this.#worker.terminate();
    for (const pending of this.#pending.values()) {
      pending.reject(new Error('ML Worker を終了した'));
    }
    this.#pending.clear();
  }
}
