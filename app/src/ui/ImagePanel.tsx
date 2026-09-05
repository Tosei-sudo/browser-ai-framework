/**
 * 画像の一覧と削除（方針16 / 持ち越し事項#7）。
 *
 * 削除は論理削除。**推論履歴やデータセットが参照している間は実体を残す**（04 §7）。
 * どこからも参照されなくなったときだけ、実体を物理削除する。
 */
import { useCallback, useEffect, useState } from 'react';
import type { Image, Project } from '@domain/index';
import type { ImageId } from '@domain/ids';
import { deleteImage, listImages } from '../application/imageManager';
import type { StoragePorts } from '@infrastructure/storage';

export function ImagePanel({
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
  const [message, setMessage] = useState<string | null>(null);

  const deps = {
    repositories: ports.repositories,
    unitOfWork: ports.unitOfWork,
    blobStore: ports.blobStore,
  };

  const reload = useCallback(() => {
    listImages(deps, project.project_id)
      .then(setImages)
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ports, project]);

  useEffect(reload, [reload, reloadToken]);

  const remove = (imageId: ImageId): void => {
    void deleteImage(deps, imageId)
      .then((result) => {
        setMessage(
          result.blobRemoved
            ? '削除した（参照が無かったため実体も回収した）'
            : '削除した（履歴が参照しているため実体は残す）',
        );
        reload();
        onChanged();
      })
      .catch((cause: unknown) => setMessage(String(cause)));
  };

  return (
    <section>
      <h2>画像</h2>
      <p className="lead">
        削除は論理削除。推論履歴は残り、詳細では「削除済み」と表示される（方針16）。
      </p>
      {message && <p className="muted">{message}</p>}
      {images.length === 0 && <p className="muted">まだ画像がない。</p>}
      <ul className="history">
        {images.map((image) => (
          <li key={image.image_id}>
            <span className="muted">
              {image.width}×{image.height} / {image.source} /{' '}
              {new Date(image.imported_at).toLocaleString('ja-JP')} /{' '}
              {image.content_hash.slice(0, 8)}…
            </span>
            <button type="button" onClick={() => remove(image.image_id)} disabled={readOnly}>
              削除
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
