// GUARDA — um subcomando TERMINAL escolhido no menu não pode enfileirar CEGO.
//
// O defeito (dono, 01/09, já na rc.162): "o /cycle stop não funcionou, enfileirou; vc não
// testou no modo interativo tmux?". Não tinha — e é por isso que passou.
//
// A rc.162 adicionou `parallelWhileBusyWith` ao `/cycle`, e o predicado passava verde nos
// testes unitários. Só que o ramo do App que trata SUBCOMANDO TERMINAL (`/cycle stop`,
// `/clear full`, …) chamava `enqueue(line)` DIRETO, sem nunca consultar
// `isParallelWhileBusy`. O predicado existia e ninguém perguntava por ele.
//
// O agravante: a fila criada aí DESARMA o Esc (`App.tsx` só interrompe em
// `isDoubleEsc && !hasQueue`). Pedir para parar tirava do dono o freio de emergência.
//
// Esta guarda lê o FONTE porque o caminho é de teclado dentro do `App.tsx` (excluído da
// cobertura por ser I/O de terminal): nenhum teste de unidade o exercita, e foi exatamente
// aí que o defeito sobreviveu a um conserto que parecia certo.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const APP = join(__dirname, '..', '..', 'src', 'session', 'App.tsx');
const fonte = readFileSync(APP, 'utf8');

/** O bloco do `if` que trata subcomando terminal, com chaves casadas. */
function blocoDoSubTerminal(): string {
  const marca = "entry.kind === 'subcommand' && isTerminalSubcommand(entry)";
  const i = fonte.indexOf(marca);
  if (i < 0) return '';
  const abre = fonte.indexOf('{', i);
  let prof = 0;
  for (let j = abre; j < fonte.length; j++) {
    if (fonte[j] === '{') prof++;
    else if (fonte[j] === '}') {
      prof--;
      if (prof === 0) return fonte.slice(i, j + 1);
    }
  }
  return '';
}

describe('subcomando terminal no menu', () => {
  const bloco = blocoDoSubTerminal();

  it('o ramo existe (a âncora não se perdeu num refactor)', () => {
    expect(bloco, 'o `if` do subcomando terminal sumiu — atualize esta guarda').not.toBe('');
  });

  it('CONSULTA `isParallelWhileBusy` antes de enfileirar', () => {
    expect(
      bloco.includes('isParallelWhileBusy'),
      'sem esta consulta o `/cycle stop` volta a enfileirar (e a fila desarma o Esc)',
    ).toBe(true);
  });

  it('passa o VERBO do subcomando, não string vazia', () => {
    // `isParallelWhileBusy(parent, '')` devolveria `false` p/ todo predicado que olha o
    // verbo — foi assim que o outro call-site do menu já errava.
    expect(bloco).toMatch(/isParallelWhileBusy\(\s*entry\.parent\s*,\s*entry\.sub\.name\s*\)/);
  });

  it('ainda ENFILEIRA quando não é paralelo-seguro (não virou bypass geral)', () => {
    expect(bloco.includes('enqueue(line)')).toBe(true);
  });

  it('a varredura ACHA a ausência (não passa por vacuidade)', () => {
    const mutado = bloco.replace(/isParallelWhileBusy/g, 'semConsulta');
    expect(mutado).not.toBe(bloco);
    expect(mutado.includes('isParallelWhileBusy')).toBe(false);
  });
});
