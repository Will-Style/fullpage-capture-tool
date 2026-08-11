'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { capture, closeBrowser } = require('./capture');
const {
  recordScrollVideo,
  recordDigestOnly,
  padExistingVideo,
  cleanupIntermediates,
  EASINGS,
  DEFAULT_EASING,
  STEP_RATIOS,
  DEFAULT_STEP_RATIO,
  DEFAULT_FPS,
} = require('./video');

const PORT = process.env.PORT || 3838;
const OUT_DIR = path.join(os.tmpdir(), 'fullpage-capture');
const VIDEO_DIR = path.join(OUT_DIR, 'video');

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.mkdirSync(VIDEO_DIR, { recursive: true });

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

/** id -> { file, filename, mime, meta } */
const results = new Map();

function normalizeUrl(input) {
  const trimmed = String(input || '').trim();
  if (!trimmed) throw new Error('URL が空です');
  // 先に弾かないと "ftp://x" に https:// を前置して "https://ftp//x" という別物になってしまう。
  // ポート付きの "localhost:3000" を巻き込まないよう、"://" が続く場合だけをスキームとみなす。
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) && !/^https?:\/\//i.test(trimmed)) {
    throw new Error('http / https のみ対応しています');
  }
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let parsed;
  try {
    parsed = new URL(withScheme);
  } catch (_) {
    throw new Error(`URL の形式が正しくありません: ${trimmed}`);
  }
  if (!/^https?:$/.test(parsed.protocol)) throw new Error('http / https のみ対応しています');
  return parsed;
}

function buildFilename(parsed, meta) {
  const host = parsed.hostname.replace(/[^a-z0-9.-]/gi, '');
  const pathPart = parsed.pathname
    .replace(/\/+$/, '')
    .replace(/^\//, '')
    .replace(/[^a-z0-9._-]+/gi, '-')
    .slice(0, 60);
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\..+$/, '');
  const scaleTag = meta.scale === 1 ? '' : `@${meta.scale}x`;
  const base = [host, pathPart, `${meta.cssWidth}w${scaleTag}`, stamp].filter(Boolean).join('_');
  return `${base}.${meta.format === 'jpeg' ? 'jpg' : 'png'}`;
}

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function clampNum(value, min, max, fallback) {
  const n = Number.parseFloat(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

app.post('/api/capture', async (req, res) => {
  const started = Date.now();
  try {
    const parsed = normalizeUrl(req.body.url);
    const options = {
      url: parsed.toString(),
      width: clampInt(req.body.width, 320, 3840, 1440),
      scale: clampInt(req.body.scale, 1, 3, 2),
      format: req.body.format === 'jpeg' ? 'jpeg' : 'png',
      quality: clampInt(req.body.quality, 1, 100, 92),
      waitMs: clampInt(req.body.waitMs, 0, 30000, 800),
      hideFixed: req.body.hideFixed !== false,
      viewportHeight: clampInt(req.body.viewportHeight, 400, 2000, 900),
      waitStable: req.body.waitStable !== false,
      stableTimeoutMs: clampInt(req.body.stableTimeoutMs, 1000, 60000, 10000),
    };

    const result = await capture(options);

    const id = crypto.randomUUID();
    const filename = buildFilename(parsed, result);
    const file = path.join(OUT_DIR, `${id}-${filename}`);
    fs.writeFileSync(file, result.buffer);

    results.set(id, {
      file,
      filename,
      mime: result.format === 'jpeg' ? 'image/jpeg' : 'image/png',
    });

    res.json({
      id,
      filename,
      title: result.title,
      pixelWidth: result.pixelWidth,
      pixelHeight: result.pixelHeight,
      cssWidth: result.cssWidth,
      cssHeight: result.cssHeight,
      scale: result.scale,
      chunked: result.chunked,
      bytes: result.bytes,
      settled: result.settled,
      elapsedMs: Date.now() - started,
    });
  } catch (err) {
    console.error('[capture]', err);
    res.status(400).json({ error: err.message || 'キャプチャに失敗しました' });
  }
});

function sendImage(req, res, disposition) {
  const entry = results.get(req.params.id);
  if (!entry || !fs.existsSync(entry.file)) {
    return res.status(404).json({ error: '画像が見つかりません' });
  }
  res.setHeader('Content-Type', entry.mime);
  res.setHeader(
    'Content-Disposition',
    `${disposition}; filename="${entry.filename}"; filename*=UTF-8''${encodeURIComponent(entry.filename)}`
  );
  fs.createReadStream(entry.file).pipe(res);
}

app.get('/api/image/:id', (req, res) => sendImage(req, res, 'inline'));
app.get('/api/download/:id', (req, res) => sendImage(req, res, 'attachment'));

/* ------------------------------------------------------------------ *
 * スクロール動画
 * ------------------------------------------------------------------ */

/** id -> ジョブ */
const jobs = new Map();
/** 動画は CPU も Chromium も食うので同時に 1 本だけ流す */
let videoRunning = false;

const MIME = { webm: 'video/webm', mp4: 'video/mp4' };

/** キャンバスは yuv420p のため偶数にそろえる */
function clampEven(value, min, max, fallback) {
  const n = clampInt(value, min, max, fallback);
  return n % 2 === 0 ? n : n - 1;
}

function normalizeColor(value, fallback) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(value || '').trim());
  return m ? `#${m[1].toUpperCase()}` : fallback;
}

