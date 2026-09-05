"""R1: YOLO 系を TF.js 形式へ変換し、ヘッドを分解できるかを調べる。

07 §3 の R1 に対応する。確認したいことは2つ。

1. **TF.js 形式へ変換できるか** — YOLOv8 を GraphModel へ変換する。
2. **ヘッドだけを学習できる形に分解できるか** — 検出ヘッドを外した
   バックボーン + ネックを別モデルとして書き出す。ブラウザ側では
   この特徴量の上に新しいヘッドを載せて学習する（PoC P2/P3 と同じ形）。

変換は開発者側の作業であり、アプリには変換機能を持たせない（論点32）。
"""

import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path

TFJS_CONVERTER = "/opt/venv-tfjs/bin/tensorflowjs_converter"

# onnx2tf は入力が4次元だと必ずこのファイルを探し、無ければ取得しに行く。
# 精度確認にしか使わないため、こちらで置いておいて外部取得を避ける。
CALIBRATION_NPY = "calibration_image_sample_data_20x128x128x3_float32.npy"


def prepare_calibration_data() -> None:
    import numpy as np

    if not Path(CALIBRATION_NPY).exists():
        np.save(CALIBRATION_NPY, np.random.rand(20, 128, 128, 3).astype("float32"))


def graph_outputs(graph_def) -> list[str]:
    """凍結グラフの出力ノード名を求める。

    どのノードの入力にもなっていないノードが出力。onnx2tf が作る SavedModel には
    serving 署名が無いため、署名ではなくこの方法で出力を特定する。
    """
    names, inputs = [], []
    for node in graph_def.node:
        names.append(node.name)
        inputs.extend(node.input)
    return sorted(f"{name}:0" for name in set(names) - set(inputs) if not name.startswith("NoOp"))


def to_tfjs(frozen_pb: Path, outputs: list[str], target: Path) -> None:
    if target.exists():
        shutil.rmtree(target)
    target.mkdir(parents=True)
    subprocess.run(
        [
            TFJS_CONVERTER,
            "--input_format=tf_frozen_model",
            f"--output_node_names={','.join(outputs)}",
            str(frozen_pb),
            str(target),
        ],
        check=True,
    )


def write_metadata(model_name: str, imgsz: int, target: Path, kind: str) -> None:
    """アプリ側が必要とするメタを書き出す。

    クラス名は .pt から取る。手で書き写すと必ずずれる。
    input_spec は Model.input_spec（方針15）にそのまま対応する。
    """
    from ultralytics import YOLO

    names = YOLO(model_name).model.names
    metadata = {
        "key": target.name,
        "source": Path(model_name).stem,
        "kind": kind,
        "task_type": "object_detection",
        "format": "tfjs_graph_model",
        "input_spec": {
            "size": {"width": imgsz, "height": imgsz},
            # YOLO は 0〜1 に正規化するだけで、平均・分散の正規化は行わない。
            "normalize": {"mean": [0.0, 0.0, 0.0], "std": [1.0, 1.0, 1.0]},
            "letterbox": True,
        },
        "classes": [{"index": int(i), "name": str(n)} for i, n in sorted(names.items())],
    }
    (target / "metadata.json").write_text(
        json.dumps(metadata, ensure_ascii=False, indent=2), encoding="utf-8"
    )


def export_full(model_name: str, imgsz: int, opset: int, out_dir: Path) -> Path:
    """検出ヘッドまで含めた完成モデル。推論に使う。"""
    import tensorflow as tf
    from ultralytics import YOLO

    print(f"[R1] 完成モデル: {model_name} を凍結 GraphDef へ変換する", flush=True)
    # opset を明示する。既定のままだと ultralytics が opset 9 を選び、
    # torch 側の版変換で segfault する。
    frozen = Path(YOLO(model_name).export(format="pb", imgsz=imgsz, half=False, opset=opset))

    graph_def = tf.compat.v1.GraphDef()
    graph_def.ParseFromString(frozen.read_bytes())
    outputs = graph_outputs(graph_def)
    print(f"[R1] 出力ノード: {outputs}", flush=True)

    target = out_dir / f"{Path(model_name).stem}_tfjs"
    to_tfjs(frozen, outputs, target)
    write_metadata(model_name, imgsz, target, kind="full")
    return target


