// GUARDA — nada pode escrever no stderr enquanto a TUI é dona da tela.
//
// Relato do dono (08/09): "aparece no início e depois some uma linha em branco dizendo a
// quantidade de sidecars prontos... não entendi". Não havia o que entender: o
// `boot-trigger` fazia `process.stderr.write('aluy: boot-supervisor — 3/3 sidecar(s)
// prontos')` com o Ink no ar. O write cai DENTRO do frame, pinta uma linha solta, e o
// repaint seguinte a apaga. Eu peguei a linha em flagrante redirecionando o stderr de uma
// sessão real de tmux para arquivo — ela estava lá, sozinha.
//
// O comentário do código dizia "log discreto ... sem poluir a TUI", que era exatamente o
// contrário do que acontecia. Comentário não é guarda; esta é.
//
// Por que ler o FONTE em vez de exercitar: fazer `total > 0` exige subir sidecars de
// verdade (headroom/ollama/mem0). O que precisa ficar travado é barato e estrutural — que
// o write esteja atrás de uma checagem de TTY —, e some sem quebrar nada se alguém o tirar.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const FONTE = readFileSync(new URL('../../src/maestro/boot-trigger.ts', import.meta.url), 'utf8');

/**
 * As linhas de CÓDIGO que escrevem no stderr, 1-based para o erro nomear o lugar.
 *
 * Descarta comentário. Sem isso a varredura casa a PRÓPRIA prosa que explica a regra — foi
 * o que aconteceu na primeira versão desta guarda: o docblock do `tuiDonaDaTela` cita a
 * chamada, e o teste acusou o comentário como violação. Contagem de texto precisa separar
 * código de prosa antes de virar alarme.
 */
function linhasDeStderr(): { n: number; linha: string }[] {
  return FONTE.split('\n')
    .map((linha, i) => ({ n: i + 1, linha }))
    .filter(({ linha }) => {
      const t = linha.trim();
      if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return false;
      return linha.includes('process.stderr.write');
    });
}

describe('boot-trigger não disputa a tela com a TUI', () => {
  it('o arquivo foi lido e AINDA escreve no stderr — senão a guarda passaria por vacuidade', () => {
    // Varredura que não acha nada passa verde sem provar nada. Se um dia o write sumir de
    // vez, este caso cai e obriga quem mexeu a reavaliar a guarda inteira.
    expect(FONTE.length).toBeGreaterThan(500);
    // São TRÊS (o log dos sidecars + os dois "erro inesperado"). A primeira versão do
    // conserto guardou UM e eu dei por pronto; foi esta varredura que achou os outros dois.
    expect(linhasDeStderr().length).toBe(3);
  });

  it('TODA escrita no stderr está atrás de uma checagem de TTY', () => {
    const fora = linhasDeStderr().filter(({ n }) => {
      // Olha o bloco ACIMA do write — e só o CÓDIGO dele. Com os comentários dentro, a
      // mutação que APAGA o `if` sobrevive: o comentário logo acima ainda cita
      // `tuiDonaDaTela`, e a guarda passa verde com o defeito de volta. Foi medido.
      //
      // A janela é CURTA (3 linhas de código) de propósito. Com 16, a guarda do write
      // ANTERIOR entrava no campo de visão do seguinte e a mutação sobrevivia de novo —
      // medido. Na prática o `if` fica sempre na linha imediatamente acima.
      const acima = FONTE.split('\n')
        .slice(0, n - 1)
        .map((l) => l.trim())
        .filter((l) => l !== '' && !(l.startsWith('//') || l.startsWith('*') || l.startsWith('/*')))
        .slice(-3)
        .join('\n');
      return !acima.includes('tuiDonaDaTela');
    });
    expect(
      fora.map(({ n, linha }) => `boot-trigger.ts:${String(n)}: ${linha.trim()}`),
      'com o Ink no ar, um write no stderr vira linha fantasma que some no repaint',
    ).toEqual([]);
  });

  it('a checagem é NEGATIVA — o stderr vale justamente quando NÃO há TTY', () => {
    // Guardar com `tuiDonaDaTela()` (sem o `!`) bloquearia o headless, que é onde o stderr
    // é o único canal que existe. O `!` é o conserto inteiro.
    expect(FONTE).toContain('!tuiDonaDaTela()');
    expect(FONTE).toContain('process.stdout.isTTY === true');
  });
});