function buildBaseName(parsed, width) {
  const host = parsed.hostname.replace(/[^a-z0-9.-]/gi, '');
  const pathPart = parsed.pathname
    .replace(/\/+$/, '')
    .replace(/^\//, '')
    .replace(/[^a-z0-9._-]+/gi, '-')
    .slice(0, 60);
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '');
  return [host, pathPart, `${width}w`, stamp].filter(Boolean).join('_');
}

/** 進捗の購読者へ 1 行流す */
function publish(job) {
  const payload = `data: ${JSON.stringify(publicJob(job))}\n\n`;
  for (const res of job.subscribers) res.write(payload);
}

function publicJob(job) {
  return {
    id: job.id,
    type: job.type,
    status: job.status,
    phase: job.phase,
    message: job.message,
    done: job.done,
    total: job.total,
    error: job.error,
    elapsedMs: Date.now() - job.startedAt,
    // path は内部専用なので外に出さない
    files: job.files.map(({ path: _path, ...rest }) => rest),
    info: job.info,
  };
}

function createJob(extra) {
  const job = {
    id: crypto.randomUUID(),
    status: 'running',
    phase: 'queued',
    message: '準備中…',
    done: 0,
    total: 0,
    error: null,
    startedAt: Date.now(),
    files: [],
    info: null,
    workDir: null,
    take: 1,
    subscribers: new Set(),
    ...extra,
  };
  jobs.set(job.id, job);
  return job;
}

const progressOf = (job) => (p) => {
  job.phase = p.phase;
  job.message = p.message;
  job.done = p.done ?? 0;
  job.total = p.total ?? 0;
  publish(job);
};

/** 出力 1 本ぶんを、公開用のファイル情報に整える */
function toFile(base, r) {
  const suffix =
    (r.key === 'digest' ? '_digest' : '') + (r.canvas && r.key !== 'padded' ? `_${r.canvas}` : '');
  const name = r.key === 'padded' ? path.basename(r.file) : `${base}${suffix}.${r.format}`;
  return {
    key: r.key,
    label: r.label,
    format: r.format,
    filename: name,
    bytes: r.bytes,
    durationSec: r.durationSec,
    path: r.file,
  };
}

/** ジョブの完了・失敗・後片付けを一箇所にまとめる */
function runJob(job, promise, onDone) {
  promise
    .then((out) => {
      onDone(out);
      job.status = 'done';
      job.phase = 'done';
      job.message = '完了';
    })
    .catch((err) => {
      console.error(`[${job.type}]`, err);
      job.status = 'error';
      job.phase = 'error';
      job.error = err.message || '処理に失敗しました';
      job.message = job.error;
    })
    .finally(() => {
      videoRunning = false;
      publish(job);
      for (const sub of job.subscribers) sub.end();
      job.subscribers.clear();
    });
}

