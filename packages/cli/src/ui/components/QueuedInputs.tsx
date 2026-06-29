// EST-0982 (type-ahead) — <QueuedInputs>: a FILA de mensagens digitadas ENQUANTO o
// agente trabalha (`thinking`/`streaming`/`retrying`). Cada item entra com Enter e é
// AUTO-SUBMETIDO como próximo objetivo quando o turno termina (ver App.tsx). Esta é
// a apresentação PURA da fila — chrome esmaecido ACIMA do composer, fora da região
// viva animada (sem jitter). A mecânica (enfileirar/auto-submit/Ctrl+Enter→injetar)
// é toda do <App> (useInput); aqui só desenhamos o estado.
//
// Anti-flicker (EST-0965): a fila é BOUNDED — mostra no máximo `VISIBLE_QUEUED`
// itens + 1 linha de contagem (`…+N na fila`). A altura é previsível e ENTRA no
// orçamento da região viva (ver `queuedInputsLines` + `speechMaxLines`) p/ a soma
// nunca estourar `rows-1` (senão o Ink redesenha o frame inteiro).
//
// a11y (§3.3): o glifo NUNCA carrega significado sozinho — a palavra "fila"
// acompanha a contagem; cada item leva o prefixo `›` esmaecido + o texto.

import React from 'react';
import { Box } from 'ink';
import { Role } from '../theme/index.js';
import { truncateToWidth } from '../markdown/table-layout.js';

/** Quantos itens da fila são mostrados em texto antes de colapsar p/ a contagem. */
export const VISIBLE_QUEUED = 3;

/** Largura máxima (colunas) do texto de um item antes de elidir com `…`. */
const ITEM_MAX_COLS = 48;

export interface QueuedInputsProps {
  /** As mensagens enfileiradas (FIFO) — a 1ª é a PRÓXIMA a submeter. */
  readonly items: readonly string[];
}

/** Elide o texto do item p/ caber numa linha (anti-jitter de largura). */
function elide(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  // FIX (HUNT-RENDER) — corta por LARGURA DE EXIBIÇÃO, não por `.length` (unidades UTF-16).
  // Antes `oneLine.length <= ITEM_MAX_COLS` + `slice(0, N)` deixava passar 48 CJK = 96
  // COLUNAS (cada CJK ocupa 2): a linha estourava `ITEM_MAX_COLS`, re-fluía e FURAVA o
  // orçamento anti-flicker (este arquivo cravou item ≤ ITEM_MAX_COLS cols). E o `slice` por
  // unidade ainda PARTIA um emoji/astral (surrogate órfão `�`). `truncateToWidth` mede por
  // display width e nunca parte um code point — devolve ≤ ITEM_MAX_COLS colunas sempre.
  return truncateToWidth(oneLine, ITEM_MAX_COLS);
}

/**
 * Quantas LINHAS a fila ocupa p/ um dado nº de itens — a MESMA conta do render
 * abaixo, p/ o orçamento anti-flicker (live-budget) reservar a altura certa:
 *   • 0 itens                    → 0 linhas (nada renderiza);
 *   • 1..VISIBLE_QUEUED itens     → 1 (cabeçalho) + N (itens);
 *   • > VISIBLE_QUEUED itens      → 1 (cabeçalho) + VISIBLE_QUEUED + 1 (`…+N`).
 */
export function queuedInputsLines(count: number): number {
  if (count <= 0) return 0;
  const shown = Math.min(count, VISIBLE_QUEUED);
  const overflow = count > VISIBLE_QUEUED ? 1 : 0;
  return 1 + shown + overflow;
}

