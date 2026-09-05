# アプリ本体（M0: 土台）

設計は [docs/design](../docs/design) を参照。ここは [07 実装計画](../docs/design/07-implementation-plan.md) の
**M0（土台）** に対応する。

## 構成

```
src/
  ui/              UI Layer          画面・ビュー・入力（React はここに閉じ込める / 論点35）
  application/     Application Layer ユースケース（Manager / Service）
  domain/          Domain Layer      エンティティ・不変条件・系譜のルール
  ports/           Port              Repository / BlobStore / InferenceEngine …（抽象）
  infrastructure/  Infrastructure    Port の実装（IndexedDB / OPFS / TF.js / fetch）
  worker/          ML Worker         単一 Worker とジョブキュー（論点19）
```

[03 §4](../docs/design/03-system-architecture.md#4-レイヤ構成) の5層をそのままディレクトリにしている。
依存の向きは `ui → application → domain` と `application → ports`。
**`infrastructure` は誰からも参照されず、起動時に `ports` の実装として注入する。**

## 守るルール

### 外部取得ゼロ（論点36・39）

- CDN・Webフォント・外部APIを使わない。フォントは OS 標準のものだけ。
- `fetch` を書いてよいのは `infrastructure/` だけで、取得先は同一オリジンの相対パスに限る。
- ビルド成果物は CI で検査する（`npm run check:no-external`）。
- リリース前に[オフライン動作確認](../docs/operations/offline-verification.md)を行う。

### 依存の追加

依存を増やすときは、それが**外部ホストへ取りに行かないか**を先に確認する。
実行時にモデル・フォント・テレメトリを取得するライブラリは採用しない。

## コマンド

| コマンド | 内容 |
| --- | --- |
| `npm run dev` | 開発サーバー |
| `npm run build` | 型検査 + 本番ビルド（`dist/`） |
| `npm run check:no-external` | 成果物の外部URL検査（要 `dist/`） |
| `npm run models:import` | 変換済みモデルを `public/models/` へ取り込みカタログを作る |
| `npm run preview` | ビルド結果の確認 |

## モデルの取り込み

`public/models/` は **git 管理外**。変換済みの重みは次の手順で持ち込む（論点36）。

```sh
# 1. 変換（Docker）。詳細は tools/model-conversion/README.md
docker build -t browser-ai-r1 ../tools/model-conversion
MSYS_NO_PATHCONV=1 docker run --rm -v "/c/…/tools/model-conversion/out:/out" browser-ai-r1 --out /out

# 2. 配信物へ取り込む（シャードを1本にまとめ、catalog.json を作る）
npm run models:import
```

## 現状

**M4 まで実装済み。MVP（推論 + 履歴、論点30）は完成。**

プロジェクトの作成・切替・削除、クラス体系の複製と編集、画像の取り込み（重複排除つき）、
複数枚の一括推論、結果の描画、履歴の一覧と詳細、エクスポート / インポートまで動く。
アプリ本体は Service Worker がキャッシュし、配信元に届かなくても起動する（論点24）。
実測（Chrome / WebGPU / 650×417）は前処理・後処理込みで **70 ms**（初回のみカーネル初期化を含み 2.2 秒）。

アノテーション・データセット・転移学習・評価は M5 以降（MVP スコープ外）。
