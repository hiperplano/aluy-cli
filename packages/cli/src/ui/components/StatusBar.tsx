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
import {
  BUDGET_WARN_PCT,
  buildSidecarChip,
  sidecarChipCell,
  type SidecarUsageView,
  type SidecarUseState,
  type SidecarChipEntry,
} from '@hiperplano/aluy-cli-core';
import { Glyph, Role, useTheme } from '../theme/index.js';
import { BusyPulse } from './BusyPulse.js';
import { progressRatio, renderBar } from './ProgressBar.js';
import {
  abbreviateCount,
  type GovernanceCounts,
  type CycleProgress,
  type McpProgress,
} from '../../session/model.js';
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
  /**
   * F-SALDO-BYO (relato do dono: "está numa posição horrível, deveria ficar após o
   * provedor") — SALDO da conta no provider BYO, já formatado (ex.: `"4.22"`).
   *
   * Aparece na linha PRIMÁRIA, colado no par provider·modelo, porque é informação do
   * MESMO assunto: quem paga a chamada e quanto ainda dá. Antes vinha pelo
   * `<QuotaFooter>`, numa LINHA PRÓPRIA acima do rodapé — órfã, sem contexto, e ocupando
   * uma linha inteira da tela para dois números.
   *
   * Ausente ⇒ o campo não aparece (o provider não expôs saldo, ou é keyless). Mesma
   * disciplina do `quotaPct`: informação, nunca motivo de ruído.
   */
  readonly credit?: string;
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
  /**
   * FATIA 1 (CICLOS/SUBCICLOS) — torna o CICLO DE VIDA DO LOOP VISÍVEL. Quando presente,
   * a barra mostra `↻ ciclo N/M · subciclos K/T` PROMINENTE (accent) logo após o tier/foco
   * — espelhando os campos existentes (governança `⌁`, foco `◎`). `iteration`/`max` = a
   * iteração do CycleEngine; `subcyclesDone`/`subcyclesTotal` = as caixas do plano. Os
   * subciclos só aparecem quando `subcyclesTotal > 0` (há plano). `undefined` ⇒ uso simples
   * (sem indicador). NUNCA cai no narrow (é o estado-de-vida do loop — como o `◷ <tier>`).
   * O knob `ALUY_CYCLE_UI_OFF` (lido pela App) suprime tudo via omitir esta prop.
   */
  readonly cycleProgress?: CycleProgress;
  /**
   * F195 (pedido do dono) — TRABALHO EM CURSO: quando `true`, a barra ganha ao FIM um
   * PULSO de blocos grossos (<BusyPulse>) que enche/esvazia com o `frame` — o "cursor
   * grosso" sinalizando processamento, ADICIONAL ao Λ que pisca e ao verbo vivo. A App
   * liga isto nas fases ativas (thinking/streaming/retrying/compacting). Ausente/false
   * ⇒ sem pulso (idle). Cai no narrow (é supplementar; o tier/⚠ têm prioridade).
   */
  readonly busy?: boolean;
  /**
   * F195 — frame do tick central que anima o <BusyPulse>. Só usado quando `busy`. A
   * StatusBar já re-renderiza a cada frame (EST-0989), então o pulso avança junto.
   */
  readonly frame?: number;
  /**
   * EST-MCP-STATUSBAR (pedido do dono) — progresso da CONEXÃO dos servers MCP em
   * background (boot desacoplado). Quando presente e AINDA conectando (`done:false`),
   * a barra ganha um indicador discreto `MCP ▰▰▱ 2/3`; quando `done:true`, um ✓ rápido
   * (`✓ MCP 3/3`, ou "· N falhou" se algum server falhou) — some sozinho ~2s depois (o
   * controller limpa o campo). `undefined` ⇒ sem MCP configurado neste boot, ou já
   * concluiu + expirou ⇒ SEM indicador (zero ruído). NUNCA vira nota na conversa —
   * antes disto o boot desacoplado empurrava "conectando N…"/"M/N conectados" como
   * nota; o dono pediu p/ tirar isso da tela principal. Supplementar: cai no narrow
   * (mesmo critério do `busy`/<BusyPulse> — não é estado de roteamento crítico).
   */
  readonly mcpProgress?: McpProgress;
  /**
   * F-SIDECAR-USO (pedido do dono) — USO REAL dos sidecars do modo turbo. Rende um chip
   * `◈ sidecars hdr·12 oll·3 mem✗` logo antes dos medidores, com CADA sidecar em um de
   * 3 estados: **usado** (accent + o nº de consultas aproveitadas), **de pé mas ocioso**
   * (fgDim, só o código) e **fora** (fgDim + `✗`).
   *
   * O PORQUÊ do campo: o `/doctor` já dizia se o sidecar responde a `GET /health`, mas
   * "de pé" é o estado normal no turbo — não informa nada. O que faltava era saber se
   * ele foi CONSULTADO. Por isso o número é de chamadas APROVEITADAS: as que degradaram
   * (fail-open) contam como falha e derrubam o estado p/ `fora`, não p/ "ocioso".
   *
   * `undefined` (perfil leve, sem medidor armado) ⇒ NADA é renderizado — o
   * `buildSidecarChip` também devolve `undefined` fora do turbo, então quem roda leve
   * não paga um pixel. Droppable no narrow? NÃO: só encolhe o rótulo (ver `.narrow`) —
   * saber se a máquina de sidecars está trabalhando é o ponto do modo turbo.
   */
  readonly sidecarUsage?: SidecarUsageView;
}

