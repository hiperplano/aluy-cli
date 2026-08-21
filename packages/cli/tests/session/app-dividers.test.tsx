// EST-0985 / EST-0987 — as divisórias de CHROME na <App> + a divisória SUTIL por
// turno. Prova de wiring (o que o teste de componente do Divider não cobre):
//   EST-0985: a App SEPARA o input do corpo e respeita a DENSIDADE.
//   EST-0987 (1/3): separação ACIMA do header ⇒ o header também fica emoldurado.
//   EST-0985 (polish): a separação ACIMA do input é INCONDICIONAL — o composer fica
//     emoldurado SEMPRE (sessão fresca/pós-`/clear` inclusive). NÃO colapsa por falta
//     de turnos. Densidade segue respeitada: `compact` omite SÓ o chrome do header,
//     nunca o que emoldura o composer.
//   EST-0987 (3/3): respiro ENTRE turnos concluídos, no `<Static>` — nunca após o vivo.
//
// ─────────────────────────────────────────────────────────────────────────────────
// O QUE MUDOU NO DESENHO (reforma de UI pedida pelo dono) — e por que as asserções
// deste arquivo trocaram de forma sem trocar de INTENÇÃO:
//
//   • F-SEM-REGUA (decisão do dono, olhando o opencode lado a lado: "as linhas no CLI
//     deixam uma cara muito ruim… em vez de linhas separando as seções, alguma outra
//     coisa") — a RÉGUA saiu. O `<Divider>` NÃO DESENHA MAIS NADA: devolve uma linha
//     VAZIA. A ALTURA é preservada de propósito — o cockpit soma a altura de cada
//     região para fechar o grid sem tremer (ADR-0076 §5), e devolver zero linha faria
//     o layout refluir e traria de volta o jitter que aquele desenho existe p/ matar.
//     Logo: onde o teste contava RÉGUAS, hoje ele conta SLOTS RESERVADOS (linha vazia)
//     e exige ZERO tinta. Contar "4 réguas" viraria contar um desenho que o dono mandou
//     tirar; contar o slot preserva exatamente o que a régua provava (a separação e o
//     orçamento de linhas).
//   • F-COMPOSER-CAIXA ("não sei se daria para deixar o composer com cara de uma caixa
//     de texto") — as DUAS réguas que cercavam o input viraram a MOLDURA do
//     `<ComposerBox>`: a barra `┃` (borderLeft do Ink) que abre a linha do input. É ela
//     que hoje prova "o composer está emoldurado", inclusive em sessão fresca.
//   • O traço CURTO entre turnos também saiu: "a separação de turno já é dada pelo
//     próprio rótulo (`▌ você` / `Λluy`) e pelo espaço". O respiro continua reservado —
//     é o que este arquivo passa a medir.

import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import {
  PolicyPermissionEngine,
  type ModelCaller,
  type ModelCallResult,
  type ToolPorts,
  type FileSystemPort,
  type ShellPort,
  type SearchPort,
} from '@hiperplano/aluy-cli-core';
import { ThemeProvider } from '../../src/ui/theme/context.js';
import { resolveTheme, type Density } from '../../src/ui/theme/theme.js';
import { App } from '../../src/session/App.js';
import { Divider } from '../../src/ui/components/Divider.js';
import { SessionController } from '../../src/session/controller.js';
import { TuiAskResolver } from '../../src/ask/ask-resolver.js';
import type { StreamSink } from '../../src/session/streaming-caller.js';

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(ESC + '\\[[0-9;]*[A-Za-z]', 'g');
const plain = (s: string): string => s.replace(ANSI, '');

function fakePorts(): ToolPorts {
  const fs: FileSystemPort = {
    async readFile() {
      return '';
    },
    async writeFile() {},
    async exists() {
      return false;
    },
  };
  const shell: ShellPort = {
    async exec() {
      return { stdout: '', stderr: '', exitCode: 0 };
    },
  };
  const search: SearchPort = {
    async search() {
      return [];
    },
  };
  return { fs, shell, search };
}

function inertCaller(): ModelCaller {
  return {
    async call(): Promise<ModelCallResult> {
      return { request_id: 'r', content: '', finish_reason: 'stop' };
    },
  };
}

/** Caller que faz STREAM do texto e fecha o turno (p/ semear turnos concluídos). */
function scriptedCaller(text: string, getSink: () => StreamSink): ModelCaller {
  return {
    async call(): Promise<ModelCallResult> {
      const sink = getSink();
      sink.onStart?.();
      for (const ch of text) sink.onDelta(ch);
      sink.onDone?.();
      return { request_id: 'r', content: text, finish_reason: 'stop' };
    },
  };
}

function buildController(model?: ModelCaller): SessionController {
  return new SessionController({
    model: model ?? inertCaller(),
    permission: new PolicyPermissionEngine(),
    ports: fakePorts(),
    askResolver: new TuiAskResolver(),
    meta: { cwd: '/proj', tier: 'aluy-flux', tokens: 0, windowPct: 0 },
    flush: { intervalMs: 0 },
  });
}

