/**
 * 推論結果の描画（M3）。
 *
 * `Detection.bbox` は元画像のピクセル座標（`bbox_format = pixel_xywh`）。
 * 表示倍率だけを掛けて描く。**座標の変換は後処理で終わっている。**
 */
import { useEffect, useRef } from 'react';
import type { Detection, LabelClass } from '@domain/index';
import type { LabelClassId } from '@domain/ids';

const MAX_WIDTH = 720;

export function DetectionCanvas({
  bitmap,
  detections,
  classes,
}: {
  bitmap: ImageBitmap;
  detections: readonly Detection[];
  classes: ReadonlyMap<LabelClassId, LabelClass>;
}): React.ReactElement {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const scale = Math.min(1, MAX_WIDTH / bitmap.width);
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);

    const context = canvas.getContext('2d');
    if (!context) return;
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    context.lineWidth = 2;
    context.font = '13px system-ui, sans-serif';
    context.textBaseline = 'top';

    for (const detection of detections) {
      const klass = classes.get(detection.label_class_id);
      const color = klass?.color ?? '#57c2b5';
      const x = detection.bbox.x * scale;
      const y = detection.bbox.y * scale;
      const w = detection.bbox.w * scale;
      const h = detection.bbox.h * scale;

      context.strokeStyle = color;
      context.strokeRect(x, y, w, h);

      const label = `${klass?.name ?? '?'} ${(detection.confidence * 100).toFixed(0)}%`;
      const width = context.measureText(label).width + 8;
      context.fillStyle = color;
      context.fillRect(x, Math.max(0, y - 18), width, 18);
      context.fillStyle = '#0b0b0b';
      context.fillText(label, x + 4, Math.max(0, y - 17));
    }
  }, [bitmap, detections, classes]);

  return <canvas ref={canvasRef} className="detection-canvas" />;
}