/** Papel de cor do `⛁ janela %` por nível (§4). */
/** LOTE-2 — soma das contagens de governança (p/ omitir o campo quando nada carregou). */
export function govTotal(g: GovernanceCounts): number {
  return g.agents + g.commands + g.skills + g.workflows + g.memory;
}

export function windowRole(pct: number): 'fgDim' | 'accent' | 'danger' {
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
 * F-SIDECAR-USO (fix de largura) — CUSTO EM COLUNAS do chip `◈ sidecars hdr oll mem`,
 * medido do que será DE FATO impresso (não estimado).
 *
 * O PORQUÊ: o `MODEL_MIN_COLS` acima foi calibrado (EST-1015/#24) para a barra SEM o
 * chip — tier+modelo+cwd+medidores ≈ 90 col. A rc.108 pendurou o chip na MESMA linha
 * (+~23 col no caso ocioso, +~30 com contadores de 2 dígitos) e NÃO recalibrou o
 * limiar. Resultado observado no binário real, em ~90–115 col: a soma dos nós passa de
 * `columns`, o Ink quebra NOS LIMITES dos nós e a barra vira DUAS linhas embaralhadas —
 * e o que visivelmente "some" é justamente o chip (é o último campo antes dos
 * medidores, e o rótulo `sidecars` é o pedaço mais longo a ser empurrado p/ a 2ª
 * linha). Ou seja: o chip não estava faltando, estava sendo PICADO pela largura —
 * exatamente o garble que o #24 já tinha consertado uma vez p/ o modelo.
 *
 * MEDIR (em vez de somar uma constante) importa porque o chip CRESCE com o uso:
 * `hdr oll mem` (ocioso) → `hdr·12 oll·3 mem·7` (em regime). Um limiar fixo acertaria
 * o boot e erraria a sessão longa — que é exatamente quando o dono olha a barra.
 *
 * Conta: 1 espaço + glifo (`◈`=1, `sc:`=3) + 1 espaço + rótulo + Σ(1 espaço + célula).
 */
function sidecarChipCols(
  chip: readonly SidecarChipEntry[],
  label: string,
  glyph: string,
  ascii: boolean,
): number {
  const cells = chip.reduce((acc, e) => acc + 1 + sidecarChipCell(e, ascii).length, 0);
  return 1 + glyph.length + 1 + label.length + cells;
}

/**
 * EST-MCP-STATUSBAR — largura (em células) da barrinha `MCP ▰▰▱` enquanto os servers
 * conectam. Curta de propósito — é um indicador DISCRETO, não uma <ProgressBar> cheia
 * (essa é `DEFAULT_BAR_WIDTH=12`, pensada p/ ocupar sozinha uma linha da região viva).
 */
const MCP_BAR_WIDTH = 6;

/**
 * EST-0948 — papel de cor do `◔ sessão %` por nível: dim normal; AVISO (accent) ao
 * cruzar BUDGET_WARN_PCT (~70%); danger nos ≥100% (no teto/estourado). É o sinal
 * ANTECIPADO antes da pausa do gate.
 */
export function budgetRole(pct: number): 'fgDim' | 'accent' | 'danger' {
  if (pct >= 100) return 'danger';
  if (pct >= BUDGET_WARN_PCT) return 'accent';
  return 'fgDim';
}

/**
 * F-SIDECAR-USO — papel de cor por ESTADO do sidecar (nunca cor crua, §3.1/ADR-0041):
 *   • `used` ⇒ `accent` — ACENDE, exatamente como o tier ≠ default e o chip de foco. É
 *     o sinal que o dono pediu: "este sidecar está trabalhando nesta sessão".
 *   • `idle` ⇒ `fgDim` — de pé, ocioso. Presente sem chamar atenção.
 *   • `off`  ⇒ `fgDim` — fora. NÃO usa `danger`: sidecar fora é degradação PREVISTA e
 *     fail-open (o aluy funciona sem), não erro do turno; `danger` está reservado ao
 *     que exige ação (janela/quota estourada, `⚠` de broker). Quem carrega o "fora" é
 *     o `✗` colado ao código (a11y §3.3: a cor nunca decide sozinha).
 */
export function sidecarRole(state: SidecarUseState): 'fgDim' | 'accent' {
  return state === 'used' ? 'accent' : 'fgDim';
}

/** Papel de cor do `◔ quota %` (#125) por nível do core (70/90%). */
export function quotaRole(level: QuotaWarnLevel): 'fgDim' | 'accent' | 'danger' {
  if (level === 'crit') return 'danger';
  if (level === 'warn') return 'accent';
  return 'fgDim';
}

export function StatusBar(props: StatusBarProps): React.ReactElement {
  const { t } = useI18n();
  const theme = useTheme();
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
  // F-SIDECAR-USO — a DECISÃO (quais aparecem, em que estado) é PURA e mora no core
  // (`buildSidecarChip`, ADR-0053 §8: o cli-core não conhece Ink). Aqui a TUI só pinta.
  // `undefined` ⇒ perfil leve ou sem medidor ⇒ nenhum nó no JSX (zero ruído, zero custo
  // de largura p/ quem não roda turbo).
  // CALCULADO ANTES do `showModel` de propósito: o chip é um campo NOVO na MESMA linha,
  // então ele entra na conta de quem cabe — ver `sidecarChipCols`.
  const sidecarChip =
    props.sidecarUsage !== undefined ? buildSidecarChip(props.sidecarUsage) : undefined;
  const sidecarLabel = showLabels ? t('statusbar.sidecars') : t('statusbar.sidecars.narrow');
  // Custo REAL do chip em colunas (0 quando ele não é renderizado). É o que faz o
  // limiar do modelo acompanhar o crescimento do chip ao longo da sessão.
  const sidecarCols =
    sidecarChip !== undefined
      ? sidecarChipCols(sidecarChip, sidecarLabel, theme.glyph('sidecar'), !theme.unicode)
      : 0;
  // O modelo só entra quando cabe DEPOIS de reservar o chip. Sem o `+ sidecarCols` a
  // barra estourava em ~90–115 col (ver `sidecarChipCols`): o Ink quebrava a linha e o
  // chip aparecia picado/ausente. Dropar o modelo (observabilidade) é o preço certo —
  // é a MESMA escolha que o #24 já fez, só que agora com o campo novo na conta.
  const showModel = (props.columns ?? MODEL_MIN_COLS + sidecarCols) >= MODEL_MIN_COLS + sidecarCols;
  /**
   * F-SALDO-BYO — colunas EXTRAS que o campo de crédito exige para entrar. `· crédito
   * 12.34` custa ~16 colunas; o teto é folgado de propósito, porque o campo é o MENOS
   * importante da linha: primeiro cabe quem identifica a sessão (tier, modelo, path),
   * depois o saldo.
   */
  const CREDIT_EXTRA_COLS = 20;

  // F-RODAPE-NAO-QUEBRA (relato do dono, e confirmado por medição: a barra enrolava em
  // TRÊS linhas em 100, 120 e 150 colunas — com e sem o campo de crédito, então não era
  // ele) — o `cwd` ia CRU para a tela. Um caminho de projeto fundo estoura qualquer
  // largura, o Ink quebra a linha, e a barra inteira vira três linhas picadas: o dono viu
  // `ortest`, `deepseek-v4-pro-081` e o path cortado ao meio.
  //
  // Corta pela CABEÇA, não pela cauda: numa barra de status o que importa é ONDE você
  // está (`…/aluy-recovery/aluy-cli`), não a raiz do sistema de arquivos. Teto
  // PROPORCIONAL à largura — a barra tem outros campos que crescem junto (modelo, tier),
  // e um teto fixo voltaria a estourar em terminal estreito.
  // F-RODAPE-NAO-QUEBRA (2/2) — o SLUG também tem teto. `deepseek/deepseek-v4-pro-0813`
  // são 29 colunas; com tier, path, sidecars, janela, sessão e crédito na mesma linha, é
  // ele que estoura assim que a largura permite exibi-lo (medido: cabia em 80, quebrava
  // em 100+, porque em 80 o campo era dropado e em 100 entrava inteiro).
  //
  // Primeiro cai o VENDOR (`deepseek/`): é redundante — o provider ativo já aparece na
  // mesma linha, logo antes. Só depois vem o corte por caractere, pela CAUDA (o começo do
  // slug é o que identifica a família).
  // F-RODAPE-NAO-QUEBRA (3/3) — os tetos eram INDEPENDENTES (20% p/ o modelo, 30% p/ o
  // path) e por isso não garantiam nada: somados dão metade da barra, e a outra metade
  // (tier, crédito, sidecars, janela, sessão) simplesmente não cabia no que sobrava. Em
  // 140 colunas a linha estourava por UM caractere — o `i` de `aluy-cli` caía sozinho na
  // linha de baixo. Sorte não é margem.
  //
  // Agora o orçamento é ACOPLADO: primeiro se reserva o que os campos fixos custam (eles
  // são os que identificam a sessão e nunca podem ser espremidos), e só o que sobra é
  // repartido entre os dois campos elásticos. Se não sobrar nada, ambos encolhem ao mínimo
  // legível em vez de empurrar a barra para uma segunda linha.
  const larguraBarra = props.columns ?? 80;
  const temCredito =
    props.credit !== undefined &&
    props.credit !== '' &&
    larguraBarra >= MODEL_MIN_COLS + sidecarCols + CREDIT_EXTRA_COLS;
  // Custo medido dos campos fixos: tier com glifo (~10), separadores, sidecars (`sidecarCols`),
  // janela (~12) e sessão (~14). O crédito entra só quando de fato será desenhado.
  const RESERVA_FIXA = 10 + 12 + 14 + 4;
  const orcamentoElastico = Math.max(
    24,
    larguraBarra - RESERVA_FIXA - sidecarCols - (temCredito ? CREDIT_EXTRA_COLS : 0),
  );
  // O modelo leva ~40% do elástico e o path o resto: o path é o campo que o dono lê para
  // saber ONDE está, e ele degrada melhor (corta pela cabeça, mantendo as pastas finais).
  const tetoModelo = Math.max(10, Math.floor(orcamentoElastico * 0.4));
  const tetoCwd = Math.max(12, orcamentoElastico - tetoModelo);

  // Primeiro cai o VENDOR (`deepseek/`): é redundante — o provider ativo já aparece na
  // mesma linha, logo antes. Só depois vem o corte por caractere, pela CAUDA (o começo do
  // slug é o que identifica a família).
  const modeloCurto = ((): string | undefined => {
    const cru = props.model;
    if (cru === undefined || cru === '') return cru;
    if (cru.length <= tetoModelo) return cru;
    const semVendor = cru.includes('/') ? (cru.split('/').pop() ?? cru) : cru;
    if (semVendor.length <= tetoModelo) return semVendor;
    return `${semVendor.slice(0, Math.max(1, tetoModelo - 1))}…`;
  })();

  // Corta pela CABEÇA, não pela cauda: numa barra de status o que importa é ONDE você
  // está (`…/aluy-recovery/aluy-cli`), não a raiz do sistema de arquivos.
  const cwdCurto = ((): string => {
    const cru = props.cwd;
    if (cru.length <= tetoCwd) return cru;
    // Corta em fronteira de PASTA quando dá — meio-nome de diretório não ajuda ninguém.
    const partes = cru.split('/').filter((x) => x !== '');
    let acc = '';
    for (let i = partes.length - 1; i >= 0; i--) {
      const proximo = `/${partes[i]}${acc}`;
      if (proximo.length + 1 > tetoCwd) break;
      acc = proximo;
    }
    return acc === '' ? `…${cru.slice(cru.length - tetoCwd + 1)}` : `…${acc}`;
  })();

  // EST-0989 (#125) — o `◔ quota` só entra quando o broker reportou consumo de janela.
  const hasQuota = props.quotaPct !== undefined;
  const qRole = quotaRole(props.quotaLevel ?? 'ok');

  // EST-MCP-STATUSBAR — a barrinha `MCP ▰▰▱ 2/3` só existe enquanto AINDA conecta
  // (`done:false`); ao terminar a barra vira o ✓/aviso (renderizado direto no JSX
  // abaixo, sem célula-por-célula). `mcpFailed` alimenta os DOIS ramos (cor do ✓ e o
  // "· N falhou" discreto).
  const mcpProgress = props.mcpProgress;
  const mcpFailed = mcpProgress?.failed ?? 0;
  const mcpBar =
    mcpProgress !== undefined && !mcpProgress.done
      ? renderBar(
          progressRatio(mcpProgress.connected + mcpProgress.failed, mcpProgress.total),
          theme.glyph('barFull'),
          theme.glyph('barEmpty'),
          MCP_BAR_WIDTH,
          theme.unicode,
        )
      : undefined;

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
          <Role name="depth">{modeloCurto}</Role>
        </>
      )}
      {/* F-SALDO-BYO — o saldo COLADO no provider·modelo: mesmo assunto, mesma linha.
          DROPA junto com o modelo em largura apertada, e ainda exige folga PRÓPRIA
          (`CREDIT_EXTRA_COLS`): sem isto a linha estourava e o Ink truncava TODOS os
          campos — o dono viu `ortest`, `deepseek-v4-pro-081` e o path picado ao meio.
          Campo de observabilidade nunca pode espremer o que identifica a sessão. */}
      {props.credit !== undefined &&
        props.credit !== '' &&
        showModel &&
        (props.columns ?? 0) >= MODEL_MIN_COLS + sidecarCols + CREDIT_EXTRA_COLS && (
        <>
          <Role name="fgDim"> · </Role>
          <Role name="depth">crédito {props.credit}</Role>
        </>
      )}

      {/* ADR-0126(A) — chip de FOCO 1:1 (`/subagent`): você fala SÓ com este sub-agente. Em
          `accent` (acende como o tier ≠ default); NUNCA dropa no narrow (estado de roteamento
          crítico — igual ao `◷ <tier>`). `/back` o limpa. */}
      {props.focus !== undefined && props.focus !== '' && (
        <Role name="accent"> ◎ foco: {props.focus}</Role>
      )}

      {/* FATIA 1 (CICLOS/SUBCICLOS) — o CICLO DE VIDA DO LOOP, PROMINENTE (accent), logo
          após o tier/foco: `↻ ciclo N/M · subciclos K/T`. CICLO ≡ iteração do CycleEngine;
          SUBCICLO ≡ caixa do plano (só aparece quando há plano, total>0). Espelha os campos
          existentes (governança `⌁`, foco `◎`). NÃO cai no narrow (estado-de-vida do loop). */}
      {props.cycleProgress !== undefined && (
        <Role name="accent">
          {' '}
          ↻ {t('statusbar.cycle')} {props.cycleProgress.iteration}/{props.cycleProgress.max}
          {props.cycleProgress.subcyclesTotal > 0 &&
            ` · ${t('statusbar.subcycles')} ${props.cycleProgress.subcyclesDone}/${props.cycleProgress.subcyclesTotal}`}
        </Role>
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
          <Role name="fgDim">{cwdCurto}</Role>
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

      {/* F-SIDECAR-USO (pedido do dono) — CHIP DE USO dos sidecars do modo turbo, logo
          ANTES dos medidores: `◈ sidecars hdr·12 oll·3 mem✗`. Cada código acende em
          `accent` COM o número de consultas aproveitadas (usado), fica `fgDim` seco
          (de pé, ocioso) ou ganha `✗` (fora). Responde o que o health-probe do
          `/doctor` não responde — "está sendo USADO?", não "está de pé?".
          NARROW (<60 col): o chip PERMANECE (é o estado da máquina do turbo, como o
          `↻ ciclo`), só o rótulo encolhe p/ a forma `.narrow` — enquanto o `cwd`, o
          `(8.2k)` e os rótulos dos medidores já caíram. Em `--ascii` o `◈` vira `sc:`
          e o `✗` vira `x` (a11y §3.3: nunca depender de glifo/cor sozinhos). */}
      {sidecarChip !== undefined && (
        <>
          <Text> </Text>
          <Glyph name="sidecar" role="fgDim" />
          <Role name="fgDim"> {sidecarLabel}</Role>
          {sidecarChip.map((entry) => (
            <Role key={entry.kind} name={sidecarRole(entry.state)}>
              {' '}
              {sidecarChipCell(entry, !theme.unicode)}
            </Role>
          ))}
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

      {/* F195 — PULSO "trabalhando" (blocos grossos que enchem/esvaziam) no FIM da barra,
          quando o agente processa. Supplementar (some no narrow); deriva do `frame`. */}
      {props.busy === true && !narrow && (
        <>
          <Text> </Text>
          <BusyPulse {...(props.frame !== undefined ? { frame: props.frame } : {})} />
        </>
      )}

      {/* EST-MCP-STATUSBAR (pedido do dono) — progresso da CONEXÃO dos servers MCP em
          background (boot desacoplado): SÓ aqui, nunca como nota na conversa. Enquanto
          conecta (`!done`): barrinha discreta `MCP ▰▰▱ 2/3`. Ao terminar (`done`): um ✓
          rápido (`success` sem falha) ou um aviso discreto (`accent` + "· N falhou"),
          que SOME sozinho ~2s depois — o controller limpa `mcpProgress` (a StatusBar não
          tem timer próprio). Supplementar: cai no narrow (mesmo critério do <BusyPulse>). */}
      {mcpProgress !== undefined && !narrow && (
        <>
          <Text> </Text>
          {mcpProgress.done ? (
            <>
              <Glyph name="ok" role={mcpFailed > 0 ? 'accent' : 'success'} />
              <Role name={mcpFailed > 0 ? 'accent' : 'success'}>
                {' '}
                MCP {mcpProgress.connected}/{mcpProgress.total}
                {mcpFailed > 0 ? ` · ${mcpFailed} ${t('statusbar.mcpFailed')}` : ''}
              </Role>
            </>
          ) : (
            <>
              <Role name="fgDim">MCP </Role>
              <Role name="accent">{mcpBar!.filled}</Role>
              <Role name="fgDim">{mcpBar!.rest}</Role>
              <Role name="fgDim">
                {' '}
                {mcpProgress.connected + mcpProgress.failed}/{mcpProgress.total}
              </Role>
            </>
          )}
        </>
      )}
    </Box>
  );
}
