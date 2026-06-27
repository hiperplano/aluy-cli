// EST-0948 · spec §4.1 — <Header>: marca `Λluy` + subtítulo de produto + `◍ broker`.
// NUNCA provider/modelo (HG-2 / handoff §10 regra 4).
//
// EST-0986 — IDENTIDADE: a MARCA Λ (glifo `aluy`, role `accent`) abre o header
// COMPACTO, à frente do subtítulo. É a MESMA marca do boot loader (<AluyLoader>)
// e do indicador de pensando (EST-0984): splash Λ → header Λ, coerência visual.
//
// EST-0988 — BANNER persistente: quando há espaço (densidade `comfortable`, largura
// não-`narrow`, terminal alto o bastante), o header exibe o WORDMARK GRANDE "Aluy"
// (o MESMO da splash, via <Wordmark> compartilhado) com a linha de info ABAIXO.
// Aqui a marca já é o wordmark — então o `Λ` compacto NÃO se repete no banner (sem
// marca duplicada); ele continua abrindo apenas o fallback de 1 linha.
//
// EST-0989 — SUBTÍTULO DE PRODUTO (Variação B, aprovada): abaixo do wordmark a linha
// de info virou `Aluy CLI · Terminal v<versão>` + `◍ broker`, SEM o tier. O tier saiu
// do banner de propósito: o header é PINADO no `<Static>` (chrome estático, escrito
// 1× no scrollback) e NÃO re-renderiza ao trocar `/model` — manter o tier aqui daria
// a impressão FALSA de que ele atualiza. O tier VIVO (que muda ao trocar o modelo)
// mora no <StatusBar> do rodapé, re-renderizado a cada frame. Cores do subtítulo:
//   `Aluy CLI` = fg · ` · Terminal ` = fgDim · `v1.x.x` = depth (mono) · `◍ broker` = depth.
//
// FALLBACK p/ não comer a tela: em `compact`, em `narrow` (<60 col) OU em terminal
// BAIXO (poucas linhas), cai no header COMPACTO de 1 linha:
//   `Λ Aluy CLI v<versão> · <tier> · ◍ broker`  (compacto inclui o tier — é a ÚNICA
//   pista de modelo quando não há banner; e o compacto não está no Static congelado
//   nos testes/caminhos que o usam), degradando p/ `Λ Aluy CLI · <tier>` em narrow.
// O wordmark herda do <Wordmark> o fallback ASCII (`/\`+`#`, TERM=linux / --ascii) e
// a degradação `Λ luy` (<MIN_WORDMARK_COLS col). É chrome ESTÁTICO — NÃO anima
// (anti-flicker EST-0965): mesma altura/largura por (largura, linhas, tema).
//
// EST-0989 — o header é PINADO NO TOPO (acima do histórico): a App o renderiza como
// o 1º item do `<Static>` do Ink (escrito uma vez no scrollback). Por isso é chrome
// PURAMENTE ESTÁTICO — o `error` (saúde do broker) NÃO atualiza aqui ao vivo; o sinal
// VIVO de `⚠ erro` mora no <StatusBar> do rodapé (re-renderizado a cada frame). O
// prop `error` segue existindo (caminho compacto/testes), mas a App não o liga mais.

import React from 'react';
import { Box, Text } from 'ink';
import { Glyph, Role, useTheme } from '../theme/index.js';
import { Wordmark, WORDMARK_ROWS } from './Wordmark.js';

export interface HeaderProps {
  readonly tier: string;
  /** Subcontexto (`entrar`, `comandos`) — vira `Aluy CLI · <sub>` no subtítulo. */
  readonly sub?: string;
  /** `true` quando há erro de broker — header ganha `· ⚠` à direita (§2.11). */
  readonly error?: boolean;
  /** Largura do terminal (responsivo §5.1: <60 col esconde `◍ broker`). */
  readonly columns?: number;
  /**
   * Altura do terminal (linhas). EST-0988: terminal baixo ⇒ banner sumiria a
   * tela, então cai no header compacto. Ausente ⇒ assume alto (mantém o banner).
   */
  readonly rows?: number;
  /**
   * EST-0989 — versão do binário (`CLI_VERSION`), passada pela App. Renderizada como
   * `v<versão>` (depth/mono) no subtítulo `Aluy CLI · Terminal v<versão>`. Ausente ⇒
   * o subtítulo cai p/ `Aluy CLI · Terminal` (sem a versão; degradação graciosa).
   */
  readonly version?: string;
  /**
   * ADR-0120 — backend EFETIVO (`local`|`broker`). O label do header reflete o modo real
   * (`◍ local` no BYO) em vez de `broker` fixo — que fazia um setup local funcionando
   * parecer broker. Ausente ⇒ `broker` (default histórico, não-regressão).
   */
  readonly backend?: 'broker' | 'local';
}

/**
 * Piso de linhas p/ exibir o BANNER (EST-0988). O wordmark são ~5 linhas + info +
 * as 2 divisórias que o emolduram (EST-0987/0985) ≈ 8 linhas só de header; abaixo
 * disso o banner engoliria a conversa/composer, então caímos no compacto. Margem
 * folgada p/ sobrar tela viva: wordmark + info + dividers + composer + status.
 */
