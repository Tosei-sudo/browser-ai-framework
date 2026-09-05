/**
 * 推論履歴の一覧（方針9・14）。
 *
 * `[project_id, executed_at]` の降順で引く。上限件数を超えたぶんは
 * `RetentionService` が古い順に消すが、**`pinned` は残る**。
 */
import { useCallback, useEffect, useState } from 'react';
import type { Inference, Project } from '@domain/index';
import type { InferenceId } from '@domain/ids';
import {
  listHistory,
  loadHistoryDetail,
  setPinned,
  type InferenceRunner,
} from '../application/inferenceManager';
import { MAX_INFERENCES_PER_PROJECT } from '../application/retentionService';
import type { StoragePorts } from '@infrastructure/storage';

interface Row {
  readonly inference: Inference;
  readonly images: number;
  readonly detections: number;
}

export function HistoryPanel({
  ports,
  project,
  runner,
  readOnly,
  reloadToken,
}: {
  ports: StoragePorts;
  project: Project;
  runner: InferenceRunner;
  readOnly: boolean;
  reloadToken: number;
}): React.ReactElement {
  const [rows, setRows] = useState<Row[]>([]);
  const [total, setTotal] = useState(0);

  const deps = {
    repositories: ports.repositories,
    unitOfWork: ports.unitOfWork,
    blobStore: ports.blobStore,
    runner,
  };

  const reload = useCallback(async () => {
    const history = await listHistory(deps, project.project_id, 20);
    const detailed = await Promise.all(
      history.map(async (inference) => {
        const targets = await loadHistoryDetail(deps, inference.inference_id);
        return {
          inference,
          images: targets.length,
          detections: targets.reduce((sum, entry) => sum + entry.detections.length, 0),
        };
      }),
    );
    setRows(detailed);
    setTotal(await ports.repositories.inferences.countByProject(project.project_id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ports, project]);

  useEffect(() => {
    reload().catch(() => undefined);
  }, [reload, reloadToken]);

  const togglePin = (inferenceId: InferenceId, pinned: boolean): void => {
    setPinned(deps, inferenceId, pinned)
      .then(() => reload())
      .catch(() => undefined);
  };

  return (
    <section>
      <h2>推論履歴</h2>
      <p className="lead">
        新しい順に最大20件。保持は {total} / {MAX_INFERENCES_PER_PROJECT} 件で、
        超えたぶんは pinned でないものから古い順に消える（方針14）。
      </p>
      {rows.length === 0 && <p className="muted">まだ履歴がない。</p>}
      <ul className="history">
        {rows.map(({ inference, images, detections }) => (
          <li key={inference.inference_id}>
            <span>
              {new Date(inference.executed_at).toLocaleString('ja-JP')}
              <span className="muted">
                {' '}
                / 画像 {images} 枚 / 検出 {detections} 件 / conf {inference.conf_threshold}
              </span>
            </span>
            <button
              type="button"
              onClick={() => togglePin(inference.inference_id, !inference.pinned)}
              disabled={readOnly}
            >
              {inference.pinned ? '固定を解除' : '固定する'}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
