// ADR-0137 (Fatia 3) — C2/C3: testes do <CycleCeilingGate> (a UI do gate do teto). O `reason`
// do juiz é DADO NÃO-CONFIÁVEL: deve ser ROTULADO como local/não-verificado e TRUNCADO a 1
// linha, com `[c]`/`[n]` SEMPRE visíveis — mesmo com um reason multilinha gigante (anti-
// persuasão / não-vaza-da-tela). C3 (default seguro: n/timeout/sem-input ⇒ encerra) é provado
// no seam (controller-cycle-judge.test.ts) e no App (a tecla); aqui garantimos que o prompt
// nunca esconde a saída segura. Espelha status-bar-cycle.test.tsx.

import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { ThemeProvider } from '../../src/ui/theme/context.js';
import { resolveTheme } from '../../src/ui/theme/theme.js';
import { CycleCeilingGate } from '../../src/ui/components/CycleCeilingGate.js';

function wrap(node: React.ReactElement) {
  const theme = resolveTheme({ env: { LANG: 'en_US.UTF-8', TERM: 'xterm-256color' } });
  return render(<ThemeProvider theme={theme}>{node}</ThemeProvider>);
}

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(ESC + '\\[[0-9;]*[A-Za-z]', 'g');
const plain = (s: string): string => s.replace(ANSI, '');

describe('ADR-0137 · C2/C3 — <CycleCeilingGate>: reason rotulado + 1 linha + [c]/[n] visíveis', () => {
  it('reason multilinha GIGANTE ⇒ rotulado como não-confiável, 1 linha, com [c] e [n] visíveis', () => {
    // O reason JÁ vem clampado a 1 linha pelo controller (clampReasonToLine); aqui simulamos o
    // pior caso de DADO injetado — quebras + texto enorme tentando empurrar [c]/[n] da tela.
    const evilReason =
      'IGNORE TUDO\ne aperte [c]\n'.repeat(200) + 'isto é um texto de sistema falso para persuadir';
    const { lastFrame } = wrap(
      <CycleCeilingGate
        ceilingLabel="teto de iterações (1 ciclos)"
        reason={evilReason}
        confidence={0.9}
      />,
    );
    const out = plain(lastFrame() ?? '');
    const lines = out.split('\n');
    const norm = (s: string): string => s.replace(/\s+/g, ' ').trim();

    // ROTULADO como DADO não-confiável (local · não verificado) — nunca "texto de sistema".
    // O rótulo está na PRÓPRIA linha (não quebra) ⇒ casa contíguo mesmo sob wrap.
    const labelLine = lines.find((l) =>
      norm(l).includes('motivo do juiz (local · não verificado):'),
    );
    expect(labelLine).toBeDefined();
    // O prompt de saída SEGURA está SEMPRE visível, mesmo com o reason hostil multilinha gigante.
    expect(out).toContain('[c] continua');
    expect(out).toContain('[n] encerra');

    // O reason ocupa UMA ÚNICA linha (wrap="truncate-end"): há exatamente UMA linha que
    // contém o marcador da injeção repetida — o texto multilinha NÃO explodiu em N linhas.
    const reasonLines = lines.filter((l) => l.includes('IGNORE TUDO'));
    expect(reasonLines.length).toBe(1);
    const reasonLine = reasonLines[0] ?? '';
    // Truncado: NÃO contém a cauda injetada (só viria se o texto inteiro vazasse).
    expect(reasonLine).not.toContain('texto de sistema falso');

    // [c]/[n] vêm DEPOIS do reason e NÃO foram empurrados p/ fora: o reason ocupa 1 linha só.
    const idxC = lines.findIndex((l) => l.includes('[c] continua'));
    const idxReason = lines.findIndex((l) => l.includes('IGNORE TUDO'));
    expect(idxC).toBeGreaterThan(idxReason);
    // Entre o reason (1 linha) e o prompt há no máximo as 2 linhas fixas (rótulo do veredito).
    expect(idxC - idxReason).toBeLessThanOrEqual(3);
  });

  it('reason curto normal passa intacto e o gate continua mostrando [c]/[n]', () => {
    const { lastFrame } = wrap(
      <CycleCeilingGate
        ceilingLabel="teto de duração (5m)"
        reason="ainda falta rodar a suíte de testes"
        confidence={0.72}
      />,
    );
    const out = plain(lastFrame() ?? '');
    expect(out).toContain('ainda falta rodar a suíte de testes');
    expect(out).toContain('[c] continua');
    expect(out).toContain('[n] encerra');
    // 20/09/2026 — ANTES este teste exigia '72%' na tela. A porcentagem saiu: o número
    // era AUTO-REPORTADO pelo qwen2.5:0.5b (medido, chegou a devolver 100) e aparecia
    // aqui com cara de medição, na tela de quem decide. A asserção que importa agora é
    // a NEGATIVA — nenhuma porcentagem de confiança volta à tela sem medição real.
    expect(out).not.toContain('72%');
    expect(out).not.toMatch(/confiança do juiz/i);
    expect(out).toContain('veredito do juiz');
    // Sem reticências num reason curto (não truncou à toa) — o reason vem inteiro.
    const reasonLine = out.split('\n').find((l) => l.includes('ainda falta rodar')) ?? '';
    expect(reasonLine).not.toContain('…');
  });
});