function buildStreamingController(text: string): SessionController {
  let ctrl: SessionController | null = null;
  const model = scriptedCaller(text, () => ctrl!.sink);
  ctrl = buildController(model);
  return ctrl;
}

const ENV = { LANG: 'en_US.UTF-8', TERM: 'xterm-256color' };

/** Microtasks p/ o React/Ink FLUSHAR o re-render. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
}

async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('waitFor: condição não assentou no prazo');
    await new Promise((r) => setTimeout(r, 0));
  }
}

/** Linhas do frame, em texto puro. */
function rows(frame: string): string[] {
  return plain(frame).split('\n');
}

/** RÉGUAS de largura total — o desenho ANTIGO do chrome (`━`/`─`/`-` de ponta a ponta).
 * F-SEM-REGUA: hoje isto tem de ser ZERO em qualquer frame. */
function chromeRules(frame: string): string[] {
  return rows(frame).filter((ln) => /^[━─-]{20,}$/.test(ln.trim()));
}

/** Traço CURTO — o desenho ANTIGO do respiro entre turnos. Também saiu. */
function subtleRules(frame: string): string[] {
  return rows(frame).filter((ln) => /^[━─-]{4,16}$/.test(ln.trim()));
}

/** A MOLDURA do composer HOJE: a barra `┃` do `<ComposerBox>` abrindo a linha do input
 * (o prompt é `❯` em unicode, `>` em ASCII). É o que substituiu as duas réguas. */
function composerFramed(frame: string): boolean {
  return rows(frame).some((ln) => /^[┃|]\s*[❯>]/.test(ln));
}

