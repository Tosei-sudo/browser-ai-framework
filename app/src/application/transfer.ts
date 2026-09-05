/**
 * エクスポート / インポートの共通定義（方針17）。
 *
 * エクスポート単位は **Project**。プロジェクトは完全分離なので（方針11）、
 * この単位で切り出せば系譜が閉じる。
 *
 * ファイル形式は依存ゼロで扱える独自の単一ファイル。
 *
 * ```text
 * 0      8              12                        12+n
 * | 'BAIF0001' | ヘッダ長(uint32 LE) | ヘッダ JSON(n) | 実体を連結したもの |
 * ```
 *
 * base64 を使わないのは、画像と重みで容量が 1.33 倍になり、
 * 数GBの持ち出しでメモリも厳しくなるため。
 */
import type { StoreName } from '@ports/stores';

export const MAGIC = 'BAIF0001';
export const HEADER_OFFSET = MAGIC.length + 4;

export interface BlobEntry {
  readonly kind: 'image' | 'model';
  readonly id: string;
  readonly offset: number;
  readonly length: number;
}

export interface TransferHeader {
  readonly format: 'baif';
  readonly version: 1;
  readonly exported_at: string;
  readonly project_name: string;
  readonly records: Partial<Record<StoreName, readonly Record<string, unknown>[]>>;
  readonly blobs: readonly BlobEntry[];
}

/**
 * ストアごとの ID 項目。インポート時の付け替えに使う。
 *
 * **ここに挙げていない項目は付け替えない。** Base Model とそのクラス体系は
 * カタログの `key` から決まる ID なので、別の環境でも同じ値になる（方針18）。
 * 付け替えないことで、インポート先の Base Model にそのままつながる。
 */
export const ID_FIELDS: Record<StoreName, readonly string[]> = {
  projects: ['project_id'],
  images: ['image_id', 'project_id', 'blob_id'],
  image_blobs: ['blob_id'],
  label_sets: ['label_set_id', 'project_id', 'derived_from_label_set_id'],
  label_classes: ['label_class_id', 'label_set_id'],
  annotation_sets: ['annotation_set_id', 'image_id', 'label_set_id', 'origin_target_id'],
  annotation_objects: ['object_id', 'annotation_set_id', 'label_class_id'],
  datasets: ['dataset_id', 'project_id', 'label_set_id'],
  dataset_versions: ['dataset_version_id', 'dataset_id'],
  dataset_items: ['item_id', 'dataset_version_id', 'image_id', 'annotation_set_id'],
  dataset_members: ['member_id', 'dataset_id', 'image_id'],
  models: ['model_id', 'project_id', 'label_set_id', 'artifact_id', 'created_by_training_id'],
  model_artifacts: ['artifact_id'],
  model_derivations: ['derivation_id', 'parent_model_id', 'child_model_id', 'training_id'],
  trainings: [
    'training_id',
    'project_id',
    'source_model_id',
    'dataset_version_id',
    'output_model_id',
  ],
  training_metrics: ['metric_id', 'training_id'],
  evaluations: ['evaluation_id', 'project_id', 'model_id', 'dataset_version_id'],
  evaluation_metrics: ['metric_id', 'evaluation_id', 'label_class_id'],
  inferences: ['inference_id', 'project_id', 'model_id'],
  inference_targets: ['target_id', 'inference_id', 'image_id'],
  detections: ['detection_id', 'target_id', 'label_class_id'],
};

/** ストアの主キー項目。 */
export const PRIMARY_KEY: Record<StoreName, string> = {
  projects: 'project_id',
  images: 'image_id',
  image_blobs: 'blob_id',
  label_sets: 'label_set_id',
  label_classes: 'label_class_id',
  annotation_sets: 'annotation_set_id',
  annotation_objects: 'object_id',
  datasets: 'dataset_id',
  dataset_versions: 'dataset_version_id',
  dataset_items: 'item_id',
  dataset_members: 'member_id',
  models: 'model_id',
  model_artifacts: 'artifact_id',
  model_derivations: 'derivation_id',
  trainings: 'training_id',
  training_metrics: 'metric_id',
  evaluations: 'evaluation_id',
  evaluation_metrics: 'metric_id',
  inferences: 'inference_id',
  inference_targets: 'target_id',
  detections: 'detection_id',
};
