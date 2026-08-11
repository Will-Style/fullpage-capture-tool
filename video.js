'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const {
  getBrowser,
  expandLazyContent,
  unpinFixedElements,
  getPageHeight,
} = require('./capture');

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
// 実測では 25fps が最も重複コマが少ない。
// screencast は 60fps 前後で取れるが、CFR に直す際の当たりが 25 で最もきれいに揃う。
const DEFAULT_FPS = 25;
const FFPROBE = process.env.FFPROBE_PATH || FFMPEG.replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1');

// 動きの間合いは固定値。1.2 秒かけて動いて 0.6 秒止まる。
const HOLD_SEC = 0.6;
const MOVE_SEC = 1.2;
// 1 回に進む量（ビューポート高さ比）。UI から選べる値
const STEP_RATIOS = [0.6, 0.8, 1.0];
const DEFAULT_STEP_RATIO = 1.0;

// 尺の上限に収めるためにやむを得ず詰めるときの下限（秒）
const MIN_HOLD_SEC = 0.25;
const MIN_MOVE_SEC = 0.3;

/* ------------------------------------------------------------------ *
 * イージング
 * ------------------------------------------------------------------ */

// 各系統の「In」だけを定義し、Out と InOut はそこから導く
const EASE_IN = {
  Sine: (t) => 1 - Math.cos((t * Math.PI) / 2),
  Quad: (t) => t * t,
  Cubic: (t) => t * t * t,
  Quart: (t) => t * t * t * t,
  Quint: (t) => t * t * t * t * t,
  Expo: (t) => (t <= 0 ? 0 : Math.pow(2, 10 * t - 10)),
};

const toOut = (f) => (t) => 1 - f(1 - t);
const toInOut = (f) => (t) => (t < 0.5 ? f(2 * t) / 2 : 1 - f(2 - 2 * t) / 2);

/** すべて f(0)=0, f(1)=1。行き過ぎる系（Back / Bounce）は含めない */
const EASINGS = { linear: (t) => t };
for (const [family, fn] of Object.entries(EASE_IN)) {
  EASINGS[`easeIn${family}`] = fn;
  EASINGS[`easeOut${family}`] = toOut(fn);
  EASINGS[`easeInOut${family}`] = toInOut(fn);
}

const DEFAULT_EASING = 'easeOutQuart';

function getEasing(name) {
  return EASINGS[name] || EASINGS[DEFAULT_EASING];
}

/** 同じシードなら同じ場面が選ばれるようにするための乱数生成器（mulberry32） */
function makeRng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ------------------------------------------------------------------ *
 * タイムライン
 * ------------------------------------------------------------------ */

/**
 * 「1 画面スクロールしては静止する」動きを、fps 単位のスクロール位置の列に展開する。
 *
 * 静止・移動時間は固定なので、尺はページの高さでほぼ決まる。
 * 上限を超える場合だけ、静止・移動を比例で詰めて収める（下限あり）。
 * それでも超えるときは超過を許容し、実尺と超過フラグを返す。
 */
function buildTimeline({
  scrollable,
  viewportHeight,
  fps,
  targetSec,
  easing = DEFAULT_EASING,
  stepRatio = DEFAULT_STEP_RATIO,
}) {
  const ease = getEasing(easing);
  const step = Math.max(1, Math.round(viewportHeight * stepRatio));
  const steps = scrollable <= 0 ? 0 : Math.ceil(scrollable / step);

  let hold = HOLD_SEC;
  let move = MOVE_SEC;
  const totalSec = () => hold + steps * (move + hold);

  if (targetSec > 0 && steps > 0 && totalSec() > targetSec) {
    const k = targetSec / totalSec();
    hold = Math.max(MIN_HOLD_SEC, hold * k);
    move = Math.max(MIN_MOVE_SEC, move * k);
  }

  const holdFrames = Math.max(1, Math.round(hold * fps));
  const moveFrames = Math.max(1, Math.round(move * fps));

  const frames = [];
  const push = (y) => frames.push(Math.max(0, Math.min(scrollable, Math.round(y))));

  for (let i = 0; i < holdFrames; i++) push(0);
  for (let i = 0; i < steps; i++) {
    const from = Math.min(i * step, scrollable);
    const to = Math.min((i + 1) * step, scrollable);
    for (let f = 1; f <= moveFrames; f++) push(from + (to - from) * ease(f / moveFrames));
    for (let k = 0; k < holdFrames; k++) push(to);
  }

  const durationSec = frames.length / fps;
  // ステップ数の切り上げとフレーム丸めで 1 サイクル分は必ずはみ出すので、その分は許容する
  const tolerance = hold + move + 1 / fps;
  return {
    kind: 'scroll',
    easing,
    frames,
    step,
    steps,
    stepRatio,
    holdSec: hold,
    moveSec: move,
    durationSec,
    fitted: !(targetSec > 0) || durationSec <= targetSec + tolerance,
    compressed: hold < HOLD_SEC - 1e-6 || move < MOVE_SEC - 1e-6,
  };
}

