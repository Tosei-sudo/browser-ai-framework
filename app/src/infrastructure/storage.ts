/**
 * ストレージ側 Port の組み立て（合成ルート）。
 *
 * ここだけが IndexedDB / OPFS を知っている。Application Layer には
 * `Repositories` / `UnitOfWork` / `BlobStore` / `StoragePolicy` として渡す。
 */
import type { BlobStore, StoragePolicy } from '@ports/blobStore';
import type { Repositories, UnitOfWork } from '@ports/repository';
import { openDatabase } from './indexeddb/open';
import { createRepositories } from './indexeddb/repositories';
import { createUnitOfWork } from './indexeddb/unitOfWork';
import { directProvider } from './indexeddb/support';
import { createOpfsBlobStore } from './opfs/blobStore';
import { createStoragePolicy } from './opfs/storagePolicy';

export interface StoragePorts {
  readonly repositories: Repositories;
  readonly unitOfWork: UnitOfWork;
  readonly blobStore: BlobStore;
  readonly storagePolicy: StoragePolicy;
  /** 読み取り専用で開いた理由。null なら通常モード（04 §8.3） */
  readonly readOnlyReason: string | null;
}

export async function createStoragePorts(): Promise<StoragePorts> {
  const state = await openDatabase();
  const readOnlyReason = state.kind === 'readonly' ? state.reason : null;
  return {
    repositories: createRepositories(directProvider(state.db)),
    unitOfWork: createUnitOfWork(state.db, readOnlyReason !== null),
    blobStore: createOpfsBlobStore(),
    storagePolicy: createStoragePolicy(),
    readOnlyReason,
  };
}
