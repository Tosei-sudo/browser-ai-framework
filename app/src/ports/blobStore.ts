/**
 * BlobStore — 大容量バイナリ（画像・重み）の格納（03 §5）。
 *
 * 実装は OPFS（論点25）。IndexedDB 実装は保険であり、
 * 論点36でブラウザが確定したため MVP の必須項目ではない。
 *
 * ファイル名は ID そのものにする。起動時の孤児GC（04 §6.2）で
 * IndexedDB のメタと突き合わせるため。
 */
import type { ArtifactId, BlobId } from '@domain/ids';

/** 実体の置き場所。OPFS 上のディレクトリに対応する。 */
export type BlobKind = 'image' | 'model';

export type BlobKey =
  | { readonly kind: 'image'; readonly id: BlobId }
  | { readonly kind: 'model'; readonly id: ArtifactId };

export interface BlobStore {
  /** 実体を書き込む。メタより先に書く（論点27） */
  put(key: BlobKey, data: ArrayBuffer): Promise<void>;
  get(key: BlobKey): Promise<ArrayBuffer | undefined>;
  exists(key: BlobKey): Promise<boolean>;
  /** 物理削除。参照が無いことを確認してから呼ぶ（04 §7） */
  delete(key: BlobKey): Promise<void>;
  byteSize(key: BlobKey): Promise<number | undefined>;
  /** 孤児GC 用。その種別に実在するファイルの ID を列挙する */
  listIds(kind: BlobKind): Promise<string[]>;
}

/** 永続化の要求と現在の容量（論点23・26）。 */
export interface StorageEstimate {
  readonly usage: number;
  readonly quota: number;
  /** `navigator.storage.persisted()` の結果。PoC では拒否された（06 §3.4） */
  readonly persisted: boolean;
}

export interface StoragePolicy {
  /** `navigator.storage.persist()` を要求する。拒否されうる前提で扱う（論点26） */
  requestPersistence(): Promise<boolean>;
  estimate(): Promise<StorageEstimate>;
}
