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

/**
 * #13 (ghost "rodando") — IMOBILIZA um bloco que está num estado VIVO mas que NÃO pode
 * mais resolver sozinho (um ÓRFÃO): uma sessão RETOMADA (`--resume`) traz a transcrição
 * gravada VERBATIM, então um `!cmd`/tool/stream que estava em voo quando o `aluy` morreu
 * volta congelado em `running`/`streaming` — sem processo vivo p/ resolvê-lo. Demover ao
 * estado TERMINAL no instante da restauração garante que o estado VIVO da sessão NUNCA
 * contenha um órfão; assim `splitBlocks` pode manter QUALQUER bloco `running`/`streaming`
 * remanescente FORA do `<Static>` (ele é, por construção, genuinamente vivo) e a resolução
 * IN-PLACE acontece ANTES de o bloco migrar p/ o scrollback. (Era a âncora F142 — coarse:
 * ela arrastava o sufixo vivo INTEIRO p/ o Static quando o rabo era concluído, congelando
 * a linha `○ rodando` viva no scrollback até um resize.)
 *
 * PURO. A demoção é HONESTA (a11y): `running`→`err`/`cancelled` ("interrompido", não
 * "falhou silenciosamente"), nunca finge sucesso. Só toca blocos vivos; o resto é cópia.
 */
export function sanitizeOrphans(blocks: readonly SessionBlock[]): SessionBlock[] {
  return blocks.map((b) => {
    switch (b.kind) {
      case 'tool':
        return b.status === 'running'
          ? { ...b, status: 'err' as const, result: b.result || 'interrompido' }
          : b;
      case 'bang':
        // `running` retomado nunca resolve: vira `err` honesto. `liveOutput` (prévia viva)
        // vira o `output` final p/ não sumir; omitido (não `undefined`) p/ exactOptional.
        if (b.status === 'running') {
          const { liveOutput, ...rest } = b;
          return { ...rest, status: 'err' as const, output: b.output ?? liveOutput ?? 'interrompido' };
        }
        return b;
      case 'aluy':
        return b.streaming ? { ...b, streaming: false } : b;
      case 'subagents':
        return b.children.some((c) => c.status === 'running')
          ? {
              ...b,
              children: b.children.map((c) =>
                c.status === 'running' ? { ...c, status: 'cancelled' as const } : c,
              ),
            }
          : b;
      case 'broker-error':
        // backoff vivo retomado: não há retry em curso ⇒ imobiliza como erro terminal.
        return b.retrying === true ? { ...b, retrying: false } : b;
      case 'doctor':
        // checklist sem resumo retomada: nenhum probe vai mais "acender" ⇒ sela com resumo.
        return b.summary === undefined ? { ...b, summary: 'sessão retomada' } : b;
      case 'testrun':
        return b.running ? { ...b, running: false } : b;
      default:
        return b;
    }
  });
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
  // #13 (ghost "rodando") — um bloco VIVO (tool/bang `running`, aluy `streaming`) é mantido
  // FORA do `<Static>` ATÉ resolver: a região viva é o sufixo contíguo a partir do PRIMEIRO
  // bloco vivo. Antes, a âncora F142 fazia o OPOSTO quando o RABO da lista era concluído
  // (ex.: um `!cmd` `running` seguido de uma `↳ note`/`inject` ao se aprovar/interromper):
  // ela arrastava o sufixo INTEIRO — incluindo o bang AINDA VIVO — p/ `done` ⇒ o Ink
  // escrevia `○ rodando $ cmd` no scrollback UMA vez e NUNCA repintava ao resolver in-place,
  // deixando a linha FANTASMA até um resize re-emitir. A premissa da âncora (bloco vivo no
  // meio ⇒ ÓRFÃO) foi MOVIDA p/ a FONTE: `sanitizeOrphans` (acima), chamado na RESTAURAÇÃO
  // de sessão (`--resume`), imobiliza órfãos persistidos no instante em que entram — então
  // QUALQUER bloco vivo remanescente aqui é, por construção, genuinamente vivo (há processo/
  // stream em voo p/ resolvê-lo) e DEVE seguir vivo. Anti-flicker preservado: sem órfãos, o
  // sufixo vivo é pequeno (o bloco em voo + no máx. uma nota), nunca o histórico inteiro.
  return {
    done: blocks.slice(0, liveStart),
    live: blocks.slice(liveStart),
    liveStart,
  };
}
