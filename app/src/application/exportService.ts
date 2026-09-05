/**
 * ExportService — プロジェクト一式の持ち出し（方針17）。
 *
 * **`persist()` が拒否されうる以上、エクスポートは保険ではなく必須の機能**
 * （06 §3.4）。ブラウザにデータを預けたままにしない手段を用意する。
 */
import type { ProjectId } from '@domain/ids';
import type { BlobStore } from '@ports/blobStore';
import type { Repositories, UnitOfWork } from '@ports/repository';
import type { StoreName } from '@ports/stores';
import { collectCascade, type ProjectManagerDeps } from './projectManager';
import { HEADER_OFFSET, MAGIC, type BlobEntry, type TransferHeader } from './transfer';

export type ExportDeps = ProjectManagerDeps & {
  readonly repositories: Repositories;
  readonly unitOfWork: UnitOfWork;
  readonly blobStore: BlobStore;
};

export interface ExportResult {
  readonly blob: Blob;
  readonly fileName: string;
  readonly records: number;
  readonly blobs: number;
}

export async function exportProject(
  deps: ExportDeps,
  projectId: ProjectId,
): Promise<ExportResult> {
  const project = await deps.repositories.projects.get(projectId);
  if (!project) throw new Error(`プロジェクトが見つからない: ${projectId}`);
  const cascade = await collectCascade(deps, projectId);

  // 実体を集める。画像は `ImageBlob` のメタも要る。
  const blobMetas = await Promise.all(
    [...new Set(cascade.images.map((image) => image.blob_id))].map((blobId) =>
      deps.repositories.imageBlobs.get(blobId),
    ),
  );
  const imageBlobs = blobMetas.flatMap((blob) => (blob ? [blob] : []));
  const artifacts = await Promise.all(
    cascade.models.flatMap((model) =>
      model.artifact_id ? [deps.repositories.modelArtifacts.get(model.artifact_id)] : [],
    ),
  );
  const modelArtifacts = artifacts.flatMap((artifact) => (artifact ? [artifact] : []));

  const parts: ArrayBuffer[] = [];
  const blobs: BlobEntry[] = [];
  let offset = 0;
  for (const blob of imageBlobs) {
    const data = await deps.blobStore.get({ kind: 'image', id: blob.blob_id });
    if (!data) continue;
    blobs.push({ kind: 'image', id: blob.blob_id, offset, length: data.byteLength });
    parts.push(data);
    offset += data.byteLength;
  }
  for (const artifact of modelArtifacts) {
    const data = await deps.blobStore.get({ kind: 'model', id: artifact.artifact_id });
    if (!data) continue;
    blobs.push({ kind: 'model', id: artifact.artifact_id, offset, length: data.byteLength });
    parts.push(data);
    offset += data.byteLength;
  }

  const records: Partial<Record<StoreName, readonly Record<string, unknown>[]>> = {
    projects: [project as unknown as Record<string, unknown>],
    images: cascade.images as unknown as Record<string, unknown>[],
    image_blobs: imageBlobs as unknown as Record<string, unknown>[],
    label_sets: cascade.labelSets as unknown as Record<string, unknown>[],
    label_classes: cascade.labelClasses as unknown as Record<string, unknown>[],
    annotation_sets: cascade.annotationSets as unknown as Record<string, unknown>[],
    annotation_objects: cascade.annotationObjects as unknown as Record<string, unknown>[],
    datasets: cascade.datasets as unknown as Record<string, unknown>[],
    dataset_versions: cascade.datasetVersions as unknown as Record<string, unknown>[],
    dataset_items: cascade.datasetItems as unknown as Record<string, unknown>[],
    dataset_members: cascade.datasetMembers as unknown as Record<string, unknown>[],
    models: cascade.models as unknown as Record<string, unknown>[],
    model_artifacts: modelArtifacts as unknown as Record<string, unknown>[],
    model_derivations: cascade.derivations as unknown as Record<string, unknown>[],
    trainings: cascade.trainings as unknown as Record<string, unknown>[],
    training_metrics: cascade.trainingMetrics as unknown as Record<string, unknown>[],
    evaluations: cascade.evaluations as unknown as Record<string, unknown>[],
    evaluation_metrics: cascade.evaluationMetrics as unknown as Record<string, unknown>[],
    inferences: cascade.inferences as unknown as Record<string, unknown>[],
    inference_targets: cascade.targets as unknown as Record<string, unknown>[],
    detections: cascade.detections as unknown as Record<string, unknown>[],
  };

  const header: TransferHeader = {
    format: 'baif',
    version: 1,
    exported_at: new Date().toISOString(),
    project_name: project.name,
    records,
    blobs,
  };
  const headerBytes = new TextEncoder().encode(JSON.stringify(header));
  const prefix = new Uint8Array(HEADER_OFFSET);
  prefix.set(new TextEncoder().encode(MAGIC), 0);
  new DataView(prefix.buffer).setUint32(MAGIC.length, headerBytes.byteLength, true);

  const recordCount = Object.values(records).reduce((sum, list) => sum + (list?.length ?? 0), 0);
  return {
    blob: new Blob([prefix, headerBytes, ...parts], { type: 'application/octet-stream' }),
    fileName: `${project.name}-${new Date().toISOString().slice(0, 10)}.baif`,
    records: recordCount,
    blobs: blobs.length,
  };
}
