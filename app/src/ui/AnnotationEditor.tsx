/**
 * アノテーション編集（M5 / 方針5）。
 *
 * 矩形を引き、クラスを割り当て、版として保存する。
 * **キーボードで回せるようにしてある**（数字キーでクラス切替、Delete で削除、
 * Ctrl+Z で取り消し、Ctrl+S で保存）。教師データ作りは反復作業なので、
 * マウスだけだと段取りが悪い。
 *
 * 座標は画素で扱う（`bbox_format = pixel_xywh`）。表示倍率だけを掛けて描く。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { BBox, Image, LabelClass } from '@domain/index';
import type { LabelClassId } from '@domain/ids';

const MAX_WIDTH = 720;
const HANDLE = 8;

export interface EditableBox {
  readonly label_class_id: LabelClassId;
  readonly bbox: BBox;
}

type Drag =
  | { readonly kind: 'draw'; readonly startX: number; readonly startY: number }
  | { readonly kind: 'move'; readonly index: number; readonly offsetX: number; readonly offsetY: number }
  | { readonly kind: 'resize'; readonly index: number };

function hit(box: BBox, x: number, y: number): boolean {
  return x >= box.x && x <= box.x + box.w && y >= box.y && y <= box.y + box.h;
}

function onHandle(box: BBox, x: number, y: number, scale: number): boolean {
  const size = HANDLE / scale;
  return Math.abs(x - (box.x + box.w)) <= size && Math.abs(y - (box.y + box.h)) <= size;
}

export function AnnotationEditor({
  image,
  bitmap,
  classes,
  initial,
  readOnly,
  onSave,
  onCreateFromDetections,
}: {
  image: Image;
  bitmap: ImageBitmap;
  classes: readonly LabelClass[];
  initial: readonly EditableBox[];
  readOnly: boolean;
  onSave: (boxes: readonly EditableBox[]) => void;
  onCreateFromDetections: (() => void) | null;
}): React.ReactElement {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [boxes, setBoxes] = useState<EditableBox[]>([...initial]);
  const [selected, setSelected] = useState<number | null>(null);
  const [classIndex, setClassIndex] = useState(0);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [preview, setPreview] = useState<BBox | null>(null);
  const history = useRef<EditableBox[][]>([]);

  useEffect(() => {
    setBoxes([...initial]);
    setSelected(null);
    history.current = [];
  }, [initial]);

  const scale = Math.min(1, MAX_WIDTH / bitmap.width);
  const activeClass = classes[classIndex];

  const push = useCallback((next: EditableBox[]) => {
    history.current.push(boxes);
    setBoxes(next);
  }, [boxes]);

  const undo = useCallback(() => {
    const previous = history.current.pop();
    if (previous) {
      setBoxes(previous);
      setSelected(null);
    }
  }, []);

  // 描画。選択中の矩形はハンドルつきで描く。
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    const context = canvas.getContext('2d');
    if (!context) return;

    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    context.lineWidth = 2;
    context.font = '13px system-ui, sans-serif';
    context.textBaseline = 'top';

    boxes.forEach((box, index) => {
      const klass = classes.find((candidate) => candidate.label_class_id === box.label_class_id);
      const color = klass?.color ?? '#57c2b5';
      const x = box.bbox.x * scale;
      const y = box.bbox.y * scale;
      const w = box.bbox.w * scale;
      const h = box.bbox.h * scale;
      context.strokeStyle = color;
      context.setLineDash(index === selected ? [4, 3] : []);
      context.strokeRect(x, y, w, h);
      context.setLineDash([]);

      const label = klass?.name ?? '?';
      const width = context.measureText(label).width + 8;
      context.fillStyle = color;
      context.fillRect(x, Math.max(0, y - 18), width, 18);
      context.fillStyle = '#0b0b0b';
      context.fillText(label, x + 4, Math.max(0, y - 17));

      if (index === selected) {
        context.fillStyle = color;
        context.fillRect(x + w - HANDLE / 2, y + h - HANDLE / 2, HANDLE, HANDLE);
      }
    });

    if (preview) {
      context.strokeStyle = activeClass?.color ?? '#93a0f2';
      context.setLineDash([4, 3]);
      context.strokeRect(
        preview.x * scale,
        preview.y * scale,
        preview.w * scale,
        preview.h * scale,
      );
      context.setLineDash([]);
    }
  }, [bitmap, boxes, classes, selected, preview, scale, activeClass]);

  // キーボード操作。教師データ作りは反復なので、手をマウスから離さずに回せるようにする。
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (readOnly) return;
      const target = event.target as HTMLElement | null;
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;

      if (event.key >= '1' && event.key <= '9') {
        const index = Number(event.key) - 1;
        if (index < classes.length) {
          setClassIndex(index);
          // 選択中の矩形があれば、そのクラスも変える。
          if (selected !== null) {
            const klass = classes[index];
            if (klass) {
              push(
                boxes.map((box, i) =>
                  i === selected ? { ...box, label_class_id: klass.label_class_id } : box,
                ),
              );
            }
          }
        }
        return;
      }
      if ((event.key === 'Delete' || event.key === 'Backspace') && selected !== null) {
        event.preventDefault();
        push(boxes.filter((_, index) => index !== selected));
        setSelected(null);
        return;
      }
      if (event.key === 'Escape') {
        setSelected(null);
        return;
      }
      if (event.ctrlKey && event.key === 'z') {
        event.preventDefault();
        undo();
        return;
      }
      if (event.ctrlKey && event.key === 's') {
        event.preventDefault();
        onSave(boxes);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [boxes, classes, selected, readOnly, push, undo, onSave]);

  const toImage = (event: React.MouseEvent<HTMLCanvasElement>): { x: number; y: number } => {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) / scale,
      y: (event.clientY - rect.top) / scale,
    };
  };

  const onMouseDown = (event: React.MouseEvent<HTMLCanvasElement>): void => {
    if (readOnly) return;
    const { x, y } = toImage(event);

    if (selected !== null) {
      const box = boxes[selected];
      if (box && onHandle(box.bbox, x, y, scale)) {
        setDrag({ kind: 'resize', index: selected });
        return;
      }
    }
    const index = [...boxes].reverse().findIndex((box) => hit(box.bbox, x, y));
    if (index >= 0) {
      const actual = boxes.length - 1 - index;
      const box = boxes[actual];
      if (box) {
        setSelected(actual);
        setDrag({ kind: 'move', index: actual, offsetX: x - box.bbox.x, offsetY: y - box.bbox.y });
        return;
      }
    }
    setSelected(null);
    setDrag({ kind: 'draw', startX: x, startY: y });
  };

  const onMouseMove = (event: React.MouseEvent<HTMLCanvasElement>): void => {
    if (!drag) return;
    const { x, y } = toImage(event);

    if (drag.kind === 'draw') {
      setPreview({
        x: Math.min(drag.startX, x),
        y: Math.min(drag.startY, y),
        w: Math.abs(x - drag.startX),
        h: Math.abs(y - drag.startY),
      });
      return;
    }
    if (drag.kind === 'move') {
      setBoxes((current) =>
        current.map((box, index) =>
          index === drag.index
            ? {
                ...box,
                bbox: {
                  ...box.bbox,
                  x: Math.max(0, Math.min(x - drag.offsetX, image.width - box.bbox.w)),
                  y: Math.max(0, Math.min(y - drag.offsetY, image.height - box.bbox.h)),
                },
              }
            : box,
        ),
      );
      return;
    }
    setBoxes((current) =>
      current.map((box, index) =>
        index === drag.index
          ? {
              ...box,
              bbox: {
                ...box.bbox,
                w: Math.max(4, Math.min(x, image.width) - box.bbox.x),
                h: Math.max(4, Math.min(y, image.height) - box.bbox.y),
              },
            }
          : box,
      ),
    );
  };

  const onMouseUp = (): void => {
    if (drag?.kind === 'draw' && preview && preview.w > 4 && preview.h > 4 && activeClass) {
      push([...boxes, { label_class_id: activeClass.label_class_id, bbox: preview }]);
      setSelected(boxes.length);
    }
    setPreview(null);
    setDrag(null);
  };

  return (
    <div>
      <p className="muted">
        ドラッグで矩形を引く / クリックで選択 / 右下のハンドルでリサイズ /{' '}
        <strong>1〜9</strong> でクラス切替 / <strong>Delete</strong> で削除 /{' '}
        <strong>Ctrl+Z</strong> で取り消し / <strong>Ctrl+S</strong> で保存
      </p>
      <p className="detection-list">
        {classes.slice(0, 9).map((klass, index) => (
          <button
            key={klass.label_class_id}
            type="button"
            onClick={() => setClassIndex(index)}
            disabled={readOnly}
            style={{
              borderColor: klass.color,
              fontWeight: index === classIndex ? 700 : 400,
            }}
          >
            <span className="swatch" style={{ background: klass.color }} /> {index + 1}. {klass.name}
          </button>
        ))}
        {classes.length === 0 && <span className="muted">クラスがない。先にクラス体系を作ること。</span>}
      </p>
      <canvas
        ref={canvasRef}
        className="detection-canvas"
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        onMouseLeave={onMouseUp}
        style={{ cursor: readOnly ? 'default' : 'crosshair' }}
      />
      <p>
        <button type="button" onClick={() => onSave(boxes)} disabled={readOnly}>
          この内容で版を保存（{boxes.length} 件）
        </button>{' '}
        <button type="button" onClick={undo} disabled={readOnly || history.current.length === 0}>
          取り消し
        </button>{' '}
        {onCreateFromDetections && (
          <button type="button" onClick={onCreateFromDetections} disabled={readOnly}>
            直近の推論結果から起こす
          </button>
        )}
      </p>
    </div>
  );
}
