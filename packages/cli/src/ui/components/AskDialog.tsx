// EST-0948 · spec §2.7/§2.8/§2.9/§2.10 · CLI-SEC-9 — <AskDialog>.
//
// Renderiza o EFEITO EXATO que a engine (EST-0945) devolveu — o COMANDO `$ ...`,
// o DIFF unificado com `-`/`+`, ou a URL/destino — NUNCA um resumo vago (CLI-SEC-9).
// F164 (decisão do dono, 2026-07-02): efeito GIGANTE (batch/heredoc/diff de 100+
// linhas) é JANELADO (cabeça + `… (+N linhas ocultas)` + cauda) — recorte com
// marcador explícito, nunca paráfrase; `[e] editar` dá o efeito completo.
// E oferece as ações `[a]/[s]/[n]/[e]`. A TUI NÃO decide permissão (handoff §10
// regra 3 / CA-2): recebe o `AskRequest` e DEVOLVE a escolha via `onResolve`.
//
// Regras de fidelidade ao escopo cravadas pela spec/seguranca:
//  - `[s] sempre nesta sessão` SÓ quando `req.alwaysAsk === false` (§2.7-nota /
//    CLI-SEC-3: categorias sempre-ask NÃO oferecem grant — cada ocorrência
//    pergunta de novo). A TUI não contorna a engine.
//  - DESTRUTIVO/rede fora da allowlist eleva fricção: ordem `[n] negar` primeiro,
//    linha "não pode ser desfeita", sem `[s]` (§2.10).
//  - egress fora da allowlist mostra `⚠ rede · ask · destino fora da allowlist`
//    com o destino EXATO (CLI-SEC-5 / §2.8).
//
// Este componente é APRESENTAÇÃO. A captura de tecla + os fail-safes (deny em
// timeout/Ctrl-C) ficam no AskResolver (ask/ask-resolver.tsx) que monta isto.

import React from 'react';
import { Box, Text } from 'ink';
import type { AskRequest } from '@hiperplano/aluy-cli-core';
import { Glyph, Role, useTheme } from '../theme/index.js';
import { resolveLanguage } from '../markdown/index.js';
import {
  ASK_EFFECT_MAX_LINES,
  DiffLine,
  langFromPath,
  windowEffectLines,
  type EffectWindow,
} from './DiffView.js';

// F164 (decisão do dono, 2026-07-02) — a JANELA (cabeça+cauda) e o RENDER de uma
// linha de diff moraram aqui originalmente; foram extraídos p/ `./DiffView.js`
// (ver comentário lá) p/ o `<ToolLine>` do histórico REUSAR a MESMA lógica em vez
// de reimplementar. Reexportados abaixo — API pública deste módulo intacta.
export { ASK_EFFECT_MAX_LINES, windowEffectLines };
export type { EffectWindow };

export interface AskDialogProps {
  readonly request: AskRequest;
  /** `true` quando o destino de rede está fora da allowlist (CLI-SEC-5). */
  readonly egressOutsideAllowlist?: boolean;
  /** Destino exato de rede (host/URL) a exibir (CLI-SEC-5/9). */
  readonly egressTarget?: string;
}

/** `true` p/ categorias que elevam fricção (destrutivo) — ordem invertida (§2.10). */
function isDestructive(req: AskRequest): boolean {
  return req.category === 'always-ask:destructive';
}

/**
 * EST-0969 (display) · CLI-SEC-9 — ORIGEM do ask quando ele vem de um SUB-AGENTE.
 * O spawner carimba o `reason` do filho com `[sub-agente: <label>]` (originAskResolver).
 * Extraímos o RÓTULO p/ exibir uma badge inequívoca no diálogo: o usuário precisa
 * saber QUE filho pede o efeito antes de aprovar (não pode sumir). `null` p/ asks do
 * próprio pai (sem o prefixo).
 */
function subAgentOriginOf(req: AskRequest): string | null {
  const m = /^\[sub-agente:\s*([^\]]+)\]/.exec(req.reason ?? '');
  return m ? m[1]!.trim() : null;
}

