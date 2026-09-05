/**
 * TrainingManager — 学習の開始・進捗・結果の確定（方針3・7・13）。
 *
 * 学習が参照するのは**凍結した `DatasetVersion`**（方針2）。
 * 生まれたモデルは `ModelDerivation` で親（バックボーン）とつながり、
 * 系譜として辿れる（方針7）。
 *
 * **失敗・中断した学習も記録として残す**（方針13）。`status` だけを確定させ、
 * レコードは消さない。何を試して駄目だったかが残らないと、同じことを繰り返す。
 */
import { newId, now, sha256Hex } from '@domain/ids';
import type {
  ArtifactId,
  DatasetVersionId,
  DerivationId,
  LabelClassId,
  ModelId,
  ProjectId,
  TrainingId,
  TrainingMetricId,
} from '@domain/ids';
import type {
  Hyperparameters,
  LabelMapping,
  Model,
  ModelArtifact,
  ModelDerivation,
  RuntimeInfo,
  Training,
  TrainingMetric,
} from '@domain/index';
import { assertDerivationValid, assertModelArtifactConsistency } from '@domain/invariants';
import type { BlobStore } from '@ports/blobStore';
import type { Repositories, UnitOfWork } from '@ports/repository';

/** Worker への依頼。Infrastructure が実装する（03 §5 の `TrainingEngine`）。 */
export interface TrainingRunner {
  train(params: {
    readonly backbone: Model;
    readonly samples: readonly {
      readonly blobId: string;
      readonly mimeType: string;
      readonly boxes: readonly {
        readonly x: number;
        readonly y: number;
        readonly w: number;
        readonly h: number;
        readonly cls: number;
      }[];
    }[];
    readonly config: { readonly epochs: number; readonly lr: number; readonly numClasses: number };
    readonly onProgress: (epoch: number, metrics: Readonly<Record<string, number>>) => void;
  }): Promise<{
    readonly weights: ArrayBuffer;
    readonly finalMetrics: Readonly<Record<string, number>>;
    readonly backend: string;
    readonly elapsedMs: number;
  }>;
  cancel(): void;
}

export interface TrainingManagerDeps {
  readonly repositories: Repositories;
  readonly unitOfWork: UnitOfWork;
  readonly blobStore: BlobStore;
  readonly runner: TrainingRunner;
}

export const DEFAULT_HYPERPARAMETERS: Hyperparameters = {
  epochs: 20,
  lr: 1e-3,
  batch_size: 1,
  // バックボーンは凍結する（方針3）。R1 で成立を確認した構成。
  frozen_layers: 'backbone',
};

export interface TrainingProgressEvent {
  readonly epoch: number;
  readonly metrics: Readonly<Record<string, number>>;
}

export async function listTrainings(
  deps: TrainingManagerDeps,
  projectId: ProjectId,
): Promise<Training[]> {
  const list = await deps.repositories.trainings.listByProject(projectId);
  return [...list].reverse();
}

/**
 * 学習を実行する。
 *
 * 手順は次のとおりで、**記録は先に作る**。途中で落ちても「走った跡」が残る（方針13）。
 *  1. `Training` を `running` で保存
 *  2. 教師データ（凍結済みの版）を組み立てる
 *  3. Worker で学習する
 *  4. 重みを OPFS に書き、メタを1トランザクションでコミット（論点27）
 */
/**
 * 複数タブでの同時学習を止める（03 §4 / 持ち越し事項#9）。
 *
 * 同じ重みを2つのタブで同時に扱うとメモリが倍要り、書き込みも競合する。
 * Web Locks で「取れなければ即座に諦める」形にする。待たせない。
 */
const TRAINING_LOCK = 'browser-ai-framework/training';

async function withTrainingLock<T>(task: () => Promise<T>): Promise<T> {
  if (!('locks' in navigator)) return task();
  const result = await navigator.locks.request(
    TRAINING_LOCK,
    { ifAvailable: true },
    async (lock) => {
      if (!lock) return { acquired: false as const };
      return { acquired: true as const, value: await task() };
    },
  );
  if (!result.acquired) {
    throw new Error('他のタブで学習中。終わってから実行すること');
  }
  return result.value;
}

