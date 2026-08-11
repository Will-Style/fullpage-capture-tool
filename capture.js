'use strict';

const { chromium } = require('playwright');
const sharp = require('sharp');

// Chromium が一度にラスタライズできる高さの上限（デバイスピクセル）。
// 実際の上限は 16384px 前後なので、余裕を持たせた値を使う。
const MAX_DEVICE_PX = 15000;

let browserPromise = null;

/** Chromium は起動が重いので 1 インスタンスを使い回す */
async function getBrowser() {
  if (!browserPromise) {
    browserPromise = chromium.launch({
      args: ['--disable-lcd-text', '--force-color-profile=srgb', '--hide-scrollbars'],
    });
  }
  return browserPromise;
}

async function closeBrowser() {
  if (!browserPromise) return;
  const browser = await browserPromise;
  browserPromise = null;
  await browser.close();
}

/**
 * 遅延読み込み（lazy load）を展開するため、最下部まで少しずつスクロールしてから先頭に戻る。
 * 一気に飛ばすと IntersectionObserver が発火しない実装が多いため、刻んでスクロールする。
 */
async function expandLazyContent(page, step) {
  await page.evaluate(async (stepPx) => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    let y = 0;
    let guard = 0;
    while (guard++ < 300) {
      window.scrollTo(0, y);
      await sleep(80);
      const max = document.documentElement.scrollHeight - window.innerHeight;
      if (y >= max) break;
      y = Math.min(y + stepPx, max);
    }
    window.scrollTo(0, 0);
    await sleep(200);
  }, step);
}

/**
 * アニメーション・トランジション・キャレットを停止する。
 * 止めないとキャプチャのたびに違う絵になり、分割キャプチャでは繋ぎ目がずれる。
 */
async function freezeAnimations(page) {
  await page.addStyleTag({
    content: `
      *, *::before, *::after {
        animation-play-state: paused !important;
        animation-delay: -1ms !important;
        animation-duration: 1ms !important;
        animation-iteration-count: 1 !important;
        transition-duration: 0s !important;
        transition-delay: 0s !important;
        caret-color: transparent !important;
        scroll-behavior: auto !important;
      }
      html { scroll-behavior: auto !important; }
    `,
  });
  await page.evaluate(() => {
    document.querySelectorAll('video').forEach((v) => {
      try { v.pause(); } catch (_) {}
    });
  });
}

/**
 * position: fixed / sticky を解除する。
 * 解除しないと、スクロールしながら撮る分割キャプチャで固定ヘッダーが何度も写り込む。
 */
async function unpinFixedElements(page) {
  await page.evaluate(() => {
    document.querySelectorAll('*').forEach((el) => {
      const pos = getComputedStyle(el).position;
      if (pos === 'fixed') {
        el.style.setProperty('position', 'absolute', 'important');
      } else if (pos === 'sticky') {
        // sticky は本来の流れの位置に戻すのが自然
        el.style.setProperty('position', 'static', 'important');
      }
    });
  });
}

/** 縮小したグレースケールにして、画面の見た目をざっくり表す指紋を作る */
async function fingerprint(buffer) {
  return sharp(buffer).greyscale().resize(32, 32, { fit: 'fill' }).raw().toBuffer();
}

function meanDiff(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / a.length;
}

/**
 * ローディングアニメーションが終わるまで待つ。
 *
 * これをせずに freezeAnimations を掛けると、フェード途中のローディング画面が
 * その不透明度のまま固定されて写り込む。
 *
 * 画面の指紋が連続して変わらなくなったら「落ち着いた」と判断する。
 * 動画の自動再生など永久に変化し続けるページもあるので、上限時間で必ず打ち切る。
 *
 * @returns {Promise<boolean>} 落ち着いたら true、時間切れなら false
 */
