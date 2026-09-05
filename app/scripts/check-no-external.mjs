/**
 * 外部取得ゼロの検査（論点39）。
 *
 * ビルド成果物（dist/）を走査し、許可リストにない外部URLが含まれていたら
 * 終了コード 1 で落ちる。閉域環境（論点36）へ持ち込む前に CI で機械的に止めるためのもの。
 *
 * これは静的な文字列しか見られない。動的に組み立てられるURLは
 * オフライン動作確認（docs/operations/offline-verification.md）で捕まえる。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const distDir = fileURLToPath(new URL('../dist', import.meta.url));

/** 走査対象の拡張子。バイナリと、実行されないソースマップは対象外。 */
const TEXT_EXTENSIONS = new Set(['.html', '.js', '.mjs', '.css', '.json', '.svg', '.txt']);

/**
 * 許可するURL。**追加は例外であり、理由をここに書くこと。**
 * 実行時に取得しないもの（名前空間、エラーメッセージ中の参照先）に限る。
 */
const ALLOWED = [
  // XML 名前空間。識別子であり、ネットワークアクセスは発生しない。
  'http://www.w3.org/2000/svg',
  'http://www.w3.org/1999/xhtml',
  'http://www.w3.org/1999/xlink',
  'http://www.w3.org/1998/Math/MathML',
  'http://www.w3.org/XML/1998/namespace',
  // React の最小化エラーメッセージに埋め込まれた解説ページ。
  // 文字列として出力されるだけで、アプリが取得することはない。
  'https://react.dev/errors/',
];

/** 開発サーバーのURL。成果物の実行には影響しない。 */
const IGNORED_PREFIXES = ['http://localhost', 'http://127.0.0.1'];

const URL_PATTERN = /\bhttps?:\/\/[^\s"'`<>()[\]{}]+/g;

/** 末尾に付いてくる区切り記号とエスケープ用のバックスラッシュを落とす。 */
const TRAILING_NOISE = new RegExp('[,;:.\u005c\u005c]+$');

function listFiles(dir) {
  const entries = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      entries.push(...listFiles(path));
    } else {
      entries.push(path);
    }
  }
  return entries;
}

function isAllowed(url) {
  if (ALLOWED.some((allowed) => url === allowed || url.startsWith(allowed))) return true;
  return IGNORED_PREFIXES.some((prefix) => url.startsWith(prefix));
}

let files;
try {
  files = listFiles(distDir);
} catch {
  console.error('dist/ がない。先に `npm run build` を実行すること。');
  process.exit(1);
}

const findings = [];
for (const file of files) {
  if (!TEXT_EXTENSIONS.has(extname(file))) continue;
  readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .forEach((line, i) => {
      for (const match of line.matchAll(URL_PATTERN)) {
        const url = match[0].replace(TRAILING_NOISE, '');
        if (isAllowed(url)) continue;
        findings.push({ file: relative(distDir, file), line: i + 1, url });
      }
    });
}

if (findings.length > 0) {
  console.error('外部URLが成果物に含まれている（論点36: 外部取得ゼロ）:');
  for (const finding of findings) {
    console.error(`  ${finding.file}:${finding.line}  ${finding.url}`);
  }
  console.error(
    '\n実行時に取得しないURLであれば scripts/check-no-external.mjs の ALLOWED に理由付きで追加する。',
  );
  process.exit(1);
}

console.log(`外部URLなし（走査 ${files.length} ファイル）。`);
