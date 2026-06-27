// EST-0962 · spec §2.13 — <ModelPicker>: seletor de modelo (TIERS + via CUSTOM).
//
// `/model` abre este picker (mesma MECÂNICA/teclas do <SlashMenu>/<FilePicker>: ↑↓
// navega; enter seleciona; esc fecha). Cada item de tier = `tier · nome amigável do
// modelo · sinal de custo` (ex.: `Strata · Claude 3.5 Sonnet · padrão`). O tier ATIVO
// ganha um marcador `●` (a11y: não só cor); o selecionado leva o prefixo `›` em accent.
// Tokens-only (papéis do DS). Apresentação PURA — a captura de teclas é da App.
//
// CUSTOM (ADR-0030 §3 / ADR-0065): a ÚLTIMA linha é `Custom · navegar modelos`. Ao
// confirmá-la, o picker entra no modo CUSTOM, que é um BROWSER NAVEGÁVEL da lista
// dedicada (`/v1/models/custom`, os ~339 modelos): digitar FILTRA, ↑↓ navegam a janela
// (scroll), `t` alterna "só com tools", enter na linha REALÇADA seleciona o `id`. Cada
// linha mostra `id`, `family`, `context` e um BADGE de tools (`✓ tools`/`— tools`/
// neutro). Selecionar um modelo sem tools dispara um aviso curto (warn-but-allow:
// avisa mas DEIXA usar). Sem catálogo (401/erro) ⇒ DEGRADA p/ texto-livre puro (digita/
// cola o slug à mão, sem browser/sugestão/aviso). HG-2: mostra `id`/`name`/`family`/
// `context`/`supports_tools` PÚBLICOS — NUNCA credencial/roteamento. O broker revalida.

import React from 'react';
import { Box, Text } from 'ink';
import { Role } from '../theme/index.js';
import { useI18n } from '../../i18n/index.js';
import type { TierCatalogEntry, EffortOption } from '@hiperplano/aluy-cli-core';
import { principalModel, costLabel } from '../../model/catalog.js';
import type { CustomBrowseRow } from '../hooks/useModelPicker.js';
import type { I18nKey } from '../../i18n/index.js';

/** Rótulo i18n de cada opção de effort (id → chave do catálogo). Tipado p/ strict. */
const EFFORT_LABEL_KEY: Record<string, I18nKey> = {
  keep: 'picker.effort.keep',
  low: 'picker.effort.low',
  medium: 'picker.effort.medium',
  high: 'picker.effort.high',
  custom: 'picker.effort.custom',
};

export interface ModelPickerProps {
  readonly tiers: readonly TierCatalogEntry[];
  /** Índice selecionado (navegado por ↑↓). `tiers.length` = a linha CUSTOM. */
  readonly selected: number;
  /** Tier ATIVO da sessão (marcado com `●`). */
  readonly currentTier: string;
  /** Catálogo ainda carregando (1ª abertura). */
  readonly loading?: boolean;
  /** Lista é o FALLBACK (broker indisponível) ⇒ aviso neutro. */
  readonly usingFallback?: boolean | null;
  // ── via CUSTOM (ADR-0030 §3) ───────────────────────────────────────────────
  /** A linha CUSTOM está selecionada? */
  readonly customSelected?: boolean;
  /** O modo CUSTOM (browser + filtro) está aberto? */
  readonly customInputOpen?: boolean;
  /** O texto digitado até agora (filtro do browser / slug no texto-livre). */
  readonly customInput?: string;
  /** Sugestões de autocomplete (vazio ⇒ texto-livre puro). */
  readonly customSuggestions?: readonly string[];
  /** `true` ⇒ slug fora do catálogo curado (warn-but-allow): mostra o aviso. */
  readonly customWarnOutOfCatalog?: boolean;
  // ── BROWSER Custom (EST-0962) ──────────────────────────────────────────────
  /** A lista CUSTOM carregou ⇒ o browser está disponível (não degradou p/ texto-livre). */
  readonly customBrowserAvailable?: boolean;
  /** A janela VISÍVEL de linhas do browser (já fatiada, com o realce marcado). */
  readonly customRows?: readonly CustomBrowseRow[];
  /** Total de modelos APÓS o filtro (texto + tools) — p/ "N de M". */
  readonly customFilteredCount?: number;
  /** Total de modelos carregados (antes do filtro) — p/ "N de M". */
  readonly customTotalCount?: number;
  /** Há itens ACIMA da janela visível (scroll p/ cima)? */
  readonly customHasMoreAbove?: boolean;
  /** Há itens ABAIXO da janela visível (scroll p/ baixo)? */
  readonly customHasMoreBelow?: boolean;
  /** O filtro "só com tools" está LIGADO? */
  readonly customToolsOnly?: boolean;
  /** `id` do modelo realçado SEM suporte a tools (warn-but-allow) — ou null. */
  readonly customNoToolsWarning?: string | null;
  // ── PASSO de EFFORT (EST-1117, conjugado) ──────────────────────────────────
  /** O passo de EFFORT (2ª etapa) está aberto? ⇒ o picker vira o seletor de effort. */
  readonly effortStepOpen?: boolean;
  /** As opções de effort (manter/low/medium/high/custom) — DADO puro do core. */
  readonly effortOptions?: readonly EffortOption[];
  /** Índice selecionado no passo de effort. */
  readonly effortSelected?: number;
  /** O `reasoning_effort` ATIVO da sessão (marca o ● "atual"). `undefined` ⇒ default. */
  readonly currentEffort?: string;
  /** O modo CUSTOM de effort (texto-livre passthrough) está aberto? */
  readonly effortCustomOpen?: boolean;
  /** O texto digitado no effort custom. */
  readonly effortCustomInput?: string;
  /** Aviso de effort custom inválido (`empty`/`too-long`) — ou null (válido). */
  readonly effortCustomWarn?: 'empty' | 'too-long' | null;
}

