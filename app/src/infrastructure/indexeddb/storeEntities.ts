/**
 * ストア名とエンティティ型の対応。
 *
 * これがあると `listByIndex(provider, 'images', ...)` の戻り値が `Image[]` に
 * 決まり、呼び出しごとに型引数を書かずに済む。ストアとエンティティの
 * 対応表そのものでもある（04 §4）。
 */
import type {
  AnnotationObject,
  AnnotationSet,
  Dataset,
  DatasetItem,
  DatasetVersion,
  Detection,
  Evaluation,
  EvaluationMetric,
  Image,
  ImageBlob,
  Inference,
  InferenceTarget,
  LabelClass,
  LabelSet,
  Model,
  ModelArtifact,
  ModelDerivation,
  Project,
  Training,
  TrainingMetric,
} from '@domain/index';

export interface StoreEntityMap {
  projects: Project;
  images: Image;
  image_blobs: ImageBlob;
  label_sets: LabelSet;
  label_classes: LabelClass;
  annotation_sets: AnnotationSet;
  annotation_objects: AnnotationObject;
  datasets: Dataset;
  dataset_versions: DatasetVersion;
  dataset_items: DatasetItem;
  models: Model;
  model_artifacts: ModelArtifact;
  model_derivations: ModelDerivation;
  trainings: Training;
  training_metrics: TrainingMetric;
  evaluations: Evaluation;
  evaluation_metrics: EvaluationMetric;
  inferences: Inference;
  inference_targets: InferenceTarget;
  detections: Detection;
}
