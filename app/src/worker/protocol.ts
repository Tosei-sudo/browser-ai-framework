/**
 * ML Worker とメインスレッドの間で交わすメッセージ（論点19）。
 *
 * Worker は単一で、ジョブは1件ずつ実行する。推論と学習を分けないのは、
 * ブラウザのメモリ上限が最大の制約であり、Worker を分けると同じ重みを
 * 二重に持ちうるため（03 §4）。
 */
import type { Backend, DetectionParams, DecodedDetection } from '@ports/mlRuntime';
import type { ModelId } from '@domain/ids';

export type JobId = string;

/** メインスレッド → Worker */
export type JobRequest =
  | { readonly type: 'init'; readonly jobId: JobId }
  | {
      readonly type: 'infer';
      readonly jobId: JobId;
      readonly modelId: ModelId;
      readonly image: ImageBitmap;
      readonly params: DetectionParams;
    }
  | { readonly type: 'cancel'; readonly jobId: JobId; readonly targetJobId: JobId };

/** Worker → メインスレッド */
export type JobResponse =
  | {
      readonly type: 'ready';
      readonly jobId: JobId;
      readonly backend: Backend;
    }
  | {
      readonly type: 'inferred';
      readonly jobId: JobId;
      readonly detections: readonly DecodedDetection[];
      readonly elapsedMs: number;
    }
  | {
      readonly type: 'progress';
      readonly jobId: JobId;
      readonly epoch: number;
      readonly metrics: Readonly<Record<string, number>>;
    }
  | { readonly type: 'failed'; readonly jobId: JobId; readonly message: string };