/** Sufixo do título após a tag: `edit ─ <path>` / `bash` (§3.4 title-tag). */
function titleSuffixOf(req: AskRequest): string {
  const k = req.effect.kind;
  if (k === 'diff' || k === 'path') {
    const path = req.effect.path ?? req.effect.exact;
    return `edit ─ ${path}`;
  }
  return 'bash';
}

export function AskDialog(props: AskDialogProps): React.ReactElement {
  const theme = useTheme();
  const req = props.request;
  const destructive = isDestructive(req);
  const network = req.category === 'always-ask:network' || props.egressOutsideAllowlist === true;
  // EST-0969 (display): rótulo de origem do sub-agente (se o ask vier de um filho).
  const origin = subAgentOriginOf(req);

  const tag = destructive ? 'destrutivo · ask' : 'ask';

  return (
    <Box flexDirection="column" paddingLeft={2}>
      {/* topo do box: a TAG de estado vem PRIMEIRO/à esquerda (§3.4 title-tag):
          `⚠ ask ─ edit ─ <path>` — é a 1ª coisa que o olho pega. */}
      <Box>
        <Role name="accent">{theme.box.topLeft} </Role>
        <Glyph name="ask" role="accent" />
        <Role name="accent">
          {' '}
          {tag} ─ {titleSuffixOf(req)} {theme.box.horizontal.repeat(2)}
          {theme.box.topRight}
        </Role>
      </Box>

      {/* respiro: 1 linha em branco no topo do corpo (§3.4 box-pad-y, confortável) */}
      <Role name="accent">{theme.box.vertical}</Role>

      {/* EST-0969 (display) — BADGE de ORIGEM quando o ask vem de um SUB-AGENTE: o
          usuário precisa saber QUE filho pede o efeito antes de aprovar (CLI-SEC-9).
          Filhos paralelos ⇒ rótulos distintos ⇒ asks distintos e inequívocos. */}
      {origin !== null && (
        <Box>
          <Role name="accent">{theme.box.vertical} </Role>
          <Glyph name="subagents" role="accent" />
          <Role name="accent"> sub-agente: </Role>
          <Role name="fg">{origin}</Role>
        </Box>
      )}

      {/* CORPO: o EFEITO EXATO (CLI-SEC-9) — diff, comando ou caminho. */}
      <EffectBody request={req} />

      {/* contagem/consequência (rodapé-resumo dim) */}
      {network && (
        <Box flexDirection="column">
          <Box>
            <Role name="accent">{theme.box.vertical} </Role>
            <Glyph name="ask" role="accent" />
            <Role name="accent"> rede · ask · destino fora da allowlist</Role>
          </Box>
          {props.egressTarget && (
            <Box>
              <Role name="accent">{theme.box.vertical} </Role>
              <Role name="depth">{props.egressTarget}</Role>
            </Box>
          )}
        </Box>
      )}

      {/* separador antes das ações */}
      <Role name="accent">
        {theme.box.teeLeft}
        {theme.box.horizontal.repeat(40)}
        {theme.box.teeRight}
      </Role>

      {destructive ? (
        <Box flexDirection="column">
          <Box>
            <Role name="accent">{theme.box.vertical} </Role>
            <Glyph name="ask" role="accent" />
            <Role name="accent"> esta ação não pode ser desfeita</Role>
          </Box>
          {/* ORDEM INVERTIDA: negar primeiro (§2.10) */}
          <Box>
            <Role name="accent">{theme.box.vertical} </Role>
            <Role name="danger">[n] negar</Role>
            <Text> </Text>
            <Role name="accent">[a] aprovar mesmo assim</Role>
          </Box>
        </Box>
      ) : (
        <Box flexDirection="column">
          <Box>
            <Role name="accent">{theme.box.vertical} </Role>
            <Glyph name="ask" role="accent" />
            <Role name="accent"> {promptCopy(req)}</Role>
          </Box>
          <Box>
            <Role name="accent">{theme.box.vertical} </Role>
            <Role name="accent">[a] aprovar</Role>
            <Text> </Text>
            {/* [s] SÓ quando NÃO é sempre-ask (CLI-SEC-3) */}
            {req.alwaysAsk === false && <Role name="accent">[s] sempre nesta sessão</Role>}
          </Box>
          <Box>
            <Role name="accent">{theme.box.vertical} </Role>
            <Role name="danger">[n] negar</Role>
            <Text> </Text>
            <Role name="fgDim">[e] editar</Role>
          </Box>
        </Box>
      )}

      <Role name="accent">
        {theme.box.bottomLeft}
        {theme.box.horizontal.repeat(42)}
        {theme.box.bottomRight}
      </Role>

      {/* footer de atalhos linear FORA do box (§2.9/§4.3) — reforço a11y +
          descoberta. Destrutivo empurra p/ a escolha segura ("recomendado"). */}
      <Role name="fgDim">{footerOf(req, destructive)}</Role>
    </Box>
  );
}

