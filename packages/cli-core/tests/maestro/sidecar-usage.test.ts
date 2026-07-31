// F-SIDECAR-USO — testes da CONTABILIDADE DE USO dos sidecars (pedido do dono:
// "ver se headroom/ollama/mem0 estão sendo USADOS de fato", não só se estão de pé).
//
// O que estes testes travam é a DECISÃO — pura, sem rede, sem Ink (ADR-0053 §8):
//   • uso ≠ tentativa: fail-open NÃO acende o indicador;
//   • "ligado e ocioso" ≠ "fora": um projeto novo (recall vazio legítimo) não pode
//     ser confundido com sidecar caído, e vice-versa;
//   • o perfil LEVE não ganha chip nenhum (não polui quem roda magro).

import { describe, expect, it } from 'vitest';
import {
  EMPTY_SIDECAR_USAGE,
  SIDECAR_CODE,
  SIDECAR_ORDER,
  SidecarUsageMeter,
  buildSidecarChip,
  recordSidecarUse,
  sidecarChipCell,
  sidecarUsageSummary,
  sidecarUseState,
  type SidecarUsageView,
} from '../../src/agent/maestro/sidecar-usage.js';

const ALL_ON = { headroom: true, ollama: true, mem0: true } as const;

function view(over: Partial<SidecarUsageView> = {}): SidecarUsageView {
  return { profile: 'turbo', enabled: ALL_ON, usage: EMPTY_SIDECAR_USAGE, ...over };
}

describe('F-SIDECAR-USO · redutor puro', () => {
  it('parte do zero absoluto — sessão que ainda não consultou ninguém', () => {
    for (const kind of SIDECAR_ORDER) {
      expect(EMPTY_SIDECAR_USAGE[kind]).toEqual({ ok: 0, fail: 0 });
    }
  });

  it('soma `ok` no sidecar certo e NÃO toca os outros', () => {
    const after = recordSidecarUse(EMPTY_SIDECAR_USAGE, 'ollama', true);
    expect(after.ollama).toEqual({ ok: 1, fail: 0 });
    expect(after.headroom).toEqual({ ok: 0, fail: 0 });
    expect(after.mem0).toEqual({ ok: 0, fail: 0 });
  });

  it('separa USO de FALHA (o fail-open não pode virar uso)', () => {
    let u = recordSidecarUse(EMPTY_SIDECAR_USAGE, 'headroom', false);
    u = recordSidecarUse(u, 'headroom', false);
    u = recordSidecarUse(u, 'headroom', true);
    expect(u.headroom).toEqual({ ok: 1, fail: 2 });
  });

  it('é IMUTÁVEL — devolve objeto novo e não muta o anterior (cache de render)', () => {
    const antes = EMPTY_SIDECAR_USAGE;
    const depois = recordSidecarUse(antes, 'mem0', true);
    expect(depois).not.toBe(antes);
    expect(antes.mem0).toEqual({ ok: 0, fail: 0 });
  });
});

describe('F-SIDECAR-USO · os 3 estados (a decisão que a StatusBar pinta)', () => {
  it('desligado ⇒ `off`, mesmo que houvesse contagem', () => {
    expect(sidecarUseState({ ok: 9, fail: 0 }, false)).toBe('off');
  });

  it('ligado e SEM nenhuma chamada ⇒ `idle` (de pé, ocioso)', () => {
    expect(sidecarUseState({ ok: 0, fail: 0 }, true)).toBe('idle');
  });

  it('≥1 chamada aproveitada ⇒ `used`', () => {
    expect(sidecarUseState({ ok: 1, fail: 0 }, true)).toBe('used');
  });

  it('SÓ falhas ⇒ `off` — tentou e não respondeu; dizer "ocioso" seria mentira', () => {
    expect(sidecarUseState({ ok: 0, fail: 3 }, true)).toBe('off');
  });

  it('uso + falhas ⇒ `used` — o sidecar SERVIU pelo menos uma vez nesta sessão', () => {
    expect(sidecarUseState({ ok: 2, fail: 5 }, true)).toBe('used');
  });
});