async function waitUntilSettled(page, { timeoutMs = 10000, intervalMs = 350, tolerance = 0.8 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let previous = null;
  let stableRounds = 0;

  while (Date.now() < deadline) {
    const shot = await page.screenshot({ type: 'jpeg', quality: 40 }).catch(() => null);
    if (!shot) return false;
    const current = await fingerprint(shot);

    if (previous && meanDiff(previous, current) < tolerance) {
      // 2 回続けて変化がなければ確定（1 回だけだとアニメの折り返しを拾うことがある）
      if (++stableRounds >= 2) return true;
    } else {
      stableRounds = 0;
    }
    previous = current;
    await page.waitForTimeout(intervalMs);
  }
  return false;
}

async function getPageHeight(page) {
  return page.evaluate(() => {
    const d = document;
    return Math.max(
      d.body ? d.body.scrollHeight : 0,
      d.body ? d.body.offsetHeight : 0,
      d.documentElement.scrollHeight,
      d.documentElement.offsetHeight,
      d.documentElement.clientHeight
    );
  });
}

/**
 * ビューポート単位でスクロールしながら撮り、sharp で縦に連結する。
 * 1 ショットが必ずビューポートサイズに収まるので、ページがどれだけ長くても
 * Chromium のラスタライズ上限に当たらない。
 */
async function captureByChunks(page, { width, scale, viewportHeight, totalHeight }) {
  const shots = [];
  let y = 0;

  while (y < totalHeight) {
    await page.evaluate((top) => window.scrollTo(0, top), y);
    await page.waitForTimeout(150);

    // スクロール限界で止まることがあるので、実際の位置を採用する
    const actualY = await page.evaluate(() => Math.round(window.scrollY));
    const buffer = await page.screenshot({ type: 'png', animations: 'disabled' });
    shots.push({ top: Math.round(actualY * scale), buffer });

    if (actualY + viewportHeight >= totalHeight) break;
    const next = y + viewportHeight;
    if (next <= actualY) break; // これ以上進めない（無限スクロール等）
    y = next;
  }

  const canvasWidth = Math.round(width * scale);
  const canvasHeight = Math.round(totalHeight * scale);

  // 後のショットほど手前に重ねる。重複部分は最新のショットで上書きされる。
  const layers = shots.map((s) => ({ input: s.buffer, top: s.top, left: 0 }));

  return sharp({
    create: {
      width: canvasWidth,
      height: canvasHeight,
      channels: 4,
      background: { r: 255, g: 255, b: 255, alpha: 1 },
    },
    limitInputPixels: false,
  })
    .composite(layers)
    .png({ compressionLevel: 9 })
    .toBuffer();
}

/**
 * フルページキャプチャを実行する。
 *
 * @param {object} opts
 * @param {string} opts.url          対象 URL
 * @param {number} opts.width        ビューポート幅（CSS px）
 * @param {number} opts.scale        デバイスピクセル比（2 で Retina）
 * @param {string} opts.format       'png' | 'jpeg'
 * @param {number} opts.quality      JPEG 品質（1-100）
 * @param {number} opts.waitMs       読み込み後の追加待機時間（ms）
 * @param {boolean} opts.hideFixed   固定要素を解除するか
 * @param {number} opts.viewportHeight ビューポート高さ（CSS px）
 * @param {boolean} opts.waitStable  ローディングが明けるまで待つか
 * @param {number} opts.stableTimeoutMs 待つ上限（ms）
 * @param {string} opts.userAgent    上書きする User-Agent（省略可）
 */
async function capture(opts) {
  const {
    url,
    width = 1440,
    scale = 2,
    format = 'png',
    quality = 92,
    waitMs = 800,
    hideFixed = true,
    viewportHeight = 900,
    waitStable = true,
    stableTimeoutMs = 10000,
    userAgent,
  } = opts;

  const browser = await getBrowser();
  const context = await browser.newContext({
    viewport: { width, height: viewportHeight },
    deviceScaleFactor: scale,
    userAgent: userAgent || undefined,
    // 幅ちょうどのレイアウトを撮るため、スクロールバーで幅が削られないようにする
    isMobile: false,
    hasTouch: width <= 768,
    locale: 'ja-JP',
    timezoneId: 'Asia/Tokyo',
  });

  const page = await context.newPage();

  try {
    await page.goto(url, { waitUntil: 'load', timeout: 60000 });
    // networkidle は広告や解析タグで永遠に来ないことがあるので、失敗しても続行する
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});

    await expandLazyContent(page, Math.floor(viewportHeight * 0.8));

    // Web フォントの適用完了を待つ（未適用だと文字がずれる）
    await page.evaluate(() => document.fonts && document.fonts.ready).catch(() => {});
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(120);

    // アニメーションを止める前に、ローディングが明けるのを待つ。
    // 順番を逆にすると、フェード途中のローディング画面が固定されてしまう。
    let settled = null;
    if (waitStable) {
      settled = await waitUntilSettled(page, { timeoutMs: stableTimeoutMs });
    }

    await freezeAnimations(page);
    if (hideFixed) await unpinFixedElements(page);
    if (waitMs > 0) await page.waitForTimeout(waitMs);

    const totalHeight = await getPageHeight(page);
    const needsChunking = totalHeight * scale > MAX_DEVICE_PX;

    let buffer;
    if (needsChunking) {
      buffer = await captureByChunks(page, { width, scale, viewportHeight, totalHeight });
    } else {
      buffer = await page.screenshot({ fullPage: true, type: 'png', animations: 'disabled' });
    }

    // PNG は可逆なのでここまで劣化ゼロ。JPEG が要求された場合のみ最後に一度だけ変換する。
    if (format === 'jpeg') {
      buffer = await sharp(buffer, { limitInputPixels: false })
        .flatten({ background: '#ffffff' })
        .jpeg({ quality, chromaSubsampling: '4:4:4', mozjpeg: true })
        .toBuffer();
    }

    const meta = await sharp(buffer, { limitInputPixels: false }).metadata();
    const title = await page.title().catch(() => '');

    return {
      buffer,
      format,
      title,
      pixelWidth: meta.width,
      pixelHeight: meta.height,
      cssWidth: width,
      cssHeight: totalHeight,
      scale,
      chunked: needsChunking,
      bytes: buffer.length,
      // null = 待たなかった / true = 落ち着いた / false = 上限まで待っても変化が続いた
      settled,
    };
  } finally {
    await context.close();
  }
}

module.exports = {
  capture,
  closeBrowser,
  MAX_DEVICE_PX,
  // 動画キャプチャ（video.js）から再利用する
  getBrowser,
  expandLazyContent,
  unpinFixedElements,
  getPageHeight,
  waitUntilSettled,
};
