// EST-0948 — render dos estados-chave da TUI (ink-testing-library).
// Cobre: header sem provider (HG-2), AskDialog com efeito EXATO + ações corretas
// (CLI-SEC-9/3), destrutivo invertido, egress (CLI-SEC-5), ToolLine ok/err,
// streaming, LoginFlow (só user_code+URL), BrokerError (neutro), a11y NO_COLOR.

import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import type { AskRequest } from '@hiperplano/aluy-cli-core';
import { ThemeProvider } from '../../src/ui/theme/context.js';
import { resolveTheme } from '../../src/ui/theme/theme.js';
import { Header, HEADER_BANNER_MIN_ROWS, HEADER_WORDMARK_3D_MIN_ROWS } from '../../src/ui/components/Header.js';
import { composeShadowedWordmark, rowSegments, SHADOW_SHADE } from '../../src/ui/components/wordmark-3d.js';
import { StatusBar } from '../../src/ui/components/StatusBar.js';
import { ToolLine } from '../../src/ui/components/ToolLine.js';
import { AskDialog } from '../../src/ui/components/AskDialog.js';
import { AluyBlock, YouBlock } from '../../src/ui/components/TurnBlock.js';
import { LoginFlow } from '../../src/ui/components/LoginFlow.js';
import { BrokerError } from '../../src/ui/components/BrokerError.js';
import { BudgetGate } from '../../src/ui/components/BudgetGate.js';
import { SlashMenu } from '../../src/ui/components/SlashMenu.js';
import { Composer } from '../../src/ui/components/Composer.js';
import { Boot } from '../../src/ui/components/Boot.js';
import { Onboarding } from '../../src/ui/components/Onboarding.js';
import {
  ProgressBar,
  progressRatio,
  progressPercent,
  renderBar,
} from '../../src/ui/components/ProgressBar.js';
import { menuEntries, filterCommands } from '../../src/slash/commands.js';

function wrap(
  node: React.ReactElement,
  env: NodeJS.ProcessEnv = { LANG: 'en_US.UTF-8', TERM: 'xterm-256color' },
) {
  const theme = resolveTheme({ env });
  return render(<ThemeProvider theme={theme}>{node}</ThemeProvider>);
}

// A suíte roda com FORCE_COLOR=3 (vitest.config.ts) p/ exercitar a SAÍDA ANSI
// real (acabamento de markdown/realce). Onde a asserção é sobre TEXTO contíguo
// que o realce/destaque pode fragmentar com cor, removemos o ANSI primeiro.
// Remove TODA sequência ANSI (CSI ESC[…letra) E qualquer ESC solto, p/ afirmar
// TEXTO contíguo independente de cor (FORCE_COLOR=3 fragmenta substrings).
const ESC = String.fromCharCode(27); // ESC: prefixo de toda sequencia ANSI
const ANSI = new RegExp(ESC + '\\[[0-9;]*[A-Za-z]', 'g');
function plain(s: string): string {
  return s.replace(ANSI, '');
}

describe('Header — tier, nunca provider (HG-2)', () => {
  // EST-0988 — terminal BAIXO (rows<18) ⇒ header COMPACTO de 1 linha (Λ + info),
  // sem banner. É o caminho que preserva as garantias do EST-0986.
  it('compacto: mostra `Aluy Cli` + tier, nunca um provider', () => {
    const { lastFrame } = wrap(<Header tier="turbo" columns={100} rows={15} />);
    const out = lastFrame() ?? '';
    // EST-0989 — o compacto inclui o NOME de produto e o tier.
    expect(out).toContain('Aluy Cli');
    expect(out).toContain('turbo');
    expect(out.toLowerCase()).not.toMatch(/openai|anthropic|gpt|gemini/);
  });

  // FIX (dono) — o indicador de backend (glifo `●` + "local"/"broker", ADR-0120) foi
  // REMOVIDO do header: ele duplicava o indicador que já mora, vivo, no rodapé
  // (<StatusBar>). O header não deve mostrar mais "broker"/"local" nem o glifo `●` em
  // NENHUM modo (compacto ou banner) — essa informação é EXCLUSIVA do footer agora.
  it('compacto: NÃO mostra mais o indicador de backend (● local/broker) — só o rodapé mostra', () => {
    const { lastFrame } = wrap(<Header tier="local · deepseek-v4-pro" columns={100} rows={15} />);
    const out = plain(lastFrame() ?? '');
    // o tier (passado pela App já sem o prefixo "local" — ver App.tsx `headerTierDisplay`)
    // segue aparecendo — só o BADGE de backend (`●`) some.
    expect(out).toContain('deepseek-v4-pro');
    expect(out).not.toContain('●');
    expect(out).not.toContain('broker');
  });

  // EST-0989 — o compacto com versão: `Λ Aluy Cli v<versão> · <tier> · ◍ broker`.
  it('compacto: com `version` mostra `v<versão>`', () => {
    const { lastFrame } = wrap(<Header tier="turbo" columns={100} rows={15} version="1.2.3" />);
    const out = plain(lastFrame() ?? '');
    expect(out).toContain('v1.2.3');
  });

  // EST-0986/0989 — no COMPACTO a MARCA Λ abre o header (splash Λ → header Λ), à
  // frente do nome de produto `Aluy Cli`.
  it('compacto: abre com a MARCA Λ em accent, ANTES de `Aluy Cli` (UTF-8)', () => {
    const { lastFrame } = wrap(<Header tier="turbo" columns={100} rows={15} />);
    const out = plain(lastFrame() ?? '');
    // Λ presente e POSICIONADO à frente do nome de produto.
    expect(out).toContain('Λ');
    expect(out.indexOf('Λ')).toBeLessThan(out.indexOf('Aluy Cli'));
    expect(out).toMatch(/Λ\s+Aluy Cli/);
    // 1 linha só — sem o wordmark grande.
    expect(out).not.toContain('██');
    // a marca é pintada por um papel (accent) — frame cru carrega ANSI da cor.
    const raw = lastFrame() ?? '';
    expect(raw).toContain('Λ');
    expect(raw).toMatch(new RegExp(String.fromCharCode(27) + '\\['));
  });

  it('compacto: fallback ASCII — a marca vira `/\\` (TERM=linux)', () => {
    const { lastFrame } = wrap(<Header tier="turbo" columns={100} rows={15} />, {
      TERM: 'linux',
    });
    const out = plain(lastFrame() ?? '');
    expect(out).toContain('/\\');
    expect(out).not.toContain('Λ');
    expect(out.indexOf('/\\')).toBeLessThan(out.indexOf('Aluy Cli'));
  });

  it('narrow (<60 col): cai no compacto — Λ + `Aluy Cli` + tier; broker e versão somem', () => {
    const { lastFrame } = wrap(<Header tier="turbo" columns={50} rows={40} version="1.2.3" />);
    const out = plain(lastFrame() ?? '');
    expect(out).toContain('Λ');
    expect(out).toContain('Aluy Cli');
    expect(out).toContain('turbo');
    expect(out).not.toContain('broker'); // narrow esconde o broker
    expect(out).not.toContain('v1.2.3'); // narrow esconde a versão (cabe na largura)
    expect(out).not.toContain('██'); // narrow NÃO come a tela com o banner
  });

  it('compacto: erro — marca Λ + `⚠` à direita convivem (sub/error intactos)', () => {
    const { lastFrame } = wrap(<Header tier="turbo" columns={100} rows={15} error sub="entrar" />);
    const out = plain(lastFrame() ?? '');
    expect(out).toContain('Λ');
    expect(out).toContain('entrar');
    expect(out).toContain('⚠');
  });
});

