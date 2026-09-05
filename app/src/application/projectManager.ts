/**
 * ProjectManager — プロジェクトの作成・切替・削除（論点16・18）。
 *
 * プロジェクトは完全分離で、資産をまたいで参照しない（方針11）。
 * 例外は Base Model とそのクラス体系（`project_id = null`）。
 *
 * 削除は **即時削除 + 実体回収**（持ち越し事項#8 の決定）。
 * メタを1トランザクションで消し、そのあと参照が無くなった実体（画像・重み）を
 * OPFS から消す。途中で失敗しても孤児が残るだけで、起動時のGCが回収する（04 §6.2）。
 */
import { newId, now } from '@domain/ids';
import type { BlobId, ProjectId } from '@domain/ids';
import type { Project } from '@domain/index';
import type { BlobStore } from '@ports/blobStore';
import type { Repositories, UnitOfWork } from '@ports/repository';

export interface ProjectManagerDeps {
  readonly repositories: Repositories;
  readonly unitOfWork: UnitOfWork;
  readonly blobStore: BlobStore;
}

export async function listProjects(deps: ProjectManagerDeps): Promise<Project[]> {
  return deps.repositories.projects.listByUpdatedAt();
}

export async function createProject(
  deps: ProjectManagerDeps,
  name: string,
  description = '',
): Promise<Project> {
  const timestamp = now();
  const project: Project = {
    project_id: newId<'ProjectId'>() as ProjectId,
    name: name.trim() || '新しいプロジェクト',
    description,
    created_at: timestamp,
    updated_at: timestamp,
  };
  await deps.unitOfWork.run(['projects'], 'readwrite', async (repos) => {
    await repos.projects.put(project);
  });
  return project;
}

export async function renameProject(
  deps: ProjectManagerDeps,
  projectId: ProjectId,
  name: string,
): Promise<void> {
  const project = await deps.repositories.projects.get(projectId);
  if (!project) return;
  await deps.unitOfWork.run(['projects'], 'readwrite', async (repos) => {
    await repos.projects.put({ ...project, name, updated_at: now() });
  });
}


export interface DeleteResult {
  /** 消したメタのレコード件数 */
  readonly records: number;
  /** OPFS から回収した画像の実体の件数 */
  readonly images: number;
  /** OPFS から回収した重みの件数 */
  readonly artifacts: number;
}

/** プロジェクト配下の全レコードを集める。親から子へ辿るだけで、走査はしない。 */
export async function collectCascade(deps: ProjectManagerDeps, projectId: ProjectId) {
  const repos = deps.repositories;
  const flat = <T>(lists: T[][]): T[] => lists.flat();

  // 論理削除済みも消すため `by_project` から取る。
  const images = await repos.images.listByProject(projectId);
  const labelSets = await repos.labelSets.listByProject(projectId);
  const datasets = await repos.datasets.listByProject(projectId);
  const models = await repos.models.listByProject(projectId);
  const trainings = await repos.trainings.listByProject(projectId);
  const inferences = await repos.inferences.listByProject(projectId);

  const labelClasses = flat(
    await Promise.all(labelSets.map((set) => repos.labelClasses.listByLabelSet(set.label_set_id))),
  );
  const annotationSets = flat(
    await Promise.all(images.map((image) => repos.annotationSets.listByImage(image.image_id))),
  );
  const annotationObjects = flat(
    await Promise.all(
      annotationSets.map((set) => repos.annotationObjects.listByAnnotationSet(set.annotation_set_id)),
    ),
  );
  const datasetVersions = flat(
    await Promise.all(datasets.map((dataset) => repos.datasetVersions.listByDataset(dataset.dataset_id))),
  );
  const datasetMembers = flat(
    await Promise.all(datasets.map((dataset) => repos.datasetMembers.listByDataset(dataset.dataset_id))),
  );
  const datasetItems = flat(
    await Promise.all(
      datasetVersions.flatMap((version) =>
        (['train', 'val', 'test'] as const).map((split) =>
          repos.datasetItems.listBySplit(version.dataset_version_id, split),
        ),
      ),
    ),
  );
  const derivations = flat(
    await Promise.all(models.map((model) => repos.modelDerivations.listByChild(model.model_id))),
  );
  const trainingMetrics = flat(
    await Promise.all(
      trainings.map((training) => repos.trainingMetrics.listByTraining(training.training_id)),
    ),
  );
  const evaluations = flat(
    await Promise.all(models.map((model) => repos.evaluations.listByModel(model.model_id))),
  );
  const evaluationMetrics = flat(
    await Promise.all(
      evaluations.map((item) => repos.evaluationMetrics.listByEvaluation(item.evaluation_id)),
    ),
  );
  const targets = flat(
    await Promise.all(
      inferences.map((inference) => repos.inferenceTargets.listByInference(inference.inference_id)),
    ),
  );
  const detections = flat(
    await Promise.all(targets.map((target) => repos.detections.listByTarget(target.target_id))),
  );

  return {
    images,
    labelSets,
    labelClasses,
    annotationSets,
    annotationObjects,
    datasets,
    datasetVersions,
    datasetItems,
    datasetMembers,
    models,
    derivations,
    trainings,
    trainingMetrics,
    evaluations,
    evaluationMetrics,
    inferences,
    targets,
    detections,
  };
}