app.post('/api/video', async (req, res) => {
  if (videoRunning) {
    return res.status(409).json({ error: '別の動画を処理中です。完了までお待ちください' });
  }

  let parsed;
  let options;
  try {
    parsed = normalizeUrl(req.body.url);
    const viewportHeight = clampInt(req.body.viewportHeight, 400, 2000, 900);
    options = {
      url: parsed.toString(),
      width: clampInt(req.body.width, 320, 3840, 1440),
      viewportHeight,
      scale: clampInt(req.body.scale, 1, 3, 2),
      fps: clampInt(req.body.fps, 12, 60, DEFAULT_FPS),
      outWidth: clampInt(req.body.outWidth, 320, 3840, 1440),
      targetSec: clampNum(req.body.targetSec, 5, 600, 60),
      // イントロを撮るための頭の静止。0 で無効
      introSec: clampNum(req.body.introSec, 0, 30, 0),
      easing: Object.prototype.hasOwnProperty.call(EASINGS, req.body.easing)
        ? req.body.easing
        : DEFAULT_EASING,
      // 選択肢以外は既定に寄せる
      stepRatio: STEP_RATIOS.includes(Number(req.body.stepRatio))
        ? Number(req.body.stepRatio)
        : DEFAULT_STEP_RATIO,
      // 未指定なら毎回変わる。同じ値を渡せば同じ場面が選ばれる
      seed: clampInt(req.body.seed, 0, 0xffffffff, Math.floor(Math.random() * 0xffffffff)),
      waitMs: clampInt(req.body.waitMs, 0, 30000, 800),
      hideFixed: req.body.hideFixed === true,
      digest: {
        enabled: req.body.digest !== false,
        targetSec: clampNum(req.body.digestSec, 3, 120, 10),
        // 0 は自動（尺から算出）
        scenes: clampInt(req.body.digestScenes, 0, 60, 0),
        introSec: clampNum(req.body.digestIntroSec, 0, 30, 0),
        pad: {
          enabled: req.body.pad === true,
          width: clampEven(req.body.padWidth, 320, 3840, 1920),
          height: clampEven(req.body.padHeight, 320, 3840, 1300),
          percent: clampInt(req.body.padPercent, 10, 100, 90),
          color: normalizeColor(req.body.padColor, '#1C1C1A'),
        },
      },
      formats: Array.isArray(req.body.formats) && req.body.formats.length
        ? req.body.formats.filter((f) => f === 'webm' || f === 'mp4')
        : ['webm', 'mp4'],
      outDir: VIDEO_DIR,
    };
    if (!options.formats.length) throw new Error('出力形式が選択されていません');
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  const job = createJob({ type: 'video', options, base: buildBaseName(parsed, options.width) });
  videoRunning = true;
  res.json({ id: job.id });

  runJob(job, recordScrollVideo(options, progressOf(job)), (out) => {
    job.workDir = out.workDir;
    job.files = out.results.map((r) => toFile(job.base, r));
    job.info = {
      fps: out.fps,
      easing: out.easing,
      stepRatio: out.stepRatio,
      seed: out.seed,
      introSec: out.introSec,
      pageHeight: out.pageHeight,
      scrollable: out.scrollable,
      viewportHeight: out.viewportHeight,
      cssWidth: out.cssWidth,
      timelines: out.timelines,
    };
    cleanupIntermediates(out.workDir, out.results);
  });
});

/**
 * ダイジェストだけを引き直す。本編のファイルには触らない。
 * シードを省略すると新しい抽選になり、指定すればその抽選を再現する。
 */
app.post('/api/video/:id/digest', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job || job.type !== 'video') return res.status(404).json({ error: 'ジョブが見つかりません' });
  if (job.status === 'running') return res.status(409).json({ error: 'このジョブはまだ処理中です' });
  if (!job.options || !job.workDir) return res.status(409).json({ error: '引き直せる情報が残っていません' });
  if (job.options.digest.enabled === false) {
    return res.status(400).json({ error: 'このジョブはダイジェストなしで作成されています' });
  }
  if (videoRunning) return res.status(409).json({ error: '別の動画を処理中です。完了までお待ちください' });

  job.take = (job.take || 1) + 1;
  const options = {
    ...job.options,
    workDir: job.workDir,
    take: job.take,
    seed: clampInt(req.body.seed, 0, 0xffffffff, Math.floor(Math.random() * 0xffffffff)),
  };

  // 引き直しの間も進捗を配れるよう、ジョブを running に戻す
  const previous = job.files.filter((f) => f.key === 'digest');
  job.status = 'running';
  job.phase = 'queued';
  job.message = 'ダイジェストを引き直しています…';
  job.done = 0;
  job.total = 0;
  job.error = null;
  job.startedAt = Date.now();
  videoRunning = true;
  res.json({ id: job.id, take: job.take });

  runJob(job, recordDigestOnly(options, progressOf(job)), (out) => {
    job.options.seed = out.seed;
    job.files = [
      ...job.files.filter((f) => f.key !== 'digest'),
      ...out.results.map((r) => toFile(job.base, r)),
    ];
    job.info = {
      ...job.info,
      seed: out.seed,
      timelines: [...job.info.timelines.filter((t) => t.key !== 'digest'), out.timeline],
    };
    // 差し替えが済んでから前回の抽選ぶんを消す（配信中のリクエストを壊さないため）
    for (const f of previous) fs.rmSync(f.path, { force: true });
  });
});