describe('Header — BANNER persistente do wordmark (EST-0988)', () => {
  // BANNER aparece com espaço: confortável, largo (≥60 col) e terminal alto (≥18).
  it('terminal alto+largo: WORDMARK grande █ + subtítulo `Aluy Cli · Terminal v<versão>` — SEM tier NEM backend (Variação B / FIX dono)', () => {
    const { lastFrame } = wrap(<Header tier="turbo" columns={100} rows={40} version="1.2.3" />);
    const out = plain(lastFrame() ?? '');
    // wordmark de meio-bloco (a MESMA marca da splash)
    expect(out).toContain('██');
    // subtítulo abaixo: `Aluy Cli · Terminal v<versão>`
    expect(out).toContain('Aluy Cli');
    expect(out).toContain('Terminal');
    expect(out).toContain('v1.2.3');
    // EST-0989 (Variação B) — o TIER NÃO fica no banner (o header é estático/pinado;
    // o tier vivo mora no rodapé). NÃO deve aparecer aqui.
    expect(out).not.toContain('turbo');
    // FIX (dono) — o indicador de backend (`● local`/`● broker`, ADR-0120) foi REMOVIDO
    // do banner: duplicava o que já mora, vivo, no rodapé (<StatusBar>).
    expect(out).not.toContain('broker');
    // o wordmark JÁ é a marca ⇒ o Λ compacto NÃO se repete no banner
    expect(out).not.toContain('Λ');
    // subtítulo DEPOIS do wordmark (a marca grande abre; o subtítulo fecha)
    expect(out.indexOf('██')).toBeLessThan(out.indexOf('Aluy Cli'));
    expect(out.toLowerCase()).not.toMatch(/openai|anthropic|gpt|gemini/);
  });

  // FIX (dono) — o banner passou a usar a MESMA arte 3D do splash (<ShadowedWordmark>,
  // marca âmbar + sombra âmbar), ESTÁTICA (sem shimmer). O <Boot> (splash secundário de
  // "conectando") segue com o <Wordmark> 2D PLANO — as duas telas agora DIVERGEM de
  // propósito (o 3D com sombra é exclusivo do splash principal + banner do header).
  it('banner: usa a arte 3D COM SOMBRA (<ShadowedWordmark>), NÃO o wordmark 2D plano do Boot', () => {
    const header = plain(wrap(<Header tier="turbo" columns={100} rows={40} />).lastFrame() ?? '');
    const boot = plain(wrap(<Boot tier="turbo" columns={100} />).lastFrame() ?? '');
    // a marca de sombra (▒, SHADOW_SHADE) só existe na arte 3D — prova que o banner NÃO
    // é mais o <Wordmark> 2D plano (que não tem sombra).
    expect(header).toContain(SHADOW_SHADE);
    expect(boot).not.toContain(SHADOW_SHADE);
    // por causa da sombra, a linha com `█████` do header já NÃO é mais idêntica à do
    // Boot (a sombra desloca/acrescenta caracteres ao lado) — as telas divergem agora.
    const headerLine = header.split('\n').find((l) => l.includes('█████'));
    const bootLine = boot.split('\n').find((l) => l.includes('█████'));
    expect(headerLine).toBeDefined();
    expect(bootLine).toBeDefined();
    expect(headerLine).not.toBe(bootLine);
  });

  it('banner: a grade do wordmark bate EXATAMENTE com composeShadowedWordmark(0, false) (mesma fonte do splash, estática)', () => {
    const out = plain(wrap(<Header tier="turbo" columns={100} rows={40} />).lastFrame() ?? '');
    const lines = out.split('\n');
    // a grade estática esperada (mesma função pura que o splash usa, animate=false).
    const expectedRows = composeShadowedWordmark(0, false).map((row) =>
      rowSegments(row)
        .map((seg) => seg.text)
        .join(''),
    );
    // as PRIMEIRAS linhas do banner são exatamente a grade da marca 3D (antes do subtítulo).
    // Comparação apara o whitespace À DIREITA: a grade crua tem padding de trailing spaces,
    // mas o render do Ink os remove — o conteúdo visível é idêntico (é a MESMA fonte/arte).
    const trimEnd = (s: string): string => s.replace(/\s+$/, '');
    expect(lines.slice(0, expectedRows.length).map(trimEnd)).toEqual(expectedRows.map(trimEnd));
  });

  it('banner: as cores da marca (accent) E da sombra (shadowAmber) aparecem no frame cru (truecolor)', () => {
    const TRUE_ENV = { COLORTERM: 'truecolor', LANG: 'en_US.UTF-8', TERM: 'xterm-256color' };
    const theme = resolveTheme({ env: TRUE_ENV });
    const raw = wrap(<Header tier="turbo" columns={100} rows={40} />, TRUE_ENV).lastFrame() ?? '';
    const accentColor = theme.role('accent').color;
    const shadowColor = theme.role('shadowAmber').color;
    expect(accentColor).toBeTruthy();
    expect(shadowColor).toBeTruthy();
    expect(accentColor).not.toBe(shadowColor); // sombra distintamente mais escura que a marca
    // as duas cores (marca E sombra) aparecem CRUAS no frame — prova de que as DUAS
    // camadas (não só a marca) estão presentes, ao contrário do <Wordmark> 2D plano
    // (que só emite `accent`, nunca `shadowAmber`).
    const sgrHex = (hex: string): RegExp =>
      new RegExp(
        String.fromCharCode(27) +
          `\\[[0-9;]*?38;2;${parseInt(hex.slice(1, 3), 16)};${parseInt(hex.slice(3, 5), 16)};${parseInt(hex.slice(5, 7), 16)}`,
      );
    expect(raw).toMatch(sgrHex(accentColor as string));
    expect(raw).toMatch(sgrHex(shadowColor as string));
  });

  // FIX (dono) — a arte 3D é 1 linha MAIOR que a 2D (a sombra projeta ↓→); no piso
  // exato do banner (HEADER_BANNER_MIN_ROWS) ainda NÃO sobra essa linha extra ⇒ o
  // banner aparece (não cai pro compacto) mas com o wordmark 2D PLANO, sem sombra.
  it('banner com rows NO PISO exato (sem a linha extra do 3D): ainda banner, mas SEM sombra', () => {
    expect(HEADER_WORDMARK_3D_MIN_ROWS).toBe(HEADER_BANNER_MIN_ROWS + 1);
    const out = plain(
      wrap(<Header tier="turbo" columns={100} rows={HEADER_BANNER_MIN_ROWS} />).lastFrame() ?? '',
    );
    expect(out).toContain('██'); // segue banner (não caiu pro compacto Λ)
    expect(out).not.toContain(SHADOW_SHADE); // mas sem a linha/sombra extra do 3D
  });

  it('banner com 1 linha A MAIS que o piso: já cabe o 3D com sombra', () => {
    const out = plain(
      wrap(<Header tier="turbo" columns={100} rows={HEADER_WORDMARK_3D_MIN_ROWS} />).lastFrame() ??
        '',
    );
    expect(out).toContain(SHADOW_SHADE);
  });

  it('banner: fallback ASCII — wordmark vira `#` (sem █) quando TERM=linux', () => {
    const { lastFrame } = wrap(<Header tier="turbo" columns={100} rows={40} />, {
      TERM: 'linux',
    });
    const out = plain(lastFrame() ?? '');
    expect(out).not.toContain('█'); // █ quebraria em TERM=linux
    expect(out).toContain('#'); // wordmark ASCII legível
    // FIX (dono) — a arte 3D (<ShadowedWordmark>) é Unicode-only (sem fallback ASCII
    // próprio); em TERM=linux o banner cai no <Wordmark> 2D, nunca no 3D com sombra.
    expect(out).not.toContain(SHADOW_SHADE);
    // EST-0989 — o subtítulo do banner (sem tier): `Aluy Cli · Terminal`.
    expect(out).toContain('Aluy Cli');
    expect(out).not.toContain('turbo'); // tier não fica no banner (Variação B)
    expect(out).not.toContain('broker'); // FIX (dono) — backend não fica no banner
  });

  it('banner: erro mostra `⚠` na info abaixo do wordmark', () => {
    const { lastFrame } = wrap(<Header tier="turbo" columns={100} rows={40} error sub="entrar" />);
    const out = plain(lastFrame() ?? '');
    expect(out).toContain('██');
    expect(out).toContain('entrar');
    expect(out).toContain('⚠');
  });

  it('compact (densidade): NÃO mostra o banner mesmo em terminal alto', () => {
    const theme = resolveTheme({ env: { LANG: 'en_US.UTF-8', TERM: 'xterm-256color' } });
    const dense = { ...theme, density: 'compact' as const };
    const { lastFrame } = render(
      <ThemeProvider theme={dense}>
        <Header tier="turbo" columns={100} rows={40} />
      </ThemeProvider>,
    );
    const out = plain(lastFrame() ?? '');
    expect(out).not.toContain('██'); // compact ⇒ 1 linha
    expect(out).toContain('Λ'); // e a marca Λ compacta volta
    expect(out).toContain('turbo');
  });
});

