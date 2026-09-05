# モデル変換（R1）

YOLO 系のモデルを TF.js 形式へ変換する開発者向けツール。
**アプリには変換機能を持たせない**（[論点32](../../docs/design/02-open-decisions.md#論点32--モデル形式を1つに固定するか)）。
閉域の外でビルドして成果物を持ち込む前提なので、ここでの外部取得は問題ない（論点36）。

結果は [06 §7](../../docs/design/06-poc-results.md#7-r1--yolo-の-tfjs-変換とヘッド分解2026-09-05-追加)。

## 使い方

```sh
docker build -t browser-ai-r1 tools/model-conversion

# Windows（Git Bash）ではパス変換を止める
MSYS_NO_PATHCONV=1 docker run --rm \
  -v "/c/path/to/browser-ai-framework/tools/model-conversion/out:/out" \
  browser-ai-r1 --model yolov8n.pt --imgsz 640 --opset 18 --out /out
```

| 引数 | 既定 | 内容 |
| --- | --- | --- |
| `--model` | `yolov8n.pt` | ultralytics のモデル名またはパス |
| `--imgsz` | `640` | 入力解像度 |
| `--opset` | `18` | ONNX opset。**下げると torch 側の版変換で落ちる** |
| `--skip-backbone` | — | 検出ヘッドを外したモデルの書き出しを省く |

## 出力

| 成果物 | 内容 | 使うところ |
| --- | --- | --- |
| `yolov8n_tfjs/` | 検出ヘッドまで含む完成モデル（GraphModel、重み 12.8 MB） | 推論（M2・M3） |
| `yolov8n_backbone_tfjs/` | 検出ヘッドを外したバックボーン + ネック（重み 9.0 MB） | 転移学習の土台（M5） |
| `r1-summary.json` | 入出力・ノード数・重みサイズの要約 | 記録 |

`out/` は git 管理外。**必要になったらこのツールで作り直す。**

## 変換の経路

```text
yolov8n.pt --(ultralytics)--> ONNX --(onnx2tf)--> SavedModel --(freeze)--> GraphDef
           --(tensorflowjs_converter)--> TF.js GraphModel
```

検出ヘッドを外す側は `Detect` を `Identity` に差し替えて同じ経路を通す。
`Identity` には `f`（入力元レイヤ）と `i`（インデックス）を引き継がせる必要がある。
引き継がないと ultralytics の `_predict_once` がスキップ接続を解決できない。

## 版を固定している理由

| 固定 | 理由 |
| --- | --- |
| `torch==2.4.1` | 2.14 の ONNX エクスポータはこの組み合わせで segfault する |
| `--opset 18` | 既定のままだと ultralytics が opset 9 を選び、版変換で segfault する |
| 変換器を別 venv | `tflite_support` は protobuf 3.20、tfjs 変換器は新しい版を要求し、同居できない |
| `ydf==0.9.0` | 新しい ydf は protobuf 6 系の gencode を持ち、TensorFlow 2.19 と両立しない |

`onnxslim` を通してから onnx2tf にかけるのも必須。簡約前の ONNX は誤変換される。