/**
 * プロジェクトを配下の資産ごと削除する（持ち越し事項#8）。
 *
 * 実体を消してよいのは **他から参照されていないもの**（04 §7）。
 * 画像の実体は `content_hash` で共有されうるため、他プロジェクトの `Image` が
 * 同じ内容を指していないかを確かめてから消す。
 */
export async function deleteProject(
  deps: ProjectManagerDeps,
  projectId: ProjectId,
): Promise<DeleteResult> {
  const cascade = await collectCascade(deps, projectId);
  const artifactIds = cascade.models.flatMap((model) =>
    model.artifact_id ? [model.artifact_id] : [],
  );
  const blobIds = [...new Set(cascade.images.map((image) => image.blob_id))] as BlobId[];

  await deps.unitOfWork.run(
    [
      'detections',
      'inference_targets',
      'inferences',
      'evaluation_metrics',
      'evaluations',
      'training_metrics',
      'trainings',
      'model_derivations',
      'model_artifacts',
      'models',
      'dataset_items',
      'dataset_members',
      'dataset_versions',
      'datasets',
      'annotation_objects',
      'annotation_sets',
      'label_classes',
      'label_sets',
      'images',
      'projects',
    ],
    'readwrite',
    async (tx) => {
      for (const row of cascade.detections) await tx.detections.delete(row.detection_id);
      for (const row of cascade.targets) await tx.inferenceTargets.delete(row.target_id);
      for (const row of cascade.inferences) await tx.inferences.delete(row.inference_id);
      for (const row of cascade.evaluationMetrics) await tx.evaluationMetrics.delete(row.metric_id);
      for (const row of cascade.evaluations) await tx.evaluations.delete(row.evaluation_id);
      for (const row of cascade.trainingMetrics) await tx.trainingMetrics.delete(row.metric_id);
      for (const row of cascade.trainings) await tx.trainings.delete(row.training_id);
      for (const row of cascade.derivations) await tx.modelDerivations.delete(row.derivation_id);
      for (const id of artifactIds) await tx.modelArtifacts.delete(id);
      for (const row of cascade.models) await tx.models.delete(row.model_id);
      for (const row of cascade.datasetItems) await tx.datasetItems.delete(row.item_id);
      for (const row of cascade.datasetMembers) await tx.datasetMembers.delete(row.member_id);
      for (const row of cascade.datasetVersions) await tx.datasetVersions.delete(row.dataset_version_id);
      for (const row of cascade.datasets) await tx.datasets.delete(row.dataset_id);
      for (const row of cascade.annotationObjects) await tx.annotationObjects.delete(row.object_id);
      for (const row of cascade.annotationSets) await tx.annotationSets.delete(row.annotation_set_id);
      for (const row of cascade.labelClasses) await tx.labelClasses.delete(row.label_class_id);
      for (const row of cascade.labelSets) await tx.labelSets.delete(row.label_set_id);
      for (const row of cascade.images) await tx.images.delete(row.image_id);
      await tx.projects.delete(projectId);
    },
  );

  // ここから実体の回収。メタを消したあとなので、失敗しても孤児が残るだけ。
  let removedImages = 0;
  for (const blobId of blobIds) {
    const blob = await deps.repositories.imageBlobs.get(blobId);
    if (!blob) continue;
    // **この実体を指す** 画像が残っていれば消さない（04 §7）。
    // 同じ内容でも別レコード（インポートで ID を振り直したものなど）は別の実体なので、
    // content_hash 一致だけで判定すると消せるものが消えなくなる。
    const sharing = (await deps.repositories.images.listByContentHash(blob.content_hash)).filter(
      (image) => image.blob_id === blobId,
    );
    if (sharing.length > 0) continue;
    await deps.unitOfWork.run(['image_blobs'], 'readwrite', async (tx) => {
      await tx.imageBlobs.delete(blobId);
    });
    await deps.blobStore.delete({ kind: 'image', id: blobId });
    removedImages += 1;
  }
  for (const artifactId of artifactIds) {
    await deps.blobStore.delete({ kind: 'model', id: artifactId });
  }

  const records =
    Object.values(cascade).reduce((sum, list) => sum + list.length, 0) + 1;
  return { records, images: removedImages, artifacts: artifactIds.length };
}