describe('StatusBar — ⛁ % por nível (CLI-SEC-8)', () => {
  it('renderiza tokens abreviados e a % da janela', () => {
    const { lastFrame } = wrap(
      <StatusBar
        branch="feat/auth"
        cwd="~/proj/aluy-app"
        tier="turbo"
        tokens={12400}
        windowPct={38}
      />,
    );
    const out = lastFrame() ?? '';
    expect(out).toContain('12.4k');
    expect(out).toContain('38%');
    expect(out).toContain('turbo');
  });

  it('EST-0948 — com budgetPct, o ◷ mostra o % do teto (cru como detalhe entre parênteses)', () => {
    const { lastFrame } = wrap(
      <StatusBar cwd="~/p" tier="flux" tokens={650_000} budgetPct={65} windowPct={20} />,
    );
    const out = lastFrame() ?? '';
    expect(out).toContain('65%'); // % do budget (display primário)
    expect(out).toContain('(650k)'); // tokens crus como detalhe secundário
  });

  it('EST-0948 — aviso ⚠ ao cruzar ~70% do teto (ANTES de pausar nos 100%)', () => {
    const warn = wrap(
      <StatusBar cwd="~/p" tier="flux" tokens={720_000} budgetPct={72} windowPct={20} />,
    );
    expect(warn.lastFrame() ?? '').toContain('⚠');

    // abaixo do limiar ⇒ sem aviso
    const calm = wrap(
      <StatusBar cwd="~/p" tier="flux" tokens={500_000} budgetPct={50} windowPct={20} />,
    );
    expect(calm.lastFrame() ?? '').not.toContain('⚠');
  });

  it('EST-0948 — sem budgetPct (sessão sem teto de tokens) ⇒ ◷ cai no número cru', () => {
    const { lastFrame } = wrap(<StatusBar cwd="~/p" tier="flux" tokens={12_400} windowPct={20} />);
    const out = lastFrame() ?? '';
    expect(out).toContain('12.4k');
    expect(out).not.toContain('⚠');
  });
});

