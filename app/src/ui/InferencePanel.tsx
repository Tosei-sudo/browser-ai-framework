/**
 * 推論の実行と結果表示（M3 / MVP の中核）。
 *
 * 画像を取り込み（重複排除つき）、Base Model で推論し、結果を描画して履歴に残す。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Detection, Image, LabelClass, Model, Project } from '@domain/index';
import type { LabelClassId } from '@domain/ids';
import { importImage, loadImageBitmap } from '../application/imageManager';
import { DEFAULT_PARAMS, runInference } from '../application/inferenceManager';
import { listBaseModels } from '../application/modelManager';
import type { InferenceRunner } from '../application/inferenceManager';
import type { StoragePorts } from '@infrastructure/storage';
import { DetectionCanvas } from './DetectionCanvas';

interface Outcome {
  readonly image: Image;
  readonly bitmap: ImageBitmap;
  readonly detections: readonly Detection[];
  readonly elapsedMs: number | null;
  readonly backend: string;
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
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [classes, setClasses] = useState<ReadonlyMap<LabelClassId, LabelClass>>(new Map());
  const [busy, setBusy] = useState(false);
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

  const onFile = (event: React.ChangeEvent<HTMLInputElement>): void => {
    const file = event.target.files?.[0];
    if (!file || !ready) return;
    setBusy(true);
    setError(null);
    void (async () => {
      try {
        const imported = await importImage(deps, project.project_id, file);
        const result = await runInference(deps, project.project_id, ready, [imported.image]);
        const first = result.targets[0];
        const bitmap = await loadImageBitmap(deps, imported.image);
        const labelClasses = await ports.repositories.labelClasses.listByLabelSet(ready.label_set_id);
        setClasses(new Map(labelClasses.map((klass) => [klass.label_class_id, klass])));
        setOutcome({
          image: imported.image,
          bitmap,
          detections: first?.detections ?? [],
          elapsedMs: first?.target.elapsed_ms ?? null,
          backend: String(result.inference.runtime_info.backend),
          deduplicated: imported.deduplicated,
        });
        if (first?.target.status === 'failed') {
          setError(first.target.error_message ?? '推論に失敗した');
        }
        onChanged();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setBusy(false);
        if (fileRef.current) fileRef.current.value = '';
      }
    })();
  };

  return (
    <section>
      <h2>推論</h2>
      <p className="lead">
        画像を選ぶと、取り込み（重複排除つき）→ 推論 → 履歴への記録までを行う。
        しきい値は conf {DEFAULT_PARAMS.confThreshold} / IoU {DEFAULT_PARAMS.iouThreshold}（方針15）。
      </p>

      {!ready && (
        <p className="notice warn">
          重みを取り込んだ Base Model がない。上の「重みを取り込む」を先に実行すること。
        </p>
      )}

      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        onChange={onFile}
        disabled={readOnly || busy || !ready}
      />
      {busy && <p>実行中…</p>}
      {error && <p className="notice stop">失敗: {error}</p>}

      {outcome && (
        <>
          <p className="muted">
            {outcome.image.width}×{outcome.image.height} / 検出 {outcome.detections.length} 件 /{' '}
            {outcome.elapsedMs ?? '—'} ms / backend: {outcome.backend}
            {outcome.deduplicated && ' / 取り込み済みの画像と同一（実体は共有）'}
          </p>
          <DetectionCanvas
            bitmap={outcome.bitmap}
            detections={outcome.detections}
            classes={classes}
          />
          <ul className="detection-list">
            {outcome.detections.slice(0, 10).map((detection) => {
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