/**
 * ダイジェスト用。ページ全体をなぞるのではなく、場面をランダムに選んでハードカットでつなぐ。
 *
 * 1 場面の中身は本編とまったく同じ動き（1 画面ぶんを moveSec で移動して holdSec 静止）。
 * 速度も距離もイージングも変えないので、切り出した断片として見える。
 * 本編が尺の上限で間合いを詰められた場合も、その値をそのまま受け取って揃える。
 *
 * 1 場面目は必ずページ先頭から始める。以降は層化抽出（残りの範囲を等分し、
 * 各区画から 1 点ずつ）で選ぶ。一様乱数だと選んだ点が固まって同じあたりばかり映るため。
 */
function buildSceneTimeline({
  scrollable,
  viewportHeight,
  fps,
  targetSec,
  scenes,
  easing = DEFAULT_EASING,
  moveSec = MOVE_SEC,
  holdSec = HOLD_SEC,
  stepRatio = DEFAULT_STEP_RATIO,
  rng,
}) {
  const ease = getEasing(easing);
  // 本編と同じ移動量にする
  const drift = Math.max(1, Math.round(viewportHeight * stepRatio));
  const moveFrames = Math.max(1, Math.round(moveSec * fps));
  const holdFrames = Math.max(1, Math.round(holdSec * fps));
  // 「カットで入る 1 枚 + 移動 + 静止」で 1 場面
  const sceneFrames = 1 + moveFrames + holdFrames;
  const sceneSec = sceneFrames / fps;

  // 場面数の指定がなければ、尺に入るだけ詰める
  const byTarget = Math.max(1, Math.floor(targetSec / sceneSec));
  // スクロール量に対して取りすぎても同じ絵が並ぶだけなので、半画面刻みの数で頭打ちにする
  const byPage = Math.max(1, Math.ceil(scrollable / Math.max(1, viewportHeight * 0.5)));
  const sceneCount = Math.max(1, Math.min(scenes || byTarget, byPage));

  // 1 場面目は必ず先頭。残りは、先頭の場面が見せ終わる位置から下を等分して選ぶ
  const starts = [0];
  const rest = sceneCount - 1;
  const from0 = Math.min(drift, scrollable);
  for (let i = 0; i < rest; i++) {
    const lo = from0 + ((scrollable - from0) * i) / rest;
    const hi = from0 + ((scrollable - from0) * (i + 1)) / rest;
    starts.push(lo + rng() * (hi - lo));
  }

  const frames = [];
  const push = (y) => frames.push(Math.max(0, Math.min(scrollable, Math.round(y))));

  for (const start of starts) {
    // 末尾付近ではこれ以上進めないので、移動量が確保できる位置まで戻す
    const from = Math.max(0, Math.min(start, scrollable - drift));
    const to = Math.min(from + drift, scrollable);
    push(from); // カットで入った瞬間の 1 枚
    for (let f = 1; f <= moveFrames; f++) push(from + (to - from) * ease(f / moveFrames));
    for (let k = 0; k < holdFrames; k++) push(to);
  }

  const durationSec = frames.length / fps;
  return {
    kind: 'scenes',
    easing,
    frames,
    scenes: sceneCount,
    sceneSec,
    driftPx: drift,
    stepRatio,
    moveSec,
    holdSec,
    startsPx: starts.map((y) => Math.round(y)),
    durationSec,
    fitted: durationSec <= targetSec + sceneSec,
    compressed: false,
  };
}

/* ------------------------------------------------------------------ *
 * ffmpeg
 * ------------------------------------------------------------------ */

let ffmpegReady = null;

