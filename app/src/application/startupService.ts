/**
 * StartupService — 起動時にしか実行できない処理（03 §5）。
 *
 * M1 の範囲は次の3つ。
 *  1. 既定プロジェクトの生成（論点37）
 *  2. 孤児ファイルの回収（論点27 / 04 §6.2）
 *  3. 中断した Training の回収（論点21）
 *  4. Base Model カタログの同期（方針18）
 */
import { newId, now, type ProjectId } from '@domain/ids';
import type { Project } from '@domain/index';
import type { BaseModelCatalog } from '@ports/baseModelCatalog';
import type { BlobStore, StorageEstimate, StoragePolicy } from '@ports/blobStore';
import type { Repositories, UnitOfWork } from '@ports/repository';
import { syncCatalog, type CatalogSyncResult } from './modelManager';

/** 既定プロジェクトの名前。MVP では利用者に見せない（論点37）。 */
const DEFAULT_PROJECT_NAME = '既定のプロジェクト';

export interface StartupDependencies {
  readonly repositories: Repositories;
  readonly unitOfWork: UnitOfWork;
  readonly blobStore: BlobStore;
  readonly storagePolicy: StoragePolicy;
  readonly catalog: BaseModelCatalog;
  /** 移行に失敗して読み取り専用で開いた場合の理由（04 §8.3） */
  readonly readOnlyReason: string | null;
}

export interface StartupResult {
  readonly project: Project;
  readonly storage: StorageEstimate;
  /** 回収した孤児ファイルの件数（04 §6.2） */
  readonly orphansCollected: { readonly images: number; readonly models: number };
  /** 中断として回収した学習の件数（論点21） */
  readonly interruptedTrainings: number;
  /** Base Model カタログの同期結果（方針18） */
  readonly catalogSync: CatalogSyncResult;
  readonly readOnly: boolean;
  readonly readOnlyReason: string | null;
}

/**
 * 既定プロジェクトを1件だけ持つ（論点37）。
 * 無ければ作り、複数あれば最も古いものを使う。
 */
async function ensureDefaultProject(
  repositories: Repositories,
  unitOfWork: UnitOfWork,
  readOnly: boolean,
): Promise<Project> {
  const existing = await repositories.projects.listByUpdatedAt();
  const oldest = existing.at(-1);
  if (oldest) return oldest;

  const timestamp = now();
  const project: Project = {
    project_id: newId<'ProjectId'>() as ProjectId,
    name: DEFAULT_PROJECT_NAME,
    description: '',
    created_at: timestamp,
    updated_at: timestamp,
  };
  if (readOnly) {
    // 書けないが、UI が動くようにメモリ上のプロジェクトは返す。
    return project;
  }
  await unitOfWork.run(['projects'], 'readwrite', async (repos) => {
    await repos.projects.put(project);
  });
  return project;
}

/**
 * OPFS のファイル一覧と IndexedDB のメタを突き合わせ、対応するメタのない
 * ファイルを削除する（04 §6.2）。
 *
 * 実体を先に書いてメタを後からコミットする順序（論点27）では、
 * コミット失敗時に孤児ファイルだけが残る。ここで回収する。
 */
async function collectOrphans(
  repositories: Repositories,
  blobStore: BlobStore,
  readOnly: boolean,
): Promise<{ images: number; models: number }> {
  if (readOnly) return { images: 0, models: 0 };

  const [imageIds, artifactIds] = await Promise.all([
    blobStore.listIds('image'),
    blobStore.listIds('model'),
  ]);

  let images = 0;
  for (const id of imageIds) {
    const blob = await repositories.imageBlobs.get(id as Parameters<typeof repositories.imageBlobs.get>[0]);
    if (blob) continue;
    await blobStore.delete({ kind: 'image', id: id as never });
    images += 1;
  }

  const knownArtifacts = new Set<string>(await repositories.modelArtifacts.listAllIds());
  let models = 0;
  for (const id of artifactIds) {
    if (knownArtifacts.has(id)) continue;
    await blobStore.delete({ kind: 'model', id: id as never });
    models += 1;
  }

  return { images, models };
}

/**
 * 中断した学習を回収する（論点21）。
 *
 * 複数タブでの同時学習は許さないと決めたため（03 §4）、
 * 起動時に `running` のまま残っているものは前回の中断とみなしてよい。
 */
async function recoverInterruptedTrainings(
  repositories: Repositories,
  unitOfWork: UnitOfWork,
  readOnly: boolean,
): Promise<number> {
  if (readOnly) return 0;
  const running = await repositories.trainings.listByStatus('running');
  if (running.length === 0) return 0;

  await unitOfWork.run(['trainings'], 'readwrite', async (repos) => {
    for (const training of running) {
      // 失敗・中断も記録として残す（方針13）。消さずに状態だけ確定させる。
      await repos.trainings.put({
        ...training,
        status: 'cancelled',
        ended_at: now(),
        error_message: '前回の実行が中断された（起動時に回収）',
      });
    }
  });
  return running.length;
}

export async function runStartup(deps: StartupDependencies): Promise<StartupResult> {
  const readOnly = deps.readOnlyReason !== null;

  // 永続化の要求は起動時に1度だけ。拒否されても処理は続ける（論点26）。
  await deps.storagePolicy.requestPersistence();

  const project = await ensureDefaultProject(deps.repositories, deps.unitOfWork, readOnly);
  const orphansCollected = await collectOrphans(deps.repositories, deps.blobStore, readOnly);
  const interruptedTrainings = await recoverInterruptedTrainings(
    deps.repositories,
    deps.unitOfWork,
    readOnly,
  );
  // Base Model のメタを全件登録する。重みはここでは取りに行かない（方針18）。
  const catalogSync = readOnly
    ? { registered: 0, alreadyKnown: 0 }
    : await syncCatalog({
        repositories: deps.repositories,
        unitOfWork: deps.unitOfWork,
        blobStore: deps.blobStore,
        catalog: deps.catalog,
      });

  const storage = await deps.storagePolicy.estimate();

  return {
    project,
    storage,
    orphansCollected,
    interruptedTrainings,
    catalogSync,
    readOnly,
    readOnlyReason: deps.readOnlyReason,
  };
}
