import { useEffect, useRef } from 'react';

interface RemoteAudioProps {
  streams: Record<string, MediaStream>;
}

/** Входящий голос: по одному <audio> на пира. Видео в комнате — не наше. */
export function RemoteAudio({ streams }: RemoteAudioProps) {
  return (
    <div className="hw-remoteaudio" aria-hidden="true">
      {Object.entries(streams).map(([peerId, stream]) => (
        <RemoteAudioTrack key={peerId} stream={stream} />
      ))}
    </div>
  );
}

function RemoteAudioTrack({ stream }: { stream: MediaStream }) {
  const ref = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    const audio = ref.current;
    if (!audio) {
      return;
    }
    audio.srcObject = stream;
    // В Tauri-WebView автозапуск разрешён, но на всякий случай повторяем
    // попытку на первом касании — иначе слушатель остался бы без звука.
    const unlock = (): void => {
      void audio.play().catch(() => undefined);
    };
    void audio.play().catch(() => {
      window.addEventListener('pointerdown', unlock, { once: true });
    });
    return () => {
      window.removeEventListener('pointerdown', unlock);
      audio.srcObject = null;
    };
  }, [stream]);

  return <audio ref={ref} autoPlay playsInline />;
}
