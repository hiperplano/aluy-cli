// EST-F54 — Política de CONTINUAÇÃO do regente: 9 TESTES OBRIGATÓRIOS.
//
// Cada teto = 1 teste. Sem placebo, sem `|| true`, sem mock fraco.
// PROVAS: decideContinuation (função PURA), resolveContinuationConfig,
// isAnnounceNoTool, buildContinuationNudge. TUDO determinístico e
// PORTÁVEL (ADR-0053 §8): sem Ink, sem I/O de terminal, sem rede.
//
// TETOS DUROS INEGOCIÁVEIS (anti-runaway):
//   - maxContinuations = 4 (cap)
//   - nudgeAt = 1 (a partir daqui, nudge é FORTE)
//   - giveUpAt = 3 (a partir daqui, desiste)

import { describe, expect, it } from 'vitest';
import {
  decideContinuation,
  resolveContinuationConfig,
  buildContinuationNudge,
  isAnnounceNoTool,
  hasPendingPlanWork,
  buildPlanPendingNudge,
  DEFAULT_CONTINUATION_CONFIG,
  DEFAULT_MAX_CONTINUATIONS,
  DEFAULT_NUDGE_AT,
  DEFAULT_GIVEUP_AT,
} from '../../src/agent/continuation.js';

// ─── F54+F79 (wire §4): gatilho plano-pendente (ContextGraph) ────────────
describe('hasPendingPlanWork — gatilho de continuação pelo plano (ContextGraph)', () => {
  it('plano vazio (sem caixas) ⇒ false (nada pendente)', () => {
    expect(hasPendingPlanWork([])).toBe(false);
  });

  it('TODAS as caixas closed (plano concluído) ⇒ false (não continua)', () => {
    expect(hasPendingPlanWork([{ closed: true }, { closed: true }])).toBe(false);
  });

  it('≥1 caixa NÃO-closed (pending/in_progress) ⇒ true (há trabalho pendente)', () => {
    expect(hasPendingPlanWork([{ closed: true }, { closed: false }])).toBe(true);
    expect(hasPendingPlanWork([{ closed: false }])).toBe(true);
  });

  it('PURO — não muta a entrada nem depende de estado externo', () => {
    const boxes = [{ closed: false }];
    hasPendingPlanWork(boxes);
    expect(boxes).toEqual([{ closed: false }]);
  });

  it('buildPlanPendingNudge — orienta executar/marcar-concluído/perguntar (não vazio)', () => {
    const n = buildPlanPendingNudge();
    expect(n.length).toBeGreaterThan(20);
    expect(n).toMatch(/plano/i);
    expect(n).toMatch(/update_plan/);
    expect(n).toMatch(/perguntar/);
  });
});

// ─── 1. cap-continuacoes ─────────────────────────────────────────────────

describe('decideContinuation — cap (maxContinuations)', () => {
  it('N+1 turnos final-texto-sem-tool ⇒ stop no cap', () => {
    // Usa giveUpAt=10 (alto) p/ isolar o cap
    const cfg = { maxContinuations: 4, nudgeAt: 1, giveUpAt: 10 };
    // A 4ª continuação ainda é permitida (continuationsThisTurn=3 ⇒ next=4 ≤ 4)
    const v4 = decideContinuation(
      { continuationsThisTurn: 3, signalAborted: false, askedUser: false },
      cfg,
    );
    expect(v4.action).toBe('continue');

    // A 5ª tentativa (continuationsThisTurn=4 ⇒ next=5 > 4) ⇒ stop por cap
    const v5 = decideContinuation(
      { continuationsThisTurn: 4, signalAborted: false, askedUser: false },
      cfg,
    );
    expect(v5.action).toBe('stop');
    expect(v5.reason).toContain('cap');
    expect(v5.reason).toContain('4');
    expect(v5.reason).toContain('max=4');
  });

  it('cap com max=2: 3ª tentativa para', () => {
    // giveUpAt=10 (alto) p/ isolar o cap
    const cfg = { maxContinuations: 2, nudgeAt: 1, giveUpAt: 10 };
    // 2ª ainda passa (ct=1 ⇒ next=2 ≤ 2)
    expect(
      decideContinuation({ continuationsThisTurn: 1, signalAborted: false, askedUser: false }, cfg)
        .action,
    ).toBe('continue');
    // 3ª para (ct=2 ⇒ next=3 > 2)
    expect(
      decideContinuation({ continuationsThisTurn: 2, signalAborted: false, askedUser: false }, cfg)
        .action,
    ).toBe('stop');
  });
});

