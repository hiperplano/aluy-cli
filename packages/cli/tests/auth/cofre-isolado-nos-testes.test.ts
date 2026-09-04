// GUARDA — nenhum teste pode escrever no cofre de credenciais REAL do usuário.
//
// Aconteceu de verdade, duas vezes em 01/09, em dois subsistemas independentes:
//
//   1. mem0: `npm test` numa máquina com o sidecar de pé despejava na memória REAL —
//      5.617 vetores, 467 distintos, campeões como "Objetivo: faça algo / Resultado:
//      pronto." (736×) e "…resultado headless." (570×), literais de teste. Fechado
//      isolando `ALUY_MEM0_URL` no `vitest.config.ts`.
//
//   2. ESTE: `connector-secret-store.test.ts` instanciava o store SEM `fileVault` e
//      chamava `set(TOKEN)`. Era inofensivo enquanto `set` só escrevia no keychain
//      (dublê) — foi a EMENDA do CLI-SEC-2 (gravar também no cofre em arquivo) que o
//      transformou num teste que sobrescreve `~/.aluy/credentials.enc`. O token de
//      Telegram do dono virou `123456789:…`, a ponte "ativou" com credencial de mentira
//      e o long-poll morreu em 401 — calado, porque o log da ponte vai para o stderr,
//      que a TUI engole. Ele passou horas achando que o Telegram estava quebrado.
//
// A lição comum: acrescentar um DESTINO DE ESCRITA a uma função obriga a re-auditar
// TODOS os chamadores existentes — inclusive os testes, que até então mexiam só no
// dublê. Lembrar disso falhou; esta guarda não esquece.
//
// Ela lê o FONTE porque nenhum teste de comportamento pega o caso: quem esquece o
// `fileVault` passa verde e só estraga a máquina de quem roda.

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const RAIZ_TESTES = join(__dirname, '..');

/** Todos os `.test.ts`/`.test.tsx` sob `packages/cli/tests/`. */
function arquivosDeTeste(dir: string, acc: string[] = []): string[] {
  for (const nome of readdirSync(dir)) {
    const p = join(dir, nome);
    if (statSync(p).isDirectory()) arquivosDeTeste(p, acc);
    else if (/\.test\.tsx?$/.test(nome)) acc.push(p);
  }
  return acc;
}

/**
 * Extrai o bloco de opções de cada `new KeychainConnectorSecretStore(...)`, casando
 * parênteses (as opções têm objetos aninhados, então regex simples não serve).
 */
function opcoesDasInstanciacoes(fonte: string): string[] {
  const marca = 'new KeychainConnectorSecretStore(';
  const blocos: string[] = [];
  let i = fonte.indexOf(marca);
  while (i >= 0) {
    let prof = 0;
    let j = i + marca.length - 1;
    for (; j < fonte.length; j++) {
      const c = fonte[j];
      if (c === '(') prof++;
      else if (c === ')') {
        prof--;
        if (prof === 0) break;
      }
    }
    blocos.push(fonte.slice(i, j + 1));
    i = fonte.indexOf(marca, j);
  }
  return blocos;
}

describe('GUARDA — cofre de credenciais isolado em TODO teste', () => {
  const arquivos = arquivosDeTeste(RAIZ_TESTES);

  it('a varredura enxerga a suíte (não passa por vacuidade)', () => {
    expect(arquivos.length).toBeGreaterThan(100);
  });

  it('TODO `new KeychainConnectorSecretStore` em teste injeta `fileVault`', () => {
    const faltando: string[] = [];
    for (const arq of arquivos) {
      // O PRÓPRIO arquivo da guarda contém um literal sintético (no caso da
      // não-vacuidade logo abaixo) — sem esta exclusão ela acusa a si mesma. Mesmo
      // auto-casamento que já deu alarme falso hoje num `pkill -f` e num `grep -c`.
      if (arq === __filename || arq.endsWith('cofre-isolado-nos-testes.test.ts')) continue;
      const fonte = readFileSync(arq, 'utf8');
      for (const bloco of opcoesDasInstanciacoes(fonte)) {
        if (!bloco.includes('fileVault')) {
          faltando.push(`${arq.replace(RAIZ_TESTES, 'tests')}: ${bloco.slice(0, 90)}…`);
        }
      }
    }
    // A mensagem NOMEIA quem esqueceu — é isso que torna a guarda acionável.
    expect(
      faltando,
      `sem cofre isolado (escreveria em ~/.aluy/credentials.enc):\n${faltando.join('\n')}`,
    ).toEqual([]);
  });

  it('a varredura ACHA alguém quando o defeito volta', () => {
    // Sem este caso, o teste acima passaria verde num diretório vazio ou com um parser
    // quebrado. Mutação sintética: uma instanciação sem `fileVault`.
    const sintetico = `const s = new KeychainConnectorSecretStore('telegram', { entryFactory: () => fake });`;
    const blocos = opcoesDasInstanciacoes(sintetico);
    expect(blocos).toHaveLength(1);
    expect(blocos[0]).not.toContain('fileVault');
  });

  it('o parser casa parênteses aninhados (opções têm objetos dentro)', () => {
    const aninhado = `new KeychainConnectorSecretStore('telegram', { fileVault: { machineId: { reader: () => 'x' } } })`;
    const blocos = opcoesDasInstanciacoes(aninhado);
    expect(blocos).toHaveLength(1);
    expect(blocos[0]).toContain('fileVault');
    expect(blocos[0]!.endsWith(')')).toBe(true);
  });
});
