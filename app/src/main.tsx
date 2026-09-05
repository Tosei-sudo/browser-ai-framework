/**
 * アプリの入口。
 *
 * 外部取得ゼロ（論点36）。フォント・CSS・スクリプトを外部から読み込まない。
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '@ui/App';

const container = document.getElementById('root');
if (!container) {
  throw new Error('#root が見つからない');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
