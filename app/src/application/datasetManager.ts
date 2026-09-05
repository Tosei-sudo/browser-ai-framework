/**
 * DatasetManager — データセットの編集と版の凍結（方針2 / 論点02）。
 *
 * `Dataset` は可変の作業領域で、中身は `DatasetMember`（2026-09-05 追加）。
 * **学習が参照するのは必ず凍結した `DatasetVersion`。**
 *
 * 凍結は明示的に行う（持ち越し事項#3 の決定）。「何で学習したか」を
 * ユーザーが把握したうえで始められるようにするため。
 */
import { assertDatasetVersionFrozen } from '@domain/invariants';
import { newId, now } from '@domain/ids';
import type {
  DatasetId,
  DatasetItemId,
  DatasetMemberId,
  DatasetVersionId,
  ImageId,
  LabelSetId,
  ProjectId,
} from '@domain/ids';
import type {
  Dataset,
  DatasetItem,
  DatasetMember,
  DatasetSplit,
  DatasetVersion,
  SplitPolicy,
} from '@domain/index';
import type { Repositories, UnitOfWork } from '@ports/repository';

export interface DatasetManagerDeps {
  readonly repositories: Repositories;
  readonly unitOfWork: UnitOfWork;
}

export const DEFAULT_SPLIT: SplitPolicy = { kind: 'ratio', train: 0.7, val: 0.2, test: 0.1 };

export async function listDatasets(
  deps: DatasetManagerDeps,
  projectId: ProjectId,
): Promise<Dataset[]> {
  return deps.repositories.datasets.listByProject(projectId);
}

export async function createDataset(
  deps: DatasetManagerDeps,
  projectId: ProjectId,
  labelSetId: LabelSetId,
  name: string,
): Promise<Dataset> {
  const timestamp = now();
  const dataset: Dataset = {
    dataset_id: newId<'DatasetId'>() as DatasetId,
    project_id: projectId,
    name: name.trim() || 'データセット',
    label_set_id: labelSetId,
    description: '',
    created_at: timestamp,
    updated_at: timestamp,
  };
  await deps.unitOfWork.run(['datasets'], 'readwrite', async (repos) => {
    await repos.datasets.put(dataset);
  });
  return dataset;
}

export async function listMembers(
  deps: DatasetManagerDeps,
  datasetId: DatasetId,
): Promise<DatasetMember[]> {
  return deps.repositories.datasetMembers.listByDataset(datasetId);
}

export async function addMember(
  deps: DatasetManagerDeps,
  datasetId: DatasetId,
  imageId: ImageId,
): Promise<void> {
  const existing = await deps.repositories.datasetMembers.findByImage(datasetId, imageId);
  if (existing) return;
  const member: DatasetMember = {
    member_id: newId<'DatasetMemberId'>() as DatasetMemberId,
    dataset_id: datasetId,
    image_id: imageId,
    added_at: now(),
  };
  await deps.unitOfWork.run(['dataset_members'], 'readwrite', async (repos) => {
    await repos.datasetMembers.put(member);
  });
}

export async function removeMember(
  deps: DatasetManagerDeps,
  datasetId: DatasetId,
  imageId: ImageId,
): Promise<void> {
  const existing = await deps.repositories.datasetMembers.findByImage(datasetId, imageId);
  if (!existing) return;
  await deps.unitOfWork.run(['dataset_members'], 'readwrite', async (repos) => {
    await repos.datasetMembers.delete(existing.member_id);
  });
}

export interface FreezeResult {
  readonly version: DatasetVersion;
  readonly items: DatasetItem[];
  /** アノテーションが無くて除外した画像 */
  readonly skipped: number;
}

/**
 * 版を凍結する（方針2）。
 *
 * その時点のメンバーと、各画像の**最新の確定済みアノテーション**を固定する。
 * 確定済みの版が無い画像は入れない。学習の入力が「下書き」では追跡にならない。
 *
 * split はハッシュ順で決める。同じ内容なら同じ割り当てになり、版を作り直しても
 * train / val の入れ替わりが起きない。
 */
export async function freezeVersion(
  deps: DatasetManagerDeps,
  datasetId: DatasetId,
  policy: SplitPolicy = DEFAULT_SPLIT,
): Promise<FreezeResult> {
  const dataset = await deps.repositories.datasets.get(datasetId);
  if (!dataset) throw new Error(`データセットが見つからない: ${datasetId}`);

  const members = await deps.repositories.datasetMembers.listByDataset(datasetId);
  const versions = await deps.repositories.datasetVersions.listByDataset(datasetId);
  const versionNo = versions.reduce((max, version) => Math.max(max, version.version_no), 0) + 1;
  const versionId = newId<'DatasetVersionId'>() as DatasetVersionId;

  const splits = planSplits(policy, members.length);
  const items: DatasetItem[] = [];
  let skipped = 0;
  for (const [index, member] of members.entries()) {
    const latest = await deps.repositories.annotationSets.findLatestByImage(member.image_id);
    if (!latest || latest.status !== 'confirmed') {
      skipped += 1;
      continue;
    }
    items.push({
      item_id: newId<'DatasetItemId'>() as DatasetItemId,
      dataset_version_id: versionId,
      image_id: member.image_id,
      // 使ったアノテーションの版を固定する（方針2）。
      annotation_set_id: latest.annotation_set_id,
      split: splits[index] ?? 'train',
    });
  }

  const version: DatasetVersion = {
    dataset_version_id: versionId,
    dataset_id: datasetId,
    version_no: versionNo,
    item_count: items.length,
    split_policy: policy,
    frozen_at: now(),
  };
  // 凍結後は変更しない。ここで作った内容がそのまま残る。
  assertDatasetVersionFrozen(version, version);

  await deps.unitOfWork.run(
    ['dataset_versions', 'dataset_items', 'datasets'],
    'readwrite',
    async (repos) => {
      await repos.datasetVersions.put(version);
      await repos.datasetItems.putMany(items);
      await repos.datasets.put({ ...dataset, updated_at: now() });
    },
  );
  return { version, items, skipped };
}

/**
 * split の割当を決める。
 *
 * 単純に比率で切ると、少ない件数では val と test が空になる
 * （3件・7:2:1 だと全部 train）。**評価できない版を作っても意味がない**ので、
 * 3件以上なら val に1件、5件以上なら test にも1件は必ず回す。
 *
 * 並び順は凍結時のメンバー順で決まるため、同じ内容なら同じ割当になる。
 */
function planSplits(policy: SplitPolicy, total: number): DatasetSplit[] {
  if (policy.kind === 'manual' || total === 0) {
    return Array.from({ length: total }, () => 'train' as DatasetSplit);
  }
  let val = Math.floor(total * policy.val);
  let test = Math.floor(total * policy.test);
  if (total >= 3 && val === 0) val = 1;
  if (total >= 5 && test === 0) test = 1;
  const train = Math.max(total - val - test, 1);
  val = Math.min(val, Math.max(total - train, 0));
  test = Math.max(total - train - val, 0);
  return [
    ...Array.from({ length: train }, () => 'train' as DatasetSplit),
    ...Array.from({ length: val }, () => 'val' as DatasetSplit),
    ...Array.from({ length: test }, () => 'test' as DatasetSplit),
  ];
}

export async function listVersions(
  deps: DatasetManagerDeps,
  datasetId: DatasetId,
): Promise<DatasetVersion[]> {
  const versions = await deps.repositories.datasetVersions.listByDataset(datasetId);
  return [...versions].reverse();
}
