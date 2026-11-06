'use strict';

// Playwright の Chromium は pnpm install の postinstall で入る想定だが、
// zip で配布したフォルダをそのまま使う／pnpm install がスキップされる などで
// 入らないまま起動されることがある。その場合キャプチャや動画生成の実行時に
// 「Executable doesn't exist at .../chrome-headless-shell」で落ちてしまい原因が分かりにくい。
// 起動前にここを通し、足りなければ入れる（入っていれば 1 秒弱で素通りする）。

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

function playwrightBin() {
  const dir = path.join(ROOT, 'node_modules', '.bin');
  const candidates =
    process.platform === 'win32' ? ['playwright.cmd', 'playwright.exe', 'playwright'] : ['playwright'];
  for (const name of candidates) {
    const p = path.join(dir, name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

const bin = playwrightBin();
if (!bin) {
  console.error('playwright が node_modules にありません。先に `pnpm install` を実行してください。');
  process.exit(1);
}

// `playwright install chromium` は冪等で、入っていれば何も出さずすぐ終わる。
const res = spawnSync(bin, ['install', 'chromium'], { cwd: ROOT, stdio: 'inherit' });
if (res.status !== 0) {
  console.error(
    '\nPlaywright の Chromium を用意できませんでした。' +
      '\n`pnpm exec playwright install chromium` を手動で実行してエラーを確認してください。' +
      "\n'does not support ... on macXX' と出る場合は、その macOS 向けのビルドが" +
      '\nこの Playwright のバージョンに無いという意味です（README の「対応 macOS」参照）。'
  );
  process.exit(1);
}
