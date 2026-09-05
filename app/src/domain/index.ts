/**
 * Domain Layer — エンティティ・不変条件・系譜のルール（03 §4）。
 *
 * この層は UI にもストレージにも依存しない。
 * ERモデル（docs/design/01-conceptual-er-model.md）の20エンティティに対応する。
 */
export * from './ids';
export * from './errors';
export * from './invariants';

export type { Project } from './entities/project';
export type { Image, ImageBlob, ImageSource } from './entities/image';
export type { LabelSet, LabelClass } from './entities/label';
export type {
  AnnotationSet,
  AnnotationObject,
  AnnotationSetStatus,
  AnnotationSource,
  BBox,
  BBoxFormat,
} from './entities/annotation';
export type {
  Dataset,
  DatasetVersion,
  DatasetItem,
  DatasetSplit,
  SplitPolicy,
} from './entities/dataset';
export type { DatasetMember } from './entities/datasetMember';
export type {
  Model,
  ModelArtifact,
  ModelDerivation,
  ModelOrigin,
  ModelFormat,
  DerivationKind,
  ArtifactStatus,
  InputSpec,
  TaskType,
} from './entities/model';
export type {
  Training,
  TrainingMetric,
  TrainingStatus,
  Hyperparameters,
  LabelMapping,
  RuntimeInfo,
} from './entities/training';
export type { Evaluation, EvaluationMetric } from './entities/evaluation';
export type {
  Inference,
  InferenceTarget,
  InferenceTargetStatus,
  Detection,
} from './entities/inference';