// EST-0989 (Variação B) — o TIER promovido a 1º campo do StatusBar, rótulos
// explícitos, ordem de descarte narrow e o `◔ quota` no fim da linha primária.
describe('StatusBar — TIER 1º campo + rótulos + quota (EST-0989)', () => {
  it('o `◷ tier` é o PRIMEIRO campo da barra (antes do cwd)', () => {
    const { lastFrame } = wrap(
      <StatusBar cwd="~/proj" tier="aluy-deep" tokens={0} windowPct={10} columns={120} />,
    );
    const out = plain(lastFrame() ?? '');
    // o tier vem ANTES do cwd na linha.
    expect(out.indexOf('aluy-deep')).toBeLessThan(out.indexOf('~/proj'));
    // o glifo ◷ (clock) abre a barra, à frente do tier.
    expect(out).toMatch(/◷\s+aluy-deep/);
  });

  it('tier ≠ default ⇒ pinta em ACCENT; tier default ⇒ neutro (fg) — atualiza ao trocar /model', () => {
    // ACENDE: isDefaultTier=false ⇒ o frame cru tem o ANSI do accent (âmbar do tema).
    const acende = wrap(
      <StatusBar
        cwd="~/p"
        tier="aluy-granito"
        isDefaultTier={false}
        tokens={0}
        windowPct={10}
        columns={120}
      />,
    );
    const rawAcende = acende.lastFrame() ?? '';
    // NEUTRO: isDefaultTier=true ⇒ o tier NÃO usa o accent.
    const neutro = wrap(
      <StatusBar
        cwd="~/p"
        tier="aluy-flux"
        isDefaultTier
        tokens={0}
        windowPct={10}
        columns={120}
      />,
    );
    const rawNeutro = neutro.lastFrame() ?? '';
    // O `◷ <tier>` acende (accent — âmbar/amarelo, ansi16 `[33m`) SÓ quando ≠ default:
    // o glifo `◷` do tier vem pintado em accent (`[33m◷`). No default o `◷` é fg
    // (sem o `[33m` imediatamente antes). É o ganho central — "trocar e enxergar":
    // a re-renderização do rodapé reflete a troca de /model com COR distinta.
    expect(rawAcende).toContain('[33m◷'); // glifo do tier em accent (≠ default)
    expect(rawNeutro).not.toContain('[33m◷'); // glifo do tier em fg (default)
    expect(rawAcende).not.toBe(rawNeutro);
  });

  it('RÓTULOS textuais janela/sessão/quota presentes em largura confortável', () => {
    const { lastFrame } = wrap(
      <StatusBar
        cwd="~/p"
        tier="aluy-flux"
        isDefaultTier
        tokens={8200}
        budgetPct={30}
        windowPct={27}
        quotaPct={40}
        quotaLevel="ok"
        columns={120}
      />,
    );
    const out = plain(lastFrame() ?? '');
    expect(out).toContain('janela');
    expect(out).toContain('sessão');
    expect(out).toContain('quota');
    // ordem: janela → sessão → quota
    expect(out.indexOf('janela')).toBeLessThan(out.indexOf('sessão'));
    expect(out.indexOf('sessão')).toBeLessThan(out.indexOf('quota'));
    // o cru `(8.2k)` é detalhe do `◔ sessão`
    expect(out).toContain('(8.2k)');
    // `◔ NN% quota` no FIM da linha primária
    expect(out).toContain('40%');
  });

  it('SEM quota reportada (broker sem janela) ⇒ o `◔ quota` NÃO aparece (degrada/oculto)', () => {
    const { lastFrame } = wrap(
      <StatusBar
        cwd="~/p"
        tier="aluy-flux"
        isDefaultTier
        tokens={8200}
        budgetPct={30}
        windowPct={27}
        columns={120}
      />,
    );
    const out = plain(lastFrame() ?? '');
    expect(out).not.toContain('quota');
  });

  it('DEGRADAÇÃO narrow (<60 col): some `(8.2k)`, rótulos e cwd; o `◷ tier` e o `⚠` PERMANECEM', () => {
    const { lastFrame } = wrap(
      <StatusBar
        cwd="~/proj/longo"
        tier="aluy-granito"
        isDefaultTier={false}
        tokens={8200}
        budgetPct={30}
        windowPct={95}
        quotaPct={40}
        quotaLevel="ok"
        columns={50}
        error
      />,
    );
    const out = plain(lastFrame() ?? '');
    // NUNCA cai: o tier (1º campo) e o ⚠ de erro.
    expect(out).toContain('aluy-granito');
    expect(out).toContain('⚠');
    // descartados em narrow: rótulos, o cru e o cwd.
    expect(out).not.toContain('janela');
    expect(out).not.toContain('sessão');
    expect(out).not.toContain('(8.2k)');
    expect(out).not.toContain('~/proj/longo');
    // mas os medidores (glifo+%) seguem.
    expect(out).toContain('95%');
  });

  it('via Custom: `◷ custom · <slug>` — slug é nome de modelo, nunca credencial (HG-2)', () => {
    const { lastFrame } = wrap(
      <StatusBar
        cwd="~/p"
        tier="custom"
        isDefaultTier={false}
        model="meta-llama/llama-3.1-8b"
        tokens={0}
        windowPct={10}
        columns={120}
      />,
    );
    const out = plain(lastFrame() ?? '');
    expect(out).toMatch(/◷\s+custom/);
    expect(out).toContain('meta-llama/llama-3.1-8b');
    expect(out).not.toMatch(/api_key|vault|bearer|sk-/i);
  });
});

describe('ToolLine — sucesso e erro (§2.5/§2.6)', () => {
  it('sucesso ⇒ resultado quantificado + ✓ (com a contagem, não só cor)', () => {
    const { lastFrame } = wrap(
      <ToolLine verb="read" target="src/a.ts" result="48 linhas" status="ok" />,
    );
    const out = lastFrame() ?? '';
    expect(out).toContain('read');
    expect(out).toContain('48 linhas');
    expect(out).toContain('✓');
  });
  it('erro ⇒ ✗ + box de saída', () => {
    const { lastFrame } = wrap(
      <ToolLine
        verb="bash"
        target="npm test"
        result="2 falhas"
        status="err"
        output={'FAIL x\n2 de 14'}
      />,
    );
    const out = lastFrame() ?? '';
    expect(out).toContain('✗');
    expect(out).toContain('saída');
    expect(out).toContain('FAIL x');
  });
});

// ── AskDialog (o coração: CLI-SEC-9 efeito exato) ────────────────────────────

function diffAsk(): AskRequest {
  return {
    call: { name: 'edit_file', input: { path: 'src/auth/session.ts', content: 'x' } },
    effect: {
      kind: 'diff',
      tool: 'edit_file',
      path: 'src/auth/session.ts',
      exact: [
        '--- src/auth/session.ts',
        '-import { httpClient } from "../net/http"',
        '+import { broker } from "@hiperplano/aluy-cli-core"',
      ].join('\n'),
    },
    category: 'default',
    reason: 'edit_file = ask com diff',
    alwaysAsk: false,
  };
}

function bashNetworkAsk(): AskRequest {
  return {
    call: { name: 'run_command', input: { command: 'npm install @hiperplano/aluy-cli-core@latest' } },
    effect: { kind: 'command', tool: 'run_command', exact: '$ npm install @hiperplano/aluy-cli-core@latest' },
    category: 'always-ask:package-exec',
    reason: 'exec de pacote',
    alwaysAsk: true,
  };
}

function destructiveAsk(): AskRequest {
  return {
    call: { name: 'run_command', input: { command: 'git push --force origin feat/auth' } },
    effect: { kind: 'command', tool: 'run_command', exact: '$ git push --force origin feat/auth' },
    category: 'always-ask:destructive',
    reason: 'destrutivo: git push --force',
    alwaysAsk: true,
  };
}

