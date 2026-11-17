import { useCallback, useEffect, useRef, useState } from 'react';
import { BottomBar } from '../features/site/BottomBar';
import { DebugZones } from '../features/site/DebugZones';
import { TopBar } from '../features/site/TopBar';
import { useSiteController } from '../features/site/useSiteController';
import { startRegionSync, type RegionPayload } from '../native/regions';

const TOAST_MS = 3400;

/** Каркас оверлея: две панели, прозрачная сцена и отладочные зоны. */
export function Shell() {
  const site = useSiteController();
  const [zonesOpen, setZonesOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [regionPayload, setRegionPayload] = useState<RegionPayload | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<number | null>(null);

  const notify = useCallback((text: string) => {
    setToast(text);
    if (toastTimer.current !== null) {
      window.clearTimeout(toastTimer.current);
    }
    toastTimer.current = window.setTimeout(() => {
      setToast(null);
      toastTimer.current = null;
    }, TOAST_MS);
  }, []);

  useEffect(
    () => () => {
      if (toastTimer.current !== null) {
        window.clearTimeout(toastTimer.current);
      }
    },
    [],
  );

  // Каждое новое уведомление native-слоя показываем один раз.
  const notice = site.status.notice;
  useEffect(() => {
    if (notice) {
      notify(notice.text);
    }
  }, [notice, notify]);

  // Отправка зон касания: restart по [zonesOpen, collapsed] даёт мгновенный
  // пересчёт после анимаций панели, дальше работают observer'ы и heartbeat.
  useEffect(
    () =>
      startRegionSync(
        () => zonesOpen,
        zonesOpen ? setRegionPayload : undefined,
      ),
    [zonesOpen, collapsed],
  );

  useEffect(() => {
    if (!zonesOpen) {
      setRegionPayload(null);
    }
  }, [zonesOpen]);

  const open = (input: string) => {
    void site.open(input);
  };

  return (
    <div className="hw-app">
      <TopBar
        status={site.status}
        zonesOpen={zonesOpen}
        onOpen={open}
        onTestPage={() => void site.openTestPage()}
        onYoutube={() => void site.openYoutube()}
        onNav={site.nav}
        onToggleZones={() => setZonesOpen((openState) => !openState)}
      />

      <main className="hw-stage" aria-hidden="true">
        <div className="hw-hint">
          Верхняя панель — <b>React</b>, остальное — сайт под ней.
          <br />
          Тапните по тестовой странице.
        </div>
      </main>

      <BottomBar
        status={site.status}
        collapsed={collapsed}
        onToggleCollapsed={() => setCollapsed((value) => !value)}
        onTogglePlay={site.togglePlay}
        onSeek={site.seekBy}
        onReload={site.reload}
      />

      {zonesOpen && (
        <DebugZones
          payload={regionPayload}
          tap={site.status.lastTap}
          onClose={() => setZonesOpen(false)}
        />
      )}

      <div className="hw-toast-slot" role="status" aria-live="polite">
        {toast ? <div className="hw-toast">{toast}</div> : null}
      </div>
    </div>
  );
}
