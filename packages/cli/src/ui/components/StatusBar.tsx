// EST-0948 · spec §4.2 / EST-0989 (Variação B) — <StatusBar>: o RODAPÉ VIVO, com o
// TIER promovido a 1º campo. Ordem (linha primária):
//   ◷ <tier> → <cwd> → ⛁ NN% janela → ◔ NN% sessão (8.2k) → ◔ NN% quota → [⚠]
//
// EST-0989 — o TIER abre a barra (`◷ <tier>`, Variação B aprovada): é o ganho central
// — "trocar e enxergar". O <StatusBar> RE-RENDERIZA a cada frame, então ao trocar
// `/model` o tier acende AQUI (≠ do <Header>, chrome estático pinado no `<Static>`).
//   • `accent` quando o tier ≠ default (granito/strata/deep/custom "acendem");
//   • `fg` quando é o tier DEFAULT (neutro).
//   • via Custom (ADR-0030 §3): `◷ custom · <slug>` — o slug em `depth`, NUNCA
//     credencial/provider (HG-2). Custom é sempre ≠ default ⇒ acende.
//
// EST-0948 — RÓTULOS explícitos (`janela`/`sessão`/`quota`) p/ o olho não confundir os
// medidores (antes `⛁ 27%` ambíguo). O `◔ sessão` é o % do TETO DA SESSÃO de tokens
// consumido (o número cru é difícil de visualizar), com o cru `(8.2k)` como detalhe;
// aos ~70% ganha `⚠` ANTES de pausar nos 100% no gate. O `⛁ janela` é o % da janela de
// CONTEXTO. O `◔ quota` (#125) é o consumo de BILLING (janela 5h/semana do broker),
// no FIM da linha primária. Níveis de cor (CLI-SEC-8 / §4): dim < 75% (janela) / < 70%
// (sessão/quota) → accent (aviso) → danger (>90%).
//
// EST-0989 — DEGRADAÇÃO narrow (suprime, nesta ordem de descarte): `(8.2k)` → rótulos
// textuais → `cwd`. NUNCA cai o `◷ <tier>` (o 1º campo) NEM o `⚠` de aviso/erro.

import React from 'react';
import { Box, Text } from 'ink';
import { BUDGET_WARN_PCT } from '@hiperplano/aluy-cli-core';
import { Glyph, Role } from '../theme/index.js';
import { abbreviateCount, type GovernanceCounts } from '../../session/model.js';
import { useI18n } from '../../i18n/index.js';

/** Nível de consumo de quota (#125) — espelha os limiares do core (70/90%). */
export type QuotaWarnLevel = 'ok' | 'warn' | 'crit';

export interface StatusBarProps {
  readonly branch?: string;
  readonly cwd: string;
  readonly tier: string;
  /**
   * EST-0989 — o tier é o DEFAULT da sessão? `true` ⇒ pinta em `fg` (neutro); `false`
   * (granito/strata/deep/custom) ⇒ `accent` (acende: "trocou o modelo"). Default
   * `true` (compat: sem o sinal, trata como default ⇒ neutro). A App resolve isso
   * comparando `meta.tier` com o `DEFAULT_TIER`.
   */
  readonly isDefaultTier?: boolean;
  /**
   * EST-0962 (Custom, ADR-0030 §3) — slug da via Custom. Quando presente, a barra
   * mostra `tier · <slug>` (ex.: `custom · meta-llama/llama-3.1-8b`). É NOME de
   * modelo escolhido pelo usuário — NUNCA credencial/provider de roteamento (HG-2).
   */
  readonly model?: string;
  /** Tokens CRUS (detalhe `(8.2k)` do `◔ sessão`, e fallback quando não há teto). */
  readonly tokens: number;
  /**
   * EST-0948 — % do TETO DA SESSÃO de tokens consumido (display PRIMÁRIO do `◔ sessão`).
   * `undefined` ⇒ sessão sem teto de tokens: o `◔` cai no número cru de tokens.
   */
  readonly budgetPct?: number;
  readonly windowPct: number;
  /**
   * EST-0989 (#125) — % de consumo de QUOTA (billing, janela do broker) p/ o `◔ quota`
   * no FIM da linha primária. `undefined` ⇒ o broker não reportou janela ⇒ o campo de
   * quota NÃO aparece (degrada/oculto — zero ruído; o crédito/reset ricos seguem no
   * <QuotaFooter> em repouso). O nível de cor vem de `quotaLevel`.
   */
  readonly quotaPct?: number;
  readonly quotaLevel?: QuotaWarnLevel;
  /**
   * EST-0989 — largura do terminal (colunas) p/ a DEGRADAÇÃO narrow: <60 col suprime
   * `(8.2k)`, os rótulos textuais e o `cwd` (mantém só glifo+%), nesta ordem. Ausente
   * ⇒ assume largo (mostra tudo). O `◷ <tier>` e o `⚠` NUNCA caem.
   */
  readonly columns?: number;
  /** `true` quando há erro de broker — barra ganha `⚠` ao fim (§2.11). */
  readonly error?: boolean;
  /**
   * LOTE-2 (governança .aluy/) — contagens do que foi carregado (agentes/comandos/skills/
   * workflows/memória). Quando presente E há ALGO carregado, a barra mostra `⌁ Na·Cc·Ss·Ww·Mm`
   * (droppable no narrow). `undefined`/tudo-zero ⇒ omitido (zero ruído em projeto sem `.aluy/`).
   */
  readonly governance?: GovernanceCounts;
  /**
   * ADR-0126(A) — NOME do sub-agente em FOCO 1:1 (`/subagent <nome>`). Quando setado, a barra
   * mostra um chip `◎ foco: <nome>` em `accent` logo após o tier — pra você LEMBRAR que está
   * falando SÓ com o sub-agente. `undefined` = sessão principal (sem chip). NUNCA cai no narrow
   * (é estado de roteamento crítico — como o `◷ <tier>`).
   */
  readonly focus?: string;
}