function ensureFfmpeg() {
  if (!ffmpegReady) {
    ffmpegReady = runFfmpeg(['-version']).catch(() => {
      ffmpegReady = null;
      throw new Error(
        `ffmpeg が見つかりません（${FFMPEG}）。'brew install ffmpeg' で入れるか、FFMPEG_PATH で実行ファイルを指定してください`
      );
    });
  }
  return ffmpegReady;
}

/** out_time=HH:MM:SS.ff → 秒 */
function parseFfmpegTime(value) {
  const m = /^(\d+):(\d+):(\d+(?:\.\d+)?)$/.exec(value);
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

function runFfmpeg(args, { onTime } = {}) {
  return new Promise((resolve, reject) => {
    const ps = spawn(FFMPEG, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let tail = '';

    ps.stdout.on('data', (chunk) => {
      if (!onTime) return;
      for (const line of String(chunk).split('\n')) {
        const m = /^out_time=(.+)$/.exec(line.trim());
        if (!m) continue;
        const sec = parseFfmpegTime(m[1]);
        if (sec !== null) onTime(sec);
      }
    });
    // stderr は失敗時のメッセージ用。全部持つと長いので末尾だけ残す
    ps.stderr.on('data', (chunk) => {
      tail = (tail + chunk).slice(-8000);
    });

    ps.on('error', reject);
    ps.on('close', (code) => {
      if (code === 0) return resolve();
      const detail = tail.trim().split('\n').slice(-12).join('\n');
      reject(new Error(`ffmpeg が異常終了しました (code ${code})\n${detail}`));
    });
  });
}

function runFfprobe(args) {
  return new Promise((resolve, reject) => {
    const ps = spawn(FFPROBE, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    ps.stdout.on('data', (c) => { out += c; });
    ps.on('error', reject);
    ps.on('close', (code) => (code === 0 ? resolve(out.trim()) : reject(new Error('ffprobe に失敗しました'))));
  });
}

/** 入力動画の素性を調べる（枠付けツール用） */
async function probeVideo(file) {
  const [v, a, d] = await Promise.all([
    runFfprobe(['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file]).catch(() => ''),
    runFfprobe(['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', file]).catch(() => ''),
    runFfprobe(['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]).catch(() => ''),
  ]);
  const [width, height] = v.split(',').map((n) => Number.parseInt(n, 10));
  if (!Number.isFinite(width) || !Number.isFinite(height)) {
    throw new Error('動画ファイルとして読み取れませんでした');
  }
  return { width, height, hasAudio: a !== '', durationSec: Number.parseFloat(d) || 0 };
}

/**
 * 秒数を ffmpeg の引数に整える。
 * NaN をそのまま渡すと "Invalid duration for option ss" という原因の追いにくい
 * エラーになるため、必ずここを通す。
 */
function secArg(value, fallback = 0) {
  return (Number.isFinite(value) ? value : fallback).toFixed(3);
}

/** 拡大はせず、指定幅を超える場合だけ縮小する（高さは偶数に丸める） */
function scaleFilter(outWidth) {
  return `scale=w='min(iw\\,${outWidth})':h=-2:flags=lanczos`;
}

/**
 * 映像フィルタを組み立てる。
 *
 * pad 指定時は「キャンバス × 割合」の枠に縦横比を保ったまま収め、中央に置いて
 * 残りを背景色で塗る（video-padding-app の pad モードと同じ計算）。
 * yuv420p のため、動画サイズも配置位置も偶数に丸める必要がある。
 *
 * @param {number|null} fps  null ならフレームレートを変えない
 */
function videoFilter({ fps, outWidth, pad }) {
  const parts = [];
  if (fps) parts.push(`fps=${fps}`);

  if (pad && pad.enabled) {
    const boxW = Math.max(2, Math.round((pad.width * pad.percent) / 100));
    const boxH = Math.max(2, Math.round((pad.height * pad.percent) / 100));
    const color = `0x${String(pad.color).replace(/^#/, '')}`;
    parts.push(
      `scale=w=${boxW}:h=${boxH}:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=lanczos`,
      `pad=${pad.width}:${pad.height}:trunc((ow-iw)/4)*2:trunc((oh-ih)/4)*2:color=${color}`
    );
  } else if (outWidth) {
    parts.push(scaleFilter(outWidth));
  }

  parts.push('format=yuv420p');
  return parts.join(',');
}

function encoderArgs(format, quality) {
  if (format === 'webm') {
    // VP9。-b:v 0 で CRF モード（品質固定）になる
    return [
      '-c:v', 'libvpx-vp9',
      '-b:v', '0',
      '-crf', String(quality.vp9),
      '-row-mt', '1',
      '-deadline', 'good',
      '-cpu-used', '2',
      '-pix_fmt', 'yuv420p',
    ];
  }
  return [
    '-c:v', 'libx264',
    '-preset', 'medium',
    '-crf', String(quality.h264),
    '-pix_fmt', 'yuv420p',
    '-profile:v', 'high',
    '-movflags', '+faststart',
  ];
}

/** 音声の扱い。WebM に AAC は入れられないので、形式で分ける */
function audioArgs(format, hasAudio) {
  if (!hasAudio) return ['-an'];
  return format === 'webm'
    ? ['-map', '0:a:0', '-c:a', 'libopus', '-b:a', '128k']
    : ['-map', '0:a:0', '-c:a', 'aac', '-b:a', '192k'];
}

/* ------------------------------------------------------------------ *
 * 収録（リアルタイム）
 * ------------------------------------------------------------------ */

/**
 * ページを開いてタイムラインどおりに実時間でスクロールしながら収録する。
 *
 * 録画は「ページ生成時点」から始まるため、読み込み・準備に要した分を後から切り落とす。
 * 切り落とす位置は contentStartedAt（＝ここから本番、と決めた瞬間）で決まる。
 *
 * イントロを撮る場合は、準備が済んだあとにページを読み込み直して
 * アニメーションを最初から流し直す（準備中のスクロールで既に再生済みのため）。
 */
/**
 * CDP の screencast を開始し、届いたフレームを 1 枚ずつファイルに書き出す。
 *
 * Playwright の録画機能（recordVideo）は 25fps 固定かつ VP8 で一度圧縮されるため、
 * 画質と滑らかさの両方で頭打ちになる。screencast なら無劣化の PNG を
 * 表示のリフレッシュに近い速さで取れるので、こちらを使う。
 *
 * ただし screencast が返すのは CSS ピクセル相当（deviceScaleFactor は効かない）。
 */
async function startScreencast(context, page, dir, { fps, width, height }) {
  fs.mkdirSync(dir, { recursive: true });
  const cdp = await context.newCDPSession(page);

  const frames = [];
  let index = 0;
  // 書き込みは直列につないで、I/O を山にしない
  let writing = Promise.resolve();

  // 届いたコマは間引かずに全部残す。
  // 出力 fps に近い数まで減らすと、ffmpeg が CFR に直すときに
  // 取りこぼしと重複が出てカクつく。素のまま渡すほうがきれいに揃う。
  cdp.on('Page.screencastFrame', (frame) => {
    // ack を返さないと次のフレームが来ないので、何よりも先に返す
    cdp.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => {});

    const t = frame.metadata && frame.metadata.timestamp ? frame.metadata.timestamp : Date.now() / 1000;
    const file = path.join(dir, `f${String(index++).padStart(6, '0')}.png`);
    frames.push({ t, file });
    const data = Buffer.from(frame.data, 'base64');
    writing = writing.then(() => fs.promises.writeFile(file, data)).catch(() => {});
  });

  await cdp.send('Page.startScreencast', {
    format: 'png',
    maxWidth: width,
    maxHeight: height,
    everyNthFrame: 1,
  });

  return {
    count: () => frames.length,
    async stop() {
      await cdp.send('Page.stopScreencast').catch(() => {});
      await writing;
      await cdp.detach().catch(() => {});
      return frames;
    },
  };
}

async function recordPass({
  browser,
  contextOpts,
  prepare,
  settle,
  buildFor,
  fps,
  dir,
  introSec = 0,
  label,
  onProgress,
}) {
  const context = await browser.newContext(contextOpts);
  const page = await context.newPage();

  let frames = [];
  let timeline = null;
  let pageHeight = 0;

  try {
    await prepare(page, `${label}: `);
    pageHeight = await getPageHeight(page);
    timeline = buildFor(Math.max(0, pageHeight - contextOpts.viewport.height));

    if (introSec > 0) {
      // 準備中のスクロールでイントロは再生され切っているので、読み込み直して撮り直す
      onProgress({ phase: 'shoot', message: `${label}: イントロを撮り直すため再読み込み中…` });
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
      await settle(page);
    }

    const totalSec = introSec + timeline.durationSec;
    onProgress({
      phase: 'shoot',
      message: `${label}を収録中…（約 ${totalSec.toFixed(0)} 秒）`,
    });

    // 収録はここから始める。前後を切り落とす必要がないので尺がずれない
    const capture = await startScreencast(context, page, dir, {
      fps,
      width: contextOpts.viewport.width,
      height: contextOpts.viewport.height,
    });

    if (introSec > 0) await page.waitForTimeout(introSec * 1000);

    await page.evaluate(
      async ({ ys, fps: rate }) => {
        const t0 = performance.now();
        const last = ys.length - 1;

        await new Promise((resolve) => {
          const tick = (now) => {
            // タイムライン上の位置を小数で求め、隣り合う値を補間する。
            //
            // fps 刻みの値をそのまま使うと、60Hz の画面では同じ位置が 2 回続けて描画され、
            // 録画側でそれが重複コマになって Parallax がカクついて見える。
            // 表示のリフレッシュごとに違う位置を渡せば、毎コマ別の絵になる。
            const t = ((now - t0) / 1000) * rate;
            if (t >= last) {
              window.scrollTo(0, ys[last]);
              resolve();
              return;
            }
            const i = Math.floor(t);
            window.scrollTo(0, ys[i] + (ys[i + 1] - ys[i]) * (t - i));
            requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        });
      },
      { ys: timeline.frames, fps }
    );

    // 末尾が切れないよう少し余韻を残す
    await page.waitForTimeout(300);
    frames = await capture.stop();
  } finally {
    await context.close();
  }

  if (!frames.length) throw new Error('画面を取得できませんでした');
  const span = frames[frames.length - 1].t - frames[0].t;
  return {
    frames,
    timeline,
    pageHeight,
    totalSec: introSec + timeline.durationSec,
    // 収録できた実効フレームレート（出力 fps を下回ると動きが粗くなる）
    capturedFps: span > 0 ? frames.length / span : 0,
  };
}

/**
 * 収録したフレームを concat 用のリストに落とす。
 * 各コマの表示時間は screencast のタイムスタンプの差そのものなので、
 * 変化がなかった区間は 1 枚が長く表示され、動きの速い区間は細かく並ぶ。
 */
function writeFrameList(frames, listPath, fps) {
  const lines = [];
  for (let i = 0; i < frames.length; i++) {
    const next = i + 1 < frames.length ? frames[i + 1].t : frames[i].t + 1 / fps;
    const dur = Math.max(1 / 1000, next - frames[i].t);
    lines.push(`file '${frames[i].file}'`, `duration ${dur.toFixed(6)}`);
  }
  // concat は最終エントリの duration を無視するので、同じファイルをもう一度並べる
  lines.push(`file '${frames[frames.length - 1].file}'`);
  fs.writeFileSync(listPath, lines.join('\n') + '\n');
}

async function encodeRecording({
  listPath, durationSec, outPath, format, fps, outWidth, pad, quality, onTime,
}) {
  await runFfmpeg(
    [
      '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
      '-progress', 'pipe:1',
      '-f', 'concat', '-safe', '0', '-i', listPath,
      '-t', secArg(durationSec),
      '-vf', videoFilter({ fps, outWidth, pad }),
      ...encoderArgs(format, quality),
      '-an',
      outPath,
    ],
    { onTime }
  );
}

/* ------------------------------------------------------------------ *
 * スクロール動画
 * ------------------------------------------------------------------ */

function buildContext(opts) {
  return {
    viewport: { width: opts.width, height: opts.viewportHeight },
    deviceScaleFactor: opts.scale,
    userAgent: opts.userAgent || undefined,
    hasTouch: opts.width <= 768,
    locale: 'ja-JP',
    timezoneId: 'Asia/Tokyo',
  };
}

/**
 * ページの準備手順を組み立てる。
 * prepare = 読み込み〜遅延画像の展開まで／settle = 読み込み直した後に再適用する分だけ
 */
function buildPreparers(opts, onProgress) {
  const { url, viewportHeight, hideFixed, waitMs } = opts;

  const settle = async (page) => {
    // アニメーションは止めない（実挙動を撮るため）。
    // ただしスムーススクロールだけは切る。有効だと位置指定が非同期になり尺が狂う。
    await page.addStyleTag({ content: `html, body, * { scroll-behavior: auto !important; }` });
    if (hideFixed) await unpinFixedElements(page);
  };

  const prepare = async (page, prefix = '') => {
    onProgress({ phase: 'load', message: `${prefix}ページを読み込み中…` });
    await page.goto(url, { waitUntil: 'load', timeout: 60000 });
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});

    onProgress({ phase: 'expand', message: `${prefix}遅延読み込み画像を展開中…` });
    await expandLazyContent(page, Math.floor(viewportHeight * 0.8));

    await settle(page);
    await page.evaluate(() => document.fonts && document.fonts.ready).catch(() => {});
    if (waitMs > 0) await page.waitForTimeout(waitMs);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(200);
  };

  return { prepare, settle };
}

function mainBuilder(opts) {
  return (scrollable) =>
    buildTimeline({
      scrollable,
      viewportHeight: opts.viewportHeight,
      fps: opts.fps,
      targetSec: opts.targetSec,
      easing: opts.easing,
      stepRatio: opts.stepRatio,
    });
}

function digestBuilder(opts, seed) {
  const { viewportHeight, fps, digest } = opts;
  const digestSec = digest.targetSec ?? 10;
  return (scrollable) => {
    // 本編は尺の上限で間合いを詰めることがあるので、その実値に合わせる。
    // 計算だけなので、ダイジェスト単独で撮り直すときも同じ値を再現できる。
    const main = mainBuilder(opts)(scrollable);
    return buildSceneTimeline({
      scrollable,
      viewportHeight,
      fps,
      targetSec: digestSec,
      scenes: digest.scenes, // 0 なら尺から自動
      easing: opts.easing,
      moveSec: main.moveSec,
      holdSec: main.holdSec,
      stepRatio: opts.stepRatio,
      rng: makeRng(seed),
    });
  };
}

/** タイムライン 1 本ぶんを収録してエンコードする */
async function producePass(ctx, spec) {
  const { browser, contextOpts, prepare, settle, opts, workDir, onProgress, quality } = ctx;
  const { key, label, buildFor, introSec, pad } = spec;

  const recDir = path.join(workDir, 'rec', `${key}-${Date.now()}`);
  fs.mkdirSync(recDir, { recursive: true });

  const rec = await recordPass({
    browser,
    contextOpts,
    prepare,
    settle,
    buildFor,
    fps: opts.fps,
    dir: recDir,
    introSec,
    label,
    onProgress,
  });

  const listPath = path.join(recDir, 'frames.txt');
  writeFrameList(rec.frames, listPath, opts.fps);

  const results = [];
  let index = 0;
  for (const format of opts.formats) {
    index++;
    const outPath = path.join(workDir, `${key}-${spec.take || 1}.${format}`);
    const report = (sec) =>
      onProgress({
        phase: 'encode',
        message: `${label}を ${format.toUpperCase()} に変換中…（${index}/${opts.formats.length}）`,
        done: Math.min(sec, rec.totalSec),
        total: rec.totalSec,
      });
    report(0);

    await encodeRecording({
      listPath,
      durationSec: rec.totalSec,
      outPath,
      format,
      fps: opts.fps,
      outWidth: opts.outWidth,
      pad,
      quality,
      onTime: report,
    });

    results.push({
      key,
      label,
      format,
      file: outPath,
      bytes: fs.statSync(outPath).size,
      durationSec: rec.totalSec,
      canvas: pad ? `${pad.width}x${pad.height}` : null,
    });
  }

  // 収録の元ファイルはもう要らない
  fs.rmSync(recDir, { recursive: true, force: true });

  return {
    results,
    timeline: rec.timeline,
    pageHeight: rec.pageHeight,
    totalSec: rec.totalSec,
    capturedFps: rec.capturedFps,
  };
}

function describeTimeline(key, label, timeline, pad, introSec, totalSec) {
  const common = {
    key,
    label,
    kind: timeline.kind,
    durationSec: Number(totalSec.toFixed(2)),
    introSec,
    easing: timeline.easing,
    fitted: timeline.fitted,
    compressed: timeline.compressed,
    pad: pad ? { ...pad } : null,
  };
  return timeline.kind === 'scenes'
    ? {
        ...common,
        scenes: timeline.scenes,
        sceneSec: Number(timeline.sceneSec.toFixed(2)),
        driftPx: timeline.driftPx,
        stepRatio: timeline.stepRatio,
        holdSec: Number(timeline.holdSec.toFixed(2)),
        moveSec: Number(timeline.moveSec.toFixed(2)),
        startsPx: timeline.startsPx,
      }
    : {
        ...common,
        steps: timeline.steps,
        stepPx: timeline.step,
        stepRatio: timeline.stepRatio,
        holdSec: Number(timeline.holdSec.toFixed(2)),
        moveSec: Number(timeline.moveSec.toFixed(2)),
      };
}

/**
 * スクロール動画（本編＋ダイジェスト）を撮る。
 *
 * @param {object} opts
 * @param {string}   opts.url            対象 URL
 * @param {number}   opts.width          ビューポート幅（CSS px）
 * @param {number}   opts.viewportHeight ビューポート高さ（CSS px）
 * @param {number}   opts.scale          デバイスピクセル比
 * @param {number}   opts.fps            出力フレームレート
 * @param {number}   opts.outWidth       出力動画の幅（これを超える場合だけ縮小）
 * @param {number}   opts.targetSec      本編の尺の上限（秒）
 * @param {number}   opts.introSec       本編の先頭で静止する秒数（イントロ用。0 で無効）
 * @param {string}   opts.easing         イージング名（EASINGS のキー）
 * @param {number}   opts.stepRatio      1 回に進む量（ビューポート高さ比。0.6 / 0.8 / 1.0）
 * @param {number}   opts.seed           場面選びの乱数シード
 * @param {object}   opts.digest         ダイジェスト設定（enabled / targetSec / scenes / stepRatio / pad）
 * @param {string[]} opts.formats        ['webm', 'mp4']
 * @param {number}   opts.waitMs         読み込み後の追加待機（ms）
 * @param {boolean}  opts.hideFixed      固定・追従要素を解除するか
 */
async function recordScrollVideo(opts, onProgress = () => {}) {
  opts = { ...opts, stepRatio: opts.stepRatio ?? DEFAULT_STEP_RATIO };
  const ctx = await openSession(opts, onProgress);
  const results = [];
  const timelines = [];
  let pageHeight = 0;

  try {
    const main = await producePass(ctx, {
      key: 'main',
      label: '本編',
      introSec: opts.introSec || 0,
      pad: null, // 本編に枠は付けない
      buildFor: mainBuilder(opts),
    });
    results.push(...main.results);
    pageHeight = main.pageHeight;
    timelines.push({
      ...describeTimeline('main', '本編', main.timeline, null, opts.introSec || 0, main.totalSec),
      capturedFps: Number(main.capturedFps.toFixed(1)),
    });

    if (opts.digest.enabled !== false) {
      const pad = opts.digest.pad && opts.digest.pad.enabled ? opts.digest.pad : null;
      // 1 場面目が必ずページ先頭なので、本編と同じようにイントロを待てる
      const digestIntro = opts.digest.introSec || 0;
      const d = await producePass(ctx, {
        key: 'digest',
        label: 'ダイジェスト',
        introSec: digestIntro,
        pad,
        buildFor: digestBuilder(opts, opts.seed),
      });
      results.push(...d.results);
      timelines.push({
        ...describeTimeline('digest', 'ダイジェスト', d.timeline, pad, digestIntro, d.totalSec),
        capturedFps: Number(d.capturedFps.toFixed(1)),
      });
    }

    return {
      workDir: ctx.workDir,
      results,
      pageHeight,
      scrollable: Math.max(0, pageHeight - opts.viewportHeight),
      viewportHeight: opts.viewportHeight,
      cssWidth: opts.width,
      fps: opts.fps,
      easing: opts.easing,
      stepRatio: opts.stepRatio,
      seed: opts.seed,
      introSec: opts.introSec || 0,
      timelines,
    };
  } catch (err) {
    fs.rmSync(ctx.workDir, { recursive: true, force: true });
    throw err;
  }
}

/**
 * ダイジェストだけを撮り直す。本編には触れない。
 * workDir と take（何回目の抽選か）は呼び出し側が持っている前提。
 */
async function recordDigestOnly(opts, onProgress = () => {}) {
  const ctx = await openSession(opts, onProgress, { workDir: opts.workDir });
  const pad = opts.digest.pad && opts.digest.pad.enabled ? opts.digest.pad : null;
  const digestIntro = opts.digest.introSec || 0;

  const d = await producePass(ctx, {
    key: 'digest',
    label: 'ダイジェスト',
    introSec: digestIntro,
    pad,
    take: opts.take || 1,
    buildFor: digestBuilder(opts, opts.seed),
  });

  return {
    results: d.results,
    seed: opts.seed,
    timeline: {
      ...describeTimeline('digest', 'ダイジェスト', d.timeline, pad, digestIntro, d.totalSec),
      capturedFps: Number(d.capturedFps.toFixed(1)),
    },
  };
}

async function openSession(opts, onProgress, { workDir } = {}) {
  await ensureFfmpeg();
  const dir = workDir || fs.mkdtempSync(path.join(opts.outDir, 'work-'));
  const { prepare, settle } = buildPreparers(opts, onProgress);
  return {
    browser: await getBrowser(),
    contextOpts: buildContext(opts),
    prepare,
    settle,
    opts,
    workDir: dir,
    onProgress,
    quality: { vp9: opts.vp9Crf ?? 32, h264: opts.h264Crf ?? 21 },
  };
}

/* ------------------------------------------------------------------ *
 * 手持ちの動画に枠を付ける
 * ------------------------------------------------------------------ */

/**
 * 既存の動画ファイルに余白を付ける。フレームレートと尺は変えない。音声があれば残す。
 *
 * @param {object} opts
 * @param {string}   opts.input   入力ファイルパス
 * @param {string}   opts.outDir  出力先ディレクトリ
 * @param {string}   opts.baseName 出力ファイル名のベース（拡張子なし）
 * @param {string[]} opts.formats ['mp4'] など
 * @param {object}   opts.pad     { width, height, percent, color }
 */
async function padExistingVideo(opts, onProgress = () => {}) {
  await ensureFfmpeg();

  onProgress({ phase: 'probe', message: '動画を解析中…' });
  const info = await probeVideo(opts.input);
  const quality = { vp9: opts.vp9Crf ?? 32, h264: opts.h264Crf ?? 20 };
  const pad = { ...opts.pad, enabled: true };

  const results = [];
  let index = 0;
  for (const format of opts.formats) {
    index++;
    const outPath = path.join(opts.outDir, `${opts.baseName}_${pad.width}x${pad.height}.${format}`);
    const report = (sec) =>
      onProgress({
        phase: 'encode',
        message: `${format.toUpperCase()} に変換中…（${index}/${opts.formats.length}）`,
        done: Math.min(sec, info.durationSec),
        total: info.durationSec,
      });
    report(0);

    await runFfmpeg(
      [
        '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
        '-progress', 'pipe:1',
        '-i', opts.input,
        '-map', '0:v:0',
        // fps は指定しない（元のフレームレートを保つ）
        '-vf', videoFilter({ fps: null, outWidth: null, pad }),
        ...encoderArgs(format, quality),
        ...audioArgs(format, info.hasAudio),
        outPath,
      ],
      { onTime: report }
    );

    results.push({
      key: 'padded',
      label: '枠付き',
      format,
      file: outPath,
      bytes: fs.statSync(outPath).size,
      durationSec: info.durationSec,
      canvas: `${pad.width}x${pad.height}`,
    });
  }

  return { results, source: info, pad };
}

/** エンコード済みの動画以外（収録元・作業ファイル）を捨てる */
function cleanupIntermediates(workDir, results) {
  const keep = new Set(results.map((r) => path.basename(r.file)));
  for (const name of fs.readdirSync(workDir)) {
    if (keep.has(name)) continue;
    fs.rmSync(path.join(workDir, name), { recursive: true, force: true });
  }
}

module.exports = {
  recordScrollVideo,
  recordDigestOnly,
  padExistingVideo,
  probeVideo,
  buildTimeline,
  buildSceneTimeline,
  cleanupIntermediates,
  ensureFfmpeg,
  makeRng,
  EASINGS,
  DEFAULT_EASING,
  HOLD_SEC,
  MOVE_SEC,
  DEFAULT_FPS,
  STEP_RATIOS,
  DEFAULT_STEP_RATIO,
};
