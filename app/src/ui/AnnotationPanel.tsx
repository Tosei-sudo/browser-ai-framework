/**
 * アノテーションの画面（M5）。
 *
 * 画像とクラス体系を選び、矩形を引いて版を保存する。
 * 推論結果から起こすこともできる（方針12）。
 */
import { useCallback, useEffect, useState } from 'react';
import type { AnnotationSet, Image, LabelClass, LabelSet, Project } from '@domain/index';
import type { ImageId, LabelSetId } from '@domain/ids';
import {
  createFromDetections,
  listRevisions,
  loadLatest,
  saveRevision,
  type AnnotationManagerDeps,
} from '../application/annotationManager';
import { listImages, loadImageBitmap } from '../application/imageManager';
import { listUsableLabelSets } from '../application/labelSetManager';
import type { StoragePorts } from '@infrastructure/storage';
import { AnnotationEditor, type EditableBox } from './AnnotationEditor';

export function AnnotationPanel({
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
  const [images, setImages] = useState<Image[]>([]);
  const [labelSets, setLabelSets] = useState<LabelSet[]>([]);
  const [imageId, setImageId] = useState<ImageId | null>(null);
  const [labelSetId, setLabelSetId] = useState<LabelSetId | null>(null);
  const [classes, setClasses] = useState<LabelClass[]>([]);
  const [bitmap, setBitmap] = useState<ImageBitmap | null>(null);
  const [boxes, setBoxes] = useState<EditableBox[]>([]);
  const [revisions, setRevisions] = useState<AnnotationSet[]>([]);
  const [message, setMessage] = useState<string | null>(null);

  const deps: AnnotationManagerDeps = {
    repositories: ports.repositories,
    unitOfWork: ports.unitOfWork,
  };
  const imageDeps = { ...deps, blobStore: ports.blobStore };

  const reloadLists = useCallback(() => {
    void (async () => {
      const [imageList, setList] = await Promise.all([
        listImages(imageDeps, project.project_id),
        listUsableLabelSets(deps, project.project_id),
      ]);
      setImages(imageList);
      setLabelSets(setList);
      setImageId((current) => current ?? imageList[0]?.image_id ?? null);
      setLabelSetId((current) => current ?? setList[0]?.label_set_id ?? null);
    })().catch((cause: unknown) => setMessage(String(cause)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ports, project]);

  useEffect(reloadLists, [reloadLists, reloadToken]);

  useEffect(() => {
    if (!labelSetId) return;
    void ports.repositories.labelClasses.listByLabelSet(labelSetId).then(setClasses);
  }, [ports, labelSetId]);

  const loadImage = useCallback(() => {
    if (!imageId) return;
    void (async () => {
      const image = images.find((candidate) => candidate.image_id === imageId);
      if (!image) return;
      const [nextBitmap, latest, revs] = await Promise.all([
        loadImageBitmap(imageDeps, image),
        loadLatest(deps, imageId),
        listRevisions(deps, imageId),
      ]);
      setBitmap((previous) => {
        previous?.close();
        return nextBitmap;
      });
      setRevisions(revs);
      // 直近の版のクラス体系に合わせる。合わなければ空から始める。
      if (latest) {
        setLabelSetId(latest.set.label_set_id);
        setBoxes(
          latest.objects.map((object) => ({
            label_class_id: object.label_class_id,
            bbox: object.bbox,
          })),
        );
      } else {
        setBoxes([]);
      }
    })().catch((cause: unknown) => setMessage(String(cause)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imageId, images, ports]);

  useEffect(loadImage, [loadImage]);

  const save = (next: readonly EditableBox[]): void => {
    if (!imageId || !labelSetId) return;
    void saveRevision(deps, { imageId, labelSetId, objects: next })
      .then((revision) => {
        setMessage(`rev${revision.set.revision_no} として保存した（${next.length} 件）`);
        loadImage();
        onChanged();
      })
      .catch((cause: unknown) => setMessage(String(cause)));
  };

  const fromDetections = (): void => {
    if (!imageId) return;
    void (async () => {
      const targets = await ports.repositories.inferenceTargets.listByImage(imageId);
      const latest = targets.at(-1);
      if (!latest) {
        setMessage('この画像の推論履歴がない');
        return;
      }
      const revision = await createFromDetections(deps, latest.target_id, { minConfidence: 0.3 });
      setMessage(
        `推論結果から rev${revision.set.revision_no}（下書き）を作った（${revision.objects.length} 件）`,
      );
      loadImage();
      onChanged();
    })().catch((cause: unknown) => setMessage(String(cause)));
  };

  const image = images.find((candidate) => candidate.image_id === imageId);

  return (
    <section>
      <h2>アノテーション</h2>
      <p className="lead">
        編集のたびに新しい版を作る（方針5）。<strong>過去の版は書き換えず、全件残す。</strong>
        学習はここで確定した版を参照する。
      </p>
      {message && <p className="muted">{message}</p>}

      <div className="row">
        <span>
          画像{' '}
          <select
            value={imageId ?? ''}
            onChange={(event) => setImageId(event.target.value as ImageId)}
          >
            {images.map((candidate) => (
              <option key={candidate.image_id} value={candidate.image_id}>
                {candidate.width}×{candidate.height} / {candidate.content_hash.slice(0, 8)}
              </option>
            ))}
          </select>
        </span>
        <span>
          クラス体系{' '}
          <select
            value={labelSetId ?? ''}
            onChange={(event) => setLabelSetId(event.target.value as LabelSetId)}
          >
            {labelSets.map((set) => (
              <option key={set.label_set_id} value={set.label_set_id}>
                {set.name}（{set.class_count}）
              </option>
            ))}
          </select>
        </span>
      </div>

      {images.length === 0 && <p className="muted">画像がない。先に推論で取り込むこと。</p>}
      {labelSets.length === 0 && (
        <p className="notice warn">クラス体系がない。上の「クラス体系」で作ること。</p>
      )}

      {image && bitmap && (
        <AnnotationEditor
          image={image}
          bitmap={bitmap}
          classes={classes}
          initial={boxes}
          readOnly={readOnly}
          onSave={save}
          onCreateFromDetections={fromDetections}
        />
      )}

      {revisions.length > 0 && (
        <p className="muted">
          版:{' '}
          {revisions
            .slice(0, 8)
            .map((set) => `rev${set.revision_no}(${set.status}/${set.source})`)
            .join(' ← ')}
        </p>
      )}
    </section>
  );
}
