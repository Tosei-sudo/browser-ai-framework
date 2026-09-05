/**
 * Port の `Repositories` を IndexedDB で実装する（04 §4）。
 *
 * クエリはすべて 04 で定義したインデックスに対応する。
 * インデックスの無い走査を書かないこと（件数が増えたときに効かなくなる）。
 */
import type { Image, Inference, Training } from '@domain/index';
import type { Repositories } from '@ports/repository';
import { NOT_DELETED, imageFromRecord, imageToRecord, inferenceFromRecord, inferenceToRecord } from './mappers';
import {
  countByIndex,
  createBaseRepository,
  findByIndex,
  identityCodec,
  listByIndex,
  type Codec,
} from './baseRepository';
import { take, type StoreProvider } from './support';

const imageCodec: Codec<Image> = {
  encode: (image) => imageToRecord(image),
  decode: (record) => imageFromRecord(record as ReturnType<typeof imageToRecord>),
};

const inferenceCodec: Codec<Inference> = {
  encode: (inference) => inferenceToRecord(inference),
  decode: (record) => inferenceFromRecord(record as ReturnType<typeof inferenceToRecord>),
};

/** 数値の複合キーの範囲。`[id, 最小]` 〜 `[id, 最大]` を作る。 */
function numericRange(prefix: string): IDBKeyRange {
  return IDBKeyRange.bound([prefix, 0], [prefix, Number.MAX_SAFE_INTEGER]);
}

