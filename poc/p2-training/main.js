// P2 / P3 のメインスレッド側。
//
// raccoon_dataset の CSV を読み、画像URLと正規化済みボックスの一覧を作って
// Worker に渡す。学習そのものはすべて Worker 内で行う（論点19）。

const CSV = '/datasets/raccoon_dataset-master/data/raccoon_labels.csv';
const IMAGES = '/datasets/raccoon_dataset-master/images/';

const out = document.getElementById('out');
const bar = document.getElementById('bar');

function log(line, cls = '') {
  console.log('[PoC]', line);
  const el = document.createElement('div');
  el.textContent = line;
  if (cls) el.className = cls;
  out.appendChild(el);
  out.scrollTop = out.scrollHeight;
}

// filename,width,height,class,xmin,ymin,xmax,ymax
async function loadSamples() {
  const text = await (await fetch(CSV)).text();
  const lines = text.trim().split(/\r?\n/).slice(1);
  const byFile = new Map();
  for (const line of lines) {
    const [filename, w, h, cls, xmin, ymin, xmax, ymax] = line.split(',');
    // 1画像に複数ボックスがある場合は最初の1件だけ使う（ヘッドが単一ボックス予測のため）
    if (byFile.has(filename)) continue;
    const W = +w, H = +h;
    const x1 = +xmin / W, y1 = +ymin / H, x2 = +xmax / W, y2 = +ymax / H;
    byFile.set(filename, {
      url: IMAGES + filename,
      cls,
      box: [(x1 + x2) / 2, (y1 + y2) / 2, x2 - x1, y2 - y1], // cxcywh
    });
  }
  return [...byFile.values()];
}

function table(rows) {
  rows.forEach(([k, v]) => log(`  ${String(k).padEnd(28)} ${v}`));
}

async function main() {
  log('--- データセット ---', 'head');
  const samples = await loadSamples();
  const classes = [...new Set(samples.map((s) => s.cls))];
  log(`raccoon_dataset: ${samples.length}枚  クラス: ${classes.join(', ')}（${classes.length}クラス）`);
  log('COCO 91クラスのバックボーンから、新しい1クラスへの転移という構成になる（方針1の LabelSet 派生に相当）');

  const worker = new Worker('./train-worker.js');
  worker.onmessage = (e) => {
    const d = e.data;
    if (d.type === 'log') {
      log(d.text);
    } else if (d.type === 'progress') {
      if (d.phase === 'features') {
        bar.textContent = `特徴量 ${d.done}/${d.total}  tensors=${d.mem.tensors} ${d.mem.mb}MB`;
      } else {
        bar.textContent = `epoch ${d.epoch}/${d.total}  loss=${d.loss} val=${d.valLoss}  ${d.ms}ms  tensors=${d.mem.tensors} ${d.mem.mb}MB`;
      }
    } else if (d.type === 'done') {
      bar.textContent = '';
      const r = d.result;
      if (!r.ok) {
        log(`失敗: ${r.error}`, 'ng');
      } else {
        log('--- 結果 ---', 'head');
        table([
          ['バックエンド', r.backend],
          ['バックボーンのロード', `${r.backboneLoadMs}ms`],
          ['特徴量の事前計算', `${r.featureMs}ms（1枚 ${r.featurePerImageMs}ms、次元 ${r.featureDim}）`],
          ['train / val', `${r.split.train} / ${r.split.val}`],
          ['ヘッドのパラメータ数', r.headParams.toLocaleString()],
          ['学習', `${r.trainMs}ms / ${r.epochs} epoch（1 epoch 中央値 ${r.epochMsMedian}ms）`],
          ['loss', `${r.lossFirst} → ${r.lossLast}`],
          ['val loss', `${r.valLossFirst} → ${r.valLossLast}`],
          ['平均IoU（検証）', `${r.iouBefore} → ${r.iouAfter}`],
          ['学習後のメモリ', `tensors=${r.memAfterTrain.tensors} ${r.memAfterTrain.mb}MB`],
          ['解放後のメモリ', `tensors=${r.memFinal.tensors} ${r.memFinal.mb}MB`],
          ['重みの取り出しと保存', `${(r.weightBytes / 1024).toFixed(1)}KB  往復一致 ${r.weightRoundTrip}`],
        ]);
        const total = r.backboneLoadMs + r.featureMs + r.trainMs;
        log(`--- 合計 ${(total / 1000).toFixed(1)}秒（ロード + 特徴量 + 学習）---`, 'ok head');
      }
      console.log('[PoC][RESULT]', JSON.stringify(r));
      worker.terminate();
    }
  };
  worker.onerror = (err) => {
    log(`Worker が失敗: ${err.message}`, 'ng');
    console.log('[PoC][RESULT] worker error', err.message);
  };
  worker.postMessage({ samples });
}

main();
