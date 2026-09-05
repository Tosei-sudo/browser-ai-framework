# R1: YOLO 系を TF.js 形式へ変換する（論点33 / 07 §3）。
#
# 変換は開発者側の作業であり、アプリには変換機能を持たせない（論点32）。
# 閉域の外でビルドして成果物を持ち込む前提なので、ここでの外部取得は問題ない（論点36）。
FROM python:3.11-slim

# opencv（ultralytics の依存）が必要とする共有ライブラリ。
RUN apt-get update && apt-get install -y --no-install-recommends \
      libgl1 libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

# 変換経路: .pt --(ultralytics)--> ONNX --(onnx2tf)--> SavedModel --(tensorflowjs)--> TF.js GraphModel
RUN pip install --no-cache-dir \
      "ultralytics==8.3.0" \
      "tensorflow-cpu==2.19.0" \
      "tensorflowjs==4.22.0" \
      "onnx==1.17.0" \
      "onnx2tf==1.26.3" \
      "onnxslim==0.1.48" \
      "onnxruntime==1.20.1" \
      "onnx_graphsurgeon==0.5.2" \
      "sng4onnx==1.0.4" \
      "tf_keras==2.19.0"

# ultralytics が export 時に自動導入するものを先に入れておく。
# 実行時の自動更新（毎回1分ほどかかる）を避け、版を固定して再現性を保つため。
# tflite_support が protobuf を 3.20.3 へ落とすが、TensorFlow 2.19 の要求
# （>=3.20.3）は満たしている。
RUN pip install --no-cache-dir \
      "onnxscript" \
      "tflite_support==0.4.4" \
      "onnx2tf==1.22.3" \
      "onnxslim==0.1.34"
# torch は ultralytics 8.3.0 と同時期の版に落とす。
# torch 2.14 の ONNX エクスポータはこの組み合わせで segfault する（exit 139）。
# CPU 版を使う。変換に GPU は要らず、イメージも小さくなる。
RUN pip install --no-cache-dir --index-url https://download.pytorch.org/whl/cpu \
      "torch==2.4.1" "torchvision==0.19.1"
# tflite_support が実行時に libusb を要求する（Edge TPU 用のバインディング）。
# 変換には使わないが、import の時点で無いと落ちる。
RUN apt-get update && apt-get install -y --no-install-recommends libusb-1.0-0 \
    && rm -rf /var/lib/apt/lists/*
# TF.js 変換器は別の venv に隔離する。
# ultralytics の SavedModel 書き出しは tflite_support（protobuf 3.20 を要求）に
# 依存するが、tensorflowjs の変換器は protobuf 5 系を要求する。
# TF.js 変換器は別の venv に隔離する。
# ultralytics の SavedModel 書き出しは tflite_support（protobuf 3.20 を要求）に
# 依存するが、tensorflowjs の変換器は新しい protobuf を要求する。同居できない。
RUN python -m venv /opt/venv-tfjs \
    && /opt/venv-tfjs/bin/pip install --no-cache-dir "tensorflowjs==4.22.0" \
    && /opt/venv-tfjs/bin/pip install --no-cache-dir "protobuf==5.29.6" "ydf==0.9.0"

WORKDIR /work
COPY convert.py /opt/convert.py
ENTRYPOINT ["python", "/opt/convert.py"]
