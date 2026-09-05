/**
 * BaseModelCatalog — Base Model のメタと重みを取得する（論点22・方針18）。
 *
 * 閉域前提（論点36）のため、取得先は**同一オリジンに同梱された静的ファイル**。
 * 外部ホストへは取りに行かない。実装は相対パスの fetch のみを使う。
 *
 * メタは初回起動時に全件登録し、重みは使用時に取得する（方針18）。
 */
import type { InputSpec, ModelFormat, TaskType } from '@domain/index';

/** カタログJSON の1件。`app/scripts/import-models.mjs` が生成する。 */
export interface BaseModelEntry {
  /** 配信物の中で安定した識別子。再配信しても変わらない */
  readonly key: string;
  readonly name: string;
  readonly task_type: TaskType;
  /** 完成モデルか、学習の土台になるバックボーンか */
  readonly kind: 'full' | 'backbone';
  readonly format: ModelFormat;
  readonly input_spec: InputSpec;
  /** クラス体系。Base Model は自身のクラス集合を持つ（方針11） */
  readonly classes: readonly { readonly index: number; readonly name: string }[];
  /** モデル構造（TF.js の model.json）。小さいので毎回読む */
  readonly topology_path: string;
  /** 重み。使用時にだけ取得して OPFS へ置く（方針18） */
  readonly weights_path: string;
  readonly byte_size: number;
  /** 重みの SHA-256。取り込み時の検証と同一重みの共有に使う */
  readonly checksum: string;
}

export interface BaseModelCatalog {
  /** カタログの全件取得。起動時に呼ぶ（方針18） */
  list(): Promise<BaseModelEntry[]>;
  /** 重みの遅延取得。同一オリジンの相対パスから読む */
  fetchWeights(entry: BaseModelEntry): Promise<ArrayBuffer>;
  /** モデル構造の取得。重みと違い小さい */
  fetchTopology(entry: BaseModelEntry): Promise<unknown>;
}