export const HEADER_BANNER_MIN_ROWS = WORDMARK_ROWS + 13;

/** Nome de PRODUTO no header (mesma string no banner e no compacto). */
const PRODUCT_NAME = 'Aluy Cli';

/**
 * Subtítulo do BANNER (EST-0989) — `Aluy CLI · Terminal v<versão>` + `◍ broker`.
 * SEM tier (Variação B): o tier vivo mora no rodapé. `Aluy CLI`=fg, ` · Terminal `
 * =fgDim, `v<versão>`=depth (mono), `◍ broker`=depth.
 */
function BannerSubtitle(props: {
  readonly sub?: string;
  readonly version?: string;
  readonly narrow: boolean;
  readonly error: boolean | undefined;
  readonly backend?: 'broker' | 'local';
}): React.ReactElement {
  return (
    <Box>
      <Role name="fg">{PRODUCT_NAME}</Role>
      {props.sub !== undefined && props.sub !== '' ? (
        // Subcontexto (entrar/comandos): `Aluy CLI · <sub>` em vez de `· Terminal`.
        <>
          <Role name="fgDim"> · </Role>
          <Role name="fgDim">{props.sub}</Role>
        </>
      ) : (
        <>
          <Role name="fgDim"> · Terminal </Role>
          {props.version !== undefined && props.version !== '' && (
            <Role name="depth">v{props.version}</Role>
          )}
        </>
      )}
      {!props.narrow && (
        <>
          <Role name="fgDim"> · </Role>
          <Glyph name="broker" role="depth" />
          <Role name="depth"> {props.backend === 'local' ? 'local' : 'broker'}</Role>
        </>
      )}
      {props.error && (
        <>
          <Role name="fgDim"> · </Role>
          <Glyph name="ask" role="danger" />
        </>
      )}
    </Box>
  );
}

/**
 * Header COMPACTO de 1 linha (EST-0989) — `compact`/`narrow`/terminal baixo:
 *   normal: `Λ Aluy CLI v<versão> · <tier> · ◍ broker`
 *   narrow (<60): `Λ Aluy CLI · <tier>`  (sem versão nem broker — cabe na largura)
 * O tier ENTRA aqui (≠ do banner): sem o wordmark, o compacto é a única pista de
 * modelo, e o compacto não fica no `<Static>` congelado.
 */
function CompactLine(props: {
  readonly tier: string;
  readonly sub?: string;
  readonly version?: string;
  readonly narrow: boolean;
  readonly error: boolean | undefined;
  readonly backend?: 'broker' | 'local';
}): React.ReactElement {
  return (
    <Box>
      {/* A marca Λ (mesma do loader/thinking) abre o compacto. */}
      <Glyph name="aluy" role="accent" />
      <Text> </Text>
      <Role name="fg">{PRODUCT_NAME}</Role>
      {/* Subcontexto (entrar/comandos): `Aluy CLI · <sub>` antes do tier. */}
      {props.sub !== undefined && props.sub !== '' && (
        <>
          <Role name="fgDim"> · </Role>
          <Role name="fgDim">{props.sub}</Role>
        </>
      )}
      {!props.narrow && props.version !== undefined && props.version !== '' && (
        <>
          <Text> </Text>
          <Role name="depth">v{props.version}</Role>
        </>
      )}
      <Role name="fgDim"> · </Role>
      <Role name="fg">{props.tier}</Role>
      {!props.narrow && (
        <>
          <Role name="fgDim"> · </Role>
          <Glyph name="broker" role="depth" />
          <Role name="depth"> {props.backend === 'local' ? 'local' : 'broker'}</Role>
        </>
      )}
      {props.error && (
        <>
          <Role name="fgDim"> · </Role>
          <Glyph name="ask" role="danger" />
        </>
      )}
    </Box>
  );
}

export function Header(props: HeaderProps): React.ReactElement {
  const theme = useTheme();
  const columns = props.columns ?? 80;
  const rows = props.rows ?? 24;
  const narrow = columns < 60;

  // EST-0988 — BANNER só quando sobra espaço: densidade confortável, não-estreito
  // e terminal alto o bastante. Senão, header COMPACTO de 1 linha (com Λ + tier).
  const showBanner = theme.density !== 'compact' && !narrow && rows >= HEADER_BANNER_MIN_ROWS;

  if (!showBanner) {
    return (
      <CompactLine
        tier={props.tier}
        {...(props.sub !== undefined ? { sub: props.sub } : {})}
        {...(props.version !== undefined ? { version: props.version } : {})}
        {...(props.backend !== undefined ? { backend: props.backend } : {})}
        narrow={narrow}
        error={props.error}
      />
    );
  }

  // Banner: WORDMARK grande (marca, via <Wordmark> compartilhado) + subtítulo ABAIXO.
  return (
    <Box flexDirection="column">
      <Wordmark columns={columns} />
      <BannerSubtitle
        {...(props.sub !== undefined ? { sub: props.sub } : {})}
        {...(props.version !== undefined ? { version: props.version } : {})}
        {...(props.backend !== undefined ? { backend: props.backend } : {})}
        narrow={narrow}
        error={props.error}
      />
    </Box>
  );
}