def export_backbone(model_name: str, imgsz: int, opset: int, out_dir: Path) -> Path:
    """検出ヘッドを外したバックボーン + ネック。転移学習の土台に使う。

    Detect を Identity に差し替えると、ネックの3つの特徴量（P3/P4/P5）が
    そのまま出力になる。ルーティング情報（f / i）は引き継ぐ必要がある。
    """
    import onnx
    import onnx2tf
    import onnxslim
    import tensorflow as tf
    import tf_keras
    import torch
    from tensorflow.python.framework.convert_to_constants import convert_variables_to_constants_v2
    from ultralytics import YOLO

    print("[R1] バックボーン + ネックを切り出す", flush=True)
    detection_model = YOLO(model_name).model.float().eval().fuse()
    head = detection_model.model[-1]
    identity = torch.nn.Identity()
    # _predict_once がスキップ接続の解決に使う属性。引き継がないと落ちる。
    identity.f, identity.i = head.f, head.i
    detection_model.model[-1] = identity

    onnx_path = Path(f"{Path(model_name).stem}_backbone.onnx")
    torch.onnx.export(
        detection_model,
        torch.zeros(1, 3, imgsz, imgsz),
        str(onnx_path),
        opset_version=opset,
        input_names=["images"],
        output_names=["p3", "p4", "p5"],
        do_constant_folding=True,
        dynamo=False,
    )
    # onnxslim を通さないと onnx2tf の変換結果が壊れる（読み込み時に落ちる）。
    slim_path = onnx_path.with_name(f"{onnx_path.stem}_slim.onnx")
    onnx.save(onnxslim.slim(onnx.load(str(onnx_path))), str(slim_path))

    saved_model_dir = f"{Path(model_name).stem}_backbone_saved_model"
    onnx2tf.convert(
        input_onnx_file_path=str(slim_path),
        output_folder_path=saved_model_dir,
        not_use_onnxsim=True,
        verbosity="error",
        disable_group_convolution=True,
        enable_batchmatmul_unfold=True,
    )

    keras_model = tf_keras.models.load_model(saved_model_dir)
    print(f"[R1] 特徴量: {[tuple(o.shape) for o in keras_model.outputs]}", flush=True)

    concrete = tf.function(lambda x: keras_model(x)).get_concrete_function(
        tf.TensorSpec(keras_model.inputs[0].shape, keras_model.inputs[0].dtype)
    )
    graph_def = convert_variables_to_constants_v2(concrete).graph.as_graph_def()
    frozen = Path(f"{Path(model_name).stem}_backbone.pb")
    tf.io.write_graph(graph_def, str(frozen.parent), frozen.name, as_text=False)

    outputs = graph_outputs(graph_def)
    print(f"[R1] 出力ノード: {outputs}", flush=True)

    target = out_dir / f"{Path(model_name).stem}_backbone_tfjs"
    to_tfjs(frozen, outputs, target)
    write_metadata(model_name, imgsz, target, kind="backbone")
    return target


def describe(model_dir: Path) -> dict:
    """model.json を読み、入出力とノードの構成を要約する。"""
    manifest = json.loads((model_dir / "model.json").read_text(encoding="utf-8"))
    topology = manifest.get("modelTopology", {})
    nodes = topology.get("node", [])
    signature = manifest.get("signature", {})

    shards = sorted(p for p in model_dir.glob("*.bin"))
    op_counts: dict[str, int] = {}
    for node in nodes:
        op = node.get("op", "?")
        op_counts[op] = op_counts.get(op, 0) + 1

    return {
        "dir": model_dir.name,
        "weight_shards": len(shards),
        "weight_bytes": sum(p.stat().st_size for p in shards),
        "model_json_bytes": (model_dir / "model.json").stat().st_size,
        "inputs": signature.get("inputs", {}),
        "outputs": signature.get("outputs", {}),
        "node_count": len(nodes),
        "top_ops": dict(sorted(op_counts.items(), key=lambda kv: -kv[1])[:12]),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", default="yolov8n.pt")
    parser.add_argument("--imgsz", type=int, default=640)
    parser.add_argument("--opset", type=int, default=18)
    parser.add_argument("--out", default="/out")
    parser.add_argument(
        "--skip-backbone",
        action="store_true",
        help="検出ヘッドを外したモデルの書き出しを省く",
    )
    args = parser.parse_args()

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    prepare_calibration_data()

    summary: dict[str, object] = {"model": args.model, "imgsz": args.imgsz, "opset": args.opset}
    try:
        summary["full"] = describe(export_full(args.model, args.imgsz, args.opset, out_dir))
        if not args.skip_backbone:
            summary["backbone"] = describe(
                export_backbone(args.model, args.imgsz, args.opset, out_dir)
            )
    except Exception as error:  # noqa: BLE001 - 失敗の内容そのものが R1 の結果
        print(f"[R1] 変換に失敗した: {type(error).__name__}: {error}", file=sys.stderr, flush=True)
        return 1

    (out_dir / "r1-summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print("[R1] 要約:", flush=True)
    print(json.dumps(summary, ensure_ascii=False, indent=2), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