/** Índice da 1ª linha do bloco do HEADER (wordmark grande OU a linha compacta). */
function headerStart(frame: string): number {
  return rows(frame).findIndex((ln) => /██|##|Λluy Cli|Aluy Cli/.test(ln));
}

/** Quantas linhas VAZIAS contíguas existem imediatamente ACIMA de `i`. */
function blankRunAbove(rs: readonly string[], i: number): number {
  let n = 0;
  while (i - 1 - n >= 0 && rs[i - 1 - n]!.trim() === '') n += 1;
  return n;
}

async function renderEmptyApp(density: Density) {
  const controller = buildController();
  const theme = resolveTheme({ env: ENV, density });
  const r = render(
    <ThemeProvider theme={theme}>
      <App controller={controller} animate={false} bootMs={0} />
    </ThemeProvider>,
  );
  controller.dismissBoot();
  await flush();
  return { ...r, controller };
}

describe('App — chrome: emoldura header + input, respeita densidade (EST-0985/0987)', () => {
  it('comfortable VAZIO: NENHUMA régua desenhada — e o composer segue EMOLDURADO', async () => {
    // EST-0985 (polish): a separação ACIMA do input é INCONDICIONAL ⇒ o composer fica
    // emoldurado mesmo sem turnos. O que mudou é COMO: as duas réguas viraram a barra
    // `┃` do <ComposerBox> (F-COMPOSER-CAIXA), e o chrome deixou de riscar a tela.
    const { lastFrame } = await renderEmptyApp('comfortable');
    const f = lastFrame() ?? '';
    expect(chromeRules(f)).toHaveLength(0);
    expect(composerFramed(f)).toBe(true);
  });

  it('compact VAZIO: a densidade tira o chrome do HEADER, nunca a moldura do input', async () => {
    // compact: sem o chrome do header (gate de densidade) — em comfortable há um SLOT
    // reservado ANTES do wordmark; em compact o header abre o frame. A moldura do
    // composer fica SEMPRE: densidade não desmoldura o input.
    const conf = (await renderEmptyApp('comfortable')).lastFrame() ?? '';
    const comp = (await renderEmptyApp('compact')).lastFrame() ?? '';
    expect(headerStart(conf)).toBe(1); // 1 linha reservada acima (o divisor de cima)
    expect(rows(conf)[0]).toBe(''); // …e ela é VAZIA, não uma régua
    expect(headerStart(comp)).toBe(0); // compact: nada reservado acima
    expect(composerFramed(comp)).toBe(true);
    expect(chromeRules(comp)).toHaveLength(0);
  });

  it('o divisor MANTÉM A ALTURA sem desenhar: 1 linha vazia, zero tinta (anti-jitter)', async () => {
    // A intenção antiga ("as réguas têm a MESMA largura, sem jitter de largura") virou
    // esta: o divisor não tem mais largura NENHUMA — mas continua ocupando EXATAMENTE
    // uma linha, porque o cockpit soma a altura de cada região p/ fechar o grid sem
    // tremer (ADR-0076 §5). Devolver zero linha faria o layout refluir.
    const theme = resolveTheme({ env: ENV, density: 'comfortable' });
    const { lastFrame } = render(
      <ThemeProvider theme={theme}>
        <Divider columns={80} />
      </ThemeProvider>,
    );
    const linhas = (lastFrame() ?? '').split('\n');
    expect(linhas).toHaveLength(1); // altura preservada
    expect(plain(linhas[0]!).trim()).toBe(''); // e sem tinta
  });

  it('o header é separado do topo por um SLOT reservado — não por uma régua', async () => {
    // EST-0987 (1/3): o divisor de cima + o de baixo emolduram o header. A prova segue
    // pela ORDEM (algo separa o topo do header), só que hoje o que aparece ali é uma
    // linha VAZIA reservada, não um traço de ponta a ponta.
    const f = (await renderEmptyApp('comfortable')).lastFrame() ?? '';
    const rs = rows(f);
    const marca = rs.findIndex((ln) => /Λluy Cli|Aluy Cli/.test(ln));
    expect(marca).toBeGreaterThan(-1);
    expect(rs[0]).toBe(''); // slot ACIMA do header
    expect(rs[marca + 1]).toBe(''); // slot SOB o header
    expect(chromeRules(f)).toHaveLength(0); // e nenhuma régua em lugar nenhum
  });
});

describe('App — a moldura do composer é ESTÁVEL: vazio e com turnos são IGUAIS (EST-0985)', () => {
  it('VAZIO e COM turnos ⇒ a MESMA moldura, e nenhuma régua (a moldura não pisca)', async () => {
    const controller = buildStreamingController('respondido.');
    const theme = resolveTheme({ env: ENV, density: 'comfortable' });
    const { lastFrame } = render(
      <ThemeProvider theme={theme}>
        <App controller={controller} animate={false} bootMs={0} />
      </ThemeProvider>,
    );
    controller.dismissBoot();
    await flush();
    // EST-0985 (polish): a moldura do input NÃO some em sessão fresca. Hoje ela é a
    // barra `┃` do <ComposerBox> (F-COMPOSER-CAIXA), não mais duas réguas.
    expect(composerFramed(lastFrame() ?? '')).toBe(true);
    expect(chromeRules(lastFrame() ?? '')).toHaveLength(0);

    await controller.submit('oi');
    await waitFor(() => controller.current.phase === 'done');
    await flush();

    // A moldura é ESTÁVEL: submeter o 1º turno NÃO faz a moldura do input "aparecer"
    // (ela já estava lá) nem some. Mesmo estado ⇒ sem salto/pisca na transição.
    expect(composerFramed(lastFrame() ?? '')).toBe(true);
    expect(chromeRules(lastFrame() ?? '')).toHaveLength(0);
  });
});

describe('App — divisória SUTIL entre turnos concluídos (EST-0987 3/3)', () => {
  it('2 turnos concluídos ⇒ 1 RESPIRO reservado entre eles (espaço, não um traço)', async () => {
    const controller = buildStreamingController('ok.');
    const theme = resolveTheme({ env: ENV, density: 'comfortable' });
    const { lastFrame } = render(
      <ThemeProvider theme={theme}>
        <App controller={controller} animate={false} bootMs={0} />
      </ThemeProvider>,
    );
    controller.dismissBoot();
    await flush();

    await controller.submit('primeiro');
    await waitFor(() => controller.current.phase === 'done');
    await controller.submit('segundo');
    await waitFor(() => controller.current.phase === 'done');
    await flush();

    // 2 turnos (2 `you` + 2 `aluy`) concluídos ⇒ há UM respiro EXTRA antes do 2º turno,
    // que o 1º não tem. Antes esse respiro era um traço CURTO; o dono tirou ("um traço
    // solto no meio da conversa é ruído com aparência de conteúdo") e ele virou ESPAÇO —
    // a linha que o divisor continua reservando. A intenção é a mesma: os turnos ficam
    // separados, sem que a separação compita com o conteúdo.
    const f = lastFrame() ?? '';
    const rs = rows(f);
    const yous = rs.map((ln, i) => (/^▌ você$/.test(ln.trimEnd()) ? i : -1)).filter((i) => i >= 0);
    expect(yous).toHaveLength(2);
    expect(blankRunAbove(rs, yous[1]!)).toBeGreaterThan(blankRunAbove(rs, yous[0]!));
    // …e o respiro NÃO é um traço: nem curto, nem régua cheia.
    expect(subtleRules(f)).toHaveLength(0);
    expect(chromeRules(f)).toHaveLength(0);
  });

  it('NÃO há divisória sutil quando há só 1 turno (nada a separar)', async () => {
    const controller = buildStreamingController('resposta.');
    const theme = resolveTheme({ env: ENV, density: 'comfortable' });
    const { lastFrame } = render(
      <ThemeProvider theme={theme}>
        <App controller={controller} animate={false} bootMs={0} />
      </ThemeProvider>,
    );
    controller.dismissBoot();
    await flush();
    await controller.submit('único');
    await waitFor(() => controller.current.phase === 'done');
    await flush();
    // Nada a separar ⇒ o respiro ENTRE turnos não é montado (e nunca houve traço).
    const rs = rows(lastFrame() ?? '');
    const yous = rs.map((ln, i) => (/^▌ você$/.test(ln.trimEnd()) ? i : -1)).filter((i) => i >= 0);
    expect(yous).toHaveLength(1);
    expect(subtleRules(lastFrame() ?? '')).toHaveLength(0);
  });
});
