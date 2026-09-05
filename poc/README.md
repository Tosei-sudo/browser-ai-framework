# PoC

[05-technology-selection.md §7](../docs/design/05-technology-selection.md#7-決定前に検証すべきことpoc) で定義した検証を実際に走らせるためのコード。

結果は [06-poc-results.md](../docs/design/06-poc-results.md) に記録する。

**これは検証用のコードであり、製品コードではない。** 設計ドキュメントのレイヤ構成やPortには従っていない。判断材料を得たら役目を終える。

## 準備

```bash
cd poc
npm install

# モデルの重み（25.0MB）。リポジトリには含めていない。
mkdir -p models/yolos-tiny
curl -L -o models/yolos-tiny/model.onnx  https://huggingface.co/Xenova/yolos-tiny/resolve/main/onnx/model.onnx
curl -L -o models/yolos-tiny/config.json https://huggingface.co/Xenova/yolos-tiny/resolve/main/config.json
```

TensorFlow.js 側（coco-ssd）の重みは実行時に `storage.googleapis.com` から取得されるため、事前準備は不要。

## 実行方法

```bash
node poc/serve.mjs              # http://localhost:8123/
node poc/serve.mjs --isolated   # COOP / COEP あり（crossOriginIsolated = true）
```

ブラウザで対象のページを開くと自動で実行され、結果が画面とコンソール（`[PoC]` 接頭辞）に出る。

| PoC | URL | 検証内容 | 状態 |
| --- | --- | --- | --- |
| P5 | `/p5-opfs/` | 重みを ArrayBuffer として OPFS に保存し読み戻せるか | 完了 |
| P1 | `/p1-inference/` | 各ランタイムで Worker 内の推論が動くか、1枚あたりの時間 | 完了 |
| P4 | `/p1-inference/` | WebGPU / WASM の速度差、COOP・COEP の要否 | 完了（`--isolated` の有無で2回測る） |
| P2 | `/p2-training/` | ブラウザ内の転移学習が動くか、数百枚の所要時間 | 未着手 |
| P3 | — | 検出ヘッドを差し替えてクラス数を変えられるか | 未着手（P2 の後） |

## ディレクトリ

```text
poc/
├── serve.mjs            静的配信サーバー（COOP / COEP の切り替え付き）
├── package.json
├── models/              モデルの重み（gitignore 済み。上の手順で取得する）
├── p5-opfs/             P5
│   ├── index.html
│   ├── main.js          メインスレッド側（createWritable）と全体の進行
│   └── opfs-worker.js   Worker 側（createSyncAccessHandle）
└── p1-inference/        P1 / P4
    ├── index.html
    ├── main.js          画像の用意と結果表示
    └── infer-worker.js  ONNX Runtime Web と TensorFlow.js の実行
```

`/p1-inference/` はページを開くと合成画像で自動実行する。検出結果の正しさを確かめたい場合は、画像選択から実写を渡す。
