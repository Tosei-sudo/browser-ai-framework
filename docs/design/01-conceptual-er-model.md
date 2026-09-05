# 概念ERモデル

| 項目 | 内容 |
| --- | --- |
| ステータス | 一部合意（設計方針10件が確定、属性レベルの一部が未確定） |
| 対象 | `order.txt` §12「次の作業」 |
| 最終更新 | 2026-09-05 |
| 関連 | [02-open-decisions.md](./02-open-decisions.md) |

## 1. このドキュメントの位置づけ

`order.txt` で挙げられた管理対象データを、概念レベルのエンティティとリレーションとして定義する。

物理DB設計・ストレージ実装（IndexedDB 等）・MLランタイム（ONNX / WebGPU / WASM 等）・モデル形式の選定は本ドキュメントのスコープ外とする。ここで確定させるのは「何を管理し、何と何がどう関係するか」のみ。

各エンティティには以下のステータスを付す。

- **合意済** — チームで合意済み。以降の設計はこれを前提にしてよい。
- **暫定** — 提案済みだが未合意。依存する論点番号を併記する。決定は [02-open-decisions.md](./02-open-decisions.md) を参照。

## 2. 合意済みの設計方針

`order.txt` の原案に対し、以下10件の変更を合意した。

### 方針1. クラス体系を独立エンティティとして管理する（論点01）

クラス名を `Annotation` と `Detection` にそれぞれ文字列で持たせない。`LabelSet` / `LabelClass` を導入し、両者が同じクラス語彙を参照する。

理由:

- 文字列で持つと表記ゆれで同一クラスが分裂し、Dataset のクラス整合性が保証できない。
- モデルの出力次元（0, 1, 2 …）とクラス名の対応を保持する場所がない。
- 転移学習では「元モデルのクラスを引き継ぐ／捨てる／追加する」が必ず発生する。これを表現できる構造が必要。

### 方針2. Dataset を可変コンテナと不変スナップショットに分離する（論点02）

`Dataset`（可変）と `DatasetVersion`（不変）を分ける。`Training` および `Evaluation` が参照するのは `DatasetVersion` のみとする。

理由: `Training` が可変の `Dataset` を直接参照すると、学習後に画像を1枚追加しただけで「どのデータで学習したか」の答えが変わる。`order.txt` §11 の設計思想③「データを捨てない」は、スナップショットなしには成立しない。

### 方針3. Training Result を独立エンティティとしない（論点03）

`Training : TrainingResult` が 1:1 になる分割は冗長。「学習結果」に混在している3つの概念を分解する。

| 元の概念 | 分解後 | 多重度 |
| --- | --- | --- |
| 最終サマリ | `Training` の属性 | 1:1（属性に内包） |
| epoch ごとの推移 | `TrainingMetric` | 1:N |
| 汎化性能 | `Evaluation` | 学習とは別タイミングで何度でも実行しうる |

### 方針4. Evaluation を管理対象に追加する（論点04）

`order.txt` §9 の Application Layer には Evaluation Manager があるが、§6 の管理対象データに対応する項目がなかった。`Evaluation` / `EvaluationMetric` を追加する。

理由: 学習条件の異なるモデル同士は、それぞれの `Training` が持つ val 指標では比較できない。共通のテストセットに対する測定が別途必要。

### 方針5. Annotation を2階層にする（論点05）

`AnnotationSet`（画像1枚 × 1版）と `AnnotationObject`（矩形1個）に分割する。

理由: 単一階層では、アノテーション作業の完了状態・バージョン・由来を記録する場所がない。`Inference` / `Detection` が2階層であることとも対称になる。

### 方針6. モデルのメタと重みを分離する（論点06）

`Model`（メタ・永久保存）と `ModelArtifact`（重み・削除可）を分離し、`Model.artifact_status` で実体の有無を表す。

理由: 系譜を辿れるようにするため全世代のモデルを保持すると、1世代あたり数十MBの重みがブラウザストレージを圧迫する。系譜（追跡性）と重み（実行可能性）は別の寿命を持つべき。

### 方針7. 系譜を ModelDerivation として独立させる（論点07）

