// EST-0970 (fix OOM) — INTEGRAÇÃO: buildSession fia o TETO de caracteres da
// observação do web_fetch (anti-OOM) do env (`ALUY_WEB_FETCH_MAX_CHARS`) até a
// POLICY da WebPort que as tools usam. É a 1ª camada do anti-OOM (a observação que
// entra no contexto do modelo); a 2ª (o teto de BYTES da LEITURA) vive na web-port.
//
// Prova end-to-end leve (sem rede): inspeciona `session.ports.web.policy` resultante.
//   - SEM env ⇒ o DEFAULT (DEFAULT_MAX_OBSERVATION_CHARS) é fiado na policy.
//   - ALUY_WEB_FETCH_MAX_CHARS=20000 ⇒ 20000 na policy.
//   - valor absurdo (typo) ⇒ CLAMPADO no teto-teto (anti-OOM duro: config errada
//     NÃO desliga o teto).
//   - sob --yolo, o teto CONVIVE com allowInternalHosts (não some).

import { describe, expect, it } from 'vitest';
import { DEFAULT_MAX_OBSERVATION_CHARS, MAX_OBSERVATION_CHARS_CEILING } from '@aluy/cli-core';
import { buildSession } from '../../src/session/wiring.js';

describe('EST-0970 — teto da observação do web_fetch fiado de buildSession à WebPort', () => {
  it('SEM env ⇒ a policy leva o DEFAULT (capa por padrão — anti-OOM)', () => {
    const s = buildSession({ env: {} });
    expect(s.ports.web?.policy?.maxObservationChars).toBe(DEFAULT_MAX_OBSERVATION_CHARS);
  });

  it('ALUY_WEB_FETCH_MAX_CHARS=20000 ⇒ 20000 na policy', () => {
    const s = buildSession({ env: { ALUY_WEB_FETCH_MAX_CHARS: '20000' } });
    expect(s.ports.web?.policy?.maxObservationChars).toBe(20_000);
  });

  it('valor absurdo (typo) ⇒ CLAMPADO no teto-teto (config errada NÃO vira blob ilimitado)', () => {
    const s = buildSession({ env: { ALUY_WEB_FETCH_MAX_CHARS: '999999999' } });
    expect(s.ports.web?.policy?.maxObservationChars).toBe(MAX_OBSERVATION_CHARS_CEILING);
  });

  it('valor inválido ⇒ DEFAULT (não quebra a sessão)', () => {
    const s = buildSession({ env: { ALUY_WEB_FETCH_MAX_CHARS: 'lixo' } });
    expect(s.ports.web?.policy?.maxObservationChars).toBe(DEFAULT_MAX_OBSERVATION_CHARS);
  });

  it('sob --yolo o teto CONVIVE com allowInternalHosts (anti-OOM não some no YOLO)', () => {
    const s = buildSession({ env: {}, mode: 'unsafe' });
    expect(s.ports.web?.policy?.maxObservationChars).toBe(DEFAULT_MAX_OBSERVATION_CHARS);
    expect(s.ports.web?.policy?.allowInternalHosts).toBe(true);
  });
});
