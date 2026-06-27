// EST — anti-flicker: split dos blocos da sessão em REGIÃO CONCLUÍDA (imutável) e
// REGIÃO VIVA (ainda muda). A App escreve a região concluída UMA VEZ no scrollback
// via `<Static>` do Ink (nunca mais re-renderiza), e só a região viva participa do
// render dinâmico (re-desenhado a cada token/frame). Isso é o que MATA o tremor:
// sem isto, o Ink redesenha a árvore inteira (incl. todo o histórico) a cada token
// do stream E a cada frame da animação — com a tela > terminal, redesenha tudo.
//
// PURO (sem React/Ink): `splitBlocks(blocks)` → `{ done, live }`. Testável sem TUI.
//
// INVARIANTE (o que torna o `<Static>` correto): um bloco é MUTÁVEL só enquanto é
//   (a) uma tool `running` (vira `ok`/`err` ao concluir), ou
//   (b) uma fala `aluy` com `streaming: true` (acumula tokens / o cursor pulsa).
// Qualquer outro bloco é IMUTÁVEL no instante em que existe. E o loop é sequencial:
// a tool running / o aluy streaming são SEMPRE o rabo da lista — então a região
// viva é um SUFIXO contíguo, e a concluída preserva a ordem cronológica. Quando um
// bloco vivo finaliza (tool resolve / stream termina), ele migra p/ `done` e o
// `<Static>` o anexa ao scrollback exatamente UMA vez (append-only do Ink).

import type { SessionBlock } from './model.js';

/** `true` se o bloco ainda pode MUTAR (e portanto não pode ir p/ o `<Static>`). */
export function isLiveBlock(block: SessionBlock): boolean {
  if (block.kind === 'tool') return block.status === 'running';
  if (block.kind === 'aluy') return block.streaming;
  // EST-0982: um `!comando` (bang) `running` é VIVO — o status muda (→ ok/err/blocked)
  // e a SAÍDA AO VIVO (`liveOutput`) acumula token-a-token. Sem isto, o bloco bang
  // ia direto p/ o `<Static>` (escrito UMA vez) e o streaming nunca apareceria.
  if (block.kind === 'bang') return block.status === 'running';
  // EST-0969 (display): o indicador de sub-agentes é VIVO enquanto QUALQUER filho
  // roda (status muda: running→done/fail). Quando todos concluem, vira imutável e
  // migra p/ o `<Static>` (escrito uma vez) — então o pai segue streamando o
  // agregado abaixo dele sem re-pintar o bloco dos filhos a cada token.
  if (block.kind === 'subagents') return block.children.some((c) => c.status === 'running');
  // EST-0948 (auto-retry): um erro de broker em BACKOFF ATIVO (`retrying`) é VIVO — o
  // countdown (`tentando de novo em Ns`) decrementa a cada segundo, então o bloco
  // precisa re-renderizar fora do `<Static>`. Quando o ciclo esgota / vira erro
  // terminal manual (`retrying` falso), ele imobiliza e migra p/ o scrollback.
  if (block.kind === 'broker-error') return block.retrying === true;
  // EST-0970 (`/doctor` ticks AO VIVO) — a CHECKLIST do doctor é VIVA enquanto roda: os
  // checks "acendem" (pending→✓/⚠/✗) por updates ASSÍNCRONOS (`upsertDoctor` in-place) à
  // medida que os probes (credencial/broker/catálogo/MCP/…) resolvem. O `summary` só
  // entra na chamada FINAL — então `summary === undefined` = ainda mutando. Sem este
  // caso o bloco caía no `<Static>` (escrito UMA vez): o seed (já com `versão` ✓ síncrono)
  // pintava e os ticks assíncronos NUNCA repintavam (congelava em "testando…"). Quando o
  // resumo chega, imobiliza e migra p/ o scrollback (idêntico ao padrão `subagents`).
  if (block.kind === 'doctor') return block.summary === undefined;
  return false;
}

export interface BlockSplit {
  /** Blocos CONCLUÍDOS (imutáveis) — vão p/ o `<Static>` (escritos uma vez). */
  readonly done: readonly SessionBlock[];
  /** Blocos VIVOS (ainda mudam) — ficam no render dinâmico. */
  readonly live: readonly SessionBlock[];
  /** Índice absoluto do 1º bloco vivo (= tamanho de `done`); `key` estável p/ `live`. */
  readonly liveStart: number;
}

/**
 * Divide os blocos em `{ done, live }`. A região viva é o sufixo contíguo a partir
 * do PRIMEIRO bloco vivo (tool running / aluy streaming). Tudo antes é concluído.
 *
 * Se NÃO houver bloco vivo (turno terminou / idle), tudo é `done` e `live` é vazio
 * — então quando o stream finaliza, o último bloco também desce p/ o `<Static>`.
 */
export function splitBlocks(blocks: readonly SessionBlock[]): BlockSplit {
  let liveStart = blocks.length;
  for (let i = 0; i < blocks.length; i++) {
    if (isLiveBlock(blocks[i]!)) {
      liveStart = i;
      break;
    }
  }
  // F142 (ÂNCORA anti-flicker) — a invariante (acima) é que bloco vivo é SEMPRE o RABO da
  // lista: a tool `running` / o aluy `streaming` que animam são o último bloco do turno em
  // voo. Então se o ÚLTIMO bloco NÃO é vivo, o turno ACABOU — e qualquer bloco "vivo" mais
  // atrás é um ÓRFÃO: um `/doctor` que nunca recebeu `summary` (persistido de ANTES do F141,
  // ou um stream interrompido por `/`/esc que não assentou). Sem este guarda o órfão arrasta
  // TODO o sufixo (tudo depois dele) p/ a região dinâmica ⇒ a viva fica > terminal ⇒ o Ink
  // repinta header+histórico+viva a cada frame (`ink.js`: `outputHeight >= rows`) = o
  // "refresh do início ao fim a cada tecla". Âncora: sem rabo vivo ⇒ TUDO é concluído (vai
  // p/ o `<Static>`, escrito uma vez). CURA órfãos já gravados no RESUME e protege a CLASSE
  // inteira (qualquer kind), não só o `/doctor` do F141. Em turno ativo o último bloco É vivo
  // (stream/tool no rabo) ⇒ guarda não dispara ⇒ comportamento inalterado.
  if (liveStart < blocks.length && !isLiveBlock(blocks[blocks.length - 1]!)) {
    liveStart = blocks.length;
  }
  return {
    done: blocks.slice(0, liveStart),
    live: blocks.slice(liveStart),
    liveStart,
  };
}
