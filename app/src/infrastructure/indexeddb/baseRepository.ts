/**
 * すべての Repository に共通する基本操作の実装。
 *
 * ドメインの値とレコードの差（`pinned` の 0/1 など）は `encode` / `decode` で吸収する。
 * ストア名からエンティティ型が決まる（`StoreEntityMap`）ため、
 * 呼び出し側は型引数を書かなくてよい。
 */
import type { Repository } from '@ports/repository';
import type { StoreName } from '@ports/stores';
import type { StoreEntityMap } from './storeEntities';
import { getAll, req, type StoreProvider } from './support';

export interface Codec<TEntity> {
  encode(entity: TEntity): unknown;
  decode(record: unknown): TEntity;
}

/** 変換の要らないストア用。 */
export function identityCodec<TEntity>(): Codec<TEntity> {
  return {
    encode: (entity) => entity,
    decode: (record) => record as TEntity,
  };
}

export function createBaseRepository<S extends StoreName, TId extends string>(
  provider: StoreProvider,
  storeName: S,
  codec: Codec<StoreEntityMap[S]>,
): Repository<StoreEntityMap[S], TId> {
  return {
    async get(id) {
      const record = await req(provider(storeName, 'readonly').get(id) as IDBRequest<unknown>);
      return record === undefined ? undefined : codec.decode(record);
    },
    async getMany(ids) {
      const store = provider(storeName, 'readonly');
      const records = await Promise.all(
        ids.map((id) => req(store.get(id) as IDBRequest<unknown>)),
      );
      return records.filter((record) => record !== undefined).map((record) => codec.decode(record));
    },
    async put(entity) {
      await req(provider(storeName, 'readwrite').put(codec.encode(entity)));
    },
    async putMany(entities) {
      const store = provider(storeName, 'readwrite');
      await Promise.all(entities.map((entity) => req(store.put(codec.encode(entity)))));
    },
    async delete(id) {
      await req(provider(storeName, 'readwrite').delete(id));
    },
    async count() {
      return req(provider(storeName, 'readonly').count());
    },
  };
}

/** インデックスから全件取り出して復号する。 */
export async function listByIndex<S extends StoreName>(
  provider: StoreProvider,
  storeName: S,
  indexName: string,
  codec: Codec<StoreEntityMap[S]>,
  query?: IDBKeyRange | IDBValidKey,
): Promise<StoreEntityMap[S][]> {
  const index = provider(storeName, 'readonly').index(indexName);
  const records = await getAll<unknown>(index, query);
  return records.map((record) => codec.decode(record));
}

/** インデックスの先頭1件。 */
export async function findByIndex<S extends StoreName>(
  provider: StoreProvider,
  storeName: S,
  indexName: string,
  codec: Codec<StoreEntityMap[S]>,
  query: IDBKeyRange | IDBValidKey,
): Promise<StoreEntityMap[S] | undefined> {
  const index = provider(storeName, 'readonly').index(indexName);
  const record = await req(index.get(query) as IDBRequest<unknown>);
  return record === undefined ? undefined : codec.decode(record);
}

/** インデックスの件数。参照の有無を判定するのに使う（04 §7）。 */
export async function countByIndex(
  provider: StoreProvider,
  storeName: StoreName,
  indexName: string,
  query: IDBKeyRange | IDBValidKey,
): Promise<number> {
  return req(provider(storeName, 'readonly').index(indexName).count(query));
}
