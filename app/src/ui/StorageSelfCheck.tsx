/**
 * ストレージ（M1）の自己診断。
 *
 * 04 で決めた次の3点が実際に成立していることを、実機で確かめる。
 *  1. 実体（OPFS）→ メタ（IndexedDB）の順で書ける（論点27）
 *  2. インデックス経由で引ける（04 §4）
 *  3. トランザクションが失敗したとき、メタが部分的に残らない（04 §6.3）
 *
 * 読み取り専用モードでは書き込みを行わないため実行できない（04 §8.3）。
 */
import { useState } from 'react';
import { newId, now, type BlobId, type ContentHash, type ImageId } from '@domain/ids';
import type { Image, ImageBlob, Project } from '@domain/index';
import type { StoragePorts } from '@infrastructure/storage';

async function sha256(data: ArrayBuffer): Promise<ContentHash> {
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('') as ContentHash;
}

async function runSelfCheck(ports: StoragePorts, project: Project): Promise<string[]> {
  const log: string[] = [];
  const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);
  const data = bytes.buffer;
  const contentHash = await sha256(data);
  const blobId = newId<'BlobId'>() as BlobId;
  const imageId = newId<'ImageId'>() as ImageId;

  // 1. 実体を先に書く（論点27）。ここで失敗しても孤児は残らない。
  await ports.blobStore.put({ kind: 'image', id: blobId }, data);
  log.push(`OPFS に書き込み: ${bytes.length} bytes`);

  // 2. メタを単一トランザクションでコミットする。
  const blob: ImageBlob = {
    blob_id: blobId,
    content_hash: contentHash,
    mime_type: 'image/png',
    byte_size: bytes.length,
  };
  const image: Image = {
    image_id: imageId,
    project_id: project.project_id,
    blob_id: blobId,
    width: 2,
    height: 2,
    content_hash: contentHash,
    source: 'upload',
    imported_at: now(),
    deleted_at: null,
  };
  await ports.unitOfWork.run(['image_blobs', 'images'], 'readwrite', async (repos) => {
    await repos.imageBlobs.put(blob);
    await repos.images.put(image);
  });
  log.push('IndexedDB にメタをコミット（image_blobs + images を単一トランザクション）');

  // 3. インデックス経由で引けるか。
  const alive = await ports.repositories.images.listAlive(project.project_id);
  const found = await ports.repositories.images.findByContentHash(project.project_id, contentHash);
  log.push(`[project_id, deleted_at] で ${alive.length} 件、by_content_hash で ${found ? 1 : 0} 件`);
  if (!found || found.image_id !== imageId) throw new Error('インデックスから引けなかった');

  // 4. 実体を読み戻して一致するか。
  const readBack = await ports.blobStore.get({ kind: 'image', id: blobId });
  if (!readBack || readBack.byteLength !== bytes.length) throw new Error('OPFS から読み戻せなかった');
  const same = new Uint8Array(readBack).every((value, i) => value === bytes[i]);
  log.push(`OPFS から読み戻して内容が一致: ${same ? 'はい' : 'いいえ'}`);
  if (!same) throw new Error('読み戻した内容が一致しない');

  // 5. トランザクションの中断で部分的な書き込みが残らないか。
  const strayId = newId<'ImageId'>() as ImageId;
  try {
    await ports.unitOfWork.run(['images'], 'readwrite', async (repos) => {
      await repos.images.put({ ...image, image_id: strayId });
      throw new Error('意図的な失敗');
    });
  } catch {
    // 想定どおり。
  }
  const stray = await ports.repositories.images.get(strayId);
  log.push(`中断したトランザクションの書き込みが残っていない: ${stray === undefined ? 'はい' : 'いいえ'}`);
  if (stray !== undefined) throw new Error('中断したのに書き込みが残っている');

  // 6. 後始末。実体とメタの両方を消す。
  await ports.unitOfWork.run(['image_blobs', 'images'], 'readwrite', async (repos) => {
    await repos.images.delete(imageId);
    await repos.imageBlobs.delete(blobId);
  });
  await ports.blobStore.delete({ kind: 'image', id: blobId });
  log.push('後始末まで完了');
  return log;
}

export function StorageSelfCheck({
  ports,
  project,
  readOnly,
}: {
  ports: StoragePorts;
  project: Project;
  readOnly: boolean;
}): React.ReactElement {
  const [log, setLog] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  const start = (): void => {
    setRunning(true);
    setError(null);
    runSelfCheck(ports, project)
      .then((lines) => setLog(lines))
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause));
        setLog(null);
      })
      .finally(() => setRunning(false));
  };

  return (
    <section>
      <h2>ストレージの自己診断</h2>
      <p className="lead">
        実体（OPFS）→ メタ（IndexedDB）の順で書き、インデックスで引き、
        中断時に部分的な書き込みが残らないことを確かめる。
      </p>
      <button type="button" onClick={start} disabled={running || readOnly}>
        {running ? '実行中…' : '実行する'}
      </button>
      {readOnly && <p className="lead">読み取り専用モードのため実行できません。</p>}
      {error && <p className="notice stop">失敗: {error}</p>}
      {log && <pre className="log">{log.map((line) => `✓ ${line}`).join('\n')}</pre>}
    </section>
  );
}
