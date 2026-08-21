// F-RECAP (pedido do dono: "um recap para ficar na linha inferior, um recap do que fez")
// — destila os blocos do ÚLTIMO turno numa linha curta que diz o que o agente FEZ.
//
// O rodapé de hoje (`<TurnFooter>`) informa CUSTO: `✓ 15.6k tokens · 2 tools · 2.5s`. Isso
// responde "quanto gastou", não "o que aconteceu" — e num turno com dez tools o dono teria
// de reler o histórico inteiro para saber que arquivo foi tocado ou que comando rodou. O
// recap responde a segunda pergunta na MESMA linha.
//
// A regra que governa o texto: contar o que TEM CONSEQUÊNCIA, não o que foi barulhento.
// Editar/escrever arquivo e rodar comando mudam o mundo; ler e buscar, não. Por isso os
// verbos de efeito vêm primeiro e nomeados; leitura entra como um número agregado, quando
// entra. FALHA nunca é omitida — um turno que escreveu um arquivo e quebrou um comando
// precisa dizer as duas coisas, senão o rodapé vira propaganda do turno.
//
// PURO: blocos → string. Sem i18n aqui de propósito — o texto é composto de nomes de
// arquivo/comando (dado do usuário) mais conectivos mínimos; a camada de i18n entra no
// componente, se e quando houver segunda língua para estes rótulos.

import type { SessionBlock } from './model.js';

/** Nome curto de um caminho: só o basename (o rodapé tem uma linha, não uma coluna). */
function nomeCurto(alvo: string): string {
  const limpo = alvo.trim();
  if (limpo === '') return '';
  // `path.basename` não serve: o alvo pode ser um comando (`npm test -- --run`) ou um
  // padrão de busca, e cortar no `/` deles produziria lixo. Só encurtamos o que PARECE
  // caminho (sem espaço e com barra).
  if (!limpo.includes(' ') && limpo.includes('/')) {
    const partes = limpo.split('/').filter((p) => p !== '');
    return partes[partes.length - 1] ?? limpo;
  }
  return limpo;
}

/** Primeira palavra de um comando (`npm test -- x` ⇒ `npm test` quando faz sentido). */
function comandoCurto(alvo: string): string {
  const limpo = alvo.trim().replace(/\s+/g, ' ');
  if (limpo === '') return '';
  const palavras = limpo.split(' ');
  // Duas palavras cobrem o caso comum (`npm test`, `git status`, `cargo build`) sem virar
  // uma linha inteira; uma só seria ambígua demais (`npm` não diz nada).
  return palavras.slice(0, 2).join(' ');
}

/** Junta itens com vírgula e "e" no último — legível numa linha só. */
function juntar(itens: readonly string[]): string {
  if (itens.length === 0) return '';
  if (itens.length === 1) return itens[0]!;
  return `${itens.slice(0, -1).join(', ')} e ${itens[itens.length - 1]}`;
}

/** Blocos do último turno (do último `you` em diante). Espelha o `suggest-digest`. */
function blocosDoUltimoTurno(blocks: readonly SessionBlock[]): readonly SessionBlock[] {
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (blocks[i]?.kind === 'you') return blocks.slice(i);
  }
  return blocks;
}

/** Teto de nomes citados: além disso a linha deixa de caber e vira ruído. */
const MAX_NOMES = 3;

/**
 * F-RECAP — a linha de recap do último turno, ou `undefined` quando não há nada de
 * consequência a contar (turno de conversa pura: o rodapé segue só com custo, que é o
 * comportamento de hoje — sem regressão).
 *
 * PURO. Ordem deliberada: efeito primeiro (escrita/comando), leitura agregada depois,
 * falha SEMPRE — ver o cabeçalho do módulo.
 */
export function buildTurnRecap(blocks: readonly SessionBlock[]): string | undefined {
  const turno = blocosDoUltimoTurno(blocks);
  const escritos = new Set<string>();
  const comandos: string[] = [];
  let lidos = 0;
  let falhas = 0;

  for (const b of turno) {
    if (b.kind === 'bang' && b.status === 'err') falhas += 1;
    if (b.kind !== 'tool') continue;
    if (b.status === 'err') falhas += 1;
    const verbo = b.verb.toLowerCase();
    if (verbo === 'edit' || verbo === 'write' || verbo === 'edit_file' || verbo === 'write_file') {
      const n = nomeCurto(b.target);
      if (n !== '') escritos.add(n);
    } else if (verbo === 'bash' || verbo === 'run' || verbo === 'run_command') {
      const c = comandoCurto(b.target);
      if (c !== '') comandos.push(c);
    } else if (verbo === 'read' || verbo === 'read_file' || verbo === 'grep' || verbo === 'glob') {
      lidos += 1;
    }
  }

  const partes: string[] = [];
  if (escritos.size > 0) {
    const nomes = [...escritos];
    const citados = juntar(nomes.slice(0, MAX_NOMES));
    const resto = nomes.length - MAX_NOMES;
    partes.push(resto > 0 ? `editou ${citados} +${resto}` : `editou ${citados}`);
  }
  if (comandos.length > 0) {
    // Comando repetido conta uma vez no NOME, mas o total importa (rodar o teste 3× é
    // informação): citamos o distinto e, quando há mais, o número.
    const distintos = [...new Set(comandos)];
    const citados = juntar(distintos.slice(0, MAX_NOMES));
    const resto = distintos.length - MAX_NOMES;
    partes.push(resto > 0 ? `rodou ${citados} +${resto}` : `rodou ${citados}`);
  }
  // Leitura só aparece quando foi a ÚNICA coisa do turno — junto de uma edição ela é
  // detalhe de processo, e o dono quer o efeito.
  if (partes.length === 0 && lidos > 0) {
    partes.push(lidos === 1 ? 'leu 1 arquivo' : `leu ${lidos} arquivos`);
  }
  if (falhas > 0) partes.push(falhas === 1 ? '1 falhou' : `${falhas} falharam`);

  return partes.length > 0 ? partes.join(' · ') : undefined;
}