親子関係を `Model` の自己参照や `Training` からの導出で表現せず、`ModelDerivation` を独立エンティティとして持つ。`kind` により派生の種別を区別する。

```text
kind : transfer_learning | fine_tune | convert | quantize | import
```

理由:

- 学習を伴わない派生（インポート・形式変換・量子化）を同じ系譜に載せられる。`Training` からの導出だけではこれらを表現できない。
- 将来のモデル統合（複数親）に構造を変えずに対応できる。
- 祖先を辿るクエリが `Training` を経由せずに済む。

`Training` による派生の場合は `ModelDerivation.training_id` に学習処理を紐づけ、系譜と学習履歴の両方から辿れるようにする。

### 方針8. ModelVersion を持たない（論点08）

`Model` を不変ノードとして扱い、系譜そのものをバージョン履歴とする。`ModelVersion` エンティティは作らない。

理由: 転移学習の出力は「同じモデルの新バージョン」ではなく「別のモデル」である。version 番号と lineage を同時に管理すると必ず矛盾する — 例えば Model B から2本派生したとき、両方が v2 になる。

系列名や世代番号の表示が必要になった場合は `ModelFamily` の追加を再検討するが、現時点では導入しない。

### 方針9. 推論を3階層にする（論点11）

`Inference`（実行1回）→ `InferenceTarget`（画像1枚）→ `Detection`（検出1件）の3階層とする。

理由: 複数画像の一括推論に構造を変えずに対応できる。1画像だけの場合も `InferenceTarget` が1件になるだけでコストはほぼない。画像ごとの成否（`status`）と処理時間（`elapsed_ms`）を持つ場所ができる。

### 方針10. Project を導入する（論点16）

`Project` を導入し、一覧のスコープ分割・一括エクスポート・用途ごとのクラス体系分離を可能にする。

`project_id` を持たせる範囲は以下とする。

| 区分 | エンティティ | 理由 |
| --- | --- | --- |
| `project_id` を持つ | `Image`, `LabelSet`, `Dataset`, `Model`, `Training`, `Evaluation`, `Inference` | ユーザーが一覧で直接扱うトップレベル資産 |
| 持たない（親から辿れる） | `AnnotationSet`, `AnnotationObject`, `DatasetVersion`, `DatasetItem`, `TrainingMetric`, `EvaluationMetric`, `InferenceTarget`, `Detection`, `ModelDerivation` | 親エンティティのスコープに従う |
| 持たない（横断共有） | `ImageBlob`, `ModelArtifact` | `content_hash` / `checksum` による重複排除の対象であり、プロジェクトをまたいで共有されうる |

この分類のうち、開発者提供 Base Model の扱いとプロジェクト間参照の可否は未確定。論点18で確定させる。

## 3. エンティティ一覧

### A. 画像・アノテーション資産

| エンティティ | ステータス | 役割 | ライフサイクル |
| --- | --- | --- | --- |
| `Image` | 合意済 | 画像1枚の同一性とメタ情報 | 不変（メタは可変） |
| `ImageBlob` | 暫定（論点15） | ピクセルデータの実体 | 不変 |
| `AnnotationSet` | 合意済 | 1画像に対する1版のアノテーション | 不変（版を積む） |
| `AnnotationObject` | 合意済 | 矩形1個 | 不変 |
| `LabelSet` | 合意済 | クラス体系 | 不変 |
| `LabelClass` | 合意済 | クラス定義 | 不変 |
| `Dataset` | 合意済 | 論理コンテナ（編集し続ける作業領域） | 可変 |
| `DatasetVersion` | 合意済 | 学習に投入した時点のスナップショット | 不変 |
| `DatasetItem` | 合意済 | 版 × 画像 × アノテーション版 × split | 不変 |

`ImageBlob` の分離は方針6（`ModelArtifact` の分離）と同じ理由による対称的な措置だが、明示的な合意は取っていない。論点15（削除の扱い）と併せて確定させる。

### B. モデルと学習

