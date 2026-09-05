# 決定ログ

| 項目 | 内容 |
| --- | --- |
| ステータス | 全18論点が決定済み（未決なし） |
| 最終更新 | 2026-09-05 |
| 関連 | [01-conceptual-er-model.md](./01-conceptual-er-model.md) |

概念ERモデルの設計論点を管理する。各論点は次の形式で記録する。

- **背景** — なぜ判断が必要か
- **選択肢** — 取りうる案
- **推奨** — 現時点の推奨とその理由
- **影響範囲** — 決定によって変わるエンティティ・属性
- **決定** — 合意内容と決定日（未決の間は空欄）

決定した論点は [01-conceptual-er-model.md](./01-conceptual-er-model.md) に反映し、本ファイルの「決定」欄を埋める。

## 合意済み

内容は [01-conceptual-er-model.md §2](./01-conceptual-er-model.md#2-合意済みの設計方針) を参照。

| # | 論点 | 決定 | 決定日 |
| --- | --- | --- | --- |
| 01 | クラス体系が管理対象にない | `LabelSet` / `LabelClass` を独立エンティティとして導入する | 2026-09-05 |
| 02 | Dataset が可変のままだと学習の追跡性が壊れる | `Dataset`（可変）と `DatasetVersion`（不変）を分離し、`Training` / `Evaluation` は `DatasetVersion` のみを参照する | 2026-09-05 |
| 03 | Training Result の独立エンティティ化は冗長 | `TrainingResult` を廃し、`Training` の属性 + `TrainingMetric` + `Evaluation` に分解する | 2026-09-05 |
| 04 | Evaluation が管理対象に含まれていない | `Evaluation` / `EvaluationMetric` を追加する | 2026-09-05 |
| 05 | Annotation の粒度が単一階層では足りない | `AnnotationSet` と `AnnotationObject` に分割する | 2026-09-05 |
| 06 | モデル重みの容量と系譜保持が衝突する | `Model`（メタ・永久保存）と `ModelArtifact`（重み・削除可）を分離し、`artifact_status` で実体の有無を表す | 2026-09-05 |
| 07 | 系譜の表現方法 | 案B。`ModelDerivation` を独立エンティティにする。派生の種別（`kind`）を持て、将来の統合・変換にも耐える | 2026-09-05 |
| 08 | `ModelVersion` の要否 | 案A。`ModelVersion` は作らない。`Model` を不変ノードとし、系譜そのものをバージョン履歴として扱う | 2026-09-05 |
| 11 | 推論の階層構造 | 案B。`Inference` / `InferenceTarget` / `Detection` の3階層。画像ごとの成否と処理時間も持てる | 2026-09-05 |
| 16 | `Project` / Workspace の導入 | 導入する。`project_id` の付与範囲は [01 方針10](./01-conceptual-er-model.md#方針10-project-を導入する論点16) を参照 | 2026-09-05 |
| 18 | `Project` のスコープ境界 | 完全分離。プロジェクト間参照を許さず、Base Model のみ `project_id = null` のグローバル資産とする | 2026-09-05 |
| 09 | 推論結果のアノテーション下書き化 | 機能は初期スコープ外。`AnnotationSet.source` / `origin_target_id` の属性のみ先に確保する | 2026-09-05 |
| 13 | 失敗・中断した Training の扱い | `Training.status` で記録し失敗も残す。`output_model_id` は nullable。`TrainingCheckpoint` は導入しない | 2026-09-05 |
| 15 | 削除の扱い | メタは論理削除、物理削除は `ImageBlob` / `ModelArtifact` のみ。`ImageBlob` の分離が確定 | 2026-09-05 |
| 10 | 推論履歴の保持ポリシー | `Inference.pinned` + 上限件数での自動削除 | 2026-09-05 |
| 14 | Base Model の同一性と更新 | 不変IDで配布し更新版は別モデルとして追加。メタは初回全件登録、重みは遅延取得 | 2026-09-05 |
| 12 | 前処理・実行パラメータの配置 | 前処理仕様は `Model.input_spec`、しきい値類は `Inference` の属性 | 2026-09-05 |
| 17 | ID採番とエクスポート単位 | UUID / ULID 採番。エクスポートは `Project` 一式を主単位とし、モデル単体も可 | 2026-09-05 |

各決定の選択肢と判断理由は以降の論点別セクションに記録している。ER構造には影響しないが実装時に決める必要がある事項は [01 §8](./01-conceptual-er-model.md#8-実装フェーズへ持ち越す事項) にまとめた。

---

## 論点07 — 系譜を Model の自己参照で持つか、独立エンティティにするか

**ステータス: 決定済（2026-09-05）**

### 背景

`order.txt` §4 が明示的に投げている論点。`Training` が `source_model_id` と `output_model_id` を持つ以上、親子関係は `Training` から導出できるため、独立した系譜エンティティは素朴には冗長である。

### 選択肢

| 案 | 内容 | 利点 | 欠点 |
| --- | --- | --- | --- |
| A | `Model.parent_model_id` の自己参照のみ | 最小構成。実装が単純 | 学習以外の派生（インポート・形式変換・量子化）を表現できない。複数親（モデル統合）も不可 |
| B | `ModelDerivation` を独立エンティティにする | 派生の種別を持てる。将来の統合・変換にも耐える。祖先探索が軽い | エンティティが1つ増え、`Training` との整合を保つ責務が発生する |
| C | `Training` からの導出のみ | 冗長が一切ない | 非学習由来の派生を系譜に載せられない。祖先探索が毎回 `Training` 経由になる |

### 推奨

**案B。** `kind: transfer_learning | fine_tune | convert | quantize | import` を持たせる。

### 確認事項

- 「モデル形式の変換」「量子化版の生成」を将来行う可能性はあるか。あるなら案B以外は選べない。
- 複数モデルの統合（アンサンブル・マージ）を将来行う可能性はあるか。

### 影響範囲

`ModelDerivation` エンティティの有無、`Model.parent_model_id` 属性の有無、ER図。

### 決定

**案Bを採用**（2026-09-05）。`ModelDerivation` を独立エンティティとする。

- `kind` に `transfer_learning` / `fine_tune` / `convert` / `quantize` / `import` を持たせ、学習を伴わない派生も同じ系譜に載せる。
- 学習由来の派生は `training_id` で `Training` に紐づけ、系譜から学習履歴へ直接辿れるようにする。
- `Model.parent_model_id` は持たない（系譜の情報源を `ModelDerivation` に一本化する）。
- 多重度は将来のモデル統合に備えて N — N とする。

反映先: [01 方針7](./01-conceptual-er-model.md#方針7-系譜を-modelderivation-として独立させる論点07)

---

## 論点08 — Model Version を独立エンティティにするか

**ステータス: 決定済（2026-09-05）**

### 背景

`order.txt` §12 が挙げている論点。転移学習の出力は「同じモデルの新バージョン」ではなく「別のモデル」である。version 番号と lineage を同時に管理すると必ず矛盾する — 例えば Model B から2本派生したとき、両方が v2 になる。

### 選択肢

| 案 | 内容 |
| --- | --- |
| A | `ModelVersion` を作らない。`Model` を不変ノードとし、系譜そのものをバージョン履歴として扱う |
| B | `ModelVersion` を独立エンティティとして持つ |
| C | 案A + `ModelFamily`（系列名・世代番号）を表示専用として追加する |

### 推奨

**案A。** 人間向けの世代表示が必要になった場合のみ案Cへ拡張する。その場合も `generation_no` は表示専用とし、識別子には使わない。

### 影響範囲

`ModelVersion` / `ModelFamily` エンティティの有無、モデル一覧UIの表示方法。

### 決定

**案Aを採用**（2026-09-05）。`ModelVersion` は作らない。`Model` を不変ノードとし、系譜そのものをバージョン履歴として扱う。

`ModelFamily` も現時点では導入しない。系列名・世代番号の表示が必要になった時点で案Cとして再検討する。その場合も `generation_no` は表示専用とし、識別子には使わない。

反映先: [01 方針8](./01-conceptual-er-model.md#方針8-modelversion-を持たない論点08)

---

## 論点09 — 推論結果をアノテーションの下書きとして再利用するか

**ステータス: 決定済（2026-09-05）**

### 背景

「モデルの推論結果を人が修正して学習データにする」（自動ラベリング）を想定するかどうかで設計が変わる。想定するなら `AnnotationSet` に `source` と由来の `InferenceTarget` を持たせる必要がある。

これがあると次の2つが可能になる。

- 「モデル出力 → 人が修正 → 次の学習データ → 次のモデル」という循環の追跡。
- 「モデルAの出力で学習したモデルB」というデータ汚染の検出。

### 推奨

機能としてスコープに含めるかは別途決めてよいが、**由来を記録する属性（`AnnotationSet.source`, `AnnotationSet.origin_target_id`）だけは最初から確保する。** 後から追加すると既存データの由来が永久に不明になる。

### 影響範囲

`AnnotationSet.source` / `origin_target_id`、`InferenceTarget` — `AnnotationSet` 間のリレーション。

### 決定

**属性のみ先に確保する**（2026-09-05）。自動ラベリング機能は初期スコープに含めないが、`AnnotationSet.source`（`manual` / `imported` / `from_detection`）と `origin_target_id`、および `InferenceTarget` — `AnnotationSet` のリレーションは最初から持つ。

反映先: [01 方針12](./01-conceptual-er-model.md#方針12-推論結果の由来を記録できるようにする論点09)

---

## 論点10 — 推論履歴をどこまで残すか（保持ポリシー）

**ステータス: 決定済（2026-09-05）**

### 背景

`order.txt` §11 の設計思想④に従い推論を全件保存すると、1回の実行で数十件の `Detection` が生まれ、レコードが際限なく増える。ブラウザストレージには容量上限があり、運用開始後すぐに問題になる。

### 選択肢

- 全件永久保存
- 直近N件 + ユーザーが `pinned` したものは永続
- 期間経過で自動削除

### 推奨

**`pinned` フラグ + 上限件数での自動削除。** ER 的には `Inference.pinned` の属性1つで足りる。

### 影響範囲

`Inference.pinned` 属性、削除ポリシーの実装。

### 決定

**pinned + 上限件数での自動削除を採用**（2026-09-05）。ユーザーが pinned した推論は永続、それ以外は上限件数を超えた分から古い順に自動削除する。上限件数の具体値は実装フェーズで決める。

反映先: [01 方針14](./01-conceptual-er-model.md#方針14-推論履歴は-pinned--上限件数で管理する論点10)

---

## 論点11 — 推論を1画像単位にするか、バッチ単位にするか

**ステータス: 決定済（2026-09-05）**

### 背景

`Inference` を「1実行 = 1画像」とすると単純だが、複数画像をまとめて処理するUIを作った時点で構造を変える必要が出る。

### 選択肢

| 案 | 内容 |
| --- | --- |
| A | `Inference`（model + image）→ `Detection` の2階層 |
| B | `Inference`（実行）→ `InferenceTarget`（画像単位）→ `Detection` の3階層 |

### 推奨

**案B。** 1画像だけの場合も `InferenceTarget` が1件になるだけでコストはほぼない。画像ごとの成否（`status`）と処理時間（`elapsed_ms`）も自然に持てる。

### 確認事項

- 複数画像の一括推論をUI要件に含めるか。

### 影響範囲

`InferenceTarget` エンティティの有無、`Detection` の親、論点09のリレーション。

### 決定

**案Bを採用**（2026-09-05）。`Inference` / `InferenceTarget` / `Detection` の3階層とする。

`InferenceTarget` は `status`（`succeeded` / `failed` / `skipped`）と `elapsed_ms` を持ち、画像ごとの成否と処理時間を記録する。`Detection` の親は `InferenceTarget` となる。

なお「複数画像の一括推論をUI要件に含めるか」は本決定とは独立に判断してよい。構造として先に対応させておく。

反映先: [01 方針9](./01-conceptual-er-model.md#方針9-推論を3階層にする論点11)

---

## 論点12 — 前処理・実行パラメータをどちらに置くか

**ステータス: 決定済（2026-09-05）**

### 背景

パラメータには性質の異なる2種類がある。

- **モデル固有** — 入力サイズ、正規化、letterbox。変えると結果が壊れる。
- **実行ごとに変える** — 信頼度しきい値、NMS の IoU しきい値、最大検出数。

混在させると「なぜこの結果になったか」を再現できない。

### 推奨

前処理仕様は `Model.input_spec`、しきい値類は `Inference` の属性。

### 影響範囲

`Model.input_spec`、`Inference.conf_threshold` / `iou_threshold` / `max_detections`。

### 決定

**Model と Inference に分離する**（2026-09-05）。前処理仕様は `Model.input_spec`、しきい値類は `Inference` の属性とする。`Inference` 側への `input_spec` のスナップショットは行わない（`Model` が不変であるため、参照だけで再現できる）。

反映先: [01 方針15](./01-conceptual-er-model.md#方針15-前処理仕様とスレッショルドを分離する論点12)

---

## 論点13 — 失敗・中断した Training をどう扱うか

**ステータス: 決定済（2026-09-05）**

### 背景

ブラウザ上での学習は、タブを閉じる・メモリ不足・バックグラウンド化などで容易に中断する。長時間ジョブが中断される前提の設計が必要。

### 推奨

`Training.status`（`running` / `completed` / `failed` / `cancelled`）を持たせ、失敗した学習も記録として残す（設計思想③）。`output_model_id` は nullable とし、`Training : Model(output)` を 1 : 0..1 とする。

### 確認事項

- 中断からの再開（checkpoint 保存）を要件に含めるか。含める場合 `TrainingCheckpoint` エンティティが追加で必要になる。

### 影響範囲

`Training.status` / `output_model_id` の nullable 化、`TrainingCheckpoint` の要否。

### 決定

**status で記録し、再開はサポートしない**（2026-09-05）。`Training.status`（`running` / `completed` / `failed` / `cancelled`）を持ち、失敗・中断した学習も記録として残す。`output_model_id` は nullable。`TrainingCheckpoint` は導入せず、中断した学習はやり直しとする。

反映先: [01 方針13](./01-conceptual-er-model.md#方針13-失敗中断した-training-も記録として残す論点13)

---

## 論点14 — 開発者提供 Base Model の同一性と更新

**ステータス: 決定済（2026-09-05）**

### 背景

アプリ更新で Base Model が差し替わったとき、既にそれを親として派生したユーザーモデルの系譜が壊れないようにする必要がある。

### 推奨

Base Model は不変IDで配布し、更新版は「別のモデル」として追加する。既存の親子関係は書き換えない。

### 確認事項

- Base Model のメタ情報は初回起動時に全件登録するか、使用時に遅延登録するか。重みのダウンロード量に関わる。

### 影響範囲

`Model.origin = builtin` の扱い、初期データ投入の設計。

### 決定

**メタは全件登録、重みは遅延取得**（2026-09-05）。Base Model は不変IDで配布し、更新版は「別のモデル」として追加する。既存の親子関係は書き換えない。メタ情報（名前・クラス体系・入力仕様）は初回起動時に全件登録し、重みは実際に使用する時点でダウンロードする。

反映先: [01 方針18](./01-conceptual-er-model.md#方針18-base-model-はメタを全件登録し重みは遅延取得する論点14)

---

## 論点15 — 削除の扱い（参照整合性）

**ステータス: 決定済（2026-09-05）**

### 背景

学習に使った画像や、推論履歴が参照している画像をユーザーが削除できるとすると、過去の `Training` / `Inference` の追跡性が失われる。一方でブラウザの容量制約上「一切削除できない」も現実的ではない。

### 推奨

論理削除（`deleted_at`）を基本とし、参照されている実体（`ImageBlob` / `ModelArtifact`）のみ物理削除を許す。`Image` / `Model` のメタは残るため、系譜と履歴は保たれる。

この決定に伴い `ImageBlob` を `Image` から分離するかも確定する（[01 §3](./01-conceptual-er-model.md#a-画像アノテーション資産) で「暫定」としている箇所）。

### 確認事項

- 「画像を消したがアノテーションと `Detection` は残っている」状態をUIでどう見せるか。

### 影響範囲

`ImageBlob` エンティティの有無、`Image.deleted_at` などの論理削除属性、削除UIの仕様。

### 決定

**論理削除 + 実体のみ物理削除を採用**（2026-09-05）。`Image` / `Model` のメタは `deleted_at` による論理削除とし、物理削除は `ImageBlob` / `ModelArtifact` のみ許す。この決定により `ImageBlob` の分離が確定した。

削除UIの表現（「画像を削除したがアノテーションと `Detection` は残っている」状態の見せ方）は実装フェーズで詰める。

反映先: [01 方針16](./01-conceptual-er-model.md#方針16-削除は論理削除を基本とする論点15)

---

## 論点16 — Project / Workspace を導入するか

**ステータス: 決定済（2026-09-05）**

### 背景

導入すると一覧のスコープ分割、一括エクスポート、用途ごとのクラス体系分離が自然になる。導入しない場合は全エンティティがフラットに並ぶ。

後から全エンティティに `project_id` を足すのはマイグレーションコストが高いため、早期に決める必要がある。

### 確認事項

- 1ユーザーが同時に扱う用途は単一か複数か。複数なら最初から導入を推奨する。

### 影響範囲

`Project` エンティティの有無、ほぼ全エンティティの `project_id` 属性。

### 決定

**導入する**（2026-09-05）。`project_id` の付与範囲は以下とした。

| 区分 | エンティティ |
| --- | --- |
| `project_id` を持つ | `Image`, `LabelSet`, `Dataset`, `Model`, `Training`, `Evaluation`, `Inference` |
| 持たない（親から辿れる） | `AnnotationSet`, `AnnotationObject`, `DatasetVersion`, `DatasetItem`, `TrainingMetric`, `EvaluationMetric`, `InferenceTarget`, `Detection`, `ModelDerivation` |
| 持たない（横断共有） | `ImageBlob`, `ModelArtifact` |

`ImageBlob` / `ModelArtifact` を横断共有としたのは、`content_hash` / `checksum` による重複排除の対象であり、プロジェクトをまたいで同一実体が参照されうるため。

この決定から、Base Model の所属とプロジェクト間参照の可否という新たな判断が必要になった。論点18として起票する。

反映先: [01 方針10](./01-conceptual-er-model.md#方針10-project-を導入する論点16)

---

## 論点17 — ID採番とポータビリティ

**ステータス: 決定済（2026-09-05）**

### 背景

ブラウザ完結 = データは端末ローカルに閉じる。将来のサーバー同期・端末間移行・チーム共有を考えるなら、連番ではなく衝突しないIDが必要。

### 推奨

全エンティティで UUID / ULID を採番する。将来サーバーへ拡張する際にID再割当てが不要になる。

### 確認事項

- エクスポート単位は何か。モデル単体か、系譜ごとか、`Dataset` + `Model` 一式か。単位が決まると、エクスポートに必要なメタ情報も決まる。

### 影響範囲

全エンティティの主キー方式、エクスポート機能の仕様。

### 決定

**UUID / ULID 採番、エクスポート単位は Project 一式 + モデル単体**（2026-09-05）。`Project` を主なエクスポート単位とし、補助的にモデル単体の書き出しも可能とする。

論点18で `Project` を完全分離としたため、`Project` 一式のエクスポートで系譜が完結する。

反映先: [01 方針17](./01-conceptual-er-model.md#方針17-id-は-uuid--ulidエクスポート単位は-project論点17)

---

## 論点18 — Project のスコープ境界

**ステータス: 決定済（2026-09-05）**

### 背景

論点16で `Project` の導入を決定したことにより、次の判断が新たに必要になった。

1. **開発者提供 Base Model（`origin = builtin`）はどのプロジェクトに属するか。** プロジェクトごとに複製すると同じ重みが重複し、方針6（重みの容量削減）と衝突する。
2. **プロジェクト間で資産を参照できるか。** 例えばプロジェクトAの `Image` をプロジェクトBの `Dataset` に入れられるか、プロジェクトAで学習した `Model` をプロジェクトBで推論に使えるか。
3. **プロジェクトを削除したとき、横断共有される `ImageBlob` / `ModelArtifact` をどう扱うか。**

### 選択肢

| 案 | 内容 | 利点 | 欠点 |
| --- | --- | --- | --- |
| A | 完全分離。`project_id` は必須で、プロジェクト間参照を一切許さない。Base Model のみ `project_id = null` のグローバル資産とする | 境界が明確。エクスポートが単純 | 同じ画像を複数プロジェクトで使うたびに登録し直す必要がある |
| B | Base Model に加えユーザーモデルもプロジェクト間で参照可とする | モデルの再利用が容易 | 系譜がプロジェクトをまたぎ、エクスポート単位の判断が複雑になる |
| C | `project_id` を nullable とし、null をグローバル資産として全プロジェクトから参照可とする | 柔軟 | 「どこに属するか曖昧な資産」が増え、一覧・削除の仕様が複雑化する |

### 推奨

**案A。** ただし Base Model は `project_id = null` の例外として扱う。

理由: `order.txt` の中心的な要件はモデル系譜の追跡であり、系譜がプロジェクト境界をまたぐと「どこまでをエクスポートすれば系譜が完結するか」が定義できなくなる。プロジェクト間でモデルを使い回したい要求が実際に出てから案Bへ拡張する方が安全。

### 確認事項

- 同じ画像を複数プロジェクトで使う要求はあるか。ある場合、`ImageBlob` の共有だけで容量的には足りるか（`Image` メタの重複は許容できるか）。
- プロジェクト削除は論理削除か物理削除か。論点15と併せて決める。

### 影響範囲

`Model.project_id` の nullable 化、`Dataset` / `Inference` から他プロジェクトの資産を参照できるかの制約、エクスポート機能の単位（論点17と関連）。

### 決定

**案Aを採用**（2026-09-05）。`Project` は完全分離とし、プロジェクト間の資産参照を許さない。開発者提供 Base Model のみ `project_id = null` のグローバル資産として例外的に全プロジェクトから参照できる。

`Model.project_id` は nullable とするが、`origin = builtin` 以外で null を許さない。プロジェクト削除が論理削除か物理削除か、および参照されなくなった `ImageBlob` / `ModelArtifact` の回収方法は実装フェーズで詰める。

反映先: [01 方針11](./01-conceptual-er-model.md#方針11-プロジェクト間の参照を許さない論点18)

---

## 決定の結果

全18論点が決定し、概念ERモデルは確定した。決定の過程でエンティティ構成に影響したものは以下。

| 決定 | 構成への影響 |
| --- | --- |
| 論点01 | `LabelSet` / `LabelClass` を追加 |
| 論点02 | `DatasetVersion` / `DatasetItem` を追加 |
| 論点03 | `TrainingResult` を不採用、`TrainingMetric` を追加 |
| 論点04 | `Evaluation` / `EvaluationMetric` を追加 |
| 論点05 | `Annotation` を `AnnotationSet` / `AnnotationObject` に分割 |
| 論点06 | `ModelArtifact` を追加 |
| 論点07 | `ModelDerivation` を追加 |
| 論点08 | `ModelVersion` / `ModelFamily` を不採用 |
| 論点11 | `InferenceTarget` を追加 |
| 論点13 | `TrainingCheckpoint` を不採用 |
| 論点15 | `ImageBlob` を追加 |
| 論点16 | `Project` を追加 |

論点09, 10, 12, 14, 17, 18 は属性・運用レベルの決定で、エンティティの増減は伴わなかった。

次の作業は [01 §9](./01-conceptual-er-model.md#9-次の作業) のとおり、システム構成図 → ブラウザ内コンポーネント構成 → ストレージ設計へ進む。