export async function runTraining(
  deps: TrainingManagerDeps,
  params: {
    readonly projectId: ProjectId;
    readonly backbone: Model;
    readonly datasetVersionId: DatasetVersionId;
    readonly labelSetId: Model['label_set_id'];
    readonly name: string;
    readonly hyperparameters?: Partial<Hyperparameters>;
    readonly onProgress?: (event: TrainingProgressEvent) => void;
  },
): Promise<{ readonly training: Training; readonly model: Model | null }> {
  const hyperparameters: Hyperparameters = {
    ...DEFAULT_HYPERPARAMETERS,
    ...params.hyperparameters,
  };
  const classes = await deps.repositories.labelClasses.listByLabelSet(params.labelSetId);
  const classIndex = new Map<LabelClassId, number>(
    classes.map((klass) => [klass.label_class_id, klass.index]),
  );
  const labelMapping: LabelMapping = Object.fromEntries(
    classes.map((klass) => [klass.index, klass.label_class_id]),
  );

  const runtimeInfo: RuntimeInfo = { backend: 'unknown', user_agent: navigator.userAgent };
  const trainingId = newId<'TrainingId'>() as TrainingId;
  let training: Training = {
    training_id: trainingId,
    project_id: params.projectId,
    source_model_id: params.backbone.model_id,
    dataset_version_id: params.datasetVersionId,
    output_model_id: null,
    label_mapping: labelMapping,
    hyperparameters,
    augmentation: {},
    status: 'running',
    started_at: now(),
    ended_at: null,
    final_metrics: null,
    error_message: null,
    runtime_info: runtimeInfo,
  };
  await deps.unitOfWork.run(['trainings'], 'readwrite', async (repos) => {
    await repos.trainings.put(training);
  });

  try {
    return await withTrainingLock(async () => {
    const samples = await buildSamples(deps, params.datasetVersionId, classIndex);
    if (samples.length === 0) {
      throw new Error('教師データが空。確定済みのアノテーションがある画像を入れること');
    }

    const metricRows: TrainingMetric[] = [];
    const outcome = await deps.runner.train({
      backbone: params.backbone,
      samples,
      config: {
        epochs: hyperparameters.epochs,
        lr: hyperparameters.lr,
        numClasses: classes.length,
      },
      onProgress: (epoch, metrics) => {
        for (const [name, value] of Object.entries(metrics)) {
          metricRows.push({
            metric_id: newId<'TrainingMetricId'>() as TrainingMetricId,
            training_id: trainingId,
            epoch,
            metric_name: name,
            value,
            logged_at: now(),
          });
        }
        params.onProgress?.({ epoch, metrics });
      },
    });

    const model = await commitResult(deps, {
      training,
      backbone: params.backbone,
      labelSetId: params.labelSetId,
      name: params.name,
      weights: outcome.weights,
      finalMetrics: outcome.finalMetrics,
      backend: outcome.backend,
      metricRows,
    });
    training = {
      ...training,
      status: 'completed',
      ended_at: now(),
      output_model_id: model.model_id,
      final_metrics: outcome.finalMetrics,
      runtime_info: { ...runtimeInfo, backend: outcome.backend },
    };
    return { training, model };
    });
  } catch (error) {
    // 失敗・中断も記録として残す（方針13）。
    const message = error instanceof Error ? error.message : String(error);
    training = {
      ...training,
      status: message.includes('中断') ? 'cancelled' : 'failed',
      ended_at: now(),
      error_message: message,
    };
    await deps.unitOfWork.run(['trainings'], 'readwrite', async (repos) => {
      await repos.trainings.put(training);
    });
    return { training, model: null };
  }
}

/** 凍結した版から教師データを組み立てる（方針2）。 */
async function buildSamples(
  deps: TrainingManagerDeps,
  versionId: DatasetVersionId,
  classIndex: ReadonlyMap<LabelClassId, number>,
): Promise<
  {
    blobId: string;
    mimeType: string;
    boxes: { x: number; y: number; w: number; h: number; cls: number }[];
  }[]
> {
  const items = [
    ...(await deps.repositories.datasetItems.listBySplit(versionId, 'train')),
    ...(await deps.repositories.datasetItems.listBySplit(versionId, 'val')),
  ];
  const samples = [];
  for (const item of items) {
    const image = await deps.repositories.images.get(item.image_id);
    if (!image) continue;
    const blob = await deps.repositories.imageBlobs.get(image.blob_id);
    const objects = await deps.repositories.annotationObjects.listByAnnotationSet(
      item.annotation_set_id,
    );
    const boxes = objects.flatMap((object) => {
      const cls = classIndex.get(object.label_class_id);
      // 別のクラス体系の矩形は落とす。index が対応しないため学習に使えない。
      if (cls === undefined) return [];
      return [{ x: object.bbox.x, y: object.bbox.y, w: object.bbox.w, h: object.bbox.h, cls }];
    });
    samples.push({
      blobId: image.blob_id,
      mimeType: blob?.mime_type ?? 'image/png',
      boxes,
    });
  }
  return samples;
}

