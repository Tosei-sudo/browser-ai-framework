// R1 のメインスレッド側。実行はすべて Worker 内で行う（論点19）。

const out = document.getElementById('out');

function log(line, cls = '') {
  console.log('[R1]', line);
  const el = document.createElement('div');
  el.textContent = line;
  if (cls) el.className = cls;
  out.appendChild(el);
}

const worker = new Worker('./r1-worker.js');
worker.onmessage = (event) => {
  const { type, line, cls } = event.data;
  if (type === 'log') log(line, cls);
  if (type === 'done') log('--- 完了 ---', 'ok');
};
worker.postMessage({ type: 'start' });
