import { useMemo, useState } from 'react';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ClipCard } from '@/components/ClipCard';
import { ColorField } from '@/components/ColorField';
import { NumberField } from '@/components/Fields';
import { Meta } from '@/components/Meta';
import { RunBar } from '@/components/RunBar';
import { SharedSettings, type Shared } from '@/components/SharedSettings';
import { useJob } from '@/hooks/useJob';
import {
  api,
  EASING_GROUPS,
  SNAPPY_EASINGS,
  type Format,
  type JobFile,
  type Timeline,
  type VideoInfo,
} from '@/lib/api';

interface Props {
  shared: Shared;
  onSharedChange: (patch: Partial<Shared>) => void;
  onSettled: () => void;
}

const OUT_WIDTHS = [
  { value: '1920', label: '1920 — フル HD' },
  { value: '1512', label: '1512 — 等倍' },
  { value: '1440', label: '1440' },
  { value: '1280', label: '1280 — 掲載向き' },
  { value: '960', label: '960 — 軽量' },
];

const FPS_OPTIONS = [
  { value: '24', label: '24' },
  { value: '25', label: '25' },
  { value: '30', label: '30 — 標準' },
  { value: '50', label: '50' },
  { value: '60', label: '60 — 最も滑らか' },
];

const STEP_RATIO_OPTIONS = [
  { value: '0.6', label: '6 割' },
  { value: '0.8', label: '8 割' },
  { value: '1', label: '1 画面' },
];

