// EST-0948 (footer de QUOTA — #61 · ADR-0069/APR-0074) — <QuotaFooter>: a QUOTA da
// PRÓPRIA conta do ator CLI/PAT vinda do BROKER (broker#59).
//
// FONTES REAIS:
//   • `quota` (de `state.meta.quota`) = saldo de CRÉDITO (dimensão PRIMÁRIA do CLI) +
//     janelas (5h/semana), do `GET /v1/quota` (boot/refresh) + dos campos achatados do
//     `usage` (loop quente). Renderiza `crédito: <saldo>` e, quando há janela COM teto,
//     `5h: 42% · reseta em 2h13`.
//   • `serverLimits` (de `state.meta.serverLimits`) = o `balance_after` do `usage` —
//     surfaça o crédito JÁ no 1º turno (antes do `/v1/quota` chegar) e ancora o aviso de
//     saldo baixo. Fallback complementar à `quota` (ambos do broker, nunca inventados).
//
// ADR-0069 CRAVA: o CLI mostra CRÉDITO como controle PRIMÁRIO (ledger ADR-0038, hard-cap
// 402), NÃO a janela 5h+semanal do app (ADR-0051) — essa estoura em minutos sob um loop
// agêntico (ADR-0053 §4). A janela só aparece QUANDO o broker a reportar (em dev/PAT sem
// janela, `windows:[]` ⇒ ela some); o crédito é a dimensão que de fato barra o CLI.
//
// É BILLING (do broker), DISTINTA do budget LOCAL anti-runaway que mora no <StatusBar>
// (`◷ % · ⛁ %`): RÓTULOS explícitos (`crédito`/`5h`/`semana`) p/ o olho não confundir os
// dois. O fail-safe LOCAL (CLI-SEC-8, o `◷`) NÃO aparece aqui.
//
// DEGRADAÇÃO (oculto): sem NENHUMA fonte aproveitável (sem crédito, sem janela, sem
// saldo) ⇒ o componente NÃO renderiza NADA (`null` — ADR-0069 §degradação: omite o
// widget, não inventa número). O estado dev real (`{windows:[], balance:null}`) cai aqui
// ⇒ footer OCULTO. Acende sozinho quando o broker mandar dado. Zero ruído antes.
//
// CORES por NÍVEL (consistente com o aviso de 70% do budget local — §4): ok < 70%
// (dim) · warn 70–89% (âmbar/accent) · crit ≥ 90% (vermelho/danger). O crédito baixo
// pinta `crit`. Apresentação pura (papéis do DS); o cálculo é puro/testável no core.

import React from 'react';
import { Box, Text } from 'ink';
import {
  formatQuota,
  formatServerLimits,
  type Quota,
  type QuotaLevel,
  type ServerLimits,
  type ServerLimitLevel,
} from '@aluy/cli-core';
import { Role } from '../theme/index.js';

export interface QuotaFooterProps {
  /**
   * EST-0948 · ADR-0069 — a quota da PRÓPRIA conta (`state.meta.quota`): saldo de CRÉDITO
   * (dimensão PRIMÁRIA) + janelas (5h/semana), do `GET /v1/quota` + dos campos achatados
   * do `usage`. `undefined`/vazio ⇒ `formatQuota` devolve `undefined` ⇒ não renderiza.
   */
  readonly quota?: Quota | undefined;
  /**
   * EST-0948 (server-limits · ADR-0069) — o `balance_after` do `usage` (de
   * `state.meta.serverLimits`). FALLBACK complementar à `quota`: surfaça o crédito JÁ no
   * 1º turno (antes do `/v1/quota` chegar). `undefined` ⇒ não renderiza esta parte.
   */
  readonly serverLimits?: ServerLimits | undefined;
  /** Relógio injetável p/ teste (default `Date.now()`). */
  readonly now?: number;
}

/** Papel de cor por nível (espelha o limiar 70/90% — §4). */
function levelRole(level: QuotaLevel | ServerLimitLevel): 'fgDim' | 'accent' | 'danger' {
  if (level === 'crit') return 'danger';
  if (level === 'warn') return 'accent';
  return 'fgDim';
}

export function QuotaFooter(props: QuotaFooterProps): React.ReactElement | null {
  const quotaView = formatQuota(props.quota, props.now);
  const serverView = formatServerLimits(props.serverLimits, props.now);
  // DEGRADA: NENHUMA fonte ⇒ NÃO renderiza (oculto, zero ruído).
  if (quotaView === undefined && serverView === undefined) return null;

  // O CRÉDITO da `quota` (de `/v1/quota`) é a dimensão PRIMÁRIA; quando ausente, o
  // `serverView` (de `balance_after`) ainda surfaça o saldo. Evita DUPLICAR "crédito":
  // se a `quota` já trouxe `creditBalance`, não repintamos o crédito do `serverView`.
  const creditFromQuota = quotaView?.creditBalance;
  const showServerCredit = creditFromQuota === undefined && serverView !== undefined;

  return (
    <Box paddingLeft={2}>
      {/* CRÉDITO (primário — ADR-0069) da `quota`: `crédito: <saldo>`. */}
      {creditFromQuota !== undefined && (
        <>
          <Role name="fgDim">crédito: </Role>
          <Role name={levelRole(quotaView?.maxLevel ?? 'ok')}>{creditFromQuota}</Role>
        </>
      )}
      {/* Janelas (5h/semana) da `quota`, quando o broker as reporta (COM teto). */}
      {quotaView !== undefined &&
        quotaView.segments.map((seg, i) => (
          <React.Fragment key={`q-${seg.label}`}>
            {(i > 0 || creditFromQuota !== undefined) && <Role name="fgDim"> · </Role>}
            {/* `5h:` / `semana:` SEMPRE dim (rótulo); o % pinta por nível. */}
            <Role name="fgDim">{seg.label}: </Role>
            <Role name={levelRole(seg.level)}>{seg.pct}%</Role>
          </React.Fragment>
        ))}
      {quotaView?.resetText !== undefined && (
        <>
          <Text> </Text>
          <Role name="fgDim">· {quotaView.resetText}</Role>
        </>
      )}
      {/* Separador entre as duas fontes quando o `serverView` (crédito de fallback) aparece. */}
      {quotaView !== undefined && showServerCredit && <Role name="fgDim"> · </Role>}
      {showServerCredit &&
        serverView.segments.map((seg, i) => (
          <React.Fragment key={`s-${seg.label}`}>
            {i > 0 && <Role name="fgDim"> · </Role>}
            <Role name="fgDim">{seg.label}: </Role>
            <Role name={levelRole(seg.level)}>{seg.value}</Role>
          </React.Fragment>
        ))}
      {showServerCredit && serverView.resetText !== undefined && (
        <>
          <Text> </Text>
          <Role name="fgDim">· {serverView.resetText}</Role>
        </>
      )}
    </Box>
  );
}
