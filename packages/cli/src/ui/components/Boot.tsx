// EST-0948 · spec §2.1 — <Boot>: SPLASH de boot (direção "wordmark bloco bold").
//
// Sobe no estado inicial (antes do composer) e SOME quando a sessão começa (o
// controlador troca de fase ⇒ a App deixa de montar este componente). Mostra o
// `tier` REAL (não um literal) e `◍ broker` desde o 1º frame — NUNCA o provider
// (HG-2). A versão vem do binário (CLI_VERSION, sincronizado do package.json no
// release — EST-0949), recebida por prop: a tela não hardcoda versão.
//
// EST-0988 — o WORDMARK (bloco bold + fallback ASCII `#` + degradação `a l u y`)
// foi extraído p/ <Wordmark> (FONTE ÚNICA), compartilhado com o banner do header.
// Aqui o Boot apenas CONSOME a marca — não redeclara as grades.
// As demais cores saem SEMPRE de papéis semânticos do tema (nunca cor crua):
//   - wordmark  → `depth`  (marca: ciano/verde-água/petrol do DS) [em <Wordmark>]
//   - onda `～`  → `accent` (âmbar)
//   - status    → `fgDim`
//   - ◍ broker  → `depth`  (petrol)

import React from 'react';
import { Box, Text } from 'ink';
import { Glyph, Role, useTheme } from '../theme/index.js';
import { useI18n } from '../../i18n/index.js';
import { AluyLoader } from './AluyLoader.js';
import { Wordmark } from './Wordmark.js';

export interface BootProps {
  /** Tier REAL da sessão (HG-2: só o tier sai do cliente). */
  readonly tier: string;
  /** Versão do binário (CLI_VERSION). Sem hardcode na tela. */
  readonly version?: string;
  /** Largura do terminal (responsivo). */
  readonly columns?: number;
  /** Modo de cobrança exibido no status (default: assinatura). */
  readonly plan?: string;
  /**
   * Frame do tick central (EST-0984): anima a marca Λ "viva" enquanto conecta
   * (login/broker). 0/ausente ⇒ marca sólida (estática). PURO.
   */
  readonly frame?: number;
  /**
   * Rótulo de status do boot (ex.: "conectando", "entrando"). Quando presente, o
   * loader Λ animado aparece com o verbo ao lado — a SENSAÇÃO de "ligando", não o
   * wordmark parado. Ausente ⇒ só o splash da marca. 〔EST-0984〕
   */
  readonly status?: string;
}

export function Boot(props: BootProps): React.ReactElement {
  const theme = useTheme();
  const { t } = useI18n();
  const columns = props.columns ?? 80;
  const plan = props.plan ?? 'assinatura';

  // A onda usa o glifo `wave` endurecido (EST-0984: `~` em vez do FF5E ambíguo).
  const wave = theme.glyph('wave').repeat(17);

  return (
    <Box flexDirection="column" paddingY={1}>
      {/* EST-0988 — a marca grande vem do <Wordmark> compartilhado (mesma fonte
          do banner do header): Unicode `█` ⇒ ASCII `#` ⇒ compacto `a l u y`. */}
      <Wordmark columns={columns} />

      <Box paddingTop={1} paddingLeft={2}>
        <Role name="fgDim">{t('boot.tagline')}</Role>
      </Box>

      <Box paddingLeft={2}>
        <Role name="accent">{wave}</Role>
        {props.version !== undefined && <Role name="fgDim"> v{props.version}</Role>}
      </Box>

      <Box paddingLeft={2}>
        <Glyph name="window" role="fgDim" />
        <Role name="fgDim"> {plan} · </Role>
        <Role name="fgDim">{props.tier}</Role>
        <Text> </Text>
        <Role name="fgDim">· </Role>
        <Glyph name="broker" role="depth" />
        <Role name="depth"> {t('boot.broker')}</Role>
      </Box>

      {/* EST-0984 — LOADER DE BOOT: enquanto conecta (login/broker), a marca Λ
          ANIMA (desenha + respira) com o verbo de status ao lado — NÃO o wordmark
          parado. Some quando entra em `idle` (a App deixa de montar o Boot). */}
      {props.status !== undefined && (
        <Box paddingTop={1} paddingLeft={2}>
          <AluyLoader frame={props.frame ?? 0} />
          <Text> </Text>
          <Role name="fgDim">{props.status}…</Role>
        </Box>
      )}
    </Box>
  );
}