describe('F-SIDECAR-USO · montagem do chip', () => {
  it('perfil LEVE ⇒ `undefined` (não polui a barra de quem roda magro)', () => {
    expect(buildSidecarChip(view({ profile: 'leve' }))).toBeUndefined();
  });

  it('perfil TURBO ⇒ os TRÊS, na ordem canônica', () => {
    const chip = buildSidecarChip(view());
    expect(chip?.map((e) => e.kind)).toEqual(['headroom', 'ollama', 'mem0']);
    expect(chip?.map((e) => e.code)).toEqual(['hdr', 'oll', 'mem']);
  });

  it('mistura os 3 estados na MESMA sessão (o caso real de dogfooding)', () => {
    const usage = {
      headroom: { ok: 12, fail: 1 }, // usado
      ollama: { ok: 0, fail: 0 }, // de pé, ocioso
      mem0: { ok: 0, fail: 4 }, // ligado, mas caído
    };
    const chip = buildSidecarChip(view({ usage }));
    expect(chip?.map((e) => e.state)).toEqual(['used', 'idle', 'off']);
  });

  it('sidecar não-ligado no fio da sessão ⇒ `off`', () => {
    const chip = buildSidecarChip(view({ enabled: { ...ALL_ON, headroom: false } }));
    expect(chip?.[0]?.state).toBe('off');
  });
});

describe('F-SIDECAR-USO · texto da célula (a11y: o dígito/✗ carrega o sentido, não a cor)', () => {
  const chip = buildSidecarChip(
    view({
      usage: {
        headroom: { ok: 12, fail: 0 },
        ollama: { ok: 0, fail: 0 },
        mem0: { ok: 0, fail: 2 },
      },
    }),
  )!;

  it('usado ⇒ código + o NÚMERO de consultas aproveitadas', () => {
    expect(sidecarChipCell(chip[0]!)).toBe('hdr·12');
  });

  it('ocioso ⇒ só o código (nada a somar)', () => {
    expect(sidecarChipCell(chip[1]!)).toBe('oll');
  });

  it('fora ⇒ código + `✗` (mesmo vocabulário do /doctor)', () => {
    expect(sidecarChipCell(chip[2]!)).toBe('mem✗');
  });

  it('ASCII (--ascii / TERM=linux) degrada o `✗` p/ `x`, sem perder o sentido', () => {
    expect(sidecarChipCell(chip[2]!, true)).toBe('memx');
    expect(sidecarChipCell(chip[0]!, true)).toBe('hdr·12'); // o número não depende de UTF-8
  });

  it('os códigos são curtos e estáveis (cabem na barra estreita)', () => {
    for (const kind of SIDECAR_ORDER) {
      expect(SIDECAR_CODE[kind]).toHaveLength(3);
    }
  });
});

describe('F-SIDECAR-USO · resumo do /doctor (forma verbosa da tela de diagnóstico)', () => {
  it('mostra uso e falhas por sidecar, e "desligado" quando não está no fio', () => {
    const linhas = sidecarUsageSummary(
      view({
        enabled: { headroom: true, ollama: true, mem0: false },
        usage: {
          headroom: { ok: 1, fail: 0 },
          ollama: { ok: 0, fail: 3 },
          mem0: { ok: 0, fail: 0 },
        },
      }),
    );
    expect(linhas[0]).toBe('headroom: 1 uso');
    expect(linhas[1]).toBe('ollama: 0 uso(s) · 3 falha(s)');
    expect(linhas[2]).toBe('mem0: desligado');
  });
});

describe('F-SIDECAR-USO · medidor de sessão (acumula + notifica)', () => {
  it('nasce zerado', () => {
    expect(new SidecarUsageMeter().snapshot()).toEqual(EMPTY_SIDECAR_USAGE);
  });

  it('acumula por sidecar e o snapshot reflete na hora', () => {
    const m = new SidecarUsageMeter();
    m.record('headroom', true);
    m.record('headroom', false);
    m.record('mem0', true);
    expect(m.snapshot().headroom).toEqual({ ok: 1, fail: 1 });
    expect(m.snapshot().mem0).toEqual({ ok: 1, fail: 0 });
    expect(m.snapshot().ollama).toEqual({ ok: 0, fail: 0 });
  });

  it('notifica o assinante a CADA registro (é o que acende o chip ao vivo)', () => {
    const m = new SidecarUsageMeter();
    const vistos: number[] = [];
    m.subscribe((u) => vistos.push(u.ollama.ok));
    m.record('ollama', true);
    m.record('ollama', true);
    expect(vistos).toEqual([1, 2]);
  });

  it('cancelar a assinatura para de notificar (sem vazar no fim da sessão)', () => {
    const m = new SidecarUsageMeter();
    let n = 0;
    const off = m.subscribe(() => n++);
    m.record('mem0', true);
    off();
    m.record('mem0', true);
    expect(n).toBe(1);
    // O acumulado SEGUE correto — cancelar a notificação não zera a contabilidade.
    expect(m.snapshot().mem0.ok).toBe(2);
  });
});
