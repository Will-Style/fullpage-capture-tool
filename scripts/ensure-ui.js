'use strict';

// public/ は UI のビルド成果物なので Git 管理外にしてある。
// クローン直後にそのまま `pnpm start` すると UI が無い状態で立ち上がってしまうため、
// start の前にここを通し、成果物が無いときだけビルドする（毎回だと起動が遅い）。

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

if (fs.existsSync(path.join(ROOT, 'public', 'index.html'))) process.exit(0);

console.log('UI がまだビルドされていません。先に pnpm build を実行します…\n');
try {
  execSync('pnpm build', { cwd: ROOT, stdio: 'inherit' });
} catch (_) {
  console.error('\nUI のビルドに失敗しました。pnpm build を手動で実行してエラーを確認してください。');
  process.exit(1);
}