/** Papel de cor do `⛁ janela %` por nível (§4). */
/** LOTE-2 — soma das contagens de governança (p/ omitir o campo quando nada carregou). */
function govTotal(g: GovernanceCounts): number {
  return g.agents + g.commands + g.skills + g.workflows + g.memory;
}

function windowRole(pct: number): 'fgDim' | 'accent' | 'danger' {
  if (pct > 90) return 'danger';
  if (pct >= 75) return 'accent';
  return 'fgDim';
}

/**
 * EST-1015 (#24) — largura MÍNIMA (em colunas) p/ exibir o `· <modelo>` no 1º campo.
 * Abaixo disso o modelo é dropado p/ a barra não estourar+embaralhar (tier+modelo+cwd+
 * medidores ≈ 90 col no caso típico — modelo ~26ch + cwd ~24ch + 3 medidores). O `◷
 * <tier>` permanece sempre. Conservador (alto) de propósito: garble é pior que ocultar
 * um detalhe de observabilidade.
 */
const MODEL_MIN_COLS = 90;

/**
 * EST-0948 — papel de cor do `◔ sessão %` por nível: dim normal; AVISO (accent) ao
 * cruzar BUDGET_WARN_PCT (~70%); danger nos ≥100% (no teto/estourado). É o sinal
 * ANTECIPADO antes da pausa do gate.
 */
function budgetRole(pct: number): 'fgDim' | 'accent' | 'danger' {
  if (pct >= 100) return 'danger';
  if (pct >= BUDGET_WARN_PCT) return 'accent';
  return 'fgDim';
}

/** Papel de cor do `◔ quota %` (#125) por nível do core (70/90%). */
function quotaRole(level: QuotaWarnLevel): 'fgDim' | 'accent' | 'danger' {
  if (level === 'crit') return 'danger';
  if (level === 'warn') return 'accent';
  return 'fgDim';
}

