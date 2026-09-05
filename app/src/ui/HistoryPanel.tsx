/**
 * 推論履歴の一覧と詳細（方針9・14 / 持ち越し事項#7）。
 *
 * `[project_id, executed_at]` の降順で引く。上限件数を超えたぶんは
 * `RetentionService` が古い順に消すが、**`pinned` は残る**。
 *
 * 画像を削除しても履歴は残る（方針16）。詳細では
 * **「画像は削除済み」と明示する**。結果だけが残っていることを隠さない。
 */
import { useCallback, useEffect, useState } from 'react';
import type { Detection, Image, Inference, InferenceTarget, LabelClass, Project } from '@domain/index';
import type { InferenceId, LabelClassId } from '@domain/ids';
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

interface DetailRow {
  readonly target: InferenceTarget;
  readonly detections: Detection[];
  readonly image: Image | undefined;
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
  const [openId, setOpenId] = useState<InferenceId | null>(null);
  const [detail, setDetail] = useState<DetailRow[]>([]);
  const [classes, setClasses] = useState<ReadonlyMap<LabelClassId, LabelClass>>(new Map());

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

  const open = (inference: Inference): void => {
    if (openId === inference.inference_id) {
      setOpenId(null);
      return;
    }
    void (async () => {
      const targets = await loadHistoryDetail(deps, inference.inference_id);
      const withImages = await Promise.all(
        targets.map(async (entry) => ({
          ...entry,
          image: await ports.repositories.images.get(entry.target.image_id),
        })),
      );
      const model = await ports.repositories.models.get(inference.model_id);
      if (model) {
        const list = await ports.repositories.labelClasses.listByLabelSet(model.label_set_id);
        setClasses(new Map(list.map((klass) => [klass.label_class_id, klass])));
      }
      setDetail(withImages);
      setOpenId(inference.inference_id);
    })();
  };

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
              <button type="button" onClick={() => open(inference)}>
                {openId === inference.inference_id ? '−' : '+'}
              </button>{' '}
              {new Date(inference.executed_at).toLocaleString('ja-JP')}
              <span className="muted">
                {' '}
                / 画像 {images} 枚 / 検出 {detections} 件 / conf {inference.conf_threshold}
                {inference.pinned && ' / 固定'}
              </span>
              {openId === inference.inference_id && (
                <ul className="detection-list">
                  {detail.map((entry) => (
                    <li key={entry.target.target_id} style={{ display: 'block' }}>
                      <span className="muted">
                        {entry.image === undefined
                          ? '画像は削除済み（履歴は残る）'
                          : entry.image.deleted_at !== null
                            ? `${entry.image.width}×${entry.image.height}（削除済み）`
                            : `${entry.image.width}×${entry.image.height}`}
                        {' / '}
                        {entry.target.status}
                        {entry.target.elapsed_ms !== null && ` / ${entry.target.elapsed_ms} ms`}
                      </span>
                      {'　'}
                      {entry.detections.slice(0, 6).map((detection) => {
                        const klass = classes.get(detection.label_class_id);
                        return (
                          <span key={detection.detection_id}>
                            <span
                              className="swatch"
                              style={{ background: klass?.color ?? '#888' }}
                            />
                            {klass?.name ?? '?'} {(detection.confidence * 100).toFixed(0)}%{'　'}
                          </span>
                        );
                      })}
                    </li>
                  ))}
                </ul>
              )}
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