export function ModelPicker(props: ModelPickerProps): React.ReactElement {
  // No modo CUSTOM (browser/texto-livre), o picker vira o browser de modelos — a lista
  // de tiers some (foco no que se navega/digita).
  const { t } = useI18n();
  // EST-1117 — PASSO de EFFORT (2ª etapa, conjugado): depois de escolher o modelo, o
  // picker vira o seletor de esforço. Tem prioridade (vem DEPOIS do modelo no fluxo).
  if (props.effortStepOpen) {
    return <EffortStep {...props} />;
  }
  if (props.customInputOpen) {
    return <CustomInput {...props} />;
  }
  const customIdx = props.tiers.length;
  return (
    <Box flexDirection="column">
      <Box>
        <Role name="fgDim">{t('picker.model.help')}</Role>
      </Box>
      {props.loading ? (
        <Box>
          <Role name="fgDim"> {t('picker.model.loading')}</Role>
        </Box>
      ) : (
        <>
          {props.tiers.map((tier, i) => {
            const isSel = i === props.selected;
            const isActive = tier.key === props.currentTier;
            const model = principalModel(tier);
            const cost = costLabel(tier.costSignal);
            return (
              <Box key={tier.key}>
                {/* prefixo › no selecionado + ● no tier ativo (a11y: não só cor) */}
                <Role name={isSel ? 'accent' : 'fgDim'}>{isSel ? '› ' : '  '}</Role>
                <Role name={isActive ? 'accent' : 'fgDim'}>{isActive ? '● ' : '  '}</Role>
                <Role name={isSel ? 'accent' : 'fg'}>{tier.displayName}</Role>
                {model !== '' && (
                  <>
                    <Role name="fgDim"> · </Role>
                    <Role name="depth">{model}</Role>
                  </>
                )}
                <Role name="fgDim"> · {cost}</Role>
              </Box>
            );
          })}
          {/* linha CUSTOM (ADR-0030 §3) — sempre a última; abre o browser de modelos. */}
          <Box key="__custom__">
            <Role name={props.selected === customIdx ? 'accent' : 'fgDim'}>
              {props.selected === customIdx ? '› ' : '  '}
            </Role>
            <Role name={props.currentTier === 'custom' ? 'accent' : 'fgDim'}>
              {props.currentTier === 'custom' ? '● ' : '  '}
            </Role>
            <Role name={props.selected === customIdx ? 'accent' : 'fg'}>Custom</Role>
            <Role name="fgDim"> · {t('picker.model.customLine')}</Role>
          </Box>
        </>
      )}
      {props.usingFallback === true && !props.loading && (
        <Box>
          {/* HG-2: mensagem NEUTRA — "broker", nunca o provider/credencial. */}
          <Role name="fgDim">
            {'  '}◍ {t('picker.model.fallback')}
          </Role>
        </Box>
      )}
    </Box>
  );
}

