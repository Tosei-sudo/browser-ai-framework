# Infrastructure（Adapter）

Port の実装を置く層（[03 §4](../../../docs/design/03-system-architecture.md#4-レイヤ構成)）。
Application Layer からは直接参照せず、起動時に注入する。

| ディレクトリ | 実装する Port | 追加するマイルストーン |
| --- | --- | --- |
| `indexeddb/` | `Repositories` / `UnitOfWork` | M1 |
| `opfs/` | `BlobStore` / `StoragePolicy` | M1 |
| `catalog/` | `BaseModelCatalog` | M2 |
| `tfjs/` | `InferenceEngine` / `ModelLoader` / `Preprocessor` / `Postprocessor` | M3 |
| `tfjs/training.ts` | `TrainingEngine` | M5 |

**外部取得ゼロ（論点36・39）。** この層だけが `fetch` を持つが、
取得先は同一オリジンの相対パスに限る。絶対URLを書かないこと。
