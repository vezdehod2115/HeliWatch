/*
 * «О приложении» (этап 7): версия, стек, ограничения и честное «без серверов».
 * Тот же текст, что в README, но коротко и внутри приложения.
 */

import { PageHeader } from '../../app/PageHeader';
import { BrandMark, Icon } from '../../app/icons';

interface AboutScreenProps {
  onBack: () => void;
  onOpenSettings: () => void;
}

export function AboutScreen({ onBack, onOpenSettings }: AboutScreenProps) {
  return (
    <div className="hw-screen" data-hw-region="about">
      <PageHeader
        title="О приложении"
        subtitle={`HeliWatch ${__APP_VERSION__}`}
        onBack={onBack}
        right={
          <button
            type="button"
            className="hw-iconbtn"
            onClick={onOpenSettings}
            aria-label="Настройки"
          >
            <Icon name="settings" size={20} />
          </button>
        }
      />
      <div className="hw-screen-scroll">
        <section className="hw-card hw-abouthero">
          <BrandMark size={64} />
          <div>
            <h2>HeliWatch</h2>
            <p>Смотрите видео вместе — сайт или файл — с голосом и чатом, без своих серверов.</p>
          </div>
        </section>

        <section className="hw-card">
          <div className="hw-card-head">
            <Icon name="broadcast" size={18} />
            <h2>Как это работает</h2>
          </div>
          <ul className="hw-aboutlist">
            <li>
              <b>Соединение напрямую.</b> WebRTC-комната поднимается через публичные
              релеи для сигналинга; голос, чат, фото и видео файла хоста идут
              между телефонами. Если прямой путь невозможен — помогает TURN.
            </li>
            <li>
              <b>Данные локально.</b> Профиль, ключи, друзья, личка, статистика и
              настройки хранятся в SQLite на этом телефоне. Синхронизации истории
              между устройствами нет — только ручной бэкап.
            </li>
            <li>
              <b>Подписи ECDSA P-256.</b> Идентичность — ключ на устройстве, а не
              аккаунт. Дружба появляется только по взаимному подтверждению.
            </li>
            <li>
              <b>Фото в файловом кэше.</b> Сжатые фото (≤2 МБ) кэшируются с LRU
              200 МБ; аватары — 128×128, до 50 файлов / 5 МБ.
            </li>
          </ul>
        </section>

        <section className="hw-card">
          <div className="hw-card-head">
            <Icon name="lock" size={18} />
            <h2>Чего приложение не делает</h2>
          </div>
          <ul className="hw-aboutlist">
            <li>Не обходит DRM, платные подписки и возрастные ограничения.</li>
            <li>Не показывает онлайн-статус друзей и не шлёт push: для этого нужен сервер.</li>
            <li>Не поднимает свои серверы и не хранит переписку в облаке.</li>
            <li>Не поддерживает больше двух зрителей файла хоста (канал телефона).</li>
          </ul>
        </section>

        <section className="hw-card">
          <div className="hw-card-head">
            <Icon name="settings" size={18} />
            <h2>Стек</h2>
          </div>
          <p className="hw-note">
            Tauri v2.12 · React 19.3 · TypeScript 5.9 · Vite 8 · Tailwind CSS 4.3 ·
            zustand 5.1 · WebRTC (trystero 0.26) · SQLite (plugin-sql) · Rust 1.90+ ·
            Kotlin-плагин с двумя WebView.
          </p>
          <p className="hw-note">
            Независимый проект, не связан с YouTube, VK, Rutube и другими сервисами.
            MIT.
          </p>
        </section>
      </div>
    </div>
  );
}