app.get('/api/video/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'ジョブが見つかりません' });
  res.json(publicJob(job));
});

app.get('/api/video/:id/events', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'ジョブが見つかりません' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  res.write(`data: ${JSON.stringify(publicJob(job))}\n\n`);

  if (job.status !== 'running') return res.end();

  job.subscribers.add(res);
  req.on('close', () => job.subscribers.delete(res));
});

function sendVideo(req, res, disposition) {
  const job = jobs.get(req.params.id);
  const entry = job && job.files.find((f) => f.key === req.params.key && f.format === req.params.format);
  if (!entry || !fs.existsSync(entry.path)) {
    return res.status(404).json({ error: '動画が見つかりません' });
  }
  res.setHeader('Content-Type', MIME[entry.format]);
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader(
    'Content-Disposition',
    `${disposition}; filename="${entry.filename}"; filename*=UTF-8''${encodeURIComponent(entry.filename)}`
  );
  // <video> のシークに応えるため Range に対応する
  const size = fs.statSync(entry.path).size;
  const range = req.headers.range;
  if (disposition === 'inline' && range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    if (m) {
      const start = m[1] ? Number(m[1]) : 0;
      const end = m[2] ? Number(m[2]) : size - 1;
      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
      res.setHeader('Content-Length', end - start + 1);
      return fs.createReadStream(entry.path, { start, end }).pipe(res);
    }
  }
  res.setHeader('Content-Length', size);
  fs.createReadStream(entry.path).pipe(res);
}

app.get('/api/video/:id/file/:key/:format', (req, res) => sendVideo(req, res, 'inline'));
app.get('/api/video/:id/download/:key/:format', (req, res) => sendVideo(req, res, 'attachment'));

/* ------------------------------------------------------------------ *
 * 手持ちの動画に枠を付ける
 * ------------------------------------------------------------------ */

const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024; // 2GB

/** 拡張子とベース名を、パス区切りなどを除いた安全な形にする */
function safeUploadName(raw) {
  const cleaned = String(raw || 'video')
    .replace(/[/\\]/g, '_')
    .replace(/[ -]/g, '')
    .slice(-120);
  const ext = (path.extname(cleaned) || '.mp4').toLowerCase();
  const base = path.basename(cleaned, path.extname(cleaned)) || 'video';
  return { base, ext: /^\.[a-z0-9]{1,6}$/.test(ext) ? ext : '.mp4' };
}

/**
 * 動画をリクエストボディでそのまま受け取り、余白を付けて返す。
 * multipart にすると解析ライブラリが要るうえ、大きな動画をメモリに載せてしまうので、
 * 生のボディをそのままファイルへ流す。設定はクエリで渡す。
 */
