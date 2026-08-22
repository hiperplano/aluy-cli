// F-SIDECAR-USO (pedido do dono) — o chip de USO dos sidecars na StatusBar.
//
// O ponto: o `/doctor` já dizia se headroom/ollama/mem0 respondem a `GET /health`,
// mas "de pé" é o estado NORMAL do modo turbo — não informa nada. O que faltava é
// enxergar, no rodapé vivo, se eles estão sendo CONSULTADOS. Estes testes travam o
// render dos 3 estados, a supressão no perfil leve e a degradação narrow/ascii.
// Espelha o estilo de `status-bar-mcp.test.tsx`.

import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { ThemeProvider } from '../../src/ui/theme/context.js';
import { resolveTheme } from '../../src/ui/theme/theme.js';
import { StatusBar } from '../../src/ui/components/StatusBar.js';
import { EMPTY_SIDECAR_USAGE, type SidecarUsageView } from '@hiperplano/aluy-cli-core';

function wrap(node: React.ReactElement, env?: Record<string, string>) {
  const theme = resolveTheme({
    env: env ?? { LANG: 'en_US.UTF-8', TERM: 'xterm-256color' },
  });
  return render(<ThemeProvider theme={theme}>{node}</ThemeProvider>);
}

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(ESC + '\\[[0-9;]*[A-Za-z]', 'g');
const plain = (s: string): string => s.replace(ANSI, '');

const TODOS_LIGADOS = { headroom: true, ollama: true, mem0: true } as const;

function usoView(over: Partial<SidecarUsageView> = {}): SidecarUsageView {
  return { profile: 'turbo', enabled: TODOS_LIGADOS, usage: EMPTY_SIDECAR_USAGE, ...over };
}

function bar(props: Partial<React.ComponentProps<typeof StatusBar>> = {}) {
  return (
    <StatusBar cwd="/proj" tier="aluy-strata" tokens={0} windowPct={0} columns={120} {...props} />
  );
}

describe('StatusBar — chip de USO dos sidecars (F-SIDECAR-USO)', () => {
  it('sem `sidecarUsage` (sessão sem medidor armado) ⇒ NENHUM campo novo', () => {
    const out = plain(wrap(bar()).lastFrame() ?? '');
    expect(out).not.toContain('sidecars');
    expect(out).not.toContain('hdr');
    expect(out).toContain('aluy-strata'); // o resto da barra intacto
  });

  it('perfil LEVE ⇒ chip SUPRIMIDO (não polui quem escolheu rodar magro)', () => {
    const out = plain(wrap(bar({ sidecarUsage: usoView({ profile: 'leve' }) })).lastFrame() ?? '');
    expect(out).not.toContain('sidecars');
    expect(out).not.toContain('hdr');
    expect(out).not.toContain('oll');
  });

  it('TURBO recém-aberto (nada consultado) ⇒ os três de pé e OCIOSOS, sem número', () => {
    const out = plain(wrap(bar({ sidecarUsage: usoView() })).lastFrame() ?? '');
    expect(out).toContain('sidecars hdr oll mem');
    // Ocioso NÃO exibe contador — número na tela significa uso real.
    expect(out).not.toContain('hdr·');
  });

  it('USADO ⇒ o código ganha o NÚMERO de consultas aproveitadas', () => {
    const out = plain(
      wrap(
        bar({
          sidecarUsage: usoView({
            usage: {
              headroom: { ok: 12, fail: 0 },
              ollama: { ok: 3, fail: 1 },
              mem0: { ok: 41, fail: 0 },
            },
          }),
        }),
      ).lastFrame() ?? '',
    );
    expect(out).toContain('hdr·12');
    expect(out).toContain('oll·3');
    expect(out).toContain('mem·41');
  });

  it('DESLIGADO no fio ⇒ `−` colado ao código — distinto do `✗` de caído', () => {
    const out = plain(
      wrap(
        bar({ sidecarUsage: usoView({ enabled: { ...TODOS_LIGADOS, headroom: false } }) }),
      ).lastFrame() ?? '',
    );
    // `−`, não `✗`: este caso é "a sessão NÃO ligou o headroom", que não é defeito.
    // Os dois dividiam o `✗` e o dono não distinguia "quebrou" de "não pedi" — foi o
    // que o levou a reportar o `/doctor` e a barra "discordando" estando ambos certos.
    // O `✗` ficou reservado ao sidecar que LIGOU e CAIU (caso logo abaixo).
    expect(out).toContain('hdr−');
    expect(out).not.toContain('hdr✗');
    expect(out).toContain('oll'); // os outros seguem de pé
  });

  it('ligado mas SÓ falhando ⇒ `✗` (fail-open não é uso, e "ocioso" seria mentira)', () => {
    const out = plain(
      wrap(
        bar({
          sidecarUsage: usoView({
            usage: { ...EMPTY_SIDECAR_USAGE, mem0: { ok: 0, fail: 5 } },
          }),
        }),
      ).lastFrame() ?? '',
    );
    expect(out).toContain('mem✗');
  });

  it('os 3 estados CONVIVEM na mesma barra (o caso real do dogfooding)', () => {
    const out = plain(
      wrap(
        bar({
          sidecarUsage: usoView({
            usage: {
              headroom: { ok: 12, fail: 1 }, // usado
              ollama: { ok: 0, fail: 0 }, // de pé, ocioso
              mem0: { ok: 0, fail: 4 }, // ligado, caído
            },
          }),
        }),
      ).lastFrame() ?? '',
    );
    expect(out).toContain('hdr·12 oll mem✗');
  });

  it('NARROW (<60 col): o chip PERMANECE, só o rótulo encolhe p/ a forma `.narrow`', () => {
    const out = plain(
      wrap(
        bar({
          columns: 50,
          sidecarUsage: usoView({ usage: { ...EMPTY_SIDECAR_USAGE, ollama: { ok: 7, fail: 0 } } }),
        }),
      ).lastFrame() ?? '',
    );
    expect(out).toContain('sc '); // rótulo curto
    expect(out).not.toContain('sidecars'); // o rótulo longo caiu
    expect(out).toContain('oll·7'); // o SINAL (uso) nunca cai
    expect(out).toContain('aluy-strata'); // o tier segue, como sempre
  });

  it('ASCII (TERM=linux) — glifo vira rótulo `sc:`; desligado vira `-`', () => {
    const out = plain(
      wrap(bar({ sidecarUsage: usoView({ enabled: { ...TODOS_LIGADOS, mem0: false } }) }), {
        TERM: 'linux',
        LANG: 'C',
      }).lastFrame() ?? '',
    );
    expect(out).toContain('sc:');
    // Desligado em ASCII é `-`; o `x` ficou para o CAÍDO, espelhando ✗/− do unicode.
    expect(out).toContain('mem-');
    expect(out).not.toContain('◈');
    expect(out).not.toContain('✗');
  });

  it('não atropela os medidores — o chip entra ANTES de janela/sessão', () => {
    const out = plain(
      wrap(bar({ windowPct: 27, budgetPct: 40, sidecarUsage: usoView() })).lastFrame() ?? '',
    );
    expect(out.indexOf('sidecars')).toBeLessThan(out.indexOf('27%'));
    expect(out).toContain('27%');
    expect(out).toContain('40%');
  });
});