describe('AskDialog — efeito EXATO + ações (CLI-SEC-9/3)', () => {
  it('edit: mostra o DIFF exato com ‹/› (direção) e oferece [s] (não é sempre-ask)', () => {
    const { lastFrame } = wrap(<AskDialog request={diffAsk()} />);
    const out = lastFrame() ?? '';
    // diff exato (CLI-SEC-9), não resumo. A DIREÇÃO vai no glifo ‹/› (a11y §3.3:
    // não só cor) — remoção `‹`, adição `›` — em vez de -/+ (não confunde c/ prosa).
    // O CONTEÚDO do diff agora ganha syntax-highlight (papéis do DS), que fragmenta
    // a linha com ANSI; removemos a cor p/ afirmar o efeito EXATO contíguo.
    const p = plain(out);
    expect(p).toContain('‹ import { httpClient } from "../net/http"');
    expect(p).toContain('› import { broker } from "@hiperplano/aluy-cli-core"');
    expect(out).toContain('[a] aprovar');
    expect(out).toContain('[s] sempre nesta sessão'); // alwaysAsk=false ⇒ oferece
    expect(out).toContain('[n] negar');
    expect(out).toContain('[e] editar');
  });

  it('bash sempre-ask: comando EXATO + SEM [s] (CLI-SEC-3)', () => {
    const { lastFrame } = wrap(<AskDialog request={bashNetworkAsk()} />);
    const out = lastFrame() ?? '';
    expect(out).toContain('$ npm install @hiperplano/aluy-cli-core@latest');
    expect(out).not.toContain('[s] sempre'); // categoria sempre-ask não oferece [s]
    expect(out).toContain('[a] aprovar');
  });

  it('destrutivo: ordem INVERTIDA (negar primeiro) + "não pode ser desfeita"', () => {
    const { lastFrame } = wrap(<AskDialog request={destructiveAsk()} />);
    const out = lastFrame() ?? '';
    expect(out).toContain('$ git push --force origin feat/auth');
    expect(out).toContain('não pode ser desfeita');
    expect(out).not.toContain('[s] sempre');
    // negar aparece ANTES de "aprovar mesmo assim"
    const idxNegar = out.indexOf('[n] negar');
    const idxAprovar = out.indexOf('[a] aprovar mesmo assim');
    expect(idxNegar).toBeGreaterThanOrEqual(0);
    expect(idxAprovar).toBeGreaterThan(idxNegar);
  });

  it('egress fora da allowlist: mostra destino EXATO + ⚠ rede (CLI-SEC-5)', () => {
    const ask: AskRequest = {
      call: { name: 'run_command', input: { command: 'curl https://evil.example.com/x' } },
      effect: {
        kind: 'network',
        tool: 'run_command',
        exact: '$ curl https://evil.example.com/x',
        target: 'https://evil.example.com/x',
      },
      category: 'always-ask:network',
      reason: 'rede: curl',
      alwaysAsk: true,
    };
    const { lastFrame } = wrap(
      <AskDialog request={ask} egressOutsideAllowlist egressTarget="https://evil.example.com/x" />,
    );
    const out = lastFrame() ?? '';
    expect(out).toContain('rede · ask · destino fora da allowlist');
    expect(out).toContain('https://evil.example.com/x');
  });

  // EST-0969 (display) — o ask de um SUB-AGENTE é ROTULADO por origem no diálogo: o
  // usuário precisa saber QUE filho pede o efeito antes de aprovar (não pode sumir).
  it('ask de sub-agente: mostra a BADGE de origem [sub-agente: <label>]', () => {
    const ask: AskRequest = {
      call: { name: 'run_command', input: { command: 'curl https://exemplo.com' } },
      effect: { kind: 'command', tool: 'run_command', exact: '$ curl https://exemplo.com' },
      category: 'always-ask:network',
      // o spawner carimba o reason com o rótulo de origem do filho (originAskResolver).
      reason: '[sub-agente: rust] rede: curl',
      alwaysAsk: true,
    };
    const out = plain(wrap(<AskDialog request={ask} />).lastFrame() ?? '');
    // a origem é VISÍVEL (o filho "rust") + o efeito exato continua intacto.
    expect(out).toMatch(/sub-agente:\s*rust/);
    expect(out).toContain('$ curl https://exemplo.com');
  });

  it('ask do PRÓPRIO pai (sem prefixo) NÃO mostra badge de sub-agente', () => {
    const out = plain(wrap(<AskDialog request={bashNetworkAsk()} />).lastFrame() ?? '');
    expect(out).not.toMatch(/sub-agente:/);
  });
});

describe('TurnBlock — streaming', () => {
  it('streaming ⇒ cursor de trabalho ● na ponta; finalizado ⇒ sem cursor', () => {
    // EST-0965 — o cursor de trabalho é o ● grosso/arredondado amarelo (frame 0 = aceso).
    const streaming = wrap(<AluyBlock text="começo pela importação" streaming={true} />);
    expect(streaming.lastFrame() ?? '').toContain('●');
    const done = wrap(<AluyBlock text="terminei" streaming={false} />);
    expect((done.lastFrame() ?? '').includes('●')).toBe(false);
  });

  it('ESCONDE o bloco cru <<<ALUY_TOOL_CALL …>>> e mantém a prosa em volta (#2)', () => {
    const raw =
      'Vou ler o arquivo agora.\n' +
      '<<<ALUY_TOOL_CALL\n{"name":"read_file","input":{"path":"a.ts"}}\nALUY_TOOL_CALL>>>';
    const { lastFrame } = wrap(<AluyBlock text={raw} streaming={false} />);
    const out = lastFrame() ?? '';
    expect(out).toContain('Vou ler o arquivo agora.'); // prosa legítima preservada
    expect(out).not.toContain('ALUY_TOOL_CALL'); // protocolo cru escondido
    expect(out).not.toContain('read_file');
  });

  it('EST-0965 — marcador PARCIAL no tail DURANTE o stream NÃO pisca cru (<<<ALUY_TOO)', () => {
    // O modelo começou a emitir o OPEN mas só chegou um prefixo no delta acumulado.
    // ANTES do fix, `<<<ALUY_TOO` vazava cru na fala enquanto o resto não chegava.
    const raw = 'Deixa eu rodar isto pra você <<<ALUY_TOO';
    const { lastFrame } = wrap(<AluyBlock text={raw} streaming={true} />);
    const out = plain(lastFrame() ?? '');
    expect(out).toContain('Deixa eu rodar isto pra você'); // prosa preservada
    expect(out).not.toContain('<<<'); // nenhum pedaço do marcador vaza
    expect(out).not.toContain('ALUY_TOO');
  });

  it('EST-0965 — `<<<` legítimo no MEIO da frase NÃO é escondido', () => {
    const raw = 'no shell use <<< para here-strings, simples assim.';
    const { lastFrame } = wrap(<AluyBlock text={raw} streaming={false} />);
    const out = plain(lastFrame() ?? '');
    expect(out).toContain('<<<'); // texto legítimo do assistente preservado
    expect(out).toContain('here-strings');
  });
});

describe('LoginFlow — só user_code + URL (CLI-SEC-2/10)', () => {
  it('mostra user_code e verification_uri, nunca token', () => {
    const { lastFrame } = wrap(
      <LoginFlow
        userCode="WDJQXKFP"
        verificationUri="https://app.aluy.dev/device"
        expiresInSeconds={594}
      />,
    );
    const out = lastFrame() ?? '';
    expect(out).toContain('W D J Q'); // código espaçado
    expect(out).toContain('https://app.aluy.dev/device');
    expect(out).toContain('expira em 09:54');
  });
});

