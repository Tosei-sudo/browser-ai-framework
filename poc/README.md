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

```bash
# P2 で使うデータセット（48.0MB, MIT ライセンス）。リポジトリには含めていない。
mkdir -p datasets
curl -L -o datasets/raccoon.zip https://github.com/datitran/raccoon_dataset/archive/refs/heads/master.zip
cd datasets && unzip -q raccoon.zip && cd ..
```

TensorFlow.js 側の重み（coco-ssd / mobilenet）は実行時に `storage.googleapis.com` から取得されるため、事前準備は不要。

```bash
# R1（/p6-yolo/）で使う YOLOv8 の変換済みモデル。tools/model-conversion で作る。
docker build -t browser-ai-r1 ../tools/model-conversion
MSYS_NO_PATHCONV=1 docker run --rm -v "/c/…/tools/model-conversion/out:/out" browser-ai-r1 --out /out
cp -r ../tools/model-conversion/out/yolov8n_tfjs ../tools/model-conversion/out/yolov8n_backbone_tfjs models/
```

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
| P2 | `/p2-training/` | ブラウザ内の転移学習が動くか、数百枚の所要時間 | 完了 |
| P3 | `/p2-training/` | 検出ヘッドを差し替えてクラス数を変えられるか | 完了（P2 と同時に確認） |
| R1 | `/p6-yolo/` | YOLOv8 の変換結果で推論でき、ヘッドだけを学習できるか | 完了 |

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
├── datasets/            データセット（gitignore 済み。上の手順で取得する）
├── p6-yolo/             R1（YOLOv8 の変換結果の確認とヘッドだけの学習）
│   ├── index.html
│   ├── main.js
│   └── r1-worker.js
├── p1-inference/        P1 / P4
    ├── index.html
    ├── main.js          画像の用意と結果表示
│   └── infer-worker.js  ONNX Runtime Web と TensorFlow.js の実行
└── p2-training/         P2 / P3
    ├── index.html
    ├── main.js          データセットの読み込みと結果表示
    └── train-worker.js  凍結バックボーン + ヘッド学習
```

`/p1-inference/` はページを開くと合成画像で自動実行する。検出結果の正しさを確かめたい場合は、画像選択から実写を渡す。