/**
 * Modo CUSTOM: o BROWSER navegável dos modelos (EST-0962) quando a lista carregou —
 * filtro por digitação, janela com scroll (↑↓), toggle "só tools" (`t`), badge de
 * tools por linha, e o aviso warn-but-allow do realce sem tools. Quando a lista NÃO
 * carregou (401/erro), DEGRADA p/ o campo de texto-livre puro (`FreeTextInput`).
 */
function CustomInput(props: ModelPickerProps): React.ReactElement {
  // Browser disponível SÓ quando a lista dedicada carregou; senão, texto-livre puro.
  if (props.customBrowserAvailable === true) {
    return <CustomBrowser {...props} />;
  }
  return <FreeTextInput {...props} />;
}

/** Badge de suporte a tools (a11y/NO_COLOR: glifo + PALAVRA, lê sem cor). */
function ToolsBadge(props: { supportsTools: boolean | undefined }): React.ReactElement {
  if (props.supportsTools === true) {
    return <Role name="accent">{'✓ tools'}</Role>;
  }
  if (props.supportsTools === false) {
    return <Role name="fgDim">{'— tools'}</Role>;
  }
  // neutro (broker não informou) — não inventa true/false.
  return <Role name="fgDim">{'· tools?'}</Role>;
}

/** Uma linha do browser: realce (›) + id + family + context + badge de tools. */
function BrowseLine(props: { row: CustomBrowseRow }): React.ReactElement {
  const { model, highlighted } = props.row;
  const meta = [model.family, model.context].map((s) => s.trim()).filter((s) => s !== '');
  return (
    <Box>
      <Role name={highlighted ? 'accent' : 'fgDim'}>{highlighted ? '› ' : '  '}</Role>
      <Role name={highlighted ? 'accent' : 'fg'}>{model.id}</Role>
      {meta.length > 0 && (
        <>
          <Role name="fgDim">{'  '}</Role>
          <Role name="depth">{meta.join(' · ')}</Role>
        </>
      )}
      <Text> </Text>
      <ToolsBadge supportsTools={model.supportsTools} />
    </Box>
  );
}

/** O BROWSER: cabeçalho de teclas + contador + janela de linhas + scroll + aviso. */
function CustomBrowser(props: ModelPickerProps): React.ReactElement {
  const { t } = useI18n();
  const value = props.customInput ?? '';
  const rows = props.customRows ?? [];
  const filtered = props.customFilteredCount ?? 0;
  const total = props.customTotalCount ?? 0;
  const toolsOnly = props.customToolsOnly === true;
  const noTools = props.customNoToolsWarning ?? null;
  return (
    <Box flexDirection="column">
      <Box>
        <Role name="fgDim">{t('picker.model.browseHelp')}</Role>
      </Box>
      {/* linha de FILTRO: o texto digitado + contador "N de M" + estado do toggle. */}
      <Box>
        <Role name="accent">{'filtro › '}</Role>
        <Role name="fg">{value}</Role>
        <Role name="accent">▏</Role>
        <Role name="fgDim">
          {'   '}
          {t('picker.model.browseCount', { filtered, total })}
          {toolsOnly ? t('picker.model.toolsOnlySuffix') : ''}
        </Role>
      </Box>
      {props.customHasMoreAbove === true && (
        <Box>
          <Role name="fgDim">
            {'  '}
            {t('picker.model.moreAbove')}
          </Role>
        </Box>
      )}
      {rows.length === 0 ? (
        <Box>
          {/* lista carregada mas nada casa o filtro ⇒ enter usa o texto digitado (livre). */}
          <Role name="fgDim">
            {'  '}
            {t('picker.model.noFilterMatch')}
          </Role>
        </Box>
      ) : (
        <Box flexDirection="column">
          {rows.map((row) => (
            <BrowseLine key={row.model.id} row={row} />
          ))}
        </Box>
      )}
      {props.customHasMoreBelow === true && (
        <Box>
          <Role name="fgDim">
            {'  '}
            {t('picker.model.moreBelow')}
          </Role>
        </Box>
      )}
      {noTools !== null && (
        <Box>
          {/* warn-but-allow (ADR-0030 §4): avisa MAS deixa usar (enter seleciona mesmo). */}
          <Role name="accent">
            {'  '}
            {t('picker.model.noTools')}
          </Role>
        </Box>
      )}
    </Box>
  );
}