describe('BrokerError — neutro, nunca provider (HG-2)', () => {
  it('diz broker, mostra status/backoff, nunca provider', () => {
    const { lastFrame } = wrap(
      <BrokerError
        status={503}
        message="não consegui falar com o broker da Aluy."
        attempt={2}
        maxAttempts={5}
        retryInSeconds={4}
      />,
    );
    const out = lastFrame() ?? '';
    expect(out).toContain('broker');
    expect(out).toContain('503');
    expect(out).toContain('(2/5)');
    expect(out.toLowerCase()).not.toMatch(/openai|anthropic/);
  });

  // EST-0942 — o título reflete a CAUSA classificada, não "indisponível" pra tudo.
  it('headline classificado: auth ⇒ "credencial recusada" (não "indisponível")', () => {
    const { lastFrame } = wrap(
      <BrokerError
        status={401}
        headline="credencial recusada"
        message="credencial inválida ou expirada — rode `aluy login`."
      />,
    );
    const out = lastFrame() ?? '';
    expect(out).toContain('credencial recusada');
    expect(out).toContain('aluy login');
    expect(out).not.toContain('indisponível');
  });

  it('headline classificado: 502 ⇒ "provedor do tier falhou" (≠ broker-down)', () => {
    const { lastFrame } = wrap(
      <BrokerError
        status={502}
        headline="provedor do tier falhou"
        message="o provedor deste tier falhou — tente outro tier ou mais tarde."
      />,
    );
    const out = lastFrame() ?? '';
    expect(out).toContain('provedor do tier falhou');
    expect(out).not.toContain('indisponível');
    expect(out.toLowerCase()).not.toMatch(/openai|anthropic/);
  });

  it('durante o backoff (retrying) o título é "tentando de novo" e IGNORA o headline', () => {
    const { lastFrame } = wrap(
      <BrokerError
        headline="provedor do tier falhou"
        message="..."
        retrying
        attempt={2}
        maxAttempts={3}
        retryInSeconds={4}
      />,
    );
    const out = lastFrame() ?? '';
    expect(out).toContain('tentando de novo');
    expect(out).not.toContain('provedor do tier falhou');
  });

  it('sem headline ⇒ default "broker indisponível" (compat #74 — não regride)', () => {
    const { lastFrame } = wrap(<BrokerError message="não consegui falar com o broker." />);
    expect(lastFrame() ?? '').toContain('broker indisponível');
  });
});

describe('a11y — NO_COLOR (mono): glifo+palavra carregam o significado', () => {
  it('AskDialog em NO_COLOR ainda mostra o comando exato e as palavras de ação', () => {
    const { lastFrame } = wrap(<AskDialog request={bashNetworkAsk()} />, { NO_COLOR: '1' });
    const out = lastFrame() ?? '';
    expect(out).toContain('$ npm install @hiperplano/aluy-cli-core@latest');
    expect(out).toContain('aprovar');
    expect(out).toContain('negar');
  });

  it('ToolLine em TERM=linux usa glifo ASCII (sem depender de Unicode)', () => {
    const { lastFrame } = wrap(
      <ToolLine verb="read" target="a.ts" result="3 linhas" status="ok" />,
      { TERM: 'linux' },
    );
    const out = lastFrame() ?? '';
    expect(out).toContain('[ok]'); // ✓ vira [ok]
    expect(out).toContain('3 linhas');
  });
});

describe('BudgetGate — pausa, não bloqueio (CLI-SEC-8)', () => {
  it('mostra o motivo, opções continuar/encerrar e a % da janela', () => {
    const { lastFrame } = wrap(
      <BudgetGate
        reason="teto de iterações atingido (25/25)"
        toolCalls={48}
        tokens={1_200_000}
        windowPct={38}
      />,
    );
    const out = lastFrame() ?? '';
    expect(out).toContain('teto da sessão');
    expect(out).toContain('[c] continuar');
    expect(out).toContain('[n] encerrar');
    expect(out).toContain('38%');
  });

  it('EST-0973 — oferece [k] compactar quando há contexto a compactar', () => {
    const { lastFrame } = wrap(
      <BudgetGate
        reason="teto de tool-calls atingido (50/50)"
        toolCalls={50}
        tokens={1_000}
        windowPct={80}
        canCompact
      />,
    );
    const out = lastFrame() ?? '';
    expect(out).toContain('[k] compactar');
    expect(out).toContain('[c] continuar');
  });

  it('EST-0973 — NÃO oferece compactar quando não há o que compactar', () => {
    const { lastFrame } = wrap(
      <BudgetGate reason="teto" toolCalls={0} tokens={0} windowPct={10} canCompact={false} />,
    );
    const out = lastFrame() ?? '';
    expect(out).not.toContain('[k] compactar');
  });

  it('EST-0948 — mostra o consumo em % do teto da sessão + o teto legível (não só tokens crus)', () => {
    const { lastFrame } = wrap(
      <BudgetGate
        reason="budget local de tokens atingido (260239/200000)"
        toolCalls={10}
        tokens={260_239}
        windowPct={90}
        budgetPct={130}
        maxTokens={200_000}
      />,
    );
    const out = lastFrame() ?? '';
    expect(out).toContain('130% do teto da sessão'); // % (pode passar de 100)
    expect(out).toContain('200k'); // teto em texto legível
  });
});

