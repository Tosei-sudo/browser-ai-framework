/**
 * InferenceManager — 推論の実行と結果の記録（方針9）。
 *
 * 記録は `Inference` / `InferenceTarget` / `Detection` の3階層。
 * **コミットは画像1枚（= Target）ごと**に行う（04 §6.3）。1回の実行を
 * 1トランザクションにすると、画像枚数 × 検出件数のぶんだけ長時間ロックする。
 *
 * 実行時のスレッショルドはモデル属性ではなくここに持つ（方針15）。
 */
import { newId, now } from '@domain/ids';
import type {
  DetectionId,
  InferenceId,
  InferenceTargetId,
  LabelClassId,
  ModelId,
  ProjectId,
} from '@domain/ids';
import type { Detection, Image, Inference, InferenceTarget, Model, RuntimeInfo } from '@domain/index';
import type { DecodedDetection, DetectionParams } from '@ports/mlRuntime';
import type { Repositories, UnitOfWork } from '@ports/repository';
import type { BlobStore } from '@ports/blobStore';
import { loadImageBitmap } from './imageManager';
import { enforceRetention } from './retentionService';

export interface InferenceRunner {
  /** ML Worker への依頼。1件ずつ順に実行される（論点19） */
  infer(
    model: Model,
    image: ImageBitmap,
    params: DetectionParams,
  ): Promise<{ detections: readonly DecodedDetection[]; elapsedMs: number; backend: string }>;
}

export interface InferenceManagerDeps {
  readonly repositories: Repositories;
  readonly unitOfWork: UnitOfWork;
  readonly blobStore: BlobStore;
  readonly runner: InferenceRunner;
}

export const DEFAULT_PARAMS: DetectionParams = {
  confThreshold: 0.25,
  iouThreshold: 0.45,
  maxDetections: 100,
};

export interface RunResult {
  readonly inference: Inference;
  readonly targets: readonly { target: InferenceTarget; detections: readonly Detection[] }[];
}

export async function runInference(
  deps: InferenceManagerDeps,
  projectId: ProjectId,
  model: Model,
  images: readonly Image[],
  params: DetectionParams = DEFAULT_PARAMS,
): Promise<RunResult> {
  const classes = await deps.repositories.labelClasses.listByLabelSet(model.label_set_id);
  const byIndex = new Map<number, LabelClassId>(
    classes.map((klass) => [klass.index, klass.label_class_id]),
  );

  const runtimeInfo: RuntimeInfo = {
    backend: 'unknown',
    user_agent: navigator.userAgent,
  };
  const inference: Inference = {
    inference_id: newId<'InferenceId'>() as InferenceId,
    project_id: projectId,
    model_id: model.model_id as ModelId,
    conf_threshold: params.confThreshold,
    iou_threshold: params.iouThreshold,
    max_detections: params.maxDetections,
    runtime_info: runtimeInfo,
    executed_at: now(),
    pinned: false,
  };

  // 実行の器を先に作る。画像ごとの結果は後から積む（方針9）。
  await deps.unitOfWork.run(['inferences'], 'readwrite', async (repos) => {
    await repos.inferences.put(inference);
  });

  const results: { target: InferenceTarget; detections: Detection[] }[] = [];
  let backend = 'unknown';

  for (const image of images) {
    const targetId = newId<'InferenceTargetId'>() as InferenceTargetId;
    let target: InferenceTarget = {
      target_id: targetId,
      inference_id: inference.inference_id,
      image_id: image.image_id,
      status: 'succeeded',
      elapsed_ms: null,
      error_message: null,
    };
    let detections: Detection[] = [];

    try {
      const bitmap = await loadImageBitmap(
        { repositories: deps.repositories, unitOfWork: deps.unitOfWork, blobStore: deps.blobStore },
        image,
      );
      const outcome = await deps.runner.infer(model, bitmap, params);
      backend = outcome.backend;
      target = { ...target, elapsed_ms: Math.round(outcome.elapsedMs) };
      detections = outcome.detections.map((detection, rank) => ({
        detection_id: newId<'DetectionId'>() as DetectionId,
        target_id: targetId,
        // クラスは参照で持つ。後から名称を変えても履歴が壊れない（方針1）。
        label_class_id: byIndex.get(detection.classIndex) ?? (classes[0]?.label_class_id as LabelClassId),
        confidence: detection.confidence,
        bbox: detection.bbox,
        bbox_format: 'pixel_xywh',
        rank,
      }));
    } catch (error) {
      // 1枚失敗しても実行全体は続ける。成否は Target が持つ（方針9）。
      target = {
        ...target,
        status: 'failed',
        error_message: error instanceof Error ? error.message : String(error),
      };
    }

    // 画像1枚ぶんを1トランザクションでコミットする（04 §6.3）。
    await deps.unitOfWork.run(['inference_targets', 'detections'], 'readwrite', async (repos) => {
      await repos.inferenceTargets.put(target);
      await repos.detections.putMany(detections);
    });
    results.push({ target, detections });
  }

  // 実際に使ったバックエンドを記録に残す。
  const finished: Inference = {
    ...inference,
    runtime_info: { ...runtimeInfo, backend },
  };
  await deps.unitOfWork.run(['inferences'], 'readwrite', async (repos) => {
    await repos.inferences.put(finished);
  });

  // 上限を超えたぶんを古い順に落とす（方針14）。
  await enforceRetention(deps, projectId);

  return { inference: finished, targets: results };
}

/** 履歴の一覧（新しい順）。`[project_id, executed_at]` を使う。 */
export async function listHistory(
  deps: InferenceManagerDeps,
  projectId: ProjectId,
  limit = 20,
): Promise<Inference[]> {
  return deps.repositories.inferences.listByProject(projectId, limit);
}

/** 履歴1件の詳細。画像ごとの成否と検出結果を返す。 */
export async function loadHistoryDetail(
  deps: InferenceManagerDeps,
  inferenceId: InferenceId,
): Promise<{ target: InferenceTarget; detections: Detection[] }[]> {
  const targets = await deps.repositories.inferenceTargets.listByInference(inferenceId);
  return Promise.all(
    targets.map(async (target) => ({
      target,
      detections: await deps.repositories.detections.listByTarget(target.target_id),
    })),
  );
}

/** 履歴を保持対象として固定する / 解除する（方針14）。 */
export async function setPinned(
  deps: InferenceManagerDeps,
  inferenceId: InferenceId,
  pinned: boolean,
): Promise<void> {
  const inference = await deps.repositories.inferences.get(inferenceId);
  if (!inference) return;
  await deps.unitOfWork.run(['inferences'], 'readwrite', async (repos) => {
    await repos.inferences.put({ ...inference, pinned });
  });
}
