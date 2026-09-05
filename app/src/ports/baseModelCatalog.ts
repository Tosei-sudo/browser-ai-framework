/**
 * BaseModelCatalog — Base Model のメタと重みを取得する（論点22・方針18）。
 *
 * 閉域前提（論点36）のため、取得先は**同一オリジンに同梱された静的ファイル**。
 * 外部ホストへは絶対に取りに行かない。実装は相対パスの fetch のみを使う。
 *
 * メタは初回起動時に全件登録し、重みは使用時に取得する（方針18）。
 */
import type { InputSpec, ModelFormat, TaskType } from '@domain/index';

/** カタログJSON の1件。`Model` へ変換して `models` ストアへ登録する。 */
export interface BaseModelEntry {
  /** 配信物の中で安定した識別子。再配信しても変わらない */
  readonly key: string;
  readonly name: string;
  readonly task_type: TaskType;
  readonly format: ModelFormat;
  readonly input_spec: InputSpec;
  readonly byte_size: number;
  readonly checksum: string;
  /** クラス体系。Base Model は自身のクラス集合を持つ */
  readonly classes: readonly { readonly index: number; readonly name: string }[];
  /** 重みの取得先。配信物内の相対パス */
  readonly weights_path: string;
}

export interface BaseModelCatalog {
  /** カタログの全件取得。起動時に1度だけ呼ぶ（方針18） */
  list(): Promise<BaseModelEntry[]>;
  /** 重みの遅延取得。同一オリジンの相対パスから読む */
  fetchWeights(entry: BaseModelEntry): Promise<ArrayBuffer>;
}