describe('SlashMenu — lista filtrável (CA-3)', () => {
  it('renderiza os comandos nativos com o selecionado destacado (› não-só-cor)', () => {
    const { lastFrame } = wrap(<SlashMenu commands={menuEntries()} selected={0} />);
    const out = lastFrame() ?? '';
    expect(out).toContain('/help');
    expect(out).toContain('/model');
    expect(out).toContain('›'); // prefixo do selecionado (a11y)
  });
  it('comando do usuário aparece sob a régua "seus comandos" (§2.15)', () => {
    const { lastFrame } = wrap(
      <SlashMenu
        commands={menuEntries([{ name: 'deploy', summary: 'sobe', source: 'user' }])}
        selected={0}
      />,
    );
    const out = lastFrame() ?? '';
    expect(out).toContain('seus comandos');
    expect(out).toContain('/deploy');
  });
  it('match destacado: a query realça o trecho dentro do nome', () => {
    // o destaque é de cor (âmbar) — verificamos que o nome aparece íntegro com a
    // query embutida (o realce não fragmenta o texto visível).
    const { lastFrame } = wrap(<SlashMenu commands={menuEntries()} selected={0} query="lo" />);
    const out = plain(lastFrame() ?? '');
    expect(out).toContain('/login');
    expect(out).toContain('/logout');
  });
  it('seções agrupam os nativos (conta/sessão/workspace)', () => {
    const { lastFrame } = wrap(<SlashMenu commands={menuEntries()} selected={0} />);
    const out = lastFrame() ?? '';
    expect(out).toContain('conta');
    expect(out).toContain('sessão');
    expect(out).toContain('workspace');
  });

  // EST-0974 — o menu MOSTRA os subcomandos achatados (`/mcp search`, `/mcp add`, …).
  it('EST-0974/EST-0970 — digitar `/mcp` lista os subs com summary (descoberta)', () => {
    const { lastFrame } = wrap(
      <SlashMenu commands={filterCommands('mcp')} selected={0} query="mcp" />,
    );
    const out = plain(lastFrame() ?? '');
    expect(out).toContain('/mcp search');
    expect(out).toContain('/mcp add');
    expect(out).toContain('/mcp list');
    expect(out).toContain('/mcp remove');
    // EST-0970 — o ciclo completo: desativar/reativar sem desinstalar, descobríveis.
    expect(out).toContain('/mcp disable');
    expect(out).toContain('/mcp enable');
    // o summary do sub aparece ao lado.
    expect(out).toMatch(/\/mcp search\s+busca/);
  });

  it('EST-0974 — `/mcp s` filtra só `/mcp search` (não `/mcp add`)', () => {
    const { lastFrame } = wrap(
      <SlashMenu commands={filterCommands('mcp s')} selected={0} query="mcp s" />,
    );
    const out = plain(lastFrame() ?? '');
    expect(out).toContain('/mcp search');
    expect(out).not.toContain('/mcp add');
  });

  // EST-0974 — SNAPSHOT do menu de `/mcp` provando os subs achatados sob o pai.
  it('EST-0974/EST-0970 — snapshot do menu de `/mcp` (pai + 8 subs)', () => {
    const { lastFrame } = wrap(
      <SlashMenu commands={filterCommands('mcp')} selected={0} query="mcp" />,
    );
    expect(plain(lastFrame() ?? '')).toMatchInlineSnapshot(`
      "/ para comandos · ↑↓ navega · enter executa · esc fecha
      workspace
      › /mcp               lista/gerencia servers MCP (add/remove/disable/enable · search <termo>)
          /mcp search        busca no registro oficial aberto
          /mcp add           adiciona um server local (stdio)
          /mcp list          lista os servers de todas as fontes
          /mcp remove        remove um server gerenciado pelo aluy
          /mcp disable       desativa um server sem desinstalar
          /mcp enable        reativa um server desativado
          /mcp reconnect     re-sobe + re-handshake os servers (recupera "Not connected")
          /mcp reload        re-lê o ~/.aluy/mcp.json + reconecta (aplica edições da config)"
    `);
  });
});

describe('Composer — ativo/inativo', () => {
  it('ativo + vazio ⇒ placeholder; inativo ⇒ dica', () => {
    const active = wrap(<Composer value="" active={true} />);
    expect(active.lastFrame() ?? '').toContain('digite um objetivo');
    const inactive = wrap(<Composer value="" active={false} hint="esc interromper" />);
    expect(inactive.lastFrame() ?? '').toContain('esc interromper');
  });
});

describe('Boot — splash bloco (bold): wordmark, tier real, versão, fallback', () => {
  it('mostra o wordmark de bloco █, o subtítulo, tier real, broker e a versão', () => {
    const { lastFrame } = wrap(<Boot tier="aluy-flux" version="1.4.2" columns={100} />);
    const out = lastFrame() ?? '';
    // wordmark de meio-bloco (direção "bloco bold")
    expect(out).toContain('██');
    // subtítulo + status do splch
    expect(out).toContain('Aluy Cli · agente de terminal');
    expect(out).toContain('assinatura');
    expect(out).toContain('aluy-flux'); // tier REAL, não literal "turbo"
    expect(out).toContain('broker');
    // versão vem por prop (não hardcode na tela)
    expect(out).toContain('v1.4.2');
    // onda âmbar presente (EST-0984: endurecida ～→~)
    expect(out).toContain('~');
    // HG-2: nunca o provider
    expect(out.toLowerCase()).not.toMatch(/openai|anthropic|gpt|claude|gemini/);
  });

  it('estreito (< MIN_WORDMARK_COLS) ⇒ wordmark degrada para `Λ luy` (EST-0989)', () => {
    const { lastFrame } = wrap(<Boot tier="aluy-flux" columns={20} />);
    const out = plain(lastFrame() ?? '');
    // EST-0989 — a degradação é `Λ luy` (a marca Λ + nome minúsculo), não mais `a l u y`.
    expect(out).toMatch(/Λ\s+luy/);
    expect(out).not.toContain('██'); // não tenta o wordmark grande
  });

  it('FALLBACK sem Unicode (TERM=linux): wordmark ASCII # (sem █) e onda ~', () => {
    const { lastFrame } = wrap(<Boot tier="aluy-flux" version="1.4.2" columns={100} />, {
      TERM: 'linux',
    });
    const out = lastFrame() ?? '';
    expect(out).not.toContain('█'); // █ quebraria em TERM=linux
    expect(out).not.toContain('～'); // onda Unicode também degrada
    expect(out).toContain('#'); // wordmark ASCII legível
    expect(out).toContain('~'); // onda ASCII
    expect(out).toContain('Aluy Cli · agente de terminal');
    expect(out).toContain('v1.4.2');
  });

  it('FALLBACK NO_COLOR (mono): ainda legível — nome, tier, broker e versão', () => {
    const { lastFrame } = wrap(<Boot tier="aluy-flux" version="1.4.2" columns={100} />, {
      NO_COLOR: '1',
      LANG: 'en_US.UTF-8',
      TERM: 'xterm-256color',
    });
    const out = lastFrame() ?? '';
    expect(out).toContain('Aluy Cli · agente de terminal');
    expect(out).toContain('aluy-flux');
    expect(out).toContain('broker');
    expect(out).toContain('v1.4.2');
  });
});

describe('Onboarding — saudação + sugestões (dado)', () => {
  it('com nome ⇒ saudação personalizada', () => {
    const { lastFrame } = wrap(<Onboarding name="tiago" />);
    expect(lastFrame() ?? '').toContain('bom te ver de novo, tiago.');
  });
  it('sem nome ⇒ saudação genérica', () => {
    const { lastFrame } = wrap(<Onboarding />);
    expect(lastFrame() ?? '').toContain('bom te ver por aqui.');
  });
});