// ─── 2. giveUp ──────────────────────────────────────────────────────────

describe('decideContinuation — giveUp', () => {
  it('giveUpAt=3: 4ª tentativa desiste ANTES do cap', () => {
    const cfg = { maxContinuations: 10, nudgeAt: 1, giveUpAt: 3 };
    // 3ª (continuationsThisTurn=2 ⇒ next=3 ≤ 3) ainda passa
    expect(
      decideContinuation({ continuationsThisTurn: 2, signalAborted: false, askedUser: false }, cfg)
        .action,
    ).toBe('continue');
    // 4ª (continuationsThisTurn=3 ⇒ next=4 > 3) ⇒ giveUp
    const v = decideContinuation(
      { continuationsThisTurn: 3, signalAborted: false, askedUser: false },
      cfg,
    );
    expect(v.action).toBe('stop');
    expect(v.reason).toContain('giveUp');
    expect(v.reason).toContain('giveUpAt=3');
  });

  it('giveUp prevalece sobre cap quando giveUp < max', () => {
    const cfg = { maxContinuations: 6, nudgeAt: 1, giveUpAt: 2 };
    const v = decideContinuation(
      { continuationsThisTurn: 2, signalAborted: false, askedUser: false },
      cfg,
    );
    expect(v.action).toBe('stop');
    expect(v.reason).toContain('giveUp'); // NÃO 'cap'
  });
});

// ─── 3. nudge ───────────────────────────────────────────────────────────

describe('decideContinuation — nudge', () => {
  it('nudgeAt=1: 1ª continuação já é FORTE (anúncio-sem-tool)', () => {
    const cfg = { maxContinuations: 4, nudgeAt: 1, giveUpAt: 3 };
    const v = decideContinuation(
      { continuationsThisTurn: 0, signalAborted: false, askedUser: false },
      cfg,
    );
    expect(v.action).toBe('continue');
    expect(v.reason).toBe('anúncio-sem-tool');
  });

  it('nudgeAt=2: 1ª é suave, 2ª é forte', () => {
    const cfg = { maxContinuations: 4, nudgeAt: 2, giveUpAt: 3 };
    const v1 = decideContinuation(
      { continuationsThisTurn: 0, signalAborted: false, askedUser: false },
      cfg,
    );
    expect(v1.action).toBe('continue');
    expect(v1.reason).toContain('continuação 1/4');

    const v2 = decideContinuation(
      { continuationsThisTurn: 1, signalAborted: false, askedUser: false },
      cfg,
    );
    expect(v2.action).toBe('continue');
    expect(v2.reason).toBe('anúncio-sem-tool');
  });
});

// ─── 4. signal-aborted ──────────────────────────────────────────────────

describe('decideContinuation — signal abortado', () => {
  it('ESC/Ctrl-C ⇒ stop imediato, independente do contador', () => {
    const cfg = DEFAULT_CONTINUATION_CONFIG;
    const v = decideContinuation(
      { continuationsThisTurn: 0, signalAborted: true, askedUser: false },
      cfg,
    );
    expect(v.action).toBe('stop');
    expect(v.reason).toContain('ESC/Ctrl-C');
  });

  it('signal abortado vence qualquer contador', () => {
    const cfg = DEFAULT_CONTINUATION_CONFIG;
    const v = decideContinuation(
      { continuationsThisTurn: 0, signalAborted: true, askedUser: false },
      cfg,
    );
    expect(v.action).toBe('stop');
  });
});

