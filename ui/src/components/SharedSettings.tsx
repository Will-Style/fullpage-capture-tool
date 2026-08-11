import { ChevronRight } from 'lucide-react';
import { Checkbox } from '@/components/ui/checkbox';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { NumberField, ToggleGroup } from '@/components/Fields';

export interface Shared {
  url: string;
  width: number;
  scale: number;
  viewportHeight: number;
  waitMs: number;
  hideFixed: boolean;
}

/** 静止画タブの初期値 */
export const STILL_DEFAULTS: Shared = {
  url: '',
  width: 1440,
  scale: 2,
  viewportHeight: 900,
  waitMs: 800,
  hideFixed: true,
};

/** 動画タブの初期値。書き出しに使う 1512x828 を既定にする */
export const VIDEO_DEFAULTS: Shared = {
  url: '',
  width: 1512,
  scale: 2,
  viewportHeight: 828,
  waitMs: 800,
  // 実挙動を見せたいので、追従ヘッダーは残す
  hideFixed: false,
};

const PRESETS = [
  { value: '1920', label: 'デスクトップ大 — 1920px' },
  { value: '1512', label: 'ノート 16:8.8 — 1512px' },
  { value: '1440', label: 'デスクトップ — 1440px' },
  { value: '1280', label: 'ノート PC — 1280px' },
  { value: '1024', label: 'タブレット横 — 1024px' },
  { value: '768', label: 'タブレット縦 — 768px' },
  { value: '390', label: 'スマートフォン — 390px' },
];

interface Props {
  value: Shared;
  onChange: (patch: Partial<Shared>) => void;
  onSubmit: () => void;
  /** 静止画タブだけに出す欄 */
  extra?: React.ReactNode;
  advancedExtra?: React.ReactNode;
}

export function SharedSettings({ value, onChange, onSubmit, extra, advancedExtra }: Props) {
  const preset = PRESETS.some((p) => p.value === String(value.width))
    ? String(value.width)
    : 'custom';

  return (
    <div className="space-y-5">
      <div className="grid gap-2">
        <Label htmlFor="url">URL</Label>
        <Input
          id="url"
          placeholder="https://example.com"
          autoComplete="off"
          spellCheck={false}
          value={value.url}
          onChange={(e) => onChange({ url: e.target.value })}
          onKeyDown={(e) => e.key === 'Enter' && onSubmit()}
        />
      </div>

      <div className="flex flex-wrap gap-4">
        <div className="grid w-56 gap-2">
          <Label htmlFor="preset">画面幅プリセット</Label>
          <Select
            value={preset}
            onValueChange={(v) => v !== 'custom' && onChange({ width: Number(v) })}
          >
            <SelectTrigger id="preset" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PRESETS.map((p) => (
                <SelectItem key={p.value} value={p.value}>
                  {p.label}
                </SelectItem>
              ))}
              <SelectItem value="custom">カスタム…</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <NumberField
          id="width"
          label="幅 (px)"
          className="w-32"
          min={320}
          max={3840}
          value={value.width}
          onChange={(width) => onChange({ width })}
        />

        <div className="grid gap-2">
          <Label>解像度</Label>
          <ToggleGroup
            value={value.scale}
            onChange={(scale) => onChange({ scale })}
            options={[
              { value: 1, label: '1x' },
              { value: 2, label: '2x Retina' },
              { value: 3, label: '3x' },
            ]}
          />
        </div>

        {extra}
      </div>

      <Collapsible>
        <CollapsibleTrigger className="text-muted-foreground hover:text-foreground flex items-center gap-1 text-sm [&[data-state=open]>svg]:rotate-90">
          <ChevronRight className="size-4 transition-transform" />
          詳細設定
        </CollapsibleTrigger>
        <CollapsibleContent className="flex flex-wrap items-end gap-4 pt-4">
          <NumberField
            id="waitMs"
            label="追加待機 (ms)"
            className="w-36"
            min={0}
            max={30000}
            step={100}
            value={value.waitMs}
            onChange={(waitMs) => onChange({ waitMs })}
          />
          <NumberField
            id="viewportHeight"
            label="ビューポート高さ (px)"
            className="w-44"
            min={400}
            max={2000}
            step={10}
            value={value.viewportHeight}
            onChange={(viewportHeight) => onChange({ viewportHeight })}
          />
          {advancedExtra}
          <Label className="flex h-9 items-center gap-2 font-normal">
            <Checkbox
              checked={value.hideFixed}
              onCheckedChange={(c) => onChange({ hideFixed: c === true })}
            />
            固定ヘッダー・追従要素を解除する
          </Label>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
