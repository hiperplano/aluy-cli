// FLICKER-F8 (guarda ESTRUTURAL) — as três funções do orçamento de altura aceitam
// `detachedSubagents` como campo OPCIONAL. Opcional é conveniente e é justamente por isso
// que é perigoso: quem esquecer de passá-lo não vê erro de tipo, não vê teste vermelho, e
// o desconto simplesmente não acontece. O orçamento volta a ser cego ao aviso do F8 EM
// SILÊNCIO — que é exatamente como este defeito nasceu na rc.144.
//
// Não é hipótese: no mesmo dia, a migração de `boxTable` p/ `tableLines` deixou `maxWidths`
// num spread onde a opção era aceita e ignorada — a coluna parou de ser truncada sem uma
// única falha. O tipo aceitava, ninguém passava, e nada acusou.
//
// Precedente para uma guarda que LÊ O FONTE: `packages/cli-core/tests/boundary.test.ts`,
// que trava a fronteira modular do mesmo jeito. Os testes puros (`live-budget.test.ts`)
// provam que o desconto CALCULA certo; este prova que ele é CHAMADO.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const APP_CONTROLLER = readFileSync(
  fileURLToPath(new URL('../../src/session/controller.ts', import.meta.url)),
  'utf8',
);

const APP = readFileSync(
  fileURLToPath(new URL('../../src/session/App.tsx', import.meta.url)),
  'utf8',
);

/** Trecho do fonte a partir da abertura da chamada até o `});` que a fecha. */
function chamada(fn: string): string {
  const i = APP.indexOf(`${fn}({`);
  expect(i, `chamada a ${fn} não encontrada no <App>`).toBeGreaterThan(-1);
  const fim = APP.indexOf('});', i);
  return APP.slice(i, fim === -1 ? i + 1200 : fim);
}

describe('FLICKER-F8 — o <App> passa `detachedSubagents` a TODO o orçamento de altura', () => {
  for (const fn of ['speechMaxLines', 'slashMenuMaxRows', 'liveRegionMinRows']) {
    it(`${fn} recebe a contagem de sub-agentes vivos`, () => {
      expect(chamada(fn)).toContain('detachedSubagents');
    });
  }
});

// FOOTER-AGENTES — mesma guarda, mesmo motivo. A coluna de agentes muda a altura do rodapé
// e o campo é OPCIONAL: quem esquecer não vê erro de tipo nem teste vermelho, e o frame
// volta a cruzar `rows` só quando há agentes na tela — o defeito mais difícil de reproduzir
// que existe, porque some sozinho quando eles terminam.
// O campo passou de booleano a CONTAGEM quando o bloco deixou de ser uma coluna ao lado do
// painel e virou linhas inteiras acima dele: a altura passou a depender de QUANTOS agentes
// há, não só de haver algum.
describe('FOOTER-AGENTES — o <App> avisa o orçamento que o rodapé cresceu', () => {
  for (const fn of ['speechMaxLines', 'slashMenuMaxRows', 'liveRegionMinRows']) {
    it(`${fn} recebe \`agentesNoRodape\``, () => {
      expect(chamada(fn)).toContain('agentesNoRodape');
    });
  }
});

// CONSUMO AO VIVO — a guarda do FIO, não do dado.
//
// O teste de estado prova que `liveSubagents[].tokens` carrega o número. Ele NÃO prova que
// alguém alimenta o nó durante a corrida — e essa distinção já custou uma versão: o bloco
// de agentes no rodapé tinha teste de componente, passava, e nunca apareceu na tela, porque
// o que faltava era o caminho até ele.
//
// São três elos, e basta um faltar para o número voltar a pular de zero ao total no fim:
//   1. o spawner EMITE (`onChildProgress`) a cada débito do filho;
//   2. o controller ESCUTA e escreve no nó;
//   3. o controller REPUBLICA, senão a tela não vê.
describe('CONSUMO AO VIVO — os três elos do fio existem', () => {
  const SPAWNER = readFileSync(
    fileURLToPath(new URL('../../../cli-core/src/agent/subagent.ts', import.meta.url)),
    'utf8',
  );

  it('1) o spawner EMITE progresso a cada débito (dentro do `onUsage`)', () => {
    const i = SPAWNER.indexOf('onUsage:');
    expect(i, '`onUsage` sumiu do spawner').toBeGreaterThan(-1);
    const bloco = SPAWNER.slice(i, i + 600);
    expect(bloco, 'o `onUsage` não emite `onChildProgress` — o número morre no runChild').toContain(
      'onChildProgress',
    );
  });

  /**
   * O CORPO do handler, delimitado pelo handler SEGUINTE — e não por uma janela de N
   * caracteres, que foi como esta guarda nasceu e como ela quebrou: bastou o handler
   * crescer (passou a atualizar também o bloco da conversa) para a chamada de republicação
   * cair fora da janela e o teste acusar um defeito que não existia. Régua que depende do
   * tamanho do código mede o código, não o contrato.
   */
  function corpoDoHandler(): string {
    const i = APP_CONTROLLER.indexOf('onChildProgress:');
    expect(i, 'o controller não registra `onChildProgress`').toBeGreaterThan(-1);
    const fim = APP_CONTROLLER.indexOf('onChildEnd:', i);
    return APP_CONTROLLER.slice(i, fim === -1 ? i + 4000 : fim);
  }

  it('2) o controller ESCUTA e escreve no nó do filho', () => {
    expect(corpoDoHandler(), 'escuta mas não escreve no nó').toContain('setUsage');
  });

  it('3) e REPUBLICA, senão a tela não enxerga a subida', () => {
    expect(corpoDoHandler(), 'escreve no nó mas não republica — a tela fica parada').toContain(
      'publishDetachedCount',
    );
  });

  // O bloco da CONVERSA é o que a tela desenha (e o que o rodapé fixa). Atualizar só o nó
  // da árvore deixaria o número subindo onde ninguém vê.
  it('4) e atualiza o BLOCO, que é o que aparece', () => {
    expect(corpoDoHandler(), 'atualiza o nó mas não o bloco').toContain('upsertSubAgentChild');
  });
});

