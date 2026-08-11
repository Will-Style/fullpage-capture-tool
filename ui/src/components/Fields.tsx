import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

interface NumberFieldProps {
  id: string;
  label: string;
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  className?: string;
  disabled?: boolean;
  placeholder?: string;
}

export function NumberField({
  id,
  label,
  value,
  onChange,
  className,
  ...rest
}: NumberFieldProps) {
  return (
    <div className={cn('grid gap-2', className)}>
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        type="number"
        value={value}
        // 空欄にした瞬間 NaN を送らないよう 0 に寄せ、サーバー側の clamp に任せる
        onChange={(e) => onChange(e.target.value === '' ? 0 : Number(e.target.value))}
        {...rest}
      />
    </div>
  );
}

interface ToggleGroupProps<T extends string | number> {
  value: T;
  onChange: (value: T) => void;
  options: { value: T; label: string }[];
  className?: string;
}

/** 1x/2x/3x のような排他選択。Radix を持ち出すほどでもないので素の button で作る */
export function ToggleGroup<T extends string | number>({
  value,
  onChange,
  options,
  className,
}: ToggleGroupProps<T>) {
  return (
    <div
      className={cn('border-input inline-flex h-9 overflow-hidden rounded-md border', className)}
    >
      {options.map((o, i) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={o.value === value}
          onClick={() => onChange(o.value)}
          className={cn(
            'px-4 text-sm whitespace-nowrap transition-colors',
            i > 0 && 'border-input border-l',
            o.value === value
              ? 'bg-secondary text-secondary-foreground font-medium'
              : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
