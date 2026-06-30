// EST-0962 (Custom, ADR-0030 §3) — render do <StatusBar> na via Custom: mostra
// `tier · <slug>` (ex.: `custom · meta-llama/...`). HG-2: o slug é NOME de modelo
// escolhido pelo usuário, NUNCA credencial/provider de roteamento.

import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { ThemeProvider } from '../../src/ui/theme/context.js';
import { resolveTheme } from '../../src/ui/theme/theme.js';
import { StatusBar } from '../../src/ui/components/StatusBar.js';

function wrap(node: React.ReactElement) {
  const theme = resolveTheme({ env: { LANG: 'en_US.UTF-8', TERM: 'xterm-256color' } });
  return render(<ThemeProvider theme={theme}>{node}</ThemeProvider>);
}

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(ESC + '\\[[0-9;]*[A-Za-z]', 'g');
const plain = (s: string): string => s.replace(ANSI, '');

describe('StatusBar — via Custom (EST-0962)', () => {
  it('com model ⇒ mostra `tier · <slug>`', () => {
    const { lastFrame } = wrap(
      <StatusBar
        cwd="/proj"
        tier="custom"
        model="meta-llama/llama-3.1-8b-instruct"
        tokens={0}
        windowPct={0}
      />,
    );
    const out = plain(lastFrame() ?? '');
    expect(out).toContain('custom');
    expect(out).toContain('meta-llama/llama-3.1-8b-instruct');
    expect(out).toContain('·');
  });

  it('sem model (tier canônico) ⇒ NÃO mostra slug (compat — só o tier)', () => {
    const { lastFrame } = wrap(<StatusBar cwd="/proj" tier="aluy-deep" tokens={0} windowPct={0} />);
    const out = plain(lastFrame() ?? '');
    expect(out).toContain('aluy-deep');
    // sem a via Custom, não há `tier · slug` (o `·` do model não aparece p/ o tier).
    expect(out).not.toContain('custom ·');
  });

  it('HG-2: NUNCA vaza credencial/roteamento — o slug é só nome de modelo', () => {
    const { lastFrame } = wrap(
      <StatusBar
        cwd="/proj"
        tier="custom"
        model="openrouter/some-model"
        tokens={0}
        windowPct={0}
      />,
    );
    const out = plain(lastFrame() ?? '');
    expect(out).not.toMatch(/api_key|api[_-]?key|vault|base_url|bearer|sk-/i);
  });

  // EST-1015 (#24, fix overflow) — em largura APERTADA o modelo é DROPADO p/ a barra
  // não estourar+embaralhar (visto no resize p/ 60 col); o tier NUNCA cai. Em largura
  // larga, o modelo aparece. Mata a regressão de render do #378.
  it('largura apertada (60 col) ⇒ DROPA o modelo, mantém o tier', () => {
    const { lastFrame } = wrap(
      <StatusBar
        cwd="~/projects/aluy/aluy-vau"
        tier="Flui"
        model="deepseek/deepseek-v4-flash"
        tokens={24_700}
        windowPct={10}
        columns={60}
      />,
    );
    const out = plain(lastFrame() ?? '');
    expect(out).toContain('Flui'); // tier nunca cai
    expect(out).not.toContain('deepseek'); // modelo dropado (sem garble)
  });

  it('largura larga (120 col) ⇒ mostra `tier · modelo`', () => {
    const { lastFrame } = wrap(
      <StatusBar
        cwd="~/proj"
        tier="Flui"
        model="deepseek/deepseek-v4-flash"
        tokens={24_700}
        windowPct={10}
        columns={120}
      />,
    );
    const out = plain(lastFrame() ?? '');
    expect(out).toContain('Flui');
    expect(out).toContain('deepseek/deepseek-v4-flash');
    expect(out).toContain('·');
  });
});

// ADR-0126(A) — chip de FOCO 1:1 (`/subagent <nome>`): a StatusBar mostra `◎ foco: <nome>`
// pra você lembrar que fala SÓ com o sub-agente; some ao voltar (`/back`); NÃO cai no narrow.
describe('StatusBar — chip de foco /subagent (ADR-0126)', () => {
  it('com focus ⇒ mostra `◎ foco: <nome>`', () => {
    const { lastFrame } = wrap(
      <StatusBar cwd="/proj" tier="aluy-strata" tokens={0} windowPct={0} focus="revisor" />,
    );
    const out = plain(lastFrame() ?? '');
    expect(out).toContain('foco: revisor');
    expect(out).toContain('aluy-strata'); // o tier segue
  });

  it('sem focus ⇒ NÃO mostra chip (sessão principal)', () => {
    const { lastFrame } = wrap(
      <StatusBar cwd="/proj" tier="aluy-strata" tokens={0} windowPct={0} />,
    );
    expect(plain(lastFrame() ?? '')).not.toContain('foco:');
  });

  it('o chip de foco NÃO cai no narrow (estado de roteamento crítico, como o tier)', () => {
    const { lastFrame } = wrap(
      <StatusBar
        cwd="/proj"
        tier="aluy-strata"
        tokens={0}
        windowPct={0}
        focus="revisor"
        columns={50}
      />,
    );
    expect(plain(lastFrame() ?? '')).toContain('foco: revisor');
  });
});

// LOTE-2 (pedido do dono) — a StatusBar mostra `⌁ Na·Cc·Ss·Ww·Mm` (agentes·comandos·skills·
// workflows·memória carregados da `.aluy/`); omitido quando nada foi carregado.
describe('StatusBar — contadores de governança .aluy/ (LOTE-2)', () => {
  it('com contagens ⇒ mostra ⌁ Na·Cc·Ss·Ww·Mm', () => {
    const { lastFrame } = wrap(
      <StatusBar
        cwd="/proj"
        tier="aluy-strata"
        tokens={0}
        windowPct={0}
        columns={120}
        governance={{ agents: 5, commands: 3, skills: 2, workflows: 4, memory: 12 }}
      />,
    );
    const out = plain(lastFrame() ?? '');
    expect(out).toContain('⌁');
    expect(out).toContain('5a');
    expect(out).toContain('2s');
    expect(out).toContain('4w');
    expect(out).toContain('12m');
  });

  it('tudo zero ⇒ OMITE o campo (projeto sem .aluy/ ⇒ zero ruído)', () => {
    const { lastFrame } = wrap(
      <StatusBar
        cwd="/proj"
        tier="aluy-strata"
        tokens={0}
        windowPct={0}
        columns={120}
        governance={{ agents: 0, commands: 0, skills: 0, workflows: 0, memory: 0 }}
      />,
    );
    expect(plain(lastFrame() ?? '')).not.toContain('⌁');
  });
});
