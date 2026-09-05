/**
 * Repository — エンティティの永続化（03 §5）。
 *
 * Application Layer はこのインターフェースにのみ依存し、
 * IndexedDB などの実装は起動時に注入する（依存性逆転）。
 *
 * 実体（画像・重み）は `BlobStore` が扱う。メタと実体は別の寿命で管理すると
 * 決めたため（方針6・16）、同じ抽象では扱わない。
 */
import type {
  AnnotationObject,
  AnnotationSet,
  Dataset,
  DatasetItem,
  DatasetSplit,
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
import type {
  AnnotationObjectId,
  AnnotationSetId,
  ArtifactId,
  BlobId,
  ContentHash,
  DatasetId,
  DatasetItemId,
  DatasetVersionId,
  DerivationId,
  DetectionId,
  EvaluationId,
  EvaluationMetricId,
  ImageId,
  InferenceId,
  InferenceTargetId,
  LabelClassId,
  LabelSetId,
  ModelId,
  ProjectId,
  TrainingId,
  TrainingMetricId,
} from '@domain/ids';
import type { StoreName } from './stores';

/** すべての Repository が持つ基本操作。`TId` はエンティティのブランド型 ID。 */
export interface Repository<TEntity, TId extends string> {
  get(id: TId): Promise<TEntity | undefined>;
  getMany(ids: readonly TId[]): Promise<TEntity[]>;
  put(entity: TEntity): Promise<void>;
  putMany(entities: readonly TEntity[]): Promise<void>;
  delete(id: TId): Promise<void>;
  count(): Promise<number>;
}

export interface ProjectRepository extends Repository<Project, ProjectId> {
  /** `by_updated_at`。更新の新しい順 */
  listByUpdatedAt(): Promise<Project[]>;
}

export interface ImageRepository extends Repository<Image, ImageId> {
  /** `[project_id, deleted_at]`。削除済みを除いた一覧 */
  listAlive(projectId: ProjectId): Promise<Image[]>;
  /** `by_content_hash`。重複排除に使う（方針16） */
  findByContentHash(projectId: ProjectId, hash: ContentHash): Promise<Image | undefined>;
}

export interface ImageBlobRepository extends Repository<ImageBlob, BlobId> {
  /** `by_content_hash`。同一内容の実体を共有する */
  findByContentHash(hash: ContentHash): Promise<ImageBlob | undefined>;
}

export interface LabelSetRepository extends Repository<LabelSet, LabelSetId> {
  listByProject(projectId: ProjectId): Promise<LabelSet[]>;
}

export interface LabelClassRepository extends Repository<LabelClass, LabelClassId> {
  /** `by_label_set`。index 昇順で返す */
  listByLabelSet(labelSetId: LabelSetId): Promise<LabelClass[]>;
  /** `[label_set_id, index]`。モデル出力の index からの逆引き */
  findByIndex(labelSetId: LabelSetId, index: number): Promise<LabelClass | undefined>;
}

export interface AnnotationSetRepository extends Repository<AnnotationSet, AnnotationSetId> {
  /** `[image_id, revision_no]` の降順先頭1件 */
  findLatestByImage(imageId: ImageId): Promise<AnnotationSet | undefined>;
  listByImage(imageId: ImageId): Promise<AnnotationSet[]>;
  /** `by_origin_target`。推論由来の由来探索（方針12） */
  listByOriginTarget(targetId: InferenceTargetId): Promise<AnnotationSet[]>;
}

export interface AnnotationObjectRepository
  extends Repository<AnnotationObject, AnnotationObjectId> {
  listByAnnotationSet(annotationSetId: AnnotationSetId): Promise<AnnotationObject[]>;
  /** `by_label_class`。クラス削除時の影響調査 */
  countByLabelClass(labelClassId: LabelClassId): Promise<number>;
}

export interface DatasetRepository extends Repository<Dataset, DatasetId> {
  listByProject(projectId: ProjectId): Promise<Dataset[]>;
}

export interface DatasetVersionRepository extends Repository<DatasetVersion, DatasetVersionId> {
  /** `[dataset_id, version_no]` */
  listByDataset(datasetId: DatasetId): Promise<DatasetVersion[]>;
  findLatestByDataset(datasetId: DatasetId): Promise<DatasetVersion | undefined>;
}

export interface DatasetItemRepository extends Repository<DatasetItem, DatasetItemId> {
  /** `[dataset_version_id, split]`。学習時の train / val / test 取り出し */
  listBySplit(versionId: DatasetVersionId, split: DatasetSplit): Promise<DatasetItem[]>;
  /** `by_image`。実体を物理削除してよいかの判定（04 §7） */
  countByImage(imageId: ImageId): Promise<number>;
  /** `by_annotation_set`。アノテーション版の参照有無 */
  countByAnnotationSet(annotationSetId: AnnotationSetId): Promise<number>;
}

export interface ModelRepository extends Repository<Model, ModelId> {
  /** `by_project`。Base Model は project_id が null のため引けない（04 §4.4） */
  listByProject(projectId: ProjectId): Promise<Model[]>;
  /** `by_origin`。Base Model の抽出（方針18） */
  listBuiltin(): Promise<Model[]>;
  listByLabelSet(labelSetId: LabelSetId): Promise<Model[]>;
  /** `by_artifact_status`。重み破棄候補の抽出（方針6） */
  listWithArtifact(): Promise<Model[]>;
}

export interface ModelArtifactRepository extends Repository<ModelArtifact, ArtifactId> {
  /** `by_checksum`。同一重みの共有・孤児検出 */
  findByChecksum(checksum: ContentHash): Promise<ModelArtifact | undefined>;
  /** 起動時の孤児GC（04 §6.2）で OPFS のファイル一覧と突き合わせる */
  listAllIds(): Promise<ArtifactId[]>;
}

export interface ModelDerivationRepository extends Repository<ModelDerivation, DerivationId> {
  /** `by_child_model`。系譜の遡上の中心（`order.txt` §4） */
  listByChild(modelId: ModelId): Promise<ModelDerivation[]>;
  listByParent(modelId: ModelId): Promise<ModelDerivation[]>;
  listByTraining(trainingId: TrainingId): Promise<ModelDerivation[]>;
}

export interface TrainingRepository extends Repository<Training, TrainingId> {
  listByProject(projectId: ProjectId): Promise<Training[]>;
  /** `by_status`。起動時の中断回収（論点21） */
  listByStatus(status: Training['status']): Promise<Training[]>;
  listBySourceModel(modelId: ModelId): Promise<Training[]>;
  listByDatasetVersion(versionId: DatasetVersionId): Promise<Training[]>;
}

export interface TrainingMetricRepository extends Repository<TrainingMetric, TrainingMetricId> {
  /** `[training_id, epoch]`。学習曲線の再描画 */
  listByTraining(trainingId: TrainingId): Promise<TrainingMetric[]>;
}

export interface EvaluationRepository extends Repository<Evaluation, EvaluationId> {
  listByModel(modelId: ModelId): Promise<Evaluation[]>;
  listByDatasetVersion(versionId: DatasetVersionId): Promise<Evaluation[]>;
}

export interface EvaluationMetricRepository
  extends Repository<EvaluationMetric, EvaluationMetricId> {
  listByEvaluation(evaluationId: EvaluationId): Promise<EvaluationMetric[]>;
}

export interface InferenceRepository extends Repository<Inference, InferenceId> {
  /** `[project_id, executed_at]`。履歴一覧（新しい順） */
  listByProject(projectId: ProjectId, limit?: number): Promise<Inference[]>;
  /**
   * `[project_id, pinned, executed_at]`。pinned でないものを古い順に返す。
   * `RetentionService` の削除対象抽出に使う（方針14）。
   */
  listUnpinnedOldestFirst(projectId: ProjectId, limit: number): Promise<Inference[]>;
  listByModel(modelId: ModelId): Promise<Inference[]>;
  countByProject(projectId: ProjectId): Promise<number>;
}

export interface InferenceTargetRepository extends Repository<InferenceTarget, InferenceTargetId> {
  listByInference(inferenceId: InferenceId): Promise<InferenceTarget[]>;
  /** `by_image`。画像の参照有無の判定（04 §7） */
  countByImage(imageId: ImageId): Promise<number>;
}

export interface DetectionRepository extends Repository<Detection, DetectionId> {
  listByTarget(targetId: InferenceTargetId): Promise<Detection[]>;
  /** `by_label_class`。クラス削除時の影響調査 */
  countByLabelClass(labelClassId: LabelClassId): Promise<number>;
}

/** 全 Repository の集合。トランザクションの内でも外でも同じ形で使う。 */
export interface Repositories {
  readonly projects: ProjectRepository;
  readonly images: ImageRepository;
  readonly imageBlobs: ImageBlobRepository;
  readonly labelSets: LabelSetRepository;
  readonly labelClasses: LabelClassRepository;
  readonly annotationSets: AnnotationSetRepository;
  readonly annotationObjects: AnnotationObjectRepository;
  readonly datasets: DatasetRepository;
  readonly datasetVersions: DatasetVersionRepository;
  readonly datasetItems: DatasetItemRepository;
  readonly models: ModelRepository;
  readonly modelArtifacts: ModelArtifactRepository;
  readonly modelDerivations: ModelDerivationRepository;
  readonly trainings: TrainingRepository;
  readonly trainingMetrics: TrainingMetricRepository;
  readonly evaluations: EvaluationRepository;
  readonly evaluationMetrics: EvaluationMetricRepository;
  readonly inferences: InferenceRepository;
  readonly inferenceTargets: InferenceTargetRepository;
  readonly detections: DetectionRepository;
}

/**
 * 複数ストアをまたぐ書き込みの境界（04 §6.3）。
 *
 * 学習の完了・アノテーションの版確定・データセット版の凍結・推論の記録は、
 * それぞれ単一トランザクションでコミットする必要がある。
 * 実体は先に書き、メタを後からここでコミットする（論点27）。
 */
export interface UnitOfWork {
  run<T>(
    stores: readonly StoreName[],
    mode: 'readonly' | 'readwrite',
    fn: (repos: Repositories) => Promise<T>,
  ): Promise<T>;
}