export function StatusBar(props: StatusBarProps): React.ReactElement {
  const { t } = useI18n();
  const wRole = windowRole(props.windowPct);
  // EST-0948 — quando há teto de tokens, o `◔ sessão` é o % do budget (+ aviso aos
  // 70%); o número cru fica como detalhe `(8.2k)`. Sem teto, mostra só o cru.
  const hasBudget = props.budgetPct !== undefined;
  const bRole = hasBudget ? budgetRole(props.budgetPct!) : 'fgDim';
  const warn = hasBudget && props.budgetPct! >= BUDGET_WARN_PCT;

  // EST-0989 — o tier acende (accent) quando ≠ default; neutro (fg) no default.
  // `isDefaultTier` ausente ⇒ trata como default (compat). Custom é sempre ≠ default.
  const isDefault = props.isDefaultTier ?? true;
  const tierRole = isDefault ? 'fg' : 'accent';

  // EST-0989 — degradação narrow (<60 col): suprime `(8.2k)`, os RÓTULOS textuais e o
  // `cwd`. Mantém glifo+% e — sempre — o `◷ <tier>` e o `⚠`. `columns` ausente ⇒ largo.
  const narrow = (props.columns ?? 80) < 60;
  const showLabels = !narrow;
  const showRaw = !narrow;
  const showCwd = !narrow;
  // EST-1015 (#24 — fix do embaralhamento em largura média) — o MODELO é o campo MAIS
  // LONGO e o MENOS crítico (observabilidade). A StatusBar é um Box-row de vários nós;
  // se a soma passa de `columns`, o Ink quebra NOS LIMITES dos nós e a barra vira um
  // emaranhado (visto em ~60 col após o #378 somar `· <modelo>`). Então o modelo só
  // entra quando há largura folgada p/ tier+modelo+cwd+medidores SEM estourar; abaixo
  // disso, dropa (o `◷ <tier>` — que importa — NUNCA cai). Sem `columns` ⇒ assume largo.
  const showModel = (props.columns ?? MODEL_MIN_COLS) >= MODEL_MIN_COLS;

  // EST-0989 (#125) — o `◔ quota` só entra quando o broker reportou consumo de janela.
  const hasQuota = props.quotaPct !== undefined;
  const qRole = quotaRole(props.quotaLevel ?? 'ok');

  return (
    <Box>
      {/* ── 1º campo: TIER (◷), promovido — re-renderiza ao trocar /model ─────────── */}
      <Glyph name="clock" role={tierRole} />
      <Role name={tierRole}> {props.tier}</Role>
      {props.model !== undefined && props.model !== '' && showModel && (
        <>
          {/* `◷ <tier> · <modelo>` — Custom (slug do usuário) OU resolvido do tier (usage.model).
              Nome de modelo público, nunca credencial (HG-2). Dropado em largura apertada. */}
          <Role name="fgDim"> · </Role>
          <Role name="depth">{props.model}</Role>
        </>
      )}

      {/* ADR-0126(A) — chip de FOCO 1:1 (`/subagent`): você fala SÓ com este sub-agente. Em
          `accent` (acende como o tier ≠ default); NUNCA dropa no narrow (estado de roteamento
          crítico — igual ao `◷ <tier>`). `/back` o limpa. */}
      {props.focus !== undefined && props.focus !== '' && (
        <Role name="accent"> ◎ foco: {props.focus}</Role>
      )}

      {/* ── cwd (suprimido em narrow) ──────────────────────────────────────────────── */}
      {showCwd && (
        <>
          <Text> </Text>
          {props.branch !== undefined && props.branch !== '' && (
            <>
              <Glyph name="branch" role="fgDim" />
              <Role name="fgDim"> {props.branch} </Role>
            </>
          )}
          <Role name="fgDim">{props.cwd}</Role>
        </>
      )}

      {/* LOTE-2 (pedido do dono) — CONTADORES da governança `.aluy/` carregada:
          `⌁ Na·Cc·Ss·Ww·Mm` (agentes·comandos·skills·workflows·memória). Droppable no narrow
          (junto do cwd); omitido quando NADA foi carregado (projeto sem `.aluy/` ⇒ zero ruído).
          O `/stat` traz a legenda + os nomes. */}
      {showCwd && props.governance !== undefined && govTotal(props.governance) > 0 && (
        <>
          <Text> </Text>
          <Role name="fgDim">
            ⌁ {props.governance.agents}a·{props.governance.commands}c·{props.governance.skills}s·
            {props.governance.workflows}w·{props.governance.memory}m
          </Role>
        </>
      )}

      {/* ── ⛁ janela (% da janela de contexto) ─────────────────────────────────────── */}
      <Text> </Text>
      <Glyph name="window" role={wRole} />
      <Role name={wRole}> {props.windowPct}%</Role>
      {showLabels && <Role name="fgDim"> {t('statusbar.window')}</Role>}

      {/* ── ◔ sessão (% do teto de tokens; cru `(8.2k)` como detalhe) ───────────────── */}
      <Text> </Text>
      <Glyph name="gauge" role={bRole} />
      {hasBudget ? (
        <>
          <Role name={bRole}> {props.budgetPct}%</Role>
          {warn && <Role name="accent"> ⚠</Role>}
          {showLabels && <Role name="fgDim"> {t('statusbar.session')}</Role>}
          {showRaw && <Role name="fgDim"> ({abbreviateCount(props.tokens)})</Role>}
        </>
      ) : (
        <>
          <Role name="fgDim"> {abbreviateCount(props.tokens)}</Role>
          {showLabels && <Role name="fgDim"> {t('statusbar.session')}</Role>}
        </>
      )}

      {/* ── ◔ quota (#125 — billing; só quando o broker reporta janela) ─────────────── */}
      {hasQuota && (
        <>
          <Text> </Text>
          <Glyph name="gauge" role={qRole} />
          <Role name={qRole}> {props.quotaPct}%</Role>
          {showLabels && <Role name="fgDim"> {t('statusbar.quota')}</Role>}
        </>
      )}

      {/* ── ⚠ erro de broker — NUNCA cai (nem em narrow) ───────────────────────────── */}
      {props.error && (
        <>
          <Text> </Text>
          <Glyph name="ask" role="danger" />
        </>
      )}
    </Box>
  );
}
