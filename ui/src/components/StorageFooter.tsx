import { Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { formatBytes } from '@/lib/format';
import { api, type Storage } from '@/lib/api';

interface Props {
  storage: Storage | null;
  onCleared: (message: string) => void;
  onError: (message: string) => void;
  refresh: () => void;
}

export function StorageFooter({ storage, onCleared, onError, refresh }: Props) {
  const clear = async () => {
    if (!confirm('これまでに作成した画像・動画をすべて削除します。よろしいですか？')) return;
    try {
      const { cleared } = await api.clearStorage();
      onCleared(`${cleared.files} 個 / ${formatBytes(cleared.bytes)} を削除しました`);
    } catch (err) {
      onError((err as Error).message);
    } finally {
      refresh();
    }
  };

  return (
    <footer className="mt-8 flex flex-wrap items-center gap-4 border-t pt-4">
      <span className="text-muted-foreground text-sm tabular-nums">
        {storage
          ? storage.files
            ? `一時ファイル: ${storage.files} 個 / ${formatBytes(storage.bytes)}`
            : '一時ファイルはありません'
          : ''}
      </span>
      <Button variant="outline" size="sm" onClick={clear} disabled={!storage?.files}>
        <Trash2 />
        一時ファイルを削除
      </Button>
    </footer>
  );
}
