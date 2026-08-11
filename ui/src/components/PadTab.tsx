import { useState } from 'react';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ClipCard } from '@/components/ClipCard';
import { ColorField } from '@/components/ColorField';
import { NumberField } from '@/components/Fields';
import { Meta } from '@/components/Meta';
import { RunBar } from '@/components/RunBar';
import { useJob } from '@/hooks/useJob';
import { api, type Format, type PadInfo } from '@/lib/api';

export function PadTab({ onSettled }: { onSettled: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [width, setWidth] = useState(1920);
  const [height, setHeight] = useState(1300);
  const [percent, setPercent] = useState(90);
  const [color, setColor] = useState('#1C1C1A');
  const [formats, setFormats] = useState<Record<Format, boolean>>({ mp4: true, webm: false });

  const [jobId, setJobId] = useState<string | null>(null);
  const job = useJob(onSettled);

  const selected = (Object.keys(formats) as Format[]).filter((f) => formats[f]);

  const run = () => {
    if (!file || !selected.length) return;
    job.start(async () => {
      const res = await api.startPad(file, {
        formats: selected.join(','),
        padWidth: String(width),
        padHeight: String(height),
        padPercent: String(percent),
        padColor: color,
      });
      setJobId(res.id);
      return res;
    }, 'アップロード中…');
  };

  const info = job.job?.info as PadInfo | undefined;

  return (
    <div className="space-y-6">
      <div className="grid gap-2">
        <Label htmlFor="pvFile">動画ファイル</Label>
        <Input
          id="pvFile"
          type="file"
          accept="video/*,.mkv,.mov,.webm,.mp4,.m4v,.avi"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          className="file:text-foreground file:mr-3 file:font-medium"
        />
      </div>

      <div className="flex flex-wrap items-end gap-4">
        <NumberField
          id="pvWidth"
          label="キャンバス幅"
          className="w-32"
          min={320}
          max={3840}
          step={2}
          value={width}
          onChange={setWidth}
        />
        <NumberField
          id="pvHeight"
          label="キャンバス高"
          className="w-32"
          min={320}
          max={3840}
          step={2}
          value={height}
          onChange={setHeight}
        />
        <NumberField
          id="pvPercent"
          label="動画の割合 %"
          className="w-32"
          min={10}
          max={100}
          value={percent}
          onChange={setPercent}
        />
        <div className="w-52">
          <ColorField id="pvColor" label="背景色" value={color} onChange={setColor} />
        </div>
        <div className="grid gap-2">
          <Label>出力形式</Label>
          <div className="flex h-9 items-center gap-4">
            {(['mp4', 'webm'] as Format[]).map((f) => (
              <Label key={f} className="flex items-center gap-2 font-normal">
                <Checkbox
                  checked={formats[f]}
                  onCheckedChange={(c) => setFormats((s) => ({ ...s, [f]: c === true }))}
                />
                {f.toUpperCase()}
              </Label>
            ))}
          </div>
        </div>
      </div>

      <RunBar
        label="枠を付ける"
        onRun={run}
        running={job.running}
        message={job.message}
        elapsed={job.elapsed}
        done={job.done}
        total={job.total}
        error={!file && job.error === null ? null : job.error}
        hint="手持ちの動画を指定サイズのキャンバス中央に置き、周囲を背景色で塗ります。フレームレートと尺は変えません。音声があればそのまま残します（上限 2GB）。"
      />

      {job.job && info && jobId && (
        <div className="space-y-4">
          <Meta
            items={[
              ['元の動画', `${info.source.width} × ${info.source.height} px`],
              ['長さ', `${info.source.durationSec.toFixed(1)} 秒`],
              ['音声', info.source.hasAudio ? 'あり（そのまま残しました）' : 'なし'],
              ['キャンバス', info.canvas],
              ['処理時間', `${(job.job.elapsedMs / 1000).toFixed(0)} 秒`],
            ]}
          />
          <ClipCard
            jobId={jobId}
            clipKey="padded"
            files={job.job.files}
            title="枠付き"
            detail={[info.canvas, `動画 ${info.pad.percent}%`, `背景 ${info.pad.color}`]}
          />
        </div>
      )}
    </div>
  );
}
