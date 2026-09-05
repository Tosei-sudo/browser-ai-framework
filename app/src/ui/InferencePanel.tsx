/**
 * 推論の実行と結果表示（M3 / MVP の中核）。
 *
 * 複数枚をまとめて流せる。実行は1回の `Inference` にまとめ、画像ごとに
 * `InferenceTarget` を積む（方針9）。しきい値は実行ごとに指定する（方針15）。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Detection, Image, LabelClass, Model, Project } from '@domain/index';
import type { LabelClassId } from '@domain/ids';
import { importImage, loadImageBitmap } from '../application/imageManager';
import { DEFAULT_PARAMS, runInference } from '../application/inferenceManager';
import { listBaseModels } from '../application/modelManager';
import { assertCanStore } from '../application/storageQuotaService';
import type { InferenceRunner } from '../application/inferenceManager';
import type { StoragePorts } from '@infrastructure/storage';
import { DetectionCanvas } from './DetectionCanvas';

interface ResultRow {
  readonly image: Image;
  readonly bitmap: ImageBitmap;
  readonly detections: readonly Detection[];
  readonly elapsedMs: number | null;
  readonly status: string;
  readonly error: string | null;
  readonly deduplicated: boolean;
}

export function InferencePanel({
  ports,
  project,
  runner,
  readOnly,
  onChanged,
  reloadToken,
}: {
  ports: StoragePorts;
  project: Project;
  runner: InferenceRunner;
  readOnly: boolean;
  onChanged: () => void;
  /** Base Model の取り込み状態が変わったら読み直す */
  reloadToken: number;
}): React.ReactElement {
  const [models, setModels] = useState<Model[]>([]);
  const [rows, setRows] = useState<ResultRow[]>([]);
  const [selected, setSelected] = useState(0);
  const [classes, setClasses] = useState<ReadonlyMap<LabelClassId, LabelClass>>(new Map());
  const [conf, setConf] = useState(DEFAULT_PARAMS.confThreshold);
  const [iou, setIou] = useState(DEFAULT_PARAMS.iouThreshold);
  const [busy, setBusy] = useState<string | null>(null);
  const [backend, setBackend] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const deps = {
    repositories: ports.repositories,
    unitOfWork: ports.unitOfWork,
    blobStore: ports.blobStore,
    catalog: ports.catalog,
    runner,
  };

  const reloadModels = useCallback(() => {
    listBaseModels(deps)
      .then(setModels)
      .catch((cause: unknown) => setError(String(cause)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ports]);

  useEffect(reloadModels, [reloadModels, reloadToken]);

  const ready = models.find((model) => model.artifact_status === 'present');

  const onFiles = (event: React.ChangeEvent<HTMLInputElement>): void => {
    const files = [...(event.target.files ?? [])];
    if (files.length === 0 || !ready) return;
    setError(null);
    void (async () => {
      try {
        // 容量が逼迫しているなら、取り込む前に止める（論点23）。
        await assertCanStore(
          ports.storagePolicy,
          files.reduce((sum, file) => sum + file.size, 0),
        );

        const imported = [];
        for (const [index, file] of files.entries()) {
          setBusy(`取り込み中（${index + 1} / ${files.length}）`);
          imported.push(await importImage(deps, project.project_id, file));
        }

        setBusy(`推論中（${files.length} 枚）`);
        const result = await runInference(
          deps,
          project.project_id,
          ready,
          imported.map((entry) => entry.image),
          { confThreshold: conf, iouThreshold: iou, maxDetections: DEFAULT_PARAMS.maxDetections },
        );
        setBackend(String(result.inference.runtime_info.backend));

        const labelClasses = await ports.repositories.labelClasses.listByLabelSet(ready.label_set_id);
        setClasses(new Map(labelClasses.map((klass) => [klass.label_class_id, klass])));

        const next: ResultRow[] = [];
        for (const [index, entry] of result.targets.entries()) {
          const source = imported[index];
          if (!source) continue;
          next.push({
            image: source.image,
            bitmap: await loadImageBitmap(deps, source.image),
            detections: entry.detections,
            elapsedMs: entry.target.elapsed_ms,
            status: entry.target.status,
            error: entry.target.error_message,
            deduplicated: source.deduplicated,
          });
        }
        rows.forEach((row) => row.bitmap.close());
        setRows(next);
        setSelected(0);
        onChanged();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setBusy(null);
        if (fileRef.current) fileRef.current.value = '';
      }
    })();
  };

  const current = rows[selected];

  return (
    <section>
      <h2>推論</h2>
      <p className="lead">
        画像を選ぶと、取り込み（重複排除つき）→ 推論 → 履歴への記録までを行う。
        複数枚を選ぶと1回の実行としてまとめて記録する（方針9）。
      </p>

      {!ready && (
        <p className="notice warn">
          重みを取り込んだ Base Model がない。上の「重みを取り込む」を先に実行すること。
        </p>
      )}

      <div className="row">
        <span>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            multiple
            onChange={onFiles}
            disabled={readOnly || busy !== null || !ready}
          />
        </span>
        <span className="muted">
          <label>
            conf{' '}
            <input
              type="range"
              min="0.05"
              max="0.9"
              step="0.05"
              value={conf}
              onChange={(event) => setConf(Number(event.target.value))}
              disabled={busy !== null}
            />{' '}
            {conf.toFixed(2)}
          </label>{' '}
          <label>
            IoU{' '}
            <input
              type="range"
              min="0.1"
              max="0.9"
              step="0.05"
              value={iou}
              onChange={(event) => setIou(Number(event.target.value))}
              disabled={busy !== null}
            />{' '}
            {iou.toFixed(2)}
          </label>
        </span>
      </div>

      {busy && <p>{busy}…</p>}
      {error && <p className="notice stop">失敗: {error}</p>}

      {rows.length > 1 && (
        <p className="muted">
          {rows.map((row, index) => (
            <button
              key={row.image.image_id}
              type="button"
              onClick={() => setSelected(index)}
              disabled={index === selected}
            >
              {index + 1}枚目（{row.detections.length}）
            </button>
          ))}
        </p>
      )}

      {current && (
        <>
          <p className="muted">
            {current.image.width}×{current.image.height} / 検出 {current.detections.length} 件 /{' '}
            {current.elapsedMs ?? '—'} ms / backend: {backend}
            {current.deduplicated && ' / 取り込み済みの画像と同一（実体は共有）'}
            {current.status === 'failed' && ` / 失敗: ${current.error ?? ''}`}
          </p>
          <DetectionCanvas
            bitmap={current.bitmap}
            detections={current.detections}
            classes={classes}
          />
          <ul className="detection-list">
            {current.detections.slice(0, 10).map((detection) => {
              const klass = classes.get(detection.label_class_id);
              return (
                <li key={detection.detection_id}>
                  <span className="swatch" style={{ background: klass?.color ?? '#888' }} />
                  {klass?.name ?? '?'}
                  <span className="muted">{(detection.confidence * 100).toFixed(1)}%</span>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}
