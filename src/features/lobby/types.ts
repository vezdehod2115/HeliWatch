/*
 * Настройки комнаты, которые задаются на главной (§4.8, этап 6):
 * открытая/закрытая, «стук», лимит, название и пароль — он же ключ сигналинга.
 */

import type { RoomMode } from '../../net/protocol';

export interface RoomSetup {
  mode: RoomMode;
  title: string;
  limit: number;
  /** Закрытая комната не публикуется в лобби — вход только по коду. */
  closed: boolean;
  /** Пускать новых только после подтверждения хостом. */
  knock: boolean;
  /** Пароль: ключ сигналинга и проверка при входе. */
  password: string | null;
}

export const DEFAULT_ROOM_LIMIT = 4;