/**
 * EST-1117 — PASSO de EFFORT (2ª etapa do `/model` conjugado): escolhe o `reasoning_effort`
 * a aplicar JUNTO com o modelo. Lista `manter` + low/medium/high + `custom` (texto-livre).
 * Marca o effort ATIVO com `●` (a11y: glifo + palavra, não só cor); o selecionado leva `›`.
 * Tokens-only (papéis do DS). Quando o modo custom abre, vira o campo de texto-livre.
 */
function EffortStep(props: ModelPickerProps): React.ReactElement {
  const { t } = useI18n();
  if (props.effortCustomOpen === true) {
    return <EffortCustomInput {...props} />;
  }
  const options = props.effortOptions ?? [];
  const sel = props.effortSelected ?? 0;
  const current = props.currentEffort;
  return (
    <Box flexDirection="column">
      <Box>
        <Role name="fgDim">{t('picker.effort.help')}</Role>
      </Box>
      {options.map((opt, i) => {
        const isSel = i === sel;
        // O effort ATIVO: o nível corrente da sessão (●). "manter" é ativo quando NENHUM
        // effort canônico está setado (default do provider). "custom" nunca marca ●.
        const isActive =
          (opt.kind === 'level' && opt.value === current) ||
          (opt.kind === 'keep' && (current === undefined || current === ''));
        return (
          <Box key={opt.id}>
            <Role name={isSel ? 'accent' : 'fgDim'}>{isSel ? '› ' : '  '}</Role>
            <Role name={isActive ? 'accent' : 'fgDim'}>{isActive ? '● ' : '  '}</Role>
            <Role name={isSel ? 'accent' : 'fg'}>
              {t(EFFORT_LABEL_KEY[opt.id] ?? 'picker.effort.keep')}
            </Role>
          </Box>
        );
      })}
    </Box>
  );
}

/** Effort CUSTOM (texto-livre passthrough): digita o valor; aviso se vazio/>32. */
function EffortCustomInput(props: ModelPickerProps): React.ReactElement {
  const { t } = useI18n();
  const value = props.effortCustomInput ?? '';
  const warn = props.effortCustomWarn ?? null;
  return (
    <Box flexDirection="column">
      <Box>
        <Role name="fgDim">{t('picker.effort.customHelp')}</Role>
      </Box>
      <Box>
        <Role name="accent">{'› '}</Role>
        <Role name="fg">{value}</Role>
        <Role name="accent">▏</Role>
      </Box>
      {warn !== null && (
        <Box>
          <Role name="accent">
            {'  '}
            {warn === 'empty' ? t('picker.effort.warnEmpty') : t('picker.effort.warnTooLong')}
          </Role>
        </Box>
      )}
    </Box>
  );
}

/** Texto-livre puro: lista NÃO carregou (degrada) — digita/cola o slug à mão. */
function FreeTextInput(props: ModelPickerProps): React.ReactElement {
  const { t } = useI18n();
  const value = props.customInput ?? '';
  const suggestions = props.customSuggestions ?? [];
  const warn = props.customWarnOutOfCatalog === true;
  return (
    <Box flexDirection="column">
      <Box>
        <Role name="fgDim">{t('picker.model.freeHelp')}</Role>
      </Box>
      <Box>
        <Role name="accent">{'› '}</Role>
        <Role name="fg">{value}</Role>
        {/* cursor textual simples (a11y: marca o ponto de inserção sem cor só). */}
        <Role name="accent">▏</Role>
      </Box>
      {suggestions.length > 0 && (
        <Box flexDirection="column">
          {suggestions.map((s) => (
            <Box key={s}>
              <Role name="fgDim">{'  ◍ '}</Role>
              <Role name="depth">{s}</Role>
            </Box>
          ))}
        </Box>
      )}
      {warn && (
        <Box>
          {/* warn-but-allow (ADR-0065): avisa MAS deixa usar (enter envia mesmo assim). */}
          <Role name="accent">
            {'  '}
            {t('picker.model.outOfCatalog')}
          </Role>
        </Box>
      )}
    </Box>
  );
}
