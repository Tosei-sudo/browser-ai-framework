/**
 * ModelManager — Base Model のメタ管理と、重みの取得・破棄（方針6・18）。
 *
 * 方針18のとおり **メタは起動時に全件登録し、重みは使用時に取得する。**
 * 閉域では取得先が同一オリジンの配信物になるだけで、構造は変わらない（論点36）。
 */
import { assertModelArtifactConsistency, assertModelProjectScope } from '@domain/invariants';
import { newId, now, sha256Hex, stableId } from '@domain/ids';
import type { ArtifactId, LabelClassId, LabelSetId, ModelId } from '@domain/ids';
import type { LabelClass, LabelSet, Model, ModelArtifact } from '@domain/index';
import type { BaseModelCatalog, BaseModelEntry } from '@ports/baseModelCatalog';
import type { BlobStore } from '@ports/blobStore';
import type { Repositories, UnitOfWork } from '@ports/repository';

/** 既定の描画色。クラス index から決める（見分けがつけばよい）。 */
function colorFor(index: number): string {
  const hue = (index * 137.508) % 360;
  return `hsl(${hue.toFixed(0)} 70% 55%)`;
}

export interface ModelManagerDeps {
  readonly repositories: Repositories;
  readonly unitOfWork: UnitOfWork;
  readonly blobStore: BlobStore;
  readonly catalog: BaseModelCatalog;
}

export interface CatalogSyncResult {
  readonly registered: number;
  readonly alreadyKnown: number;
}

/**
 * カタログのメタを登録する（方針18）。
 *
 * ID はカタログの `key` から決まるため、何度実行しても同じレコードへ収束する。
 * **重みはここでは取りに行かない。**
 */
export async function syncCatalog(deps: ModelManagerDeps): Promise<CatalogSyncResult> {
  const entries = await deps.catalog.list();
  let registered = 0;
  let alreadyKnown = 0;

  for (const entry of entries) {
    const modelId = await stableId<'ModelId'>('model', entry.key);
    if (await deps.repositories.models.get(modelId as ModelId)) {
      alreadyKnown += 1;
      continue;
    }
    await registerEntry(deps, entry, modelId as ModelId);
    registered += 1;
  }
  return { registered, alreadyKnown };
}

async function registerEntry(
  deps: ModelManagerDeps,
  entry: BaseModelEntry,
  modelId: ModelId,
): Promise<void> {
  const labelSetId = (await stableId<'LabelSetId'>('label_set', entry.key)) as LabelSetId;
  const labelSet: LabelSet = {
    label_set_id: labelSetId,
    // Base Model のクラス体系はグローバル資産（方針11）。
    project_id: null,
    name: `${entry.name} のクラス`,
    class_count: entry.classes.length,
    derived_from_label_set_id: null,
  };
  const classes: LabelClass[] = await Promise.all(
    entry.classes.map(async (klass) => ({
      label_class_id: (await stableId<'LabelClassId'>(
        'label_class',
        `${entry.key}:${klass.index}`,
      )) as LabelClassId,
      label_set_id: labelSetId,
      name: klass.name,
      index: klass.index,
      color: colorFor(klass.index),
    })),
  );
  const model: Model = {
    model_id: modelId,
    project_id: null,
    name: entry.name,
    origin: 'builtin',
    task_type: entry.task_type,
    label_set_id: labelSetId,
    input_spec: entry.input_spec,
    // 重みはまだ取得していない（方針18）。
    artifact_id: null,
    artifact_status: 'evicted',
    created_by_training_id: null,
    created_at: now(),
  };
  assertModelProjectScope(model);
  assertModelArtifactConsistency(model);

  await deps.unitOfWork.run(['label_sets', 'label_classes', 'models'], 'readwrite', async (repos) => {
    await repos.labelSets.put(labelSet);
    await repos.labelClasses.putMany(classes);
    await repos.models.put(model);
  });
}

/**
 * 重みを取り込む（方針18の遅延取得）。
 *
 * 順序は **実体（OPFS）→ メタ（IndexedDB）**（論点27）。
 * コミットに失敗した場合は孤児ファイルが残るが、起動時のGCで回収される。
 */
export async function ensureWeights(deps: ModelManagerDeps, modelId: ModelId): Promise<Model> {
  const model = await deps.repositories.models.get(modelId);
  if (!model) throw new Error(`モデルが見つからない: ${modelId}`);
  if (model.artifact_status === 'present') return model;

  const entries = await deps.catalog.list();
  const matched = await findEntryFor(entries, modelId);
  if (!matched) throw new Error(`カタログに対応する項目がない: ${modelId}`);

  const weights = await deps.catalog.fetchWeights(matched);
  const checksum = await sha256Hex(weights);
  if (checksum !== matched.checksum) {
    // 配信物が壊れているか、カタログと重みの版がずれている。
    throw new Error(`重みの checksum が一致しない: ${matched.key}`);
  }

  const artifactId = newId<'ArtifactId'>() as ArtifactId;
  await deps.blobStore.put({ kind: 'model', id: artifactId }, weights);

  const artifact: ModelArtifact = {
    artifact_id: artifactId,
    format: matched.format,
    byte_size: weights.byteLength,
    checksum,
    stored_at: now(),
  };
  const updated: Model = { ...model, artifact_id: artifactId, artifact_status: 'present' };
  assertModelArtifactConsistency(updated);

  await deps.unitOfWork.run(['model_artifacts', 'models'], 'readwrite', async (repos) => {
    await repos.modelArtifacts.put(artifact);
    await repos.models.put(updated);
  });
  return updated;
}

/**
 * 重みを破棄する（方針6）。メタは残り、系譜は壊れない。
 *
 * 取り込みとは逆に **メタ → 実体** の順で消す。逆にすると
 * 「メタはあるが実体がない」状態が生まれ、読み込み時に落ちる。
 */
export async function evictWeights(deps: ModelManagerDeps, modelId: ModelId): Promise<Model> {
  const model = await deps.repositories.models.get(modelId);
  if (!model) throw new Error(`モデルが見つからない: ${modelId}`);
  if (model.artifact_status === 'evicted' || model.artifact_id === null) return model;

  const artifactId = model.artifact_id;
  const updated: Model = { ...model, artifact_id: null, artifact_status: 'evicted' };
  assertModelArtifactConsistency(updated);

  await deps.unitOfWork.run(['model_artifacts', 'models'], 'readwrite', async (repos) => {
    await repos.models.put(updated);
    await repos.modelArtifacts.delete(artifactId);
  });
  await deps.blobStore.delete({ kind: 'model', id: artifactId });
  return updated;
}

/** カタログの項目と登録済みモデルを `key` 由来の ID で突き合わせる。 */
async function findEntryFor(
  entries: readonly BaseModelEntry[],
  modelId: ModelId,
): Promise<BaseModelEntry | undefined> {
  for (const entry of entries) {
    if ((await stableId<'ModelId'>('model', entry.key)) === modelId) return entry;
  }
  return undefined;
}

/** Base Model の一覧（方針18でメタは全件ある）。 */
export async function listBaseModels(deps: ModelManagerDeps): Promise<Model[]> {
  return deps.repositories.models.listBuiltin();
}