app.post('/api/pad', (req, res) => {
  if (videoRunning) {
    return res.status(409).json({ error: '別の動画を処理中です。完了までお待ちください' });
  }

  const q = req.query;
  const formats = String(q.formats || 'mp4')
    .split(',')
    .filter((f) => f === 'webm' || f === 'mp4');
  if (!formats.length) return res.status(400).json({ error: '出力形式が選択されていません' });

  const declared = Number.parseInt(req.headers['content-length'], 10);
  if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES) {
    return res.status(413).json({ error: '動画が大きすぎます（上限 2GB）' });
  }

  const { base, ext } = safeUploadName(q.filename);
  const workDir = fs.mkdtempSync(path.join(VIDEO_DIR, 'pad-'));
  const input = path.join(workDir, `input${ext}`);

  const sink = fs.createWriteStream(input);
  let received = 0;
  let aborted = false;

  const abort = (status, message) => {
    if (aborted) return;
    aborted = true;
    req.unpipe(sink);
    sink.destroy();
    fs.rmSync(workDir, { recursive: true, force: true });
    if (!res.headersSent) res.status(status).json({ error: message });
  };

  req.on('data', (chunk) => {
    received += chunk.length;
    if (received > MAX_UPLOAD_BYTES) abort(413, '動画が大きすぎます（上限 2GB）');
  });
  req.on('aborted', () => abort(400, 'アップロードが中断されました'));
  sink.on('error', () => abort(500, 'アップロードの保存に失敗しました'));

  req.pipe(sink);

  sink.on('finish', () => {
    if (aborted) return;
    if (received === 0) return abort(400, '動画が空です');

    const options = {
      input,
      outDir: workDir,
      baseName: base,
      formats,
      pad: {
        width: clampEven(q.padWidth, 320, 3840, 1920),
        height: clampEven(q.padHeight, 320, 3840, 1300),
        percent: clampInt(q.padPercent, 10, 100, 90),
        color: normalizeColor(q.padColor, '#1C1C1A'),
      },
    };

    const job = createJob({ type: 'pad', workDir, base });
    videoRunning = true;
    res.json({ id: job.id });

    runJob(job, padExistingVideo(options, progressOf(job)), (out) => {
      job.files = out.results.map((r) => toFile(job.base, r));
      job.info = {
        source: out.source,
        pad: out.pad,
        canvas: `${out.pad.width}x${out.pad.height}`,
      };
      cleanupIntermediates(workDir, out.results);
    });
  });
});

/* ------------------------------------------------------------------ *
 * 一時ファイル
 * ------------------------------------------------------------------ */

/** ディレクトリ配下のファイル数と合計バイト数を数える */
function measureDir(dir) {
  let files = 0;
  let bytes = 0;
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        files++;
        bytes += fs.statSync(full).size;
      }
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return { files, bytes };
}

app.get('/api/storage', (req, res) => {
  res.json({ ...measureDir(OUT_DIR), dir: OUT_DIR, jobs: jobs.size + results.size });
});

/** 出力した画像・動画をすべて捨てる。処理中は受け付けない */
app.post('/api/storage/clear', (req, res) => {
  if (videoRunning) {
    return res.status(409).json({ error: '処理中です。完了してから実行してください' });
  }
  const before = measureDir(OUT_DIR);
  try {
    fs.rmSync(OUT_DIR, { recursive: true, force: true });
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.mkdirSync(VIDEO_DIR, { recursive: true });
    // ファイルを消したらジョブの参照先も無効になるので、まとめて破棄する
    for (const job of jobs.values()) {
      for (const sub of job.subscribers) sub.end();
      job.subscribers.clear();
    }
    jobs.clear();
    results.clear();
    res.json({ cleared: before, ...measureDir(OUT_DIR) });
  } catch (err) {
    console.error('[storage]', err);
    res.status(500).json({ error: err.message || '削除に失敗しました' });
  }
});

const server = app.listen(PORT, () => {
  console.log(`\n  Fullpage Capture → http://localhost:${PORT}\n`);
});

async function shutdown() {
  server.close();
  await closeBrowser().catch(() => {});
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
