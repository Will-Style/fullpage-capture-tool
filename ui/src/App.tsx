import { useCallback, useEffect, useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { PadTab } from '@/components/PadTab';
import { STILL_DEFAULTS, VIDEO_DEFAULTS, type Shared } from '@/components/SharedSettings';
import { StillTab } from '@/components/StillTab';
import { StorageFooter } from '@/components/StorageFooter';
import { VideoTab } from '@/components/VideoTab';
import { api, type Storage } from '@/lib/api';

type Tab = 'still' | 'video' | 'pad';

export default function App() {
  const [tab, setTab] = useState<Tab>('still');
  // 画面サイズの好みはタブごとに違うので別々に持つ。URL だけは行き来しても引き継ぐ。
  const [still, setStill] = useState<Shared>(STILL_DEFAULTS);
  const [video, setVideo] = useState<Shared>(VIDEO_DEFAULTS);
  const [storage, setStorage] = useState<Storage | null>(null);
  const [notice, setNotice] = useState('');

  const refreshStorage = useCallback(() => {
    // useEffect に Promise を返さないよう、戻り値は捨てる
    void api.storage().then(setStorage).catch(() => setStorage(null));
  }, []);

  useEffect(() => {
    refreshStorage();
  }, [refreshStorage]);

  const patchStill = useCallback((patch: Partial<Shared>) => {
    setStill((s) => ({ ...s, ...patch }));
    if (patch.url !== undefined) setVideo((s) => ({ ...s, url: patch.url as string }));
  }, []);

  const patchVideo = useCallback((patch: Partial<Shared>) => {
    setVideo((s) => ({ ...s, ...patch }));
    if (patch.url !== undefined) setStill((s) => ({ ...s, url: patch.url as string }));
  }, []);

  return (
    <div className="mx-auto max-w-5xl px-5 py-8 pb-16">
      <header className="mb-6">
        <h1 className="text-xl font-semibold tracking-tight">Fullpage Capture</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          URL のページ全体を指定した画面幅でキャプチャし、スクロール動画も作れます。
        </p>
      </header>

      <Tabs
        value={tab}
        onValueChange={(v) => {
          setTab(v as Tab);
          setNotice('');
        }}
      >
        <TabsList variant="line">
          <TabsTrigger value="still">静止画</TabsTrigger>
          <TabsTrigger value="video">スクロール動画</TabsTrigger>
          <TabsTrigger value="pad">動画に枠を付ける</TabsTrigger>
        </TabsList>

        <Card className="mt-4">
          <CardContent>
            <TabsContent value="still">
              <StillTab shared={still} onSharedChange={patchStill} onSettled={refreshStorage} />
            </TabsContent>
            <TabsContent value="video">
              <VideoTab shared={video} onSharedChange={patchVideo} onSettled={refreshStorage} />
            </TabsContent>
            <TabsContent value="pad">
              <PadTab onSettled={refreshStorage} />
            </TabsContent>
          </CardContent>
        </Card>
      </Tabs>

      {notice && <p className="text-muted-foreground mt-4 text-sm">{notice}</p>}

      <StorageFooter
        storage={storage}
        onCleared={setNotice}
        onError={setNotice}
        refresh={refreshStorage}
      />
    </div>
  );
}