// ─── 5. asked-user ──────────────────────────────────────────────────────

describe('decideContinuation — perguntou ao usuário', () => {
  it('askedUser=true ⇒ stop (não insiste)', () => {
    const cfg = DEFAULT_CONTINUATION_CONFIG;
    const v = decideContinuation(
      { continuationsThisTurn: 0, signalAborted: false, askedUser: true },
      cfg,
    );
    expect(v.action).toBe('stop');
    expect(v.reason).toContain('perguntou ao usuário');
  });
});

// ─── 6. zero-state (nenhuma continuação ainda) ──────────────────────────

describe('decideContinuation — estado zero', () => {
  it('sem sinal de abort nem pergunta ⇒ continue', () => {
    const cfg = DEFAULT_CONTINUATION_CONFIG;
    const v = decideContinuation(
      { continuationsThisTurn: 0, signalAborted: false, askedUser: false },
      cfg,
    );
    expect(v.action).toBe('continue');
  });
});

// ─── 7. resolveContinuationConfig — defaults ─────────────────────────────

describe('resolveContinuationConfig — defaults', () => {
  it('default sem env: max=4, nudgeAt=1, giveUpAt=3', () => {
    const cfg = resolveContinuationConfig({});
    expect(cfg.maxContinuations).toBe(DEFAULT_MAX_CONTINUATIONS);
    expect(cfg.nudgeAt).toBe(DEFAULT_NUDGE_AT);
    expect(cfg.giveUpAt).toBe(DEFAULT_GIVEUP_AT);
  });

  it('giveUpAt NUNCA ultrapassa maxContinuations', () => {
    const cfg = resolveContinuationConfig({
      ALUY_CONT_MAX: '2',
      ALUY_CONT_GIVEUP_AT: '99',
    });
    expect(cfg.maxContinuations).toBe(2);
    expect(cfg.giveUpAt).toBe(2); // clampado ao max
  });
});

// ─── 8. resolveContinuationConfig — env overrides ────────────────────────

describe('resolveContinuationConfig — env overrides', () => {
  it('ALUY_CONT_MAX=6, ALUY_CONT_NUDGE_AT=2, ALUY_CONT_GIVEUP_AT=4', () => {
    const cfg = resolveContinuationConfig({
      ALUY_CONT_MAX: '6',
      ALUY_CONT_NUDGE_AT: '2',
      ALUY_CONT_GIVEUP_AT: '4',
    });
    expect(cfg.maxContinuations).toBe(6);
    expect(cfg.nudgeAt).toBe(2);
    expect(cfg.giveUpAt).toBe(4);
  });

  it('valores inválidos (zero, negativo, texto) ⇒ default', () => {
    const cfg = resolveContinuationConfig({
      ALUY_CONT_MAX: '0',
      ALUY_CONT_NUDGE_AT: 'abc',
      ALUY_CONT_GIVEUP_AT: '-1',
    });
    expect(cfg.maxContinuations).toBe(DEFAULT_MAX_CONTINUATIONS);
    expect(cfg.nudgeAt).toBe(DEFAULT_NUDGE_AT);
    expect(cfg.giveUpAt).toBe(DEFAULT_GIVEUP_AT);
  });

  it('piso floor: valores abaixo do piso (0, negativo) ⇒ default', () => {
    const cfg = resolveContinuationConfig({
      ALUY_CONT_NUDGE_AT: '0',
    });
    expect(cfg.nudgeAt).toBe(DEFAULT_NUDGE_AT); // piso ≥1
  });
});

// ─── 9. isAnnounceNoTool ────────────────────────────────────────────────

