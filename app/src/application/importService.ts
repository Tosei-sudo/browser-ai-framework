/**
 * ImportService — 持ち出したプロジェクトの取り込み（方針17）。
 *
 * **必ず新しいプロジェクトとして取り込む。** ID を付け替えるので、
 * 同じファイルを2回入れても既存のデータを壊さない。
 *
 * 付け替えないのは Base Model とそのクラス体系の ID（`transfer.ts` を参照）。
 * カタログの `key` から決まる値なので、取り込み先でも同じものを指す（方針18）。
 *
 * 書き込み順序は **実体（OPFS）→ メタ（IndexedDB）**（論点27）。
 */
import { newId, now } from '@domain/ids';
import type { ArtifactId, BlobId, ProjectId } from '@domain/ids';
import type { BlobStore } from '@ports/blobStore';
import type { Repositories, UnitOfWork } from '@ports/repository';
import { STORE_NAMES, type StoreName } from '@ports/stores';
import { HEADER_OFFSET, ID_FIELDS, MAGIC, PRIMARY_KEY, type TransferHeader } from './transfer';

export interface ImportDeps {
  readonly repositories: Repositories;
  readonly unitOfWork: UnitOfWork;
  readonly blobStore: BlobStore;
}

export interface ImportResult {
  readonly projectId: ProjectId;
  readonly projectName: string;
  readonly records: number;
  readonly blobs: number;
}

function parse(buffer: ArrayBuffer): { header: TransferHeader; payload: ArrayBuffer } {
  const magic = new TextDecoder().decode(new Uint8Array(buffer, 0, MAGIC.length));
  if (magic !== MAGIC) throw new Error('このファイルはエクスポート形式ではない');
  const headerLength = new DataView(buffer).getUint32(MAGIC.length, true);
  const headerBytes = new Uint8Array(buffer, HEADER_OFFSET, headerLength);
  const header = JSON.parse(new TextDecoder().decode(headerBytes)) as TransferHeader;
  if (header.version !== 1) throw new Error(`未知のエクスポート版: ${header.version}`);
  return { header, payload: buffer.slice(HEADER_OFFSET + headerLength) };
}

export async function importProject(deps: ImportDeps, file: File): Promise<ImportResult> {
  const { header, payload } = parse(await file.arrayBuffer());

  // 1. 旧 ID → 新 ID の対応を作る。主キーだけを対象にする。
  const idMap = new Map<string, string>();
  for (const store of STORE_NAMES) {
    const rows = header.records[store] ?? [];
    const primaryKey = PRIMARY_KEY[store];
    for (const row of rows) {
      const oldId = row[primaryKey];
      if (typeof oldId === 'string' && !idMap.has(oldId)) {
        idMap.set(oldId, newId<'ImportedId'>());
      }
    }
  }

  // 2. 実体を先に書く（論点27）。ファイル内の位置から切り出す。
  for (const entry of header.blobs) {
    const data = payload.slice(entry.offset, entry.offset + entry.length);
    const newIdValue = idMap.get(entry.id) ?? entry.id;
    await deps.blobStore.put(
      entry.kind === 'image'
        ? { kind: 'image', id: newIdValue as BlobId }
        : { kind: 'model', id: newIdValue as ArtifactId },
      data,
    );
  }

  // 3. メタを付け替えてコミットする。
  const remapped = new Map<StoreName, Record<string, unknown>[]>();
  for (const store of STORE_NAMES) {
    const rows = header.records[store] ?? [];
    remapped.set(
      store,
      rows.map((row) => {
        const next: Record<string, unknown> = { ...row };
        for (const field of ID_FIELDS[store]) {
          const value = next[field];
          if (typeof value === 'string' && idMap.has(value)) {
            next[field] = idMap.get(value);
          }
        }
        return next;
      }),
    );
  }

  const projects = remapped.get('projects') ?? [];
  const project = projects[0];
  if (!project) throw new Error('エクスポートにプロジェクトが含まれていない');
  project['name'] = `${String(project['name'])}（取り込み）`;
  project['updated_at'] = now();

  await deps.unitOfWork.run([...STORE_NAMES], 'readwrite', async (repos) => {
    // 型は復元済みのレコードそのもの。Repository は主キーだけ見る。
    const put = async (store: StoreName, rows: Record<string, unknown>[]): Promise<void> => {
      const target = REPOSITORY_BY_STORE[store](repos);
      for (const row of rows) {
        await target.put(row as never);
      }
    };
    for (const store of STORE_NAMES) {
      await put(store, remapped.get(store) ?? []);
    }
  });

  const records = [...remapped.values()].reduce((sum, rows) => sum + rows.length, 0);
  return {
    projectId: project[PRIMARY_KEY.projects] as ProjectId,
    projectName: String(project['name']),
    records,
    blobs: header.blobs.length,
  };
}

/** ストア名から Repository を引く。インポートは全ストアを機械的に書き戻す。 */
const REPOSITORY_BY_STORE: Record<
  StoreName,
  (repos: Repositories) => { put(entity: never): Promise<void> }
> = {
  projects: (r) => r.projects,
  images: (r) => r.images,
  image_blobs: (r) => r.imageBlobs,
  label_sets: (r) => r.labelSets,
  label_classes: (r) => r.labelClasses,
  annotation_sets: (r) => r.annotationSets,
  annotation_objects: (r) => r.annotationObjects,
  datasets: (r) => r.datasets,
  dataset_versions: (r) => r.datasetVersions,
  dataset_items: (r) => r.datasetItems,
  models: (r) => r.models,
  model_artifacts: (r) => r.modelArtifacts,
  model_derivations: (r) => r.modelDerivations,
  trainings: (r) => r.trainings,
  training_metrics: (r) => r.trainingMetrics,
  evaluations: (r) => r.evaluations,
  evaluation_metrics: (r) => r.evaluationMetrics,
  inferences: (r) => r.inferences,
  inference_targets: (r) => r.inferenceTargets,
  detections: (r) => r.detections,
};
