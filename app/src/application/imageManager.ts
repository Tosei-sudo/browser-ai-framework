/**
 * ImageManager — 画像の取り込みと重複排除（方針16）。
 *
 * 同じ画像を2回入れても実体は1つ。`content_hash` で判定する。
 * 書き込み順序は **実体（OPFS）→ メタ（IndexedDB）**（論点27）。
 */
import { newId, now, sha256Hex } from '@domain/ids';
import type { BlobId, ImageId, ProjectId } from '@domain/ids';
import type { Image, ImageBlob } from '@domain/index';
import type { BlobStore } from '@ports/blobStore';
import type { Repositories, UnitOfWork } from '@ports/repository';

export interface ImageManagerDeps {
  readonly repositories: Repositories;
  readonly unitOfWork: UnitOfWork;
  readonly blobStore: BlobStore;
}

export interface ImportResult {
  readonly image: Image;
  /** 既存の画像と同じ内容だったか（方針16の重複排除） */
  readonly deduplicated: boolean;
}

export async function importImage(
  deps: ImageManagerDeps,
  projectId: ProjectId,
  file: File,
): Promise<ImportResult> {
  const bytes = await file.arrayBuffer();
  const contentHash = await sha256Hex(bytes);

  const existing = await deps.repositories.images.findByContentHash(projectId, contentHash);
  if (existing) return { image: existing, deduplicated: true };

  // 寸法はメタとして持つ（方針15の前処理で使う）。
  const bitmap = await createImageBitmap(file);
  const width = bitmap.width;
  const height = bitmap.height;
  bitmap.close();

  // 実体が既にあれば共有する。無ければ書く。
  const sharedBlob = await deps.repositories.imageBlobs.findByContentHash(contentHash);
  const blobId = sharedBlob?.blob_id ?? (newId<'BlobId'>() as BlobId);
  if (!sharedBlob) {
    await deps.blobStore.put({ kind: 'image', id: blobId }, bytes);
  }

  const blob: ImageBlob = sharedBlob ?? {
    blob_id: blobId,
    content_hash: contentHash,
    mime_type: file.type || 'application/octet-stream',
    byte_size: bytes.byteLength,
  };
  const image: Image = {
    image_id: newId<'ImageId'>() as ImageId,
    project_id: projectId,
    blob_id: blobId,
    width,
    height,
    content_hash: contentHash,
    source: 'upload',
    imported_at: now(),
    deleted_at: null,
  };

  await deps.unitOfWork.run(['image_blobs', 'images'], 'readwrite', async (repos) => {
    await repos.imageBlobs.put(blob);
    await repos.images.put(image);
  });
  return { image, deduplicated: false };
}

/** 画像の実体を読む。推論と表示で使う。 */
export async function loadImageBitmap(
  deps: ImageManagerDeps,
  image: Image,
): Promise<ImageBitmap> {
  const bytes = await deps.blobStore.get({ kind: 'image', id: image.blob_id });
  if (!bytes) throw new Error(`画像の実体が見つからない: ${image.image_id}`);
  const blobMeta = await deps.repositories.imageBlobs.get(image.blob_id);
  return createImageBitmap(new Blob([bytes], { type: blobMeta?.mime_type ?? 'image/png' }));
}