describe('isAnnounceNoTool — detecção de anúncio-sem-tool', () => {
  it('"vou agora: screenshot" sem tool ⇒ true', () => {
    expect(isAnnounceNoTool('vou agora: screenshot', false)).toBe(true);
  });

  it('"vou criar o arquivo" sem tool ⇒ true', () => {
    expect(isAnnounceNoTool('vou criar o arquivo config.ts', false)).toBe(true);
  });

  it('"deixa eu ver isso" sem tool ⇒ true', () => {
    expect(isAnnounceNoTool('deixa eu ver isso aqui', false)).toBe(true);
  });

  it('"farei a implementação" sem tool ⇒ true', () => {
    expect(isAnnounceNoTool('farei a implementação agora', false)).toBe(true);
  });

  it('"vamos rodar os testes" sem tool ⇒ true', () => {
    expect(isAnnounceNoTool('vamos rodar os testes unitários', false)).toBe(true);
  });

  it('"vou te mostrar o resultado" sem tool ⇒ true', () => {
    expect(isAnnounceNoTool('vou te mostrar o resultado', false)).toBe(true);
  });

  it('com tool-call (hadToolCall=true) ⇒ false', () => {
    expect(isAnnounceNoTool('vou agora: screenshot', true)).toBe(false);
  });

  it('texto sem anúncio de ação ⇒ false', () => {
    expect(isAnnounceNoTool('Arquivo criado com sucesso.', false)).toBe(false);
  });

  it('texto vazio ⇒ false', () => {
    expect(isAnnounceNoTool('', false)).toBe(false);
  });

  it('texto só com whitespace ⇒ false', () => {
    expect(isAnnounceNoTool('   \n  ', false)).toBe(false);
  });
});

// HUNT-LIMBO — esta detecção GATEIA a continuação (loop.ts: só nudge+continua quando
// true). Um falso-NEGATIVO = o LIMBO da F54 (agente PARA com trabalho pendente). Estes
// fraseados eram falsos-negativos REAIS — PT formal + o INGLÊS p/ onde o modelo escorrega.
describe('isAnnounceNoTool — fraseados antes NÃO-cobertos (anti-limbo F54)', () => {
  it.each([
    ['PT formal "deixe-me"', 'Deixe-me verificar os testes primeiro'],
    ['PT formal "permita-me"', 'Permita-me executar o comando'],
    ['EN "Let me run…"', 'Let me run the tests'],
    ['EN "I will…"', 'I will create the file'],
    ['EN "I\'ll…"', "I'll check the logs now"],
    ['EN "I’ll…" (apóstrofo curvo)', 'I’ll check the logs now'],
    ['EN "I\'m going to…"', "I'm going to execute the command"],
    ['EN "Let\'s…"', "Let's run the build"],
    ['EN "Next, I will…"', 'Next, I will look at the config'],
  ])('SINALIZA (continua, não limba): %s', (_label, text) => {
    expect(isAnnounceNoTool(text, false)).toBe(true);
  });

  // NÃO super-sinaliza: completões (incl. passado) e "let me know" (= falar com o
  // usuário, não anúncio de ação) seguem `false` ⇒ o loop PARA corretamente.
  it.each([
    ['passado "I ran…"', 'I ran the tests and they pass'],
    ['passado "I\'ve created…"', "I've created the file successfully"],
    ['"let me know" = fala com usuário', 'Let me know if you need anything else'],
    ['conclusão EN', 'Done. The answer is 42.'],
    ['conclusão PT', 'Concluí: 3 testes passaram'],
  ])('NÃO sinaliza (loop para): %s', (_label, text) => {
    expect(isAnnounceNoTool(text, false)).toBe(false);
  });
});

// ─── BÔNUS: buildContinuationNudge ──────────────────────────────────────

describe('buildContinuationNudge', () => {
  it('nudge FORTE (anúncio-sem-tool) cita tool AGORA', () => {
    const text = buildContinuationNudge('anúncio-sem-tool');
    expect(text).toContain('PARE de anunciar');
    expect(text).toContain('Emita tool AGORA');
  });

  it('nudge SUAVE (continuação normal) cita o número e pede ação', () => {
    const text = buildContinuationNudge('continuação 1/4');
    expect(text).toContain('Continue');
    expect(text).toContain('ferramentas');
    expect(text).toContain('1/4');
  });
});