/** Footer linear de atalhos (§4.3), por tipo de ask. */
function footerOf(req: AskRequest, destructive: boolean): string {
  if (destructive) return 'n nega (recomendado) · a aprova mesmo assim · esc cancela';
  if (req.alwaysAsk === false) return 'a aprova · s sempre · n nega · e edita · esc cancela';
  return 'a aprova · n nega · e edita · esc cancela';
}

/** O pedido em linguagem natural (edit vs bash). */
function promptCopy(req: AskRequest): string {
  if (req.effect.kind === 'diff' || req.effect.kind === 'path') {
    return 'aplicar esta alteração?';
  }
  return 'executar este comando?';
}

/** Renderiza o corpo do efeito EXATO conforme o tipo (CLI-SEC-9 + janela F164). */
function EffectBody(props: { readonly request: AskRequest }): React.ReactElement {
  const theme = useTheme();
  const eff = props.request.effect;
  // F164 — janela cabeça+cauda (ver windowEffectLines): efeito curto = idêntico ao
  // de antes; efeito gigante = cabeça + `… (+N linhas ocultas)` + cauda.
  const win = windowEffectLines(eff.exact.split('\n'));
  // Destrutivo NÃO oferece `[e]` (§2.10) — o marcador não pode sugerir tecla inexistente.
  const editHint = isDestructive(props.request) ? '' : ' — [e] editar mostra tudo';
  const marker = (key: string): React.ReactElement => (
    <Box key={key}>
      <Role name="accent">{theme.box.vertical} </Role>
      <Role name="fgDim">
        … (+{win.hidden} linhas ocultas{editHint})
      </Role>
    </Box>
  );

  if (eff.kind === 'diff') {
    const lang = resolveLanguage(langFromPath(eff.path ?? eff.exact));
    const diffLine = (line: string, key: string): React.ReactElement => (
      <Box key={key}>
        <Role name="accent">{theme.box.vertical} </Role>
        <DiffLine line={line} lang={lang ?? undefined} />
      </Box>
    );
    return (
      <Box flexDirection="column">
        {win.head.map((line, i) => diffLine(line, `h${i}`))}
        {win.hidden > 0 && marker('m')}
        {win.tail.map((line, i) => diffLine(line, `t${i}`))}
      </Box>
    );
  }

  // command / network / path: mostra a verdade literal (`$ cmd` já vem no exact).
  const cmdLine = (line: string, key: string): React.ReactElement => (
    <Box key={key}>
      <Role name="accent">{theme.box.vertical} </Role>
      <Role name="fg">{line}</Role>
    </Box>
  );
  return (
    <Box flexDirection="column">
      {win.head.map((line, i) => cmdLine(line, `h${i}`))}
      {win.hidden > 0 && marker('m')}
      {win.tail.map((line, i) => cmdLine(line, `t${i}`))}
    </Box>
  );
}
