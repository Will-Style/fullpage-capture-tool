import { useState } from 'react';
import { Download, ExternalLink } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Meta } from '@/components/Meta';
import { NumberField, ToggleGroup } from '@/components/Fields';
import { RunBar } from '@/components/RunBar';
import { SharedSettings, type Shared } from '@/components/SharedSettings';
import { api, type StillResult } from '@/lib/api';
import { formatBytes } from '@/lib/format';

interface Props {
  shared: Shared;
  onSharedChange: (patch: Partial<Shared>) => void;
  onSettled: () => void;
}

export function StillTab({ shared, onSharedChange, onSettled }: Props) {
  const [format, setFormat] = useState<'png' | 'jpeg'>('png');
  const [quality, setQuality] = useState(92);
  const [waitStable, setWaitStable] = useState(true);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<StillResult | null>(null);

  const run = async () => {
    if (!shared.url.trim()) return;
    setRunning(true);
    setError(null);
    setResult(null);
    try {
      setResult(await api.capture({ ...shared, format, quality, waitStable }));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setRunning(false);
      onSettled();
    }
  };

  return (
    <div className="space-y-6">
      <SharedSettings
        value={shared}
        onChange={onSharedChange}
        onSubmit={run}
        extra={
          <div className="grid gap-2">
            <Label>保存形式</Label>
            <ToggleGroup
              value={format}
              onChange={setFormat}
              options={[
                { value: 'png', label: 'PNG 無劣化' },
                { value: 'jpeg', label: 'JPEG' },
              ]}
            />
          </div>
        }
        advancedExtra={
          <>
            {format === 'jpeg' && (
              <NumberField
                id="quality"
                label="JPEG 品質"
                className="w-32"
                min={1}
                max={100}
                value={quality}
                onChange={setQuality}
              />
            )}
            <Label className="flex h-9 items-center gap-2 font-normal">
              <Checkbox
                checked={waitStable}
                onCheckedChange={(c) => setWaitStable(c === true)}
              />
              ローディングが明けるまで待つ
            </Label>
          </>
        }
      />

      <RunBar
        label="キャプチャ"
        onRun={run}
        running={running}
        message={running ? 'キャプチャ中…' : result ? '完了' : ''}
        elapsed={0}
        done={0}
        total={0}
        error={error}
        hint={
          waitStable
            ? '初回はページ読み込みと遅延画像の展開に十数秒かかることがあります。ローディングアニメーションが終わって画面が落ち着いてから撮ります（最大 10 秒待機）。'
            : '初回はページ読み込みと遅延画像の展開に十数秒かかることがあります。'
        }
      />

      {result && (
        <div>
          <Meta
            items={[
              ['実ピクセル', `${result.pixelWidth} × ${result.pixelHeight} px`],
              ['CSS サイズ', `${result.cssWidth} × ${result.cssHeight} px`],
              ['解像度', `${result.scale}x`],
              [
                'ファイル',
                `${result.filename.split('.').pop()?.toUpperCase()} / ${formatBytes(result.bytes)}`,
              ],
              ['処理時間', `${(result.elapsedMs / 1000).toFixed(1)} 秒`],
              ...(result.settled === false
                ? ([['ローディング', '待機上限まで変化が続きました']] as [string, string][])
                : []),
              ...(result.chunked ? ([['方式', '分割キャプチャ結合']] as [string, string][]) : []),
            ]}
          />
          <div className="mb-4 flex flex-wrap gap-2">
            <Button asChild>
              <a href={`/api/download/${result.id}`} download={result.filename}>
                <Download />
                ダウンロード
              </a>
            </Button>
            <Button variant="outline" asChild>
              <a href={`/api/image/${result.id}`} target="_blank" rel="noopener">
                <ExternalLink />
                原寸で開く
              </a>
            </Button>
          </div>
          <div className="max-h-[640px] overflow-auto rounded-lg border bg-white">
            <img src={`/api/image/${result.id}`} alt="キャプチャ結果" className="block w-full" />
          </div>
        </div>
      )}
    </div>
  );
}
