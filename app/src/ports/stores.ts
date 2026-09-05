/**
 * 永続化するストアの名前（04 §4 の21ストア）。
 *
 * トランザクション境界（04 §6.3）はこの名前の集合で指定する。
 */
export const STORE_NAMES = [
  'projects',
  'images',
  'image_blobs',
  'label_sets',
  'label_classes',
  'annotation_sets',
  'annotation_objects',
  'datasets',
  'dataset_versions',
  'dataset_items',
  'dataset_members',
  'models',
  'model_artifacts',
  'model_derivations',
  'trainings',
  'training_metrics',
  'evaluations',
  'evaluation_metrics',
  'inferences',
  'inference_targets',
  'detections',
] as const;

export type StoreName = (typeof STORE_NAMES)[number];