| エンティティ | ステータス | 役割 | ライフサイクル |
| --- | --- | --- | --- |
| `Model` | 合意済 | 系譜上の1ノード。メタのみ、永久保存 | 不変 |
| `ModelArtifact` | 合意済 | 重み本体。破棄しても系譜は残る | 不変・削除可 |
| `ModelDerivation` | 合意済 | 派生関係。学習以外の派生も表現 | 不変 |
| `Training` | 合意済 | 学習処理1回。学習条件を内包 | 進行中は可変 → 完了後は不変 |
| `TrainingMetric` | 合意済 | epoch 単位の学習曲線 | 不変・追記 |

### C. 実行と結果

| エンティティ | ステータス | 役割 | ライフサイクル |
| --- | --- | --- | --- |
| `Evaluation` | 合意済 | モデル × テストセットの性能測定 | 不変 |
| `EvaluationMetric` | 合意済 | 全体 / クラス別のスコア | 不変 |
| `Inference` | 合意済 | 推論実行1回 | 不変 |
| `InferenceTarget` | 合意済 | 実行 × 画像1枚 | 不変 |
| `Detection` | 合意済 | 検出1件 | 不変 |

### 横断

| エンティティ | ステータス | 役割 | ライフサイクル |
| --- | --- | --- | --- |
| `Project` | 合意済 | スコープ分割・一括エクスポート単位 | 可変 |

### 採用しないもの

| 名称 | 判断 | 理由 |
| --- | --- | --- |
| `TrainingResult` | 不採用（合意済） | 方針3のとおり3つに分解した |
| `ModelVersion` | 不採用（合意済） | 系譜との二重管理になる。方針8を参照 |
| `ModelFamily` | 現時点では不採用 | 方針8の付随判断。系列表示が必要になった時点で再検討する |
| `User` | 不採用 | ブラウザ完結のため。開発者提供／ユーザー作成の区別は `Model.origin` で表す |

## 4. エンティティ定義

属性は概念レベルの例示であり、型・制約・命名規則は物理設計フェーズで確定する。

### A. 画像・アノテーション資産

#### Image

複数の Dataset・推論から共有参照される。1枚の画像を複数の Dataset で利用できることを保証する起点。

```text
image_id
project_id
blob_id
width / height
content_hash
source           : upload | capture | import
imported_at
deleted_at       : 論理削除（論点15）
```

#### ImageBlob

`content_hash` 一致で重複排除し、同じ画像の二重保存を防ぐ。

```text
blob_id
content_hash
mime_type
byte_size
data
```

#### AnnotationSet

「ある画像に対する、ある時点の、完成した1版のアノテーション」。編集のたびに新しい版を作り、過去の学習が参照した内容を保存する。

```text
annotation_set_id
image_id
label_set_id
revision_no
status           : draft | confirmed
source           : manual | imported | from_detection   ← 論点09
origin_target_id : 推論結果由来の場合の InferenceTarget  ← 論点09
created_at
```

#### AnnotationObject

```text
object_id
annotation_set_id
label_class_id     ← 文字列ではなく参照
bbox               : x, y, w, h
bbox_format
attributes
```

#### LabelSet

`Dataset` と `Model` が「同じクラス集合の話をしている」ことを保証する唯一の仕組み。

```text
label_set_id
project_id
name
class_count
derived_from_label_set_id
```

#### LabelClass

`index` がモデル出力の次元との対応を固定する。

```text
label_class_id
label_set_id
name
index
color
```

#### Dataset

ユーザーが編集し続ける論理的な作業領域。画像の出し入れが起きる前提で、可変であることを許容する。

```text
dataset_id
project_id
name
label_set_id
description
created_at / updated_at
```

#### DatasetVersion

学習を開始した時点で切り出す不変スナップショット。`Training` が参照するのは `Dataset` ではなく必ずこちら。

```text
dataset_version_id
dataset_id
version_no
item_count
split_policy
frozen_at
```

#### DatasetItem

版・画像・アノテーション版・split の4点を結びつける。「この学習は画像 X の rev3 のアノテーションを train として使った」を確定させる。

```text
item_id
dataset_version_id
image_id
annotation_set_id     ← 使用したアノテーションの版を固定
split                 : train | val | test
```

### B. モデルと学習

#### Model

