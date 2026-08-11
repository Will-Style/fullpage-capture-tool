import { AlertCircle, Loader2 } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';

interface Props {
  label: string;
  onRun: () => void;
  running: boolean;
  message: string;
  elapsed: number;
  done: number;
  total: number;
  error: string | null;
  hint: string;
}

/** 実行ボタン・進捗・ヒント・エラーをまとめた下部の帯 */
export function RunBar({
  label,
  onRun,
  running,
  message,
  elapsed,
  done,
  total,
  error,
  hint,
}: Props) {
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={onRun} disabled={running} size="lg" >
          {running && <Loader2 className="animate-spin" />}
          {label}
        </Button>
        {(running || message) && (
          <span className="text-muted-foreground text-sm tabular-nums">
            {message}
            {running && ` — ${elapsed.toFixed(0)} 秒`}
          </span>
        )}
      </div>

      {running && total > 0 && <Progress value={(done / total) * 100} />}

      <p className="text-muted-foreground text-xs leading-relaxed">{hint}</p>

      {error && (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertDescription className="whitespace-pre-wrap">{error}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}
