// EST-0948 · spec §2.7/§2.8/§2.9/§2.10 · CLI-SEC-9 — <AskDialog>.
//
// Renderiza o EFEITO EXATO que a engine (EST-0945) devolveu — o COMANDO `$ ...`,
// o DIFF unificado com `-`/`+`, ou a URL/destino — NUNCA um resumo vago (CLI-SEC-9).
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
import type { AskRequest } from '@aluy/cli-core';
import { Glyph, Role, useTheme } from '../theme/index.js';
import { highlightToSegments, resolveLanguage } from '../markdown/index.js';

/** Linguagem inferida da extensão do path (p/ realçar o conteúdo do diff). */
function langFromPath(path: string | undefined): string | undefined {
  if (!path) return undefined;
  const ext = path.split('.').pop();
  return ext && ext !== path ? ext : undefined;
}

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

/** Renderiza o corpo do efeito EXATO conforme o tipo (CLI-SEC-9). */
function EffectBody(props: { readonly request: AskRequest }): React.ReactElement {
  const theme = useTheme();
  const eff = props.request.effect;

  if (eff.kind === 'diff') {
    const lang = resolveLanguage(langFromPath(eff.path ?? eff.exact));
    return (
      <Box flexDirection="column">
        {eff.exact.split('\n').map((line, i) => (
          <Box key={i}>
            <Role name="accent">{theme.box.vertical} </Role>
            <DiffLine line={line} lang={lang ?? undefined} />
          </Box>
        ))}
      </Box>
    );
  }

  // command / network / path: mostra a verdade literal (`$ cmd` já vem no exact).
  return (
    <Box flexDirection="column">
      {eff.exact.split('\n').map((line, i) => (
        <Box key={i}>
          <Role name="accent">{theme.box.vertical} </Role>
          <Role name="fg">{line}</Role>
        </Box>
      ))}
    </Box>
  );
}

/**
 * Uma linha de diff com DIREÇÃO no glifo (§2.9 refinado): remoção `‹` em danger,
 * adição `›` em success, contexto em dim. O glifo `‹`/`›` carrega a direção ALÉM
 * da cor (a11y §3.3) — em NO_COLOR/mono nada se perde. Cabeçalhos de hunk do
 * unified diff (`---`/`+++`/`@@`) ficam em dim (meta, não conteúdo).
 */
function DiffLine(props: {
  readonly line: string;
  readonly lang?: string | undefined;
}): React.ReactElement {
  const theme = useTheme();
  const l = props.line;
  // cabeçalhos do unified diff: meta estrutural (não é uma linha de mudança).
  if (l.startsWith('---') || l.startsWith('+++') || l.startsWith('@@')) {
    return <Role name="fgDim">{l}</Role>;
  }
  if (l.startsWith('-')) {
    // SINAL/direção em `danger` (mantém `‹` + vermelho do diff, a11y §3.3); o
    // CONTEÚDO ganha realce de sintaxe — mas tingido p/ não perder o "isto saiu":
    // sem lang, fica tudo `danger`; com lang, realça e o sinal segue em danger.
    return (
      <Text>
        <Role name="danger">{theme.glyph('diffDel')} </Role>
        <HighlightedCode code={l.slice(1)} lang={props.lang} fallback="danger" />
      </Text>
    );
  }
  if (l.startsWith('+')) {
    return (
      <Text>
        <Role name="success">{theme.glyph('diffAdd')} </Role>
        <HighlightedCode code={l.slice(1)} lang={props.lang} fallback="success" />
      </Text>
    );
  }
  return <Role name="fgDim">{l}</Role>;
}

/**
 * Conteúdo de uma linha (de diff) realçado por sintaxe. Sem `lang` (ou linha
 * vazia) ⇒ um único papel `fallback` (mantém o verde/vermelho do sinal de diff).
 */
function HighlightedCode(props: {
  readonly code: string;
  readonly lang?: string | undefined;
  readonly fallback: 'danger' | 'success' | 'fg';
}): React.ReactElement {
  if (props.lang === undefined || props.code === '') {
    return <Role name={props.fallback}>{props.code}</Role>;
  }
  const segs = highlightToSegments(props.code, props.lang);
  return (
    <Text>
      {segs.map((s, i) => (
        <Role key={i} name={s.role}>
          {s.text}
        </Role>
      ))}
    </Text>
  );
}