/**
 * 学習の結果を確定させる。
 *
 * **実体（OPFS）→ メタ（IndexedDB）の順**（論点27）。メタは
 * `ModelArtifact` / `Model` / `ModelDerivation` / `Training` / `TrainingMetric` を
 * 単一トランザクションでコミットする（04 §6.3）。
 */
async function commitResult(
  deps: TrainingManagerDeps,
  params: {
    readonly training: Training;
    readonly backbone: Model;
    readonly labelSetId: Model['label_set_id'];
    readonly name: string;
    readonly weights: ArrayBuffer;
    readonly finalMetrics: Readonly<Record<string, number>>;
    readonly backend: string;
    readonly metricRows: readonly TrainingMetric[];
  },
): Promise<Model> {
  const artifactId = newId<'ArtifactId'>() as ArtifactId;
  await deps.blobStore.put({ kind: 'model', id: artifactId }, params.weights);

  const artifact: ModelArtifact = {
    artifact_id: artifactId,
    // 学習したヘッドの形式。バックボーンは持たず、系譜の親から辿る（論点32）。
    format: 'baif_yolo_head_v1',
    byte_size: params.weights.byteLength,
    checksum: await sha256Hex(params.weights),
    stored_at: now(),
  };
  const modelId = newId<'ModelId'>() as ModelId;
  const model: Model = {
    model_id: modelId,
    project_id: params.training.project_id,
    name: params.name.trim() || `学習モデル ${new Date().toLocaleString('ja-JP')}`,
    origin: 'user_trained',
    task_type: 'object_detection',
    label_set_id: params.labelSetId,
    // 前処理はバックボーンと同じでなければならない。特徴量の形が変わる。
    input_spec: params.backbone.input_spec,
    artifact_id: artifactId,
    artifact_status: 'present',
    created_by_training_id: params.training.training_id,
    created_at: now(),
  };
  assertModelArtifactConsistency(model);

  const derivation: ModelDerivation = {
    derivation_id: newId<'DerivationId'>() as DerivationId,
    parent_model_id: params.backbone.model_id,
    child_model_id: modelId,
    kind: 'transfer_learning',
    training_id: params.training.training_id,
    created_at: now(),
  };
  assertDerivationValid(derivation);

  const finished: Training = {
    ...params.training,
    status: 'completed',
    ended_at: now(),
    output_model_id: modelId,
    final_metrics: params.finalMetrics,
    runtime_info: { ...params.training.runtime_info, backend: params.backend },
  };

  await deps.unitOfWork.run(
    ['model_artifacts', 'models', 'model_derivations', 'trainings', 'training_metrics'],
    'readwrite',
    async (repos) => {
      await repos.modelArtifacts.put(artifact);
      await repos.models.put(model);
      await repos.modelDerivations.put(derivation);
      await repos.trainings.put(finished);
      await repos.trainingMetrics.putMany(params.metricRows);
    },
  );
  return model;
}

/** 学習曲線（方針3）。エポックごとの指標をそのまま返す。 */
export async function loadCurve(
  deps: TrainingManagerDeps,
  trainingId: TrainingId,
): Promise<TrainingMetric[]> {
  return deps.repositories.trainingMetrics.listByTraining(trainingId);
}

/** 系譜をさかのぼる（方針7）。UI の表示に使う。 */
export async function loadLineage(
  deps: TrainingManagerDeps,
  modelId: ModelId,
): Promise<{ readonly model: Model; readonly kind: ModelDerivation['kind'] | null }[]> {
  const chain: { model: Model; kind: ModelDerivation['kind'] | null }[] = [];
  let currentId: ModelId | undefined = modelId;
  let kind: ModelDerivation['kind'] | null = null;
  const seen = new Set<string>();

  while (currentId && !seen.has(currentId)) {
    seen.add(currentId);
    const model: Model | undefined = await deps.repositories.models.get(currentId);
    if (!model) break;
    chain.push({ model, kind });
    const derivations = await deps.repositories.modelDerivations.listByChild(currentId);
    const parent = derivations[0];
    kind = parent?.kind ?? null;
    currentId = parent?.parent_model_id;
  }
  return chain;
}