系譜上の1ノード。一度作られたら中身は変わらない（不変）ため、更新ではなく派生でしか増えない。メタは軽量なので永久保存する。

```text
model_id
project_id           : builtin モデルの扱いは論点18
name
origin               : builtin | user_trained | imported
task_type
label_set_id
input_spec           : size, normalize, letterbox    ← 論点12
artifact_id
artifact_status      : present | evicted
created_by_training_id
created_at
```

#### ModelArtifact

```text
artifact_id
format
byte_size
checksum
data
stored_at
```

#### ModelDerivation

モデルの親子関係。`kind` により派生の種別を区別し、学習を伴わない派生も同じ系譜に載せる。

```text
derivation_id
parent_model_id
child_model_id
kind                : transfer_learning | fine_tune | convert | quantize | import
training_id         : nullable（学習由来の場合のみ）
created_at
```

通常は子から見た親が1件だが、将来のモデル統合に備えて多重度は N — N とする（[§5](#5-リレーション)）。

#### Training

学習処理1回。source model・dataset version・学習条件・実行状態を保持する。

```text
training_id
project_id
source_model_id
dataset_version_id
output_model_id       : nullable（論点13）
label_mapping         : source model のクラス → dataset のクラス
hyperparameters       : epochs, lr, batch_size, frozen_layers …
augmentation
status                : running | completed | failed | cancelled   ← 論点13
started_at / ended_at
final_metrics
error_message
runtime_info
```

#### TrainingMetric

学習曲線を後から再描画するために 1:N で持つ。

```text
metric_id
training_id
epoch
metric_name
value
logged_at
```

### C. 実行と結果

#### Evaluation

```text
evaluation_id
project_id
model_id
dataset_version_id
split_used
conf_threshold / iou_threshold
executed_at
```

#### EvaluationMetric

mAP、クラス別 AP、precision / recall など。`label_class_id` が null のものは全体スコア。

```text
metric_id
evaluation_id
label_class_id        : nullable
metric_name
value
```

#### Inference

実行時パラメータはモデル属性ではなくここに置く（論点12）。

```text
inference_id
project_id
model_id
conf_threshold / iou_threshold / max_detections
runtime_info
executed_at
pinned                ← 論点10
```

#### InferenceTarget

実行 × 画像1枚。複数画像をまとめて処理する場合の受け皿で、画像ごとの成否と処理時間もここで持つ。

```text
target_id
inference_id
image_id
status                : succeeded | failed | skipped
elapsed_ms
error_message
```

#### Detection

クラスは `label_class_id` 参照で持つため、後からクラス名を変えても履歴が壊れない。

```text
detection_id
target_id
label_class_id
confidence
bbox                  : x, y, w, h
rank
```

### 横断

#### Project

トップレベル資産のスコープ単位。一覧表示・一括エクスポート・クラス体系の分離をこの単位で行う。

```text
project_id
name
description
created_at / updated_at
```

## 5. リレーション

| 親 | 多重度 | 子 | 設計意図 |
| --- | --- | --- | --- |
| `Project` | 1 — N | `Image` / `LabelSet` / `Dataset` / `Model` / `Training` / `Evaluation` / `Inference` | トップレベル資産のスコープ単位（方針10） |
| `LabelSet` | 1 — N | `LabelClass` | クラス名とモデル出力 index の対応をここで固定 |
| `Image` | 1 — N | `AnnotationSet` | 1画像に複数版。最新版だけでなく履歴を保持 |
| `AnnotationSet` | 1 — N | `AnnotationObject` | 版の中に矩形が複数。0個（背景画像）も有効 |
| `AnnotationObject` | N — 1 | `LabelClass` | クラスは文字列ではなく参照 |
| `Dataset` | 1 — N | `DatasetVersion` | 可変コンテナ／不変スナップショットの分離 |
| `DatasetVersion` | 1 — N | `DatasetItem` | その版に含まれる画像の確定リスト |
| `Image` | 1 — N | `DatasetItem` | **1枚の画像を複数 Dataset で再利用可能** |
| `AnnotationSet` | 1 — N | `DatasetItem` | **どの版のアノテーションで学習したかを固定** |
| `Model`(source) | 1 — N | `Training` | 1つのベースモデルから何度でも派生できる |
| `DatasetVersion` | 1 — N | `Training` | 同じデータで条件を変えた学習を比較できる |
| `Training` | 1 — 0..1 | `Model`(output) | 失敗・中断した学習は出力モデルを持たない（論点13） |
| `Training` | 1 — N | `TrainingMetric` | epoch 単位の学習曲線 |
| `Model` | 1 — 0..1 | `ModelArtifact` | 重みを破棄しても系譜ノードは残る |
| `Model` | N — N | `Model`（`ModelDerivation` 経由） | 親子。通常は子から見て親1、将来の統合に備えて N — N（方針7） |
| `Training` | 1 — 0..1 | `ModelDerivation` | 学習由来の派生を系譜と紐づける |
| `Model` | N — 1 | `LabelSet` | モデルが出力できるクラス集合 |
| `Model` | 1 — N | `Inference` | 推論履歴はモデルに紐づく |
| `Inference` | 1 — N | `InferenceTarget` | バッチ実行と画像単位の成否を表現（方針9） |
| `Image` | 1 — N | `InferenceTarget` | 同じ画像に別モデルで何度でも推論できる |
| `InferenceTarget` | 1 — N | `Detection` | 検出0件も「検出されなかった」という結果 |
| `Detection` | N — 1 | `LabelClass` | 推論結果とアノテーションが同じクラス語彙を使う |
| `InferenceTarget` | 1 — 0..1 | `AnnotationSet` | 推論結果を下書きに昇格した場合の由来（論点09） |
| `Model` | 1 — N | `Evaluation` | 同一モデルを複数テストセットで測定 |
| `Evaluation` | 1 — N | `EvaluationMetric` | 全体スコアとクラス別スコア |

## 6. ER図

```mermaid
erDiagram
  PROJECT         ||--o{ IMAGE             : "所有する"
  PROJECT         ||--o{ LABEL_SET         : "所有する"
  PROJECT         ||--o{ DATASET           : "所有する"
  PROJECT         ||--o{ MODEL             : "所有する"
  PROJECT         ||--o{ TRAINING          : "所有する"
  PROJECT         ||--o{ EVALUATION        : "所有する"
  PROJECT         ||--o{ INFERENCE         : "所有する"

  LABEL_SET       ||--o{ LABEL_CLASS       : "定義する"
  IMAGE           ||--|| IMAGE_BLOB        : "実体"
  IMAGE           ||--o{ ANNOTATION_SET    : "版を持つ"
  ANNOTATION_SET  ||--o{ ANNOTATION_OBJECT : "含む"
  ANNOTATION_SET  }o--|| LABEL_SET         : "準拠する"
  ANNOTATION_OBJECT }o--|| LABEL_CLASS     : "分類"

  DATASET         }o--|| LABEL_SET         : "採用する"
  DATASET         ||--o{ DATASET_VERSION   : "凍結する"
  DATASET_VERSION ||--o{ DATASET_ITEM      : "含む"
  DATASET_ITEM    }o--|| IMAGE             : "参照"
  DATASET_ITEM    }o--|| ANNOTATION_SET    : "版を固定"

  MODEL           }o--|| LABEL_SET         : "出力する"
  MODEL           ||--o| MODEL_ARTIFACT    : "重み"
  MODEL           ||--o{ MODEL_DERIVATION  : "親として"
  MODEL           ||--o| MODEL_DERIVATION  : "子として"

  MODEL           ||--o{ TRAINING          : "source として"
  DATASET_VERSION ||--o{ TRAINING          : "学習に使用"
  TRAINING        ||--o| MODEL             : "output を生成"
  TRAINING        ||--o| MODEL_DERIVATION  : "派生を記録"
  TRAINING        ||--o{ TRAINING_METRIC   : "epoch ログ"

  MODEL           ||--o{ EVALUATION        : "評価される"
  DATASET_VERSION ||--o{ EVALUATION        : "test に使用"
  EVALUATION      ||--o{ EVALUATION_METRIC : "スコア"

  MODEL           ||--o{ INFERENCE         : "実行する"
  INFERENCE       ||--o{ INFERENCE_TARGET  : "画像単位"
  IMAGE           ||--o{ INFERENCE_TARGET  : "対象"
  INFERENCE_TARGET ||--o{ DETECTION        : "検出"
  DETECTION       }o--|| LABEL_CLASS       : "分類"
  INFERENCE_TARGET ||--o| ANNOTATION_SET   : "下書きに昇格"
```

エンティティの構成は確定した。残る未確定は以下の2点のみで、いずれも属性レベルまたは適用範囲の問題であり、エンティティの追加・削除は伴わない。

| 図中の要素 | 依存する論点 |
| --- | --- |
| `INFERENCE_TARGET ||--o| ANNOTATION_SET`（推論結果の下書き昇格） | 論点09 |
| `IMAGE ||--|| IMAGE_BLOB`（実体分離の要否） | 論点15 |

`PROJECT` の所有関係は方針10の分類に従う。`ImageBlob` / `ModelArtifact` はプロジェクト横断で共有されうるため `PROJECT` に紐づけない。Base Model（`origin = builtin`）をどのプロジェクトに置くかは論点18で確定させる。

## 7. モデル系譜の追跡経路

方針「モデルそのものと学習処理を分離する」（`order.txt` §11 ①）の実現形。

```mermaid
flowchart LR
  A["Model A&#10;origin: builtin"]
  T1["Training X&#10;epochs 30 / lr 1e-4"]
  B["Model B&#10;origin: user_trained"]
  T2["Training Y&#10;epochs 10 / lr 5e-5"]
  C["Model C"]
  DV1["DatasetVersion v1&#10;items 120"]
  DV2["DatasetVersion v2&#10;items 340"]

  A -->|source_model| T1
  DV1 -->|dataset_version| T1
  T1 -->|output_model| B
  B -->|source_model| T2
  DV2 -->|dataset_version| T2
  T2 -->|output_model| C

  A -.->|"ModelDerivation&#10;kind: transfer_learning"| B
  B -.->|"ModelDerivation&#10;kind: transfer_learning"| C
```

実線が実際の処理の流れ、点線が系譜の直接参照。この構造により以下が追跡できる。

- **どのモデルから派生したか** — `Training.source_model_id` を辿る。
- **どのデータで学習したか** — `Training.dataset_version_id` → `DatasetItem` → `Image` + `AnnotationSet`（版まで確定）。
- **どんな条件で学習したか** — `Training.hyperparameters` / `label_mapping` / `augmentation`。
- **学習がどう進んだか** — `TrainingMetric`。
- **どれくらいの性能か** — `Evaluation` / `EvaluationMetric`。

`ModelDerivation` は学習由来の派生では `training_id` を持つため、系譜（点線）から学習履歴（実線）へ直接辿れる。インポートや形式変換による派生は `training_id` を持たず、`kind` で区別される。

## 8. 未確定事項

8件の未決事項を [02-open-decisions.md](./02-open-decisions.md) で管理する。ER構造を変える論点（07 / 08 / 11 / 16）は合意済みのため、残るものはいずれも属性レベル、機能スコープ、または適用範囲の判断となる。

| 論点 | 内容 | 優先度 |
| --- | --- | --- |
| 18 | `Project` のスコープ境界（Base Model の所属、プロジェクト間参照） | 高 |
| 09 | 推論結果のアノテーション下書き化 | 中 |
| 13 | 失敗・中断した Training の扱い | 中 |
| 14 | 開発者提供 Base Model の同一性と更新 | 中 |
| 15 | 削除の扱い（`ImageBlob` の分離を含む） | 中 |
| 10 | 推論履歴の保持ポリシー | 中 |
| 12 | 前処理・実行パラメータの配置 | 低 |
| 17 | ID採番とポータビリティ | 低 |

## 9. 次の作業

`order.txt` §12 に従い、ER図確定後に以下へ進む。

1. システム構成図
2. ブラウザ内コンポーネント構成
3. ストレージ設計 — 特に `ModelArtifact` / `ImageBlob` の格納方式と容量上限の扱いが焦点