export function QueuedInputs(props: QueuedInputsProps): React.ReactElement | null {
  const { items } = props;
  if (items.length === 0) return null;
  const shown = items.slice(0, VISIBLE_QUEUED);
  const hidden = items.length - shown.length;
  return (
    <Box flexDirection="column">
      {/* Cabeçalho da fila: contagem + a palavra "fila" (a11y — nunca só glifo). */}
      <Role name="depth">{`⊟ ${items.length} na fila · enviada(s) ao terminar o turno`}</Role>
      {shown.map((text, i) => (
        <Box key={i}>
          <Role name="fgDim">{`  › ${elide(text)}`}</Role>
        </Box>
      ))}
      {hidden > 0 && (
        <Box>
          <Role name="fgDim">{`  …+${hidden} na fila`}</Role>
        </Box>
      )}
    </Box>
  );
}

export interface PendingInjectsProps {
  /**
   * Os ECOS REDIGIDOS (CLI-SEC-6 — nunca texto cru) dos injects de texto puro feitos
   * num turno VIVO, AINDA não drenados pelo loop. FIFO; o 1º é o próximo a encaixar.
   */
  readonly items: readonly string[];
}

/**
 * EST-0982 (mid-turn UX) — <PendingInjects>: o input de texto puro digitado DURANTE o
 * trabalho do agente NÃO entra na fila de submit (<QueuedInputs>) — é INJETADO no turno
 * vivo (`injectInput('root', …)`) e o loop o incorpora na próxima iteração ("↳ encaixado",
 * InjectBlock). Entre o Enter e essa incorporação havia um VÃO INVISÍVEL — o dono não via
 * que a mensagem estava ESPERANDO. Este indicador (irmão do <QueuedInputs>, mesma altura
 * BOUNDED/anti-flicker, fora da região viva) mostra o(s) pendente(s) como "encaixando…"
 * até o loop drenar. Os itens são os ECOS JÁ REDIGIDOS (nunca texto cru/segredo).
 */
export function PendingInjects(props: PendingInjectsProps): React.ReactElement | null {
  const { items } = props;
  if (items.length === 0) return null;
  const shown = items.slice(0, VISIBLE_QUEUED);
  const hidden = items.length - shown.length;
  return (
    <Box flexDirection="column">
      {/* Cabeçalho: contagem + a palavra "encaixando" (a11y — nunca só glifo). */}
      <Role name="depth">{`↳ ${items.length} encaixando… · incorporada(s) na próxima iteração`}</Role>
      {shown.map((text, i) => (
        <Box key={i}>
          <Role name="fgDim">{`  › ${elide(text)}`}</Role>
        </Box>
      ))}
      {hidden > 0 && (
        <Box>
          <Role name="fgDim">{`  …+${hidden} encaixando`}</Role>
        </Box>
      )}
    </Box>
  );
}

export interface PendingAsksProps {
  /** `/ask` EM VOO (canal lateral read-only) ainda sem resposta. `{id, question}` — head curto. */
  readonly items: readonly { readonly id: string; readonly question: string }[];
}

/**
 * `<PendingAsks>`: as `/ask` (canal lateral, paralelo) AINDA sem resposta. Irmão do
 * <QueuedInputs>/<PendingInjects> (mesma altura BOUNDED/anti-flicker), mas SEPARADO da fila do
 * agente principal — a fila é só pedido sem `/ask`. Mostra a pergunta com a seta `↗` (canal
 * lateral) até a resposta chegar (some, vira nota `↗ /ask:`). Achado do dono: antes a `/ask`
 * pendente não aparecia em lugar nenhum.
 */
export function PendingAsks(props: PendingAsksProps): React.ReactElement | null {
  const { items } = props;
  if (items.length === 0) return null;
  const shown = items.slice(0, VISIBLE_QUEUED);
  const hidden = items.length - shown.length;
  return (
    <Box flexDirection="column">
      <Role name="depth">{`↗ ${items.length} /ask em paralelo · respondendo (canal lateral, sem parar o trabalho)`}</Role>
      {shown.map((a) => (
        <Box key={a.id}>
          <Role name="fgDim">{`  ↗ ${elide(a.question)}`}</Role>
        </Box>
      ))}
      {hidden > 0 && (
        <Box>
          <Role name="fgDim">{`  …+${hidden} /ask`}</Role>
        </Box>
      )}
    </Box>
  );
}
