// EST-0962 · /provider — <ProviderPicker>: seletor de PROVIDER (par do modelo Custom).
//
// `/provider` abre este picker (MESMA mecânica/teclas do <SlashMenu>/<ThemePicker>/
// <ModelPicker>: ↑↓ navega; enter seta; esc fecha). Cada item = `rótulo · resumo`. O
// provider ATIVO ganha o marcador `●` (a11y: não só cor); o selecionado leva o prefixo
// `›` em accent. Tokens-only (papéis do DS) — ZERO cor crua. Apresentação PURA: a
// captura de teclas é da App; aqui só desenhamos a lista. Espelha o <ThemePicker>.
//
// HG-2: o picker mostra só o NOME público do provider (catálogo) + um resumo neutro —
// NUNCA credencial/base_url. O broker resolve `(provider, model)` server-side.

import React from 'react';
import { Box } from 'ink';
import { Role, useTheme } from '../theme/index.js';
import { PickerFrame, alturaDeLista } from './PickerFrame.js';
import { useI18n } from '../../i18n/index.js';
import type { ProviderEntry } from '../../model/providers.js';
import type {
  AddCustomProviderStep,
  AddCustomProviderDraft,
  CredentialStep,
} from '../hooks/useProviderPicker.js';
import { displayWidth } from '../../session/visual-lines.js';
import { windowAround } from '../window.js';

export interface ProviderPickerProps {
  readonly providers: readonly ProviderEntry[];
  /** Índice selecionado (navegado por ↑↓). */
  readonly selected: number;
  /** Provider ATIVO da sessão (marcado com `●`). `undefined` = nenhum setado ainda. */
  readonly currentProvider?: string;
  /**
   * EST-0962 / ADR-0076 — a lista é o FALLBACK estático (broker fora / vazio), não a viva
   * do broker? ⇒ mostra a nota honesta "(não foi possível listar os cadastrados)". `false`
   * quando veio do broker; `null`/`undefined` antes de carregar (sem nota).
   */
  readonly usingFallback?: boolean | null;
  /**
   * Máx. de providers visíveis (janela centrada no selecionado). Belt-and-suspenders:
   * a lista costuma ser pequena (seed openrouter/deepseek), mas o broker pode trazer
   * mais e um terminal curto estouraria `rows` ⇒ full-screen do Ink ⇒ flicker no
   * Windows. MESMO padrão do <HistoryPicker>. Default 10 (auto-seguro).
   */
  readonly maxRows?: number;
  /** Altura do terminal — a janela da lista é derivada dela (ver `alturaDeLista`). */
  readonly rows?: number;
  /** F89 (wrap-aware) — largura do terminal; janela por LINHAS VISUAIS em cols estreito. */
  readonly columns?: number;
  /**
   * F-PROV — passo corrente do formulário "+ adicionar provider custom" (`null`/
   * `undefined` ⇒ mostra a LISTA normal; presente ⇒ mostra o campo de texto do passo).
   */
  readonly addCustomStep?: AddCustomProviderStep;
  /** F-PROV — rascunho em digitação do formulário (campo corrente = `addCustomStep`). */
  readonly addCustomDraft?: AddCustomProviderDraft;
  /**
   * F-PROV-CRED — passo do campo de credencial ("colar a API key", `null`/`undefined`
   * fora do fluxo). Entra ANTES da lista voltar a ser mostrada: o `<ProviderPicker>`
   * despacha pra este campo do MESMO jeito que despacha pro "+ adicionar" (mutuamente
   * exclusivos — nunca os dois setados ao mesmo tempo).
   */
  readonly credentialStep?: CredentialStep;
  /** F-PROV-CRED — provider ao qual a chave em digitação vai se aplicar (display: NOME
   * de catálogo, nunca credencial — CLI-SEC-7). */
  readonly credentialProviderId?: string;
  /** F-PROV-CRED — valor em digitação. NUNCA renderizado cru — só via `maskValue`. */
  readonly credentialDraft?: string;
  /** F-PROV-CRED — motivo de uma tentativa ANTERIOR ter falhado (vazio na 1ª vez). Nunca
   * contém a chave — só o `detail`/mensagem do backend (gravação OU teste de conexão). */
  readonly credentialError?: string;
}

/**
 * F-PROV-CRED — mascara o valor digitado no campo de chave: só `•`, um por caractere,
 * NUNCA o texto em si. MESMO padrão do `TextRow` do `aluy onboard` (`session/onboard.tsx`).
 * Pura: sem ela, provar "nunca ecoa" exigiria montar a árvore Ink inteira; com ela, é uma
 * asserção de string — mas o componente abaixo TAMBÉM é coberto por um render-test (ver
 * `provider-picker-credential.test.tsx`) que prova que o próprio `<ProviderPicker>` só usa
 * este valor mascarado, nunca `props.credentialDraft` cru.
 *
 * MEDIDO (achado que motivou esta tela) — uma tentativa anterior leu a API key por
 * readline SOB a TUI (Ink em modo raw): a tecla vazou pro composer da sessão, disparou um
 * turno, o prompt travou ~10s, e a chave apareceu em TEXTO CLARO na tela (mesma classe do
 * vazamento que a rc.135 já tinha consertado uma vez — o dono teve de rotacionar a chave
 * real). Este campo é Ink puro, desenhado pelo React — nunca sai do controle dele.
 */
