/** server.js が返す形をそのまま写した型 */

export type Format = 'webm' | 'mp4';
export type ClipKey = 'main' | 'digest' | 'padded';

export interface StillResult {
  id: string;
  filename: string;
  title: string;
  pixelWidth: number;
  pixelHeight: number;
  cssWidth: number;
  cssHeight: number;
  scale: number;
  chunked: boolean;
  bytes: number;
  /** null = 待たなかった / true = ローディングが明けた / false = 上限まで待っても変化が続いた */
  settled: boolean | null;
  elapsedMs: number;
}

export interface PadSettings {
  width: number;
  height: number;
  percent: number;
  color: string;
}

export interface JobFile {
  key: ClipKey;
  label: string;
  format: Format;
  filename: string;
  bytes: number;
  durationSec: number;
}

export interface Timeline {
  key: string;
  label: string;
  kind: 'scroll' | 'scenes';
  durationSec: number;
  introSec: number;
  easing: string;
  fitted: boolean;
  compressed: boolean;
  pad: (PadSettings & { enabled: boolean }) | null;
  /** kind: 'scroll' のとき */
  steps?: number;
  stepPx?: number;
  /** kind: 'scenes' のとき */
  scenes?: number;
  sceneSec?: number;
  driftPx?: number;
  startsPx?: number[];
  /** 両方 */
  holdSec?: number;
  moveSec?: number;
  stepRatio?: number;
}

export interface VideoInfo {
  fps: number;
  easing: string;
  stepRatio: number;
  seed: number;
  introSec: number;
  pageHeight: number;
  scrollable: number;
  viewportHeight: number;
  cssWidth: number;
  timelines: Timeline[];
}

export interface PadInfo {
  source: { width: number; height: number; hasAudio: boolean; durationSec: number };
  pad: PadSettings & { enabled: boolean };
  canvas: string;
}

export interface Job {
  id: string;
  type: 'video' | 'pad';
  status: 'running' | 'done' | 'error';
  phase: string;
  message: string;
  done: number;
  total: number;
  error: string | null;
  elapsedMs: number;
  files: JobFile[];
  info: VideoInfo | PadInfo | null;
}

export interface Storage {
  files: number;
  bytes: number;
  dir: string;
}

async function json<T>(res: Response): Promise<T> {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error || '処理に失敗しました');
  return data as T;
}

export const api = {
  capture: (body: unknown) =>
    fetch('/api/capture', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(json<StillResult>),

  startVideo: (body: unknown) =>
    fetch('/api/video', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(json<{ id: string }>),

  rerollDigest: (id: string, seed?: number) =>
    fetch(`/api/video/${id}/digest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(seed === undefined ? {} : { seed }),
    }).then(json<{ id: string; take: number }>),

  /** 動画は multipart にせず生のボディで送る（大きいのでメモリに載せたくない） */
  startPad: (file: File, params: Record<string, string>) =>
    fetch(`/api/pad?${new URLSearchParams({ filename: file.name, ...params })}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: file,
    }).then(json<{ id: string }>),

  storage: () => fetch('/api/storage').then(json<Storage>),
  clearStorage: () =>
    fetch('/api/storage/clear', { method: 'POST' }).then(
      json<{ cleared: { files: number; bytes: number } }>,
    ),
};

export const videoSrc = (id: string, key: ClipKey, format: Format) =>
  `/api/video/${id}/file/${key}/${format}`;
export const videoDownload = (id: string, key: ClipKey, format: Format) =>
  `/api/video/${id}/download/${key}/${format}`;

/** video.js の EASINGS と同じ並び */
const FAMILIES = ['Sine', 'Quad', 'Cubic', 'Quart', 'Quint', 'Expo'] as const;

export const EASING_GROUPS = [
  { label: 'Out（急発進して減速＝慣性）', items: FAMILIES.map((f) => `easeOut${f}`) },
  { label: 'InOut（緩発進・緩停止）', items: FAMILIES.map((f) => `easeInOut${f}`) },
  { label: 'In（ゆっくり動き出して加速）', items: FAMILIES.map((f) => `easeIn${f}`) },
];

/** 1 コマあたりの移動量が大きく、30fps ではカクつきやすいもの */
export const SNAPPY_EASINGS = ['easeOutQuint', 'easeOutExpo'];
