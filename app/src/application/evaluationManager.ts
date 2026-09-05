/**
 * EvaluationManager — 学習とは独立した評価（方針4 / 論点04）。
 *
 * 凍結した版の `test` split に対してモデルを走らせ、mAP@0.5 とクラス別 AP、
 * 全体の precision / recall を出す。**同じ版で測れば、モデル同士を比べられる。**
 *
 * 突き合わせは信頼度の高い順に貪欲で行い、IoU 0.5 以上を正解とする。
 * 1つの正解に2つの検出が当たった場合、後から来たほうは誤検出として数える。
 */
import { newId, now } from '@domain/ids';
import type {
  DatasetVersionId,
  EvaluationId,
  EvaluationMetricId,
  LabelClassId,
  ProjectId,
} from '@domain/ids';
import type { BBox, DatasetSplit, Evaluation, EvaluationMetric, Model } from '@domain/index';
import type { BlobStore } from '@ports/blobStore';
import type { DetectionParams } from '@ports/mlRuntime';
import type { Repositories, UnitOfWork } from '@ports/repository';
import { loadImageBitmap } from './imageManager';
import type { InferenceRunner } from './inferenceManager';

export interface EvaluationManagerDeps {
  readonly repositories: Repositories;
  readonly unitOfWork: UnitOfWork;
  readonly blobStore: BlobStore;
  readonly runner: InferenceRunner;
}

export const IOU_MATCH = 0.5;

function iou(a: BBox, b: BBox): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = a.w * a.h + b.w * b.h - inter;
  return union <= 0 ? 0 : inter / union;
}

interface Scored {
  readonly score: number;
  readonly truePositive: boolean;
}

/** all-point interpolation の AP。PASCAL VOC 2010 以降と同じ数え方。 */
function averagePrecision(scored: readonly Scored[], positives: number): number {
  if (positives === 0) return 0;
  const sorted = [...scored].sort((a, b) => b.score - a.score);
  let tp = 0;
  let fp = 0;
  const points: { recall: number; precision: number }[] = [];
  for (const entry of sorted) {
    if (entry.truePositive) tp += 1;
    else fp += 1;
    points.push({ recall: tp / positives, precision: tp / (tp + fp) });
  }
  let ap = 0;
  let previousRecall = 0;
  let maxPrecision = 0;
  for (let i = points.length - 1; i >= 0; i -= 1) {
    const point = points[i];
    if (!point) continue;
    maxPrecision = Math.max(maxPrecision, point.precision);
    const nextRecall = i === 0 ? 0 : (points[i - 1]?.recall ?? 0);
    ap += (point.recall - nextRecall) * maxPrecision;
  }
  void previousRecall;
  return ap;
}

export interface EvaluationResult {
  readonly evaluation: Evaluation;
  readonly metrics: EvaluationMetric[];
  readonly summary: {
    readonly mAP50: number;
    readonly precision: number;
    readonly recall: number;
    readonly images: number;
    readonly groundTruths: number;
  };
}

