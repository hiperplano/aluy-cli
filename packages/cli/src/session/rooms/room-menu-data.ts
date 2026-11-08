// Leitor das salas para o seletor de `/rooms` (`menuData.rooms`). Só LEITURA do `RoomStore` da
// sessão — a MESMA fonte do `/rooms list`; o efeito de escolher uma sala continua sendo o do
// comando digitado (`/rooms read <código>` / `/rooms watch <código>`).

import type { RoomStore } from '@hiperplano/aluy-cli-core';
import type { MenuDatum } from '../../slash/menu-pickers.js';
import { participantsOf, relTime } from './room-render.js';

export function roomsMenuData(
  store: RoomStore,
  clock: () => number = Date.now,
): () => Promise<readonly MenuDatum[]> {
  return async () => {
    const now = clock();
    const rooms = (await store.list()).filter((r) => !r.revoked);
    return rooms.map((r) => {
      const n = r.messages.length;
      const last = n > 0 ? r.messages[n - 1]!.ts : undefined;
      const who = participantsOf(r);
      return {
        id: r.code,
        label: r.code,
        hint: `${n} msg · ${
          last !== undefined ? `há ${relTime(now - last)}` : 'sem atividade'
        }${who.length > 0 ? ` · ${who.join(', ')}` : ''}`,
      };
    });
  };
}
