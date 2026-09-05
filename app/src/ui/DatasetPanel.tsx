/**
 * データセットの編集と版の凍結（M5 / 方針2）。
 *
 * `Dataset` は可変。**学習が参照するのは凍結した `DatasetVersion`** で、
 * 凍結は明示的に行う（持ち越し事項#3 の決定）。
 */
import { useCallback, useEffect, useState } from 'react';
import type { Dataset, DatasetVersion, Image, LabelSet, Project } from '@domain/index';
import type { DatasetId, LabelSetId } from '@domain/ids';
import {
  addMember,
  createDataset,
  freezeVersion,
  listDatasets,
  listMembers,
  listVersions,
  removeMember,
  type DatasetManagerDeps,
} from '../application/datasetManager';
import { listImages } from '../application/imageManager';
import { listUsableLabelSets } from '../application/labelSetManager';
import type { StoragePorts } from '@infrastructure/storage';

export function DatasetPanel({
  ports,
  project,
  readOnly,
  reloadToken,
  onChanged,
}: {
  ports: StoragePorts;
  project: Project;
  readOnly: boolean;
  reloadToken: number;
  onChanged: () => void;
}): React.ReactElement {
  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const [labelSets, setLabelSets] = useState<LabelSet[]>([]);
  const [images, setImages] = useState<Image[]>([]);
  const [selected, setSelected] = useState<DatasetId | null>(null);
  const [memberIds, setMemberIds] = useState<Set<string>>(new Set());
  const [versions, setVersions] = useState<DatasetVersion[]>([]);
  const [name, setName] = useState('');
  const [labelSetId, setLabelSetId] = useState<LabelSetId | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const deps: DatasetManagerDeps = {
    repositories: ports.repositories,
    unitOfWork: ports.unitOfWork,
  };
  const imageDeps = { ...deps, blobStore: ports.blobStore };

  const reload = useCallback(() => {
    void (async () => {
      const [datasetList, setList, imageList] = await Promise.all([
        listDatasets(deps, project.project_id),
        listUsableLabelSets(deps, project.project_id),
        listImages(imageDeps, project.project_id),
      ]);
      setDatasets(datasetList);
      setLabelSets(setList);
      setImages(imageList);
      setLabelSetId((current) => current ?? setList[0]?.label_set_id ?? null);
      const target = selected ?? datasetList[0]?.dataset_id ?? null;
      setSelected(target);
      if (target) {
        const [members, versionList] = await Promise.all([
          listMembers(deps, target),
          listVersions(deps, target),
        ]);
        setMemberIds(new Set(members.map((member) => member.image_id)));
        setVersions(versionList);
      }
    })().catch((cause: unknown) => setMessage(String(cause)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ports, project, selected]);

  useEffect(reload, [reload, reloadToken]);

  const run = (task: Promise<unknown>): void => {
    setMessage(null);
    task
      .then(() => {
        reload();
        onChanged();
      })
      .catch((cause: unknown) => setMessage(cause instanceof Error ? cause.message : String(cause)));
  };

  const toggle = (imageId: Image['image_id']): void => {
    if (!selected) return;
    run(
      memberIds.has(imageId)
        ? removeMember(deps, selected, imageId)
        : addMember(deps, selected, imageId),
    );
  };

  const freeze = (): void => {
    if (!selected) return;
    run(
      freezeVersion(deps, selected).then((result) => {
        setMessage(
          `v${result.version.version_no} を凍結した（${result.items.length} 件`
            + `${result.skipped > 0 ? ` / 確定済みアノテーションが無い ${result.skipped} 件を除外` : ''}）`,
        );
      }),
    );
  };

  return (
    <section>
      <h2>データセット</h2>
      <p className="lead">
        中身は出し入れできる。<strong>学習は凍結した版だけを参照する</strong>ので、
        学習の前に版を確定する（方針2）。確定済みのアノテーションが無い画像は版に入らない。
      </p>
      {message && <p className="muted">{message}</p>}

      <div className="row">
        <span>
          <input
            type="text"
            value={name}
            placeholder="データセット名"
            onChange={(event) => setName(event.target.value)}
            disabled={readOnly}
          />{' '}
          <select
            value={labelSetId ?? ''}
            onChange={(event) => setLabelSetId(event.target.value as LabelSetId)}
          >
            {labelSets.map((set) => (
              <option key={set.label_set_id} value={set.label_set_id}>
                {set.name}
              </option>
            ))}
          </select>{' '}
          <button
            type="button"
            disabled={readOnly || !labelSetId}
            onClick={() =>
              labelSetId &&
              run(createDataset(deps, project.project_id, labelSetId, name).then(() => setName('')))
            }
          >
            作成
          </button>
        </span>
        {datasets.length > 0 && (
          <span>
            対象{' '}
            <select
              value={selected ?? ''}
              onChange={(event) => setSelected(event.target.value as DatasetId)}
            >
              {datasets.map((dataset) => (
                <option key={dataset.dataset_id} value={dataset.dataset_id}>
                  {dataset.name}
                </option>
              ))}
            </select>
          </span>
        )}
      </div>

      {selected && (
        <>
          <ul className="history">
            {images.map((image) => (
              <li key={image.image_id}>
                <label>
                  <input
                    type="checkbox"
                    checked={memberIds.has(image.image_id)}
                    onChange={() => toggle(image.image_id)}
                    disabled={readOnly}
                  />{' '}
                  <span className="muted">
                    {image.width}×{image.height} / {image.content_hash.slice(0, 8)}…
                  </span>
                </label>
              </li>
            ))}
          </ul>
          <p>
            <button type="button" onClick={freeze} disabled={readOnly || memberIds.size === 0}>
              版を確定する（{memberIds.size} 件）
            </button>
          </p>
          {versions.length > 0 && (
            <p className="muted">
              版:{' '}
              {versions
                .slice(0, 6)
                .map((version) => `v${version.version_no}(${version.item_count}件)`)
                .join(' ← ')}
            </p>
          )}
        </>
      )}
    </section>
  );
}