export function createRepositories(provider: StoreProvider): Repositories {
  return {
    projects: {
      ...createBaseRepository(provider, 'projects', identityCodec()),
      async listByUpdatedAt() {
        const projects = await listByIndex(provider, 'projects', 'by_updated_at', identityCodec());
        return projects.reverse();
      },
    },

    images: {
      ...createBaseRepository(provider, 'images', imageCodec),
      listAlive(projectId) {
        return listByIndex(provider, 'images', 'by_project_deleted', imageCodec, [
          projectId,
          NOT_DELETED,
        ]);
      },
      listByProject(projectId) {
        return listByIndex(provider, 'images', 'by_project', imageCodec, projectId);
      },
      listByContentHash(hash) {
        return listByIndex(provider, 'images', 'by_content_hash', imageCodec, hash);
      },
      async findByContentHash(projectId, hash) {
        const images = await listByIndex(provider, 'images', 'by_content_hash', imageCodec, hash);
        // 重複排除はプロジェクト内で行う。プロジェクト間の参照は許さない（方針11）。
        return images.find((image) => image.project_id === projectId && image.deleted_at === null);
      },
    },

    imageBlobs: {
      ...createBaseRepository(provider, 'image_blobs', identityCodec()),
      findByContentHash(hash) {
        return findByIndex(provider, 'image_blobs', 'by_content_hash', identityCodec(), hash);
      },
    },

    labelSets: {
      ...createBaseRepository(provider, 'label_sets', identityCodec()),
      listByProject(projectId) {
        return listByIndex(provider, 'label_sets', 'by_project', identityCodec(), projectId);
      },
    },

    labelClasses: {
      ...createBaseRepository(provider, 'label_classes', identityCodec()),
      async listByLabelSet(labelSetId) {
        const classes = await listByIndex(
          provider,
          'label_classes',
          'by_label_set_index',
          identityCodec<import('@domain/index').LabelClass>(),
          numericRange(labelSetId),
        );
        return classes;
      },
      findByIndex(labelSetId, index) {
        return findByIndex(provider, 'label_classes', 'by_label_set_index', identityCodec(), [
          labelSetId,
          index,
        ]);
      },
    },

    annotationSets: {
      ...createBaseRepository(provider, 'annotation_sets', identityCodec()),
      async findLatestByImage(imageId) {
        // `[image_id, revision_no]` の降順先頭1件（04 §4.2）。
        const store = provider('annotation_sets', 'readonly').index('by_image_revision');
        const [latest] = await take<import('@domain/index').AnnotationSet>(
          store,
          numericRange(imageId),
          'prev',
          1,
        );
        return latest;
      },
      listByImage(imageId) {
        return listByIndex(
          provider,
          'annotation_sets',
          'by_image_revision',
          identityCodec(),
          numericRange(imageId),
        );
      },
      listByOriginTarget(targetId) {
        return listByIndex(
          provider,
          'annotation_sets',
          'by_origin_target',
          identityCodec(),
          targetId,
        );
      },
    },

    annotationObjects: {
      ...createBaseRepository(provider, 'annotation_objects', identityCodec()),
      listByAnnotationSet(annotationSetId) {
        return listByIndex(
          provider,
          'annotation_objects',
          'by_annotation_set',
          identityCodec(),
          annotationSetId,
        );
      },
      countByLabelClass(labelClassId) {
        return countByIndex(provider, 'annotation_objects', 'by_label_class', labelClassId);
      },
    },

    datasets: {
      ...createBaseRepository(provider, 'datasets', identityCodec()),
      listByProject(projectId) {
        return listByIndex(provider, 'datasets', 'by_project', identityCodec(), projectId);
      },
    },

    datasetVersions: {
      ...createBaseRepository(provider, 'dataset_versions', identityCodec()),
      listByDataset(datasetId) {
        return listByIndex(
          provider,
          'dataset_versions',
          'by_dataset_version_no',
          identityCodec(),
          numericRange(datasetId),
        );
      },
      async findLatestByDataset(datasetId) {
        const index = provider('dataset_versions', 'readonly').index('by_dataset_version_no');
        const [latest] = await take<import('@domain/index').DatasetVersion>(
          index,
          numericRange(datasetId),
          'prev',
          1,
        );
        return latest;
      },
    },

    datasetItems: {
      ...createBaseRepository(provider, 'dataset_items', identityCodec()),
      listBySplit(versionId, split) {
        return listByIndex(provider, 'dataset_items', 'by_version_split', identityCodec(), [
          versionId,
          split,
        ]);
      },
      countByImage(imageId) {
        return countByIndex(provider, 'dataset_items', 'by_image', imageId);
      },
      countByAnnotationSet(annotationSetId) {
        return countByIndex(provider, 'dataset_items', 'by_annotation_set', annotationSetId);
      },
    },

    datasetMembers: {
      ...createBaseRepository(provider, 'dataset_members', identityCodec()),
      listByDataset(datasetId) {
        return listByIndex(provider, 'dataset_members', 'by_dataset', identityCodec(), datasetId);
      },
      findByImage(datasetId, imageId) {
        return findByIndex(provider, 'dataset_members', 'by_dataset_image', identityCodec(), [
          datasetId,
          imageId,
        ]);
      },
      countByImage(imageId) {
        return countByIndex(provider, 'dataset_members', 'by_image', imageId);
      },
    },

    models: {
      ...createBaseRepository(provider, 'models', identityCodec()),
      listByProject(projectId) {
        return listByIndex(provider, 'models', 'by_project', identityCodec(), projectId);
      },
      listBuiltin() {
        // Base Model は project_id が null で by_project に載らないため、
        // origin から取る（04 §4.4）。
        return listByIndex(provider, 'models', 'by_origin', identityCodec(), 'builtin');
      },
      listByLabelSet(labelSetId) {
        return listByIndex(provider, 'models', 'by_label_set', identityCodec(), labelSetId);
      },
      listWithArtifact() {
        return listByIndex(provider, 'models', 'by_artifact_status', identityCodec(), 'present');
      },
    },

    modelArtifacts: {
      ...createBaseRepository(provider, 'model_artifacts', identityCodec()),
      findByChecksum(checksum) {
        return findByIndex(provider, 'model_artifacts', 'by_checksum', identityCodec(), checksum);
      },
      async listAllIds() {
        const keys = await new Promise<IDBValidKey[]>((resolve, reject) => {
          const request = provider('model_artifacts', 'readonly').getAllKeys();
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error ?? new Error('キーの取得に失敗した'));
        });
        return keys as import('@domain/ids').ArtifactId[];
      },
    },

    modelDerivations: {
      ...createBaseRepository(provider, 'model_derivations', identityCodec()),
      listByChild(modelId) {
        return listByIndex(
          provider,
          'model_derivations',
          'by_child_model',
          identityCodec(),
          modelId,
        );
      },
      listByParent(modelId) {
        return listByIndex(
          provider,
          'model_derivations',
          'by_parent_model',
          identityCodec(),
          modelId,
        );
      },
      listByTraining(trainingId) {
        return listByIndex(provider, 'model_derivations', 'by_training', identityCodec(), trainingId);
      },
    },

    trainings: {
      ...createBaseRepository(provider, 'trainings', identityCodec()),
      listByProject(projectId) {
        return listByIndex(provider, 'trainings', 'by_project', identityCodec(), projectId);
      },
      listByStatus(status: Training['status']) {
        // 起動時の中断回収（論点21）で status='running' を拾う。
        return listByIndex(provider, 'trainings', 'by_status', identityCodec(), status);
      },
      listBySourceModel(modelId) {
        return listByIndex(provider, 'trainings', 'by_source_model', identityCodec(), modelId);
      },
      listByDatasetVersion(versionId) {
        return listByIndex(provider, 'trainings', 'by_dataset_version', identityCodec(), versionId);
      },
    },

    trainingMetrics: {
      ...createBaseRepository(provider, 'training_metrics', identityCodec()),
      listByTraining(trainingId) {
        return listByIndex(
          provider,
          'training_metrics',
          'by_training_epoch',
          identityCodec(),
          numericRange(trainingId),
        );
      },
    },

    evaluations: {
      ...createBaseRepository(provider, 'evaluations', identityCodec()),
      listByModel(modelId) {
        return listByIndex(provider, 'evaluations', 'by_model', identityCodec(), modelId);
      },
      listByDatasetVersion(versionId) {
        return listByIndex(provider, 'evaluations', 'by_dataset_version', identityCodec(), versionId);
      },
    },

    evaluationMetrics: {
      ...createBaseRepository(provider, 'evaluation_metrics', identityCodec()),
      listByEvaluation(evaluationId) {
        return listByIndex(
          provider,
          'evaluation_metrics',
          'by_evaluation',
          identityCodec(),
          evaluationId,
        );
      },
    },

    inferences: {
      ...createBaseRepository(provider, 'inferences', inferenceCodec),
      async listByProject(projectId, limit) {
        // `[project_id, executed_at]` の降順（新しい順）。
        const index = provider('inferences', 'readonly').index('by_project_executed_at');
        const range = IDBKeyRange.bound([projectId, ''], [projectId, '\uffff']);
        const records = await take<unknown>(index, range, 'prev', limit ?? Number.MAX_SAFE_INTEGER);
        return records.map((record) => inferenceCodec.decode(record));
      },
      async listUnpinnedOldestFirst(projectId, limit) {
        // `[project_id, pinned, executed_at]` の pinned=0 を古い順（方針14）。
        const index = provider('inferences', 'readonly').index('by_project_pinned_executed_at');
        const range = IDBKeyRange.bound([projectId, 0, ''], [projectId, 0, '\uffff']);
        const records = await take<unknown>(index, range, 'next', limit);
        return records.map((record) => inferenceCodec.decode(record));
      },
      listByModel(modelId) {
        return listByIndex(provider, 'inferences', 'by_model', inferenceCodec, modelId);
      },
      countByProject(projectId) {
        return countByIndex(
          provider,
          'inferences',
          'by_project_executed_at',
          IDBKeyRange.bound([projectId, ''], [projectId, '\uffff']),
        );
      },
    },

    inferenceTargets: {
      ...createBaseRepository(provider, 'inference_targets', identityCodec()),
      listByInference(inferenceId) {
        return listByIndex(
          provider,
          'inference_targets',
          'by_inference',
          identityCodec(),
          inferenceId,
        );
      },
      listByImage(imageId) {
        return listByIndex(provider, 'inference_targets', 'by_image', identityCodec(), imageId);
      },
      countByImage(imageId) {
        return countByIndex(provider, 'inference_targets', 'by_image', imageId);
      },
    },

    detections: {
      ...createBaseRepository(provider, 'detections', identityCodec()),
      listByTarget(targetId) {
        return listByIndex(provider, 'detections', 'by_target', identityCodec(), targetId);
      },
      countByLabelClass(labelClassId) {
        return countByIndex(provider, 'detections', 'by_label_class', labelClassId);
      },
    },
  };
}
