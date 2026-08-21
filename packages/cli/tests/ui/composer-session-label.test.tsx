// EST-0972 (rename) — o rótulo de identificação da sessão NO COMPOSER.
//
// F-LABEL-SEM-BOLINHA (relato do dono: "quando uso o rename ficam duas bolinhas no
// composer") — a BOLINHA de identificação SAIU. `sessionDot` e o cursor do composer eram o
// MESMO glifo `●`, então uma sessão nomeada exibia `● TESTE ❯ ●texto`: dois círculos
// idênticos lado a lado significando coisas diferentes (identidade e posição do cursor).
// Em vez de inventar um terceiro glifo, quem passa a carregar a COR da sessão é o PRÓPRIO
// NOME — a informação é a mesma (o nome já estava ali, só pintado de cinza) e some a
// ambiguidade. As asserções abaixo migraram do `●` para o NOME; a intenção (identidade
// visível, antes do prompt, degradando sem cor) é a mesma.
//
// DoD (atualizado ao desenho de hoje):
//   - com rótulo ⇒ desenha `nome ❯` (nome COLORIDO + o prompt) e NENHUM ● de identidade;
//   - sem rótulo ⇒ NÃO desenha nada (composer limpo — não polui);
//   - a cor sai da paleta do DS (truecolor ⇒ SGR de cor no NOME);
//   - NO_COLOR (a11y) ⇒ degrada textual: o nome aparece, sem SGR de cor;
//   - SNAPSHOT do composer com o rótulo colorido.

import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { ThemeProvider } from '../../src/ui/theme/context.js';
import { resolveTheme } from '../../src/ui/theme/theme.js';
import { Composer } from '../../src/ui/components/Composer.js';

const ENV = { LANG: 'en_US.UTF-8', TERM: 'xterm-256color', COLORTERM: 'truecolor' };
const ESC = String.fromCharCode(27);
const ANSI = new RegExp(ESC + '\\[[0-9;]*[A-Za-z]', 'g');
const plain = (s: string): string => s.replace(ANSI, '');

function wrap(node: React.ReactElement, env: NodeJS.ProcessEnv = ENV) {
  const theme = resolveTheme({ env });
  return render(<ThemeProvider theme={theme}>{node}</ThemeProvider>);
}

describe('Composer — nome da sessão (/rename)', () => {
  // EST-0965 — o CURSOR do composer é ● (grosso) e mora DEPOIS do prompt. O prefixo
  // (o que vem ANTES do prompt) é onde morava a bolinha de IDENTIFICAÇÃO — hoje ele
  // carrega só o nome. Varrer o frame inteiro por ● confundiria cursor com identidade.
  // F-COMPOSER-CAIXA — o prompt passou de `›` para `❯` (U+276F).
  const PROMPT = '❯';

  it('COM rótulo ⇒ desenha o NOME ANTES do prompt (e NENHUMA bolinha de identidade)', () => {
    const { lastFrame } = wrap(
      <Composer value="" active={true} sessionLabel="projeto-x" sessionColor="azul" />,
    );
    const out = plain(lastFrame() ?? '');
    expect(out).toContain('projeto-x');
    // o nome vem ANTES do prompt `❯` (F-COMPOSER: o prompt passou de `›` p/ `❯`).
    expect(out.indexOf('projeto-x')).toBeLessThan(out.lastIndexOf(PROMPT));
    // F-LABEL-SEM-BOLINHA — o ÚNICO ● da linha é o CURSOR (depois do prompt); nenhum ●
    // de identidade sobra antes dele. Era esse o "ficam duas bolinhas" do dono.
    expect(out.slice(0, out.indexOf(PROMPT))).not.toContain('●');
  });

  const beforePrompt = (out: string): string => out.slice(0, out.indexOf(PROMPT));

  it('SEM rótulo ⇒ NÃO desenha ● nem nome (composer limpo)', () => {
    const { lastFrame } = wrap(<Composer value="" active={true} />);
    const out = plain(lastFrame() ?? '');
    expect(beforePrompt(out)).not.toContain('●'); // sem dot de identificação antes do `›`
  });

  it('rótulo VAZIO ⇒ não desenha (não polui)', () => {
    const { lastFrame } = wrap(<Composer value="" active={true} sessionLabel="   " />);
    const out = plain(lastFrame() ?? '');
    expect(beforePrompt(out)).not.toContain('●');
  });

  it('truecolor ⇒ o NOME carrega SGR de COR (a cor da paleta do DS)', () => {
    const { lastFrame } = wrap(
      <Composer value="" active={true} sessionLabel="proj" sessionColor="azul" />,
    );
    const raw = lastFrame() ?? '';
    // F-LABEL-SEM-BOLINHA — quem carrega a cor da sessão passou a ser o próprio NOME.
    // Por isso não basta "há alguma cor no frame" (o composer inteiro é colorido): o SGR
    // 24-bit tem de vir COLADO no nome.
    expect(raw).toMatch(new RegExp(ESC + '\\[[0-9;]*38;2;[0-9;]*m' + 'proj'));
  });

  it('NO_COLOR (a11y) ⇒ o NOME AINDA aparece, mas SEM SGR de cor', () => {
    const { lastFrame } = wrap(
      <Composer value="" active={true} sessionLabel="proj" sessionColor="azul" />,
      { NO_COLOR: '1', ...ENV },
    );
    const raw = lastFrame() ?? '';
    const out = plain(raw);
    // o NOME continua (o significado mora nele, não na cor — em mono a cor degrada p/ bold)…
    expect(out).toContain('proj');
    // …e NÃO há SGR de cor truecolor (mono não emite 38;2;…).
    expect(raw).not.toMatch(new RegExp(ESC + '\\[[0-9;]*38;2;'));
  });

  it('também aparece no MODO SHELL (`!`) — a identidade não some no atalho de shell', () => {
    const { lastFrame } = wrap(
      <Composer
        value="ls"
        active={true}
        shellMode={true}
        sessionLabel="proj"
        sessionColor="teal"
      />,
    );
    const out = plain(lastFrame() ?? '');
    // F-LABEL-SEM-BOLINHA — a identidade é o NOME (a bolinha saiu); é ele que não some.
    expect(out).toContain('proj');
    expect(out).toContain('shell');
  });

  it('SNAPSHOT — composer com o rótulo colorido (truecolor)', () => {
    const { lastFrame } = wrap(
      <Composer value="" active={true} sessionLabel="projeto-x" sessionColor="azul" />,
    );
    // snapshot do texto VISÍVEL (sem ANSI) — estabilidade do layout `nome ❯ fantasma`.
    expect(plain(lastFrame() ?? '')).toMatchSnapshot();
  });
});
