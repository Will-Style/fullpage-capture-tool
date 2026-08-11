import { useCallback, useEffect, useRef, useState } from 'react';
import type { Job } from '@/lib/api';

interface State {
  running: boolean;
  /** 経過秒。サーバーの elapsedMs ではなく手元で数える（表示がなめらかになる） */
  elapsed: number;
  message: string;
  done: number;
  total: number;
  error: string | null;
  job: Job | null;
}

const IDLE: State = {
  running: false,
  elapsed: 0,
  message: '',
  done: 0,
  total: 0,
  error: null,
  job: null,
};

/**
 * サーバーのジョブを SSE で購読する。
 * start() には「ジョブ ID を返す非同期処理」を渡す。開始要求の失敗もここで拾う。
 */
export function useJob(onSettled?: () => void) {
  const [state, setState] = useState<State>(IDLE);
  const sourceRef = useRef<EventSource | null>(null);
  const timerRef = useRef<number | null>(null);

  const stopTimer = useCallback(() => {
    if (timerRef.current !== null) window.clearInterval(timerRef.current);
    timerRef.current = null;
  }, []);

  // 画面から消えるときに購読を残さない
  useEffect(
    () => () => {
      sourceRef.current?.close();
      stopTimer();
    },
    [stopTimer],
  );

  const start = useCallback(
    async (begin: () => Promise<{ id: string }>, initialMessage = '準備中…') => {
      sourceRef.current?.close();
      stopTimer();

      const startedAt = Date.now();
      setState({ ...IDLE, running: true, message: initialMessage });
      timerRef.current = window.setInterval(() => {
        setState((s) => (s.running ? { ...s, elapsed: (Date.now() - startedAt) / 1000 } : s));
      }, 200);

      let id: string;
      try {
        ({ id } = await begin());
      } catch (err) {
        stopTimer();
        setState({ ...IDLE, error: (err as Error).message });
        return;
      }

      const source = new EventSource(`/api/video/${id}/events`);
      sourceRef.current = source;

      const finish = (patch: Partial<State>) => {
        source.close();
        sourceRef.current = null;
        stopTimer();
        setState((s) => ({ ...s, running: false, done: 0, total: 0, ...patch }));
        onSettled?.();
      };

      source.onmessage = (e) => {
        const job = JSON.parse(e.data) as Job;
        if (job.status === 'running') {
          setState((s) => ({
            ...s,
            message: job.message || '処理中…',
            done: job.done,
            total: job.total,
          }));
          return;
        }
        if (job.status === 'error') finish({ error: job.error, message: '' });
        else finish({ job, message: '完了' });
      };

      source.onerror = () => {
        finish({
          error: `進捗の受信が切れました。/api/video/${id} で状態を確認できます`,
          message: '',
        });
      };
    },
    [onSettled, stopTimer],
  );

  const reset = useCallback(() => {
    sourceRef.current?.close();
    stopTimer();
    setState(IDLE);
  }, [stopTimer]);

  return { ...state, start, reset };
}