export function maskValue(value: string): string {
  return '•'.repeat(value.length);
}

/** F-PROV-CRED — o campo de texto MASCARADO do passo de credencial. Espelha o
 * `AddCustomProviderField` acima (mesma densidade/tokens) — só troca `value` cru por
 * `maskValue(value)` e acrescenta a linha de erro (retry) quando houver uma. */
function CredentialField(props: {
  readonly providerId: string;
  readonly value: string;
  readonly error: string;
}): React.ReactElement {
  const { t } = useI18n();
  const theme = useTheme();
  return (
    <PickerFrame>
      {props.error !== '' && (
        <Box flexDirection="column">
          <Box>
            <Role name="fg">{t('picker.provider.credential.retryTitle')}</Role>
          </Box>
          <Box>
            <Role name="fgDim">{props.error}</Role>
          </Box>
        </Box>
      )}
      <Box>
        <Role name="fgDim">
          {t('picker.provider.credential.label', { provider: props.providerId })}
        </Role>
      </Box>
      <Box>
        <Role name="depth">{theme.glyph('prompt')} </Role>
        <Role name="fg">{maskValue(props.value)}</Role>
        <Role name="accent">{theme.glyph('cursor')}</Role>
      </Box>
      <Box>
        <Role name="fgDim">{t('picker.provider.credential.help')}</Role>
      </Box>
    </PickerFrame>
  );
}

/** F-PROV — o campo de texto do passo CORRENTE do formulário "+ adicionar provider
 * custom". Espelha o `TextField` do <QuestionDialog> (mesma densidade/tokens). */
function AddCustomProviderField(props: {
  readonly step: Exclude<AddCustomProviderStep, null>;
  readonly draft: AddCustomProviderDraft;
}): React.ReactElement {
  const { t } = useI18n();
  const theme = useTheme();
  const label = t(`picker.provider.addCustom.${props.step}`);
  const value = props.draft[props.step];
  return (
    <PickerFrame>
      <Box>
        <Role name="fgDim">{label}</Role>
      </Box>
      <Box>
        <Role name="depth">{theme.glyph('prompt')} </Role>
        <Role name="fg">{value}</Role>
        <Role name="accent">{theme.glyph('cursor')}</Role>
      </Box>
      <Box>
        <Role name="fgDim">{t('picker.provider.addCustom.help')}</Role>
      </Box>
    </PickerFrame>
  );
}

export function ProviderPicker(props: ProviderPickerProps): React.ReactElement {
  const { t } = useI18n();
  // F-PROV-CRED — despacha ANTES da lista, mesma mecânica do "+ adicionar" abaixo (os
  // dois passos são mutuamente exclusivos — nunca setados ao mesmo tempo pelo hook).
  if (props.credentialStep !== undefined && props.credentialStep !== null) {
    return (
      <CredentialField
        providerId={props.credentialProviderId ?? ''}
        value={props.credentialDraft ?? ''}
        error={props.credentialError ?? ''}
      />
    );
  }
  if (props.addCustomStep !== undefined && props.addCustomStep !== null) {
    return (
      <AddCustomProviderField
        step={props.addCustomStep}
        draft={props.addCustomDraft ?? { id: '', baseUrl: '', model: '' }}
      />
    );
  }
  const maxRows = Math.max(1, props.maxRows ?? alturaDeLista(props.rows));
  // F89 — altura visual por provider: prefixo (2) + `● ` (2) + `label · summary` (+ dica
  // "padrão"); quebra em `ceil(largura / columns)`. Sem `columns`, janela por item.
  const cols = props.columns;
  const rowHeight =
    cols !== undefined && cols > 0
      ? (p: ProviderEntry): number => {
          const w =
            4 +
            displayWidth(`${p.label} · ${p.summary}`) +
            (p.isDefault ? 2 + displayWidth(t('picker.provider.default')) : 0);
          return Math.max(1, Math.ceil(w / cols));
        }
      : undefined;
  const { start, slice } = windowAround(props.providers, props.selected, maxRows, rowHeight);
  return (
    <PickerFrame>
      <Box>
        <Role name="fgDim">{t('picker.provider.help')}</Role>
      </Box>
      {props.usingFallback === true ? (
        <Box>
          <Role name="fgDim">{t('picker.provider.fallback')}</Role>
        </Box>
      ) : null}
      {slice.map((provider, i) => {
        const isSel = start + i === props.selected;
        const isActive = provider.name === props.currentProvider;
        return (
          <Box key={provider.name}>
            {/* prefixo › no selecionado + ● no provider ativo (a11y: não só cor) */}
            <Role name={isSel ? 'accent' : 'fgDim'}>{isSel ? '› ' : '  '}</Role>
            <Role name={isActive ? 'accent' : 'fgDim'}>{isActive ? '● ' : '  '}</Role>
            <Role name={isSel ? 'accent' : 'fg'}>{provider.label}</Role>
            <Role name="fgDim"> · {provider.summary}</Role>
            {provider.isDefault ? (
              <Role name="fgDim"> · {t('picker.provider.default')}</Role>
            ) : null}
          </Box>
        );
      })}
      {props.providers.length > slice.length && (
        <Box>
          <Role name="fgDim">
            {'  '}
            {t('picker.provider.more', { count: props.providers.length - slice.length })}
          </Role>
        </Box>
      )}
    </PickerFrame>
  );
}