export async function runEvaluation(
  deps: EvaluationManagerDeps,
  params: {
    readonly projectId: ProjectId;
    readonly model: Model;
    readonly datasetVersionId: DatasetVersionId;
    readonly split?: DatasetSplit;
    readonly detection?: DetectionParams;
  },
): Promise<EvaluationResult> {
  const split = params.split ?? 'test';
  const detection = params.detection ?? {
    confThreshold: 0.05,
    iouThreshold: 0.5,
    maxDetections: 100,
  };
  const items = await deps.repositories.datasetItems.listBySplit(params.datasetVersionId, split);
  if (items.length === 0) throw new Error(`${split} split に画像がない`);

  const classes = await deps.repositories.labelClasses.listByLabelSet(params.model.label_set_id);
  const byIndex = new Map<number, LabelClassId>(
    classes.map((klass) => [klass.index, klass.label_class_id]),
  );
  const perClass = new Map<LabelClassId, { scored: Scored[]; positives: number }>();
  for (const klass of classes) {
    perClass.set(klass.label_class_id, { scored: [], positives: 0 });
  }

  let totalTp = 0;
  let totalFp = 0;
  let totalGt = 0;

  for (const item of items) {
    const image = await deps.repositories.images.get(item.image_id);
    if (!image) continue;
    const truth = await deps.repositories.annotationObjects.listByAnnotationSet(
      item.annotation_set_id,
    );
    totalGt += truth.length;
    for (const object of truth) {
      const bucket = perClass.get(object.label_class_id);
      if (bucket) bucket.positives += 1;
    }

    const bitmap = await loadImageBitmap(
      { repositories: deps.repositories, unitOfWork: deps.unitOfWork, blobStore: deps.blobStore },
      image,
    );
    const outcome = await deps.runner.infer(params.model, bitmap, detection);

    const used = new Set<string>();
    for (const predicted of [...outcome.detections].sort((a, b) => b.confidence - a.confidence)) {
      const labelClassId = byIndex.get(predicted.classIndex);
      if (!labelClassId) continue;
      const bucket = perClass.get(labelClassId);
      if (!bucket) continue;

      let best: { id: string; score: number } | null = null;
      for (const object of truth) {
        if (object.label_class_id !== labelClassId) continue;
        if (used.has(object.object_id)) continue;
        const overlap = iou(predicted.bbox, object.bbox);
        if (overlap >= IOU_MATCH && (!best || overlap > best.score)) {
          best = { id: object.object_id, score: overlap };
        }
      }
      if (best) {
        used.add(best.id);
        bucket.scored.push({ score: predicted.confidence, truePositive: true });
        totalTp += 1;
      } else {
        bucket.scored.push({ score: predicted.confidence, truePositive: false });
        totalFp += 1;
      }
    }
  }

  const evaluationId = newId<'EvaluationId'>() as EvaluationId;
  const evaluation: Evaluation = {
    evaluation_id: evaluationId,
    project_id: params.projectId,
    model_id: params.model.model_id,
    dataset_version_id: params.datasetVersionId,
    split_used: split,
    conf_threshold: detection.confThreshold,
    iou_threshold: detection.iouThreshold,
    executed_at: now(),
  };

  const metrics: EvaluationMetric[] = [];
  const aps: number[] = [];
  for (const [labelClassId, bucket] of perClass) {
    if (bucket.positives === 0 && bucket.scored.length === 0) continue;
    const ap = averagePrecision(bucket.scored, bucket.positives);
    aps.push(ap);
    metrics.push({
      metric_id: newId<'EvaluationMetricId'>() as EvaluationMetricId,
      evaluation_id: evaluationId,
      label_class_id: labelClassId,
      metric_name: 'AP50',
      value: ap,
    });
  }
  const mAP50 = aps.length > 0 ? aps.reduce((sum, ap) => sum + ap, 0) / aps.length : 0;
  const precision = totalTp + totalFp > 0 ? totalTp / (totalTp + totalFp) : 0;
  const recall = totalGt > 0 ? totalTp / totalGt : 0;

  // 全体スコアは label_class_id を null にする（01 の定義どおり）。
  for (const [name, value] of Object.entries({ mAP50, precision, recall })) {
    metrics.push({
      metric_id: newId<'EvaluationMetricId'>() as EvaluationMetricId,
      evaluation_id: evaluationId,
      label_class_id: null,
      metric_name: name,
      value,
    });
  }

  await deps.unitOfWork.run(['evaluations', 'evaluation_metrics'], 'readwrite', async (repos) => {
    await repos.evaluations.put(evaluation);
    await repos.evaluationMetrics.putMany(metrics);
  });

  return {
    evaluation,
    metrics,
    summary: { mAP50, precision, recall, images: items.length, groundTruths: totalGt },
  };
}

export async function listEvaluations(
  deps: EvaluationManagerDeps,
  modelId: Model['model_id'],
): Promise<Evaluation[]> {
  const list = await deps.repositories.evaluations.listByModel(modelId);
  return [...list].reverse();
}
