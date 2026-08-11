import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

interface Props {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}

/** カラーピッカーと 16 進表記を並べ、互いに追従させる */
export function ColorField({ id, label, value, onChange, disabled }: Props) {
  const commitText = (raw: string) => {
    const m = /^#?([0-9a-f]{6})$/i.exec(raw.trim());
    onChange(m ? `#${m[1].toUpperCase()}` : value);
  };

  return (
    <div className="grid gap-2">
      <Label htmlFor={id}>{label}</Label>
      <div className="flex gap-2">
        <input
          type="color"
          aria-label={`${label}のカラーピッカー`}
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value.toUpperCase())}
          className="border-input h-9 w-11 shrink-0 cursor-pointer rounded-md border bg-transparent p-1 disabled:cursor-not-allowed disabled:opacity-50"
        />
        <Input
          id={id}
          value={value}
          disabled={disabled}
          spellCheck={false}
          onChange={(e) => onChange(e.target.value)}
          onBlur={(e) => commitText(e.target.value)}
        />
      </div>
    </div>
  );
}