export function VideoTab({ shared, onSharedChange, onSettled }: Props) {
  const [targetSec, setTargetSec] = useState(60);
  const [introSec, setIntroSec] = useState(0);
  const [easing, setEasing] = useState('easeOutQuart');
  const [stepRatio, setStepRatio] = useState(1);
  const [outWidth, setOutWidth] = useState(1512);
  const [fps, setFps] = useState(30);
  const [formats, setFormats] = useState<Record<Format, boolean>>({ webm: true, mp4: true });

  const [digest, setDigest] = useState(true);
  const [digestSec, setDigestSec] = useState(10);
  const [digestScenes, setDigestScenes] = useState(0);
  const [digestIntroSec, setDigestIntroSec] = useState(0);
  const [seed, setSeed] = useState('');

  const [pad, setPad] = useState(false);
  const [padWidth, setPadWidth] = useState(1920);
  const [padHeight, setPadHeight] = useState(1300);
  const [padPercent, setPadPercent] = useState(90);
  const [padColor, setPadColor] = useState('#1C1C1A');

  const [jobId, setJobId] = useState<string | null>(null);
  const job = useJob(onSettled);

  const selectedFormats = (Object.keys(formats) as Format[]).filter((f) => formats[f]);

  const hint = useMemo(() => {
    let text =
      '実ブラウザを実時間で収録します。追従ヘッダーやスクロール連動アニメもそのまま写ります。実際の尺はページの長さで決まります（短いページは指定より短くなります）。';
    if (SNAPPY_EASINGS.includes(easing)) {
      text +=
        ' 減速の急なイージングは 1 コマの移動量が大きいため、30fps だとカクつくことがあります（60fps 推奨）。';
    }
    if (introSec > 0 || (digest && digestIntroSec > 0)) {
      text += ' 冒頭の静止を使うと、収録直前にページを読み込み直してイントロを最初から流します。';
    }
    return text;
  }, [easing, introSec, digest, digestIntroSec]);

  const run = () => {
    if (!shared.url.trim()) return;
    if (!selectedFormats.length) return;
    job.start(async () => {
      const res = await api.startVideo({
        ...shared,
        targetSec,
        introSec,
        easing,
        stepRatio,
        outWidth,
        fps,
        formats: selectedFormats,
        digest,
        digestSec,
        digestScenes,
        digestIntroSec,
        ...(seed.trim() ? { seed: Number(seed.trim()) } : {}),
        pad,
        padWidth,
        padHeight,
        padPercent,
        padColor,
      });
      setJobId(res.id);
      return res;
    });
  };

  const reroll = () => {
    if (!jobId) return;
    job.start(() => api.rerollDigest(jobId), 'ダイジェストを引き直しています…');
  };

  const info = job.job?.info as VideoInfo | undefined;

  return (
    <div className="space-y-6">
      <SharedSettings value={shared} onChange={onSharedChange} onSubmit={run} />

      <div className="flex flex-wrap items-end gap-4">
        <NumberField
          id="targetSec"
          label="本編の尺の上限 (秒)"
          className="w-40"
          min={5}
          max={600}
          step={5}
          value={targetSec}
          onChange={setTargetSec}
        />
        <NumberField
          id="introSec"
          label="冒頭の静止 (秒)"
          className="w-36"
          min={0}
          max={30}
          step={0.5}
          value={introSec}
          onChange={setIntroSec}
        />
        <div className="grid w-64 gap-2">
          <Label htmlFor="easing">スクロールのイージング</Label>
          <Select value={easing} onValueChange={setEasing}>
            <SelectTrigger id="easing" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="linear">linear — 等速</SelectItem>
              {EASING_GROUPS.map((group) => (
                <SelectGroup key={group.label}>
                  <SelectLabel>{group.label}</SelectLabel>
                  {group.items.map((name) => (
                    <SelectItem key={name} value={name}>
                      {name}
                    </SelectItem>
                  ))}
                </SelectGroup>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="grid w-44 gap-2">
          <Label htmlFor="stepRatio">1 回のスクロール量</Label>
          <Select value={String(stepRatio)} onValueChange={(v) => setStepRatio(Number(v))}>
            <SelectTrigger id="stepRatio" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {STEP_RATIO_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <p className="text-muted-foreground pb-2 text-xs">移動 1.2 秒・静止 0.6 秒で固定</p>
      </div>

      <div className="flex flex-wrap items-end gap-4">
        <div className="grid w-52 gap-2">
          <Label htmlFor="outWidth">出力サイズ (幅 px)</Label>
          <Select value={String(outWidth)} onValueChange={(v) => setOutWidth(Number(v))}>
            <SelectTrigger id="outWidth" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {OUT_WIDTHS.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="grid w-44 gap-2">
          <Label htmlFor="fps">fps</Label>
          <Select value={String(fps)} onValueChange={(v) => setFps(Number(v))}>
            <SelectTrigger id="fps" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {FPS_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-2">
          <Label>出力形式</Label>
          <div className="flex h-9 items-center gap-4">
            {(['webm', 'mp4'] as Format[]).map((f) => (
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

      {/* ダイジェスト */}
      <fieldset className="rounded-lg border p-4">
        <legend className="px-1.5">
          <Label className="flex items-center gap-2 font-medium">
            <Checkbox checked={digest} onCheckedChange={(c) => setDigest(c === true)} />
            ダイジェストも作る
          </Label>
        </legend>

        <div
          className={`space-y-4 ${digest ? '' : 'pointer-events-none opacity-40'}`}
          aria-hidden={!digest}
        >
          <div className="flex flex-wrap items-end gap-4">
            <NumberField
              id="digestSec"
              label="尺 (秒)"
              className="w-28"
              min={3}
              max={120}
              value={digestSec}
              onChange={setDigestSec}
            />
            <NumberField
              id="digestScenes"
              label="場面数"
              className="w-32"
              min={0}
              max={60}
              placeholder="0 = 自動"
              value={digestScenes}
              onChange={setDigestScenes}
            />
            <NumberField
              id="digestIntroSec"
              label="冒頭の静止 (秒)"
              className="w-36"
              min={0}
              max={30}
              step={0.5}
              value={digestIntroSec}
              onChange={setDigestIntroSec}
            />
            <div className="grid w-48 gap-2">
              <Label htmlFor="seed">シード（空でランダム）</Label>
              <Input
                id="seed"
                inputMode="numeric"
                placeholder="毎回ランダム"
                value={seed}
                onChange={(e) => setSeed(e.target.value)}
              />
            </div>
            <p className="text-muted-foreground pb-2 text-xs">
              動き（移動量・速度・イージング）は本編と同じ。1 場面目は必ずページ先頭
            </p>
          </div>

          <div className="flex flex-wrap items-end gap-4">
            <Label className="flex h-9 items-center gap-2 font-normal">
              <Checkbox checked={pad} onCheckedChange={(c) => setPad(c === true)} />
              枠（余白）を付ける
            </Label>
            <NumberField
              id="padWidth"
              label="キャンバス幅"
              className="w-32"
              min={320}
              max={3840}
              step={2}
              disabled={!pad}
              value={padWidth}
              onChange={setPadWidth}
            />
            <NumberField
              id="padHeight"
              label="キャンバス高"
              className="w-32"
              min={320}
              max={3840}
              step={2}
              disabled={!pad}
              value={padHeight}
              onChange={setPadHeight}
            />
            <NumberField
              id="padPercent"
              label="動画の割合 %"
              className="w-32"
              min={10}
              max={100}
              disabled={!pad}
              value={padPercent}
              onChange={setPadPercent}
            />
            <div className="w-52">
              <ColorField
                id="padColor"
                label="背景色"
                value={padColor}
                onChange={setPadColor}
                disabled={!pad}
              />
            </div>
          </div>
        </div>
      </fieldset>

      <RunBar
        label="動画を作成"
        onRun={run}
        running={job.running}
        message={job.message}
        elapsed={job.elapsed}
        done={job.done}
        total={job.total}
        error={
          !selectedFormats.length ? '出力形式を 1 つ以上選んでください' : job.error
        }
        hint={hint}
      />

      {job.job && info && jobId && <VideoResult jobId={jobId} info={info} files={job.job.files} elapsedMs={job.job.elapsedMs} onReroll={reroll} rerolling={job.running} />}
    </div>
  );
}

function VideoResult({
  jobId,
  info,
  files,
  elapsedMs,
  onReroll,
  rerolling,
}: {
  jobId: string;
  info: VideoInfo;
  files: JobFile[];
  elapsedMs: number;
  onReroll: () => void;
  rerolling: boolean;
}) {
  const order = ['main', 'digest'];
  const grouped = order
    .map((key) => ({ key, files: files.filter((f) => f.key === key) }))
    .filter((g) => g.files.length);

  return (
    <div className="space-y-4">
      <Meta
        items={[
          ['イージング', info.easing],
          ['1 回のスクロール量', `${Math.round((info.stepRatio ?? 1) * 100)}%`],
          ['ページ高さ', `${info.pageHeight} px`],
          ['ビューポート', `${info.cssWidth} × ${info.viewportHeight} px`],
          ['fps', info.fps],
          ['シード', info.seed],
          ['処理時間', `${(elapsedMs / 1000).toFixed(0)} 秒`],
        ]}
      />
      {grouped.map(({ key, files: clipFiles }) => {
        const tl = info.timelines.find((t) => t.key === key);
        return (
          <ClipCard
            key={key}
            jobId={jobId}
            clipKey={key as 'main' | 'digest'}
            files={clipFiles}
            title={clipFiles[0].label}
            detail={describe(tl)}
            notes={notesOf(tl)}
            onReroll={key === 'digest' ? onReroll : undefined}
            rerolling={rerolling}
          />
        );
      })}
    </div>
  );
}

function describe(tl?: Timeline): string[] {
  if (!tl) return [];
  const intro = tl.introSec ? [`冒頭の静止 ${tl.introSec} 秒`] : [];
  if (tl.kind === 'scenes') {
    return [
      `${tl.durationSec} 秒`,
      ...intro,
      `${tl.scenes} 場面（1 場面目は先頭、以降ランダム抽出）`,
      `1 場面 ${tl.sceneSec} 秒`,
      `${tl.driftPx} px 移動`,
      `移動 ${tl.moveSec} 秒 / 静止 ${tl.holdSec} 秒`,
    ];
  }
  return [
    `${tl.durationSec} 秒`,
    ...intro,
    `${tl.steps} ステップ`,
    `1 回 ${tl.stepPx} px`,
    `移動 ${tl.moveSec} 秒 / 静止 ${tl.holdSec} 秒`,
  ];
}

function notesOf(tl?: Timeline): string[] {
  if (!tl) return [];
  const notes: string[] = [];
  if (tl.pad) {
    notes.push(
      `枠: ${tl.pad.width}×${tl.pad.height} / 動画 ${tl.pad.percent}% / 背景 ${tl.pad.color}`,
    );
  }
  if (tl.compressed) notes.push('尺に収めるため移動・静止を規定より短くしました');
  if (tl.fitted === false) notes.push('ページが長く、指定の尺に収まりませんでした');
  return notes;
}