describe('YouBlock — turno do usuário', () => {
  it('mostra o glifo de papel e o texto', () => {
    const { lastFrame } = wrap(<YouBlock text="troca o cliente http" />);
    const out = lastFrame() ?? '';
    expect(out).toContain('você');
    expect(out).toContain('troca o cliente http');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// EST-0973 — <ProgressBar>: feedback de progresso de ops longas (det + indet).
// ═══════════════════════════════════════════════════════════════════════════

describe('ProgressBar — helpers puros (ratio/percent/bar)', () => {
  it('progressRatio clampa e é fail-safe (max<=0 ⇒ 0; NaN ⇒ 0)', () => {
    expect(progressRatio(3, 5)).toBeCloseTo(0.6);
    expect(progressRatio(10, 5)).toBe(1); // clamp em cima
    expect(progressRatio(-1, 5)).toBe(0); // clamp embaixo
    expect(progressRatio(1, 0)).toBe(0); // div-zero ⇒ 0
    expect(progressRatio(Number.NaN, 5)).toBe(0);
  });
  it('progressPercent arredonda p/ inteiro', () => {
    expect(progressPercent(3, 5)).toBe(60);
    expect(progressPercent(1, 3)).toBe(33);
  });
  it('renderBar: largura CONSTANTE entre percentuais (anti-jitter)', () => {
    const a = renderBar(0.2, '▰', '▱', 10, true);
    const b = renderBar(0.8, '▰', '▱', 10, true);
    expect((a.filled + a.rest).length).toBe(10);
    expect((b.filled + b.rest).length).toBe(10);
  });
  it('renderBar: avanço >0% mostra ≥1 célula cheia; <100% nunca enche tudo', () => {
    const tiny = renderBar(0.01, '▰', '▱', 10, true);
    expect(tiny.filled.length).toBe(1); // não lê "0" tendo começado
    const almost = renderBar(0.99, '▰', '▱', 10, true);
    expect(almost.rest.length).toBeGreaterThanOrEqual(1); // não "completa" antes de 100%
  });
  it('renderBar ASCII (unicode=false) envelopa em colchetes [###...]', () => {
    const r = renderBar(0.6, '#', '.', 10, false);
    expect(r.filled.startsWith('[')).toBe(true);
    expect(r.rest.endsWith(']')).toBe(true);
    expect(r.filled + r.rest).toMatch(/^\[#+\.+\]$/);
  });
});

describe('ProgressBar — DETERMINADO (barra + N% + label)', () => {
  it('60% ⇒ barra com células cheias/vazias, "60%" e o label', () => {
    const { lastFrame } = wrap(
      <ProgressBar label="resumindo blocos" value={3} max={5} width={10} frame={0} />,
    );
    const out = plain(lastFrame() ?? '');
    expect(out).toContain('60%');
    expect(out).toContain('resumindo blocos');
    expect(out).toContain('▰'); // célula cheia (Unicode default)
    expect(out).toContain('▱'); // célula vazia
    // largura visual estável: 6 cheias + 4 vazias = 10 células de barra
    expect((out.match(/▰/g) ?? []).length).toBe(6);
    expect((out.match(/▱/g) ?? []).length).toBe(4);
  });
  it('NÃO mostra spinner/elapsed no modo determinado (não finge atividade)', () => {
    const { lastFrame } = wrap(<ProgressBar label="x" value={1} max={2} width={8} frame={3} />);
    const out = plain(lastFrame() ?? '');
    expect(out).toContain('50%');
    // sem braille de spinner
    expect(out).not.toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
  });
});

describe('ProgressBar — INDETERMINADO (spinner + label + elapsed, sem % falso)', () => {
  it('mostra o label, o elapsed M:SS e um frame de braille — sem porcentagem', () => {
    const { lastFrame } = wrap(
      <ProgressBar label="compactando a conversa" elapsedMs={3000} frame={0} />,
    );
    const out = plain(lastFrame() ?? '');
    expect(out).toContain('compactando a conversa');
    expect(out).toContain('0:03'); // elapsed honesto
    expect(out).not.toContain('%'); // NÃO inventa porcentagem
    expect(out).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/); // spinner braille animado
  });
  it('o frame escolhe o glifo do spinner (puro: frame % len)', () => {
    const f0 = plain(wrap(<ProgressBar label="x" frame={0} />).lastFrame() ?? '');
    const f1 = plain(wrap(<ProgressBar label="x" frame={1} />).lastFrame() ?? '');
    expect(f0).toContain('⠋');
    expect(f1).toContain('⠙');
  });
  it('reduced-motion (ALUY_NO_ANIM) ⇒ glifo ◷ estático, sem braille', () => {
    const { lastFrame } = wrap(<ProgressBar label="compactando" elapsedMs={1000} frame={5} />, {
      LANG: 'en_US.UTF-8',
      TERM: 'xterm-256color',
      ALUY_NO_ANIM: '1',
    });
    const out = plain(lastFrame() ?? '');
    expect(out).toContain('◷'); // clock estático
    expect(out).not.toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
    expect(out).toContain('compactando');
  });
});

describe('ProgressBar — DEGRADAÇÃO (NO_COLOR / safe-glyphs / ASCII)', () => {
  it('NO_COLOR (mono): SEM ANSI de cor, mas % e label ainda carregam o sentido', () => {
    const { lastFrame } = wrap(<ProgressBar label="compactando" value={3} max={5} width={10} />, {
      LANG: 'en_US.UTF-8',
      TERM: 'xterm-256color',
      NO_COLOR: '1',
    });
    const raw = lastFrame() ?? '';
    expect(raw).toContain('60%');
    expect(raw).toContain('compactando');
    // mono ⇒ a paleta MONO usa só ÊNFASE (bold `1m`/dim `2m`), NUNCA cor: nenhuma
    // sequência de cor SGR (`38;5;`/`38;2;` ou códigos 30-37/90-97). O contraste
    // cheio/vazado + o `60%` carregam o sentido sem depender de cor (a11y §6).
    expect(raw).not.toMatch(/38;[25];/); // 256/truecolor fg
    expect(raw).not.toMatch(new RegExp(String.fromCharCode(27) + '\\[(3[0-7]|9[0-7])m')); // 16-cor fg
  });
  it('safe-glyphs: barra cai p/ blocos █/░ (parallelogramas ▰/▱ podem virar tofu)', () => {
    const { lastFrame } = wrap(<ProgressBar label="x" value={3} max={5} width={10} />, {
      LANG: 'en_US.UTF-8',
      TERM: 'xterm-256color',
      ALUY_SAFE_GLYPHS: '1',
    });
    const out = plain(lastFrame() ?? '');
    expect(out).toContain('█');
    expect(out).toContain('░');
    expect(out).not.toContain('▰');
  });
  it('safe-glyphs: indeterminado usa spinner ASCII (braille pode faltar)', () => {
    const { lastFrame } = wrap(<ProgressBar label="compactando" elapsedMs={2000} frame={1} />, {
      LANG: 'en_US.UTF-8',
      TERM: 'xterm-256color',
      ALUY_SAFE_GLYPHS: '1',
    });
    const out = plain(lastFrame() ?? '');
    expect(out).not.toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
    expect(out).toMatch(/[-\\|/]/); // frames ASCII do spinner
    expect(out).toContain('0:02');
  });
  it('ASCII puro (TERM=linux): determinado vira [###...] N%', () => {
    const { lastFrame } = wrap(<ProgressBar label="compactando" value={3} max={5} width={10} />, {
      LANG: 'C',
      TERM: 'linux',
    });
    const out = plain(lastFrame() ?? '');
    expect(out).toContain('60%');
    expect(out).toMatch(/\[#+\.+\]/); // barra ASCII com colchetes
    expect(out).not.toContain('▰');
  });
});
