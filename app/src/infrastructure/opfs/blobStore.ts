/**
 * BlobStore の OPFS 実装（論点25）。
 *
 * ファイル名は ID そのもの。起動時の孤児GC（04 §6.2）で IndexedDB のメタと
 * 突き合わせるため、名前に余計な情報を含めない。
 *
 * 配置:
 *   blobs/images/{blob_id}
 *   blobs/models/{artifact_id}
 */
import type { BlobKey, BlobKind, BlobStore } from '@ports/blobStore';

const ROOT_DIR = 'blobs';

const DIRECTORY: Record<BlobKind, string> = {
  image: 'images',
  model: 'models',
};

async function directoryFor(kind: BlobKind, create: boolean): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  const blobs = await root.getDirectoryHandle(ROOT_DIR, { create });
  return blobs.getDirectoryHandle(DIRECTORY[kind], { create });
}

async function fileFor(key: BlobKey, create: boolean): Promise<FileSystemFileHandle> {
  const dir = await directoryFor(key.kind, create);
  return dir.getFileHandle(key.id, { create });
}

/** 存在しない場合の `NotFoundError` を undefined として扱う。 */
async function orUndefined<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof DOMException && error.name === 'NotFoundError') return undefined;
    throw error;
  }
}

export function createOpfsBlobStore(): BlobStore {
  return {
    async put(key, data) {
      const file = await fileFor(key, true);
      const writable = await file.createWritable();
      try {
        await writable.write(data);
      } finally {
        await writable.close();
      }
    },

    async get(key) {
      const handle = await orUndefined(() => fileFor(key, false));
      if (!handle) return undefined;
      const file = await handle.getFile();
      return file.arrayBuffer();
    },

    async exists(key) {
      return (await orUndefined(() => fileFor(key, false))) !== undefined;
    },

    async delete(key) {
      const dir = await orUndefined(() => directoryFor(key.kind, false));
      if (!dir) return;
      await orUndefined(() => dir.removeEntry(key.id));
    },

    async byteSize(key) {
      const handle = await orUndefined(() => fileFor(key, false));
      if (!handle) return undefined;
      return (await handle.getFile()).size;
    },

    async listIds(kind) {
      const dir = await orUndefined(() => directoryFor(kind, false));
      if (!dir) return [];
      const ids: string[] = [];
      // TypeScript の DOM 型定義に FileSystemDirectoryHandle の反復メソッドが
      // 含まれていないため、ここだけ形を明示する（型定義パッケージを増やさない）。
      const entries = dir as unknown as { keys(): AsyncIterableIterator<string> };
      for await (const name of entries.keys()) {
        ids.push(name);
      }
      return ids;
    },
  };
}
