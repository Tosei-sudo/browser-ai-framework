import type {
  DatasetVersionId,
  EvaluationId,
  EvaluationMetricId,
  IsoDateTime,
  LabelClassId,
  ModelId,
  ProjectId,
} from '../ids';
import type { DatasetSplit } from './dataset';

/** Evaluation — 学習とは独立した評価の実行（方針4 / 論点04）。 */
export interface Evaluation {
  readonly evaluation_id: EvaluationId;
  readonly project_id: ProjectId;
  readonly model_id: ModelId;
  readonly dataset_version_id: DatasetVersionId;
  readonly split_used: DatasetSplit;
  readonly conf_threshold: number;
  readonly iou_threshold: number;
  readonly executed_at: IsoDateTime;
}

/** EvaluationMetric — `label_class_id` が null のものは全体スコア。 */
export interface EvaluationMetric {
  readonly metric_id: EvaluationMetricId;
  readonly evaluation_id: EvaluationId;
  readonly label_class_id: LabelClassId | null;
  readonly metric_name: string;
  readonly value: number;
}
