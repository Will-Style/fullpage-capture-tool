import { Download, Shuffle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatBytes } from '@/lib/format';
import { videoDownload, videoSrc, type ClipKey, type Format, type JobFile } from '@/lib/api';

interface Props {
  jobId: string;
  clipKey: ClipKey;
  files: JobFile[];
  title: string;
  detail: string[];
  notes?: string[];
  onReroll?: () => void;
  rerolling?: boolean;
}

const ORDER: Format[] = ['webm', 'mp4'];

export function ClipCard({
  jobId,
  clipKey,
  files,
  title,
  detail,
  notes = [],
  onReroll,
  rerolling,
}: Props) {
  // WebM を先に置き、再生できないブラウザだけ MP4 に落ちる
  const ordered = ORDER.map((fmt) => files.find((f) => f.format === fmt)).filter(
    (f): f is JobFile => Boolean(f),
  );
  if (!ordered.length) return null;

  const snippet =
    ordered.length === 2
      ? `[video webm="…/${ordered[0].filename}" mp4="…/${ordered[1].filename}"]`
      : `[video ${ordered[0].format}="…/${ordered[0].filename}"]`;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <p className="text-muted-foreground text-xs">{detail.join(' · ')}</p>
        {notes.map((note) => (
          <p key={note} className="text-muted-foreground text-xs">
            ※ {note}
          </p>
        ))}
      </CardHeader>

      <CardContent className="space-y-4">
        <video
          key={ordered.map((f) => f.filename).join()}
          controls
          preload="metadata"
          playsInline
          className="w-full rounded-md bg-black"
        >
          {ordered.map((f) => (
            <source
              key={f.format}
              src={videoSrc(jobId, clipKey, f.format)}
              type={`video/${f.format}`}
            />
          ))}
        </video>

        <div className="flex flex-wrap gap-2">
          {ordered.map((f) => (
            <Button key={f.format} variant="outline" size="sm" asChild>
              <a href={videoDownload(jobId, clipKey, f.format)} download={f.filename}>
                <Download />
                {f.format.toUpperCase()} ({formatBytes(f.bytes)})
              </a>
            </Button>
          ))}
          {onReroll && (
            <Button size="sm" onClick={onReroll} disabled={rerolling}>
              <Shuffle />
              ダイジェストを引き直す
            </Button>
          )}
        </div>

        <div className="space-y-1.5">
          <p className="text-muted-foreground text-xs">
            WordPress 貼り付け例（アップロード後の URL に差し替え）
          </p>
          <pre className="bg-muted overflow-x-auto rounded-md p-3 font-mono text-xs">
            {snippet}
          </pre>
        </div>
      </CardContent>
    </Card>
  );
}
