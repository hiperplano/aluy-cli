// EST-0989 — <SplashScreen>: a TELA DE BOOT centralizada (TTY-only).
//
// O boot do `aluy` faz trabalho assíncrono (carregar config, descobrir MCP, recall
// de memória, checar a sessão anterior, perfis .md) ANTES de montar a TUI normal.
// Antes desta estória esse intervalo mostrava FRASES SOLTAS no meio da tela (o
// prompt cru de `[S/n]`, notas avulsas) — feio. Agora um SPLASH centralizado segura
// a cena: o WORDMARK `Λluy` (a marca — FONTE ÚNICA <Wordmark>, EST-0988/0989) + um
// "carregando…" DISCRETO (pontinhos calmos) ENQUANTO o trabalho roda; e, quando o
// boot precisa PERGUNTAR algo (retomar a sessão `[S/n]`, confirmar `--yolo`), a
// pergunta vem num BLOCO BEM FORMATADO e centralizado (<BootPromptBox>), nunca como
// linha solta.
//
// CENTRALIZAÇÃO: um contêiner do tamanho da JANELA (`columns`×`rows`) com
// `alignItems="center"` + `justifyContent="center"` — o miolo (marca + carregando |
// caixa de pergunta) fica no centro geométrico, vertical E horizontal.
//
// ANTI-FLICKER (EST-0965 / #95 / #118): é um frame ESTÁVEL — largura/altura fixas, o
// "carregando" anima só a CAUDA de pontinhos (3 estados, cadência lenta do tick
// central ~8fps), nunca redesenha a marca nem a tela toda. Sem `setInterval` aqui:
// o `frame` chega por prop (PURO, handoff §10.1) — o driver (splash-controller) é
// quem avança o tick. NO_COLOR / `--ascii` degradam pelos MESMOS papéis/glifos do DS
// (a marca já cai p/ `/\`+`#`; a caixa cai p/ box ASCII via Ink).
//
// As cores saem SEMPRE de papéis semânticos (nunca cor crua):
//   - wordmark   → accent/depth (dentro de <Wordmark>)
//   - "carregando" → fgDim (discreto)
//   - moldura da caixa → accent (borderColor lido do papel — token, não cor crua)
//   - título da caixa  → accent ; opções → fg ; dica → fgDim

import React from 'react';
import { Box, Text } from 'ink';
import { Role, useTheme } from '../theme/index.js';
import { Wordmark, MIN_WORDMARK_COLS } from './Wordmark.js';
import { composeShadowedWordmark, rowSegments } from './wordmark-3d.js';
import { splashQuip } from './splash-quips.js';

/** Quantidade de estados da cauda de pontinhos do "carregando" (`` → `.` → `..` → `...`). */
const LOADING_DOTS_CYCLE = 4;

/**
 * F195 — TAGLINE âmbar default sob a marca (pedido do dono: "tela profissional, tagline
 * âmbar"). Curta e fiel à marca do site ("o agente de terminal", help.html PT). Papel
 * `accentDim` (âmbar calmo, não crua). O caller pode sobrescrever via prop `tagline`.
 */
export const DEFAULT_TAGLINE = 'agente de terminal';

/**
 * Cauda de pontinhos do "carregando" em função do `frame` do tick central. PURO:
 * `0..3` pontos, em laço. Cadência lenta (deriva do tick ~120ms) ⇒ respiro calmo,
 * sem flicker. `frame` ausente / reduced-motion ⇒ caller passa 0 (cauda vazia,
 * estática) — o verbo "carregando" sozinho carrega o sentido.
 */
export function loadingDots(frame: number): string {
  const n = ((frame % LOADING_DOTS_CYCLE) + LOADING_DOTS_CYCLE) % LOADING_DOTS_CYCLE;
  return '.'.repeat(n);
}

export interface SplashScreenProps {
  /** Largura do terminal (p/ centralizar e p/ a degradação do wordmark). */
  readonly columns: number;
  /** Altura do terminal (p/ centralizar verticalmente). */
  readonly rows: number;
  /**
   * Frame do tick central (EST-0984/0965): anima SÓ a cauda de pontinhos do
   * "carregando". 0/ausente ⇒ cauda vazia (estático). PURO.
   */
  readonly frame?: number;
  /**
   * Verbo do estado de carga (ex.: "carregando", "conectando", "descobrindo MCP").
   * Default "carregando". É a linha DISCRETA sob a marca enquanto o boot trabalha.
   */
  readonly status?: string;
  /**
   * PERGUNTA de boot pendente (retomar sessão / confirmar YOLO). Quando presente, a
   * <BootPromptBox> centralizada SUBSTITUI a linha "carregando" — uma decisão de cada
   * vez, bem formatada. Ausente ⇒ só a marca + "carregando".
   */
  readonly prompt?: BootPrompt;
  /**
   * F195 — versão do binário (`CLI_VERSION`), passada pelo splash-controller. Renderizada
   * DISCRETA no rodapé do card (`Aluy CLI · v<versão>`, papel `depth`). Ausente ⇒ a linha
   * de versão some (degradação graciosa; tela mais limpa ainda).
   */
  readonly version?: string;
  /**
   * F195 — tagline âmbar sob a marca. Ausente ⇒ `DEFAULT_TAGLINE` ("agente de terminal").
   */
  readonly tagline?: string;
}

/**
 * Uma pergunta de boot a apresentar FORMATADA (caixa do DS), no lugar da frase solta.
 * PURO/declarativo: o título, o corpo (linhas já quebradas) e as opções. A captura de
 * tecla mora no driver (splash-controller) — este componente é só APRESENTAÇÃO.
 */
export interface BootPrompt {
  /** Título curto da caixa (ex.: "retomar sessão", "modo YOLO"). */
  readonly title: string;
  /** Corpo da pergunta — uma ou mais linhas já prontas (sem o `[S/n]` cru). */
  readonly body: readonly string[];
  /** Linha de opções (ex.: "[s] retomar · [n] nova sessão"). */
  readonly options: string;
}

/**
 * A TELA DE BOOT centralizada. Mostra o wordmark `Λluy` no centro e, abaixo, OU a
 * linha "carregando…" (enquanto o boot trabalha) OU a caixa de pergunta formatada
 * (quando há uma decisão pendente). TTY-only por construção (o caller só a monta no
 * ramo TTY). PURO/ESTÁTICO salvo a cauda de pontinhos (anti-flicker EST-0965).
 */
export function SplashScreen(props: SplashScreenProps): React.ReactElement {
  const theme = useTheme();
  const columns = props.columns;
  const rows = props.rows;
  const frame = props.frame ?? 0;
  const status = props.status ?? 'carregando';
  const tagline = props.tagline ?? DEFAULT_TAGLINE;
  // SÓ no splash, COM Unicode e animação ligada (não reduced-motion) e largura que
  // comporta a marca grande: o wordmark ganha a SOMBRA 3D que respira. Senão, a marca
  // ESTÁTICA <Wordmark> (idêntica ao header) — fallback fiel, sem efeito.
  const wants3d = theme.animate && theme.unicode && columns >= MIN_WORDMARK_COLS;
  const mark = wants3d ? <ShadowedWordmark frame={frame} /> : <Wordmark columns={columns} />;

  // F195 — quando há PERGUNTA de boot, a tela é a DECISÃO: marca + <BootPromptBox>
  // focada (comportamento herdado, sem card em volta — evita moldura dentro de moldura).
  if (props.prompt !== undefined) {
    return (
      <Box
        width={columns}
        height={rows}
        flexDirection="column"
        alignItems="center"
        justifyContent="center"
      >
        {mark}
        <Box paddingTop={1}>
          <BootPromptBox prompt={props.prompt} columns={columns} />
        </Box>
      </Box>
    );
  }

  // F195 (feedback do dono: "tira a borda") — TELA DE CARGA arejada, SEM moldura/box: só
  // o miolo centrado e com respiro. Empilhado: marca 3D → TAGLINE âmbar → "carregando…"
  // divertido → versão discreta. NADA de box-drawing (o dono achou o card horrível). O
  // respiro vem de `paddingTop` entre os blocos; a centralização nos dois eixos vem do
  // contêiner do tamanho da janela. Anti-flicker: a marca/altura seguem estáveis (só a
  // sombra 3D e a cauda do quip animam) — sem borda, nada a refluir.
  return (
    // Contêiner do TAMANHO da janela: centraliza o miolo nos dois eixos. `height`
    // fixa a moldura vertical (o Ink alinha o conteúdo ao centro). Sem `height` o
    // splash colaria no topo (o bug das "frases soltas no meio da tela" — agora
    // centralizado de verdade).
    <Box
      width={columns}
      height={rows}
      flexDirection="column"
      alignItems="center"
      justifyContent="center"
    >
      {mark}
      <Box paddingTop={1}>
        <Tagline text={tagline} />
      </Box>
      <Box paddingTop={1}>
        <Loading status={status} frame={frame} />
      </Box>
      {props.version !== undefined && props.version !== '' && (
        <Box paddingTop={1}>
          <VersionLine version={props.version} />
        </Box>
      )}
    </Box>
  );
}

/**
 * F195 — a TAGLINE âmbar sob a marca (papel `accentDim` — nunca cor crua). É a linha de
 * identidade calma que dá o ar "profissional/produto" ao splash, sem competir com a marca.
 */
function Tagline(props: { readonly text: string }): React.ReactElement {
  return (
    <Box>
      <Role name="accentDim">{props.text}</Role>
    </Box>
  );
}

/**
 * F195 — a linha de VERSÃO discreta no rodapé do card: `Aluy CLI · v<versão>`. `Aluy CLI`
 * em `fgDim` (meta), o `v<versão>` em `depth` (o mesmo papel da versão no <Header>). Sem
 * hardcode: a versão chega por prop (`CLI_VERSION`, sincronizada do package.json).
 */
function VersionLine(props: { readonly version: string }): React.ReactElement {
  return (
    <Box>
      <Role name="fgDim">Aluy CLI · </Role>
      <Role name="depth">v{props.version}</Role>
    </Box>
  );
}

/**
 * O wordmark `Λluy` COM a sombra 3D que respira (splash-only). Compõe a grade
 * {marca `accent` · sombra `depth`} pelo `frame` (PURO, em `wordmark-3d.ts`) e emite
 * um <Text> por papel em cada linha. NÃO usado no header (lá a marca é estática).
 */
function ShadowedWordmark(props: { readonly frame: number }): React.ReactElement {
  const grid = composeShadowedWordmark(props.frame);
  return (
    <Box flexDirection="column">
      {grid.map((row, r) => (
        <Box key={r}>
          {rowSegments(row).map((seg, i) =>
            seg.role === null ? (
              <Text key={i}>{seg.text}</Text>
            ) : (
              <Role key={i} name={seg.role}>
                {seg.text}
              </Role>
            ),
          )}
        </Box>
      ))}
    </Box>
  );
}

/**
 * A linha DISCRETA de carga: o verbo + a cauda de pontinhos calma. Largura estável
 * (a cauda só muda os 0..3 pontos finais — sem reflow). Papel `fgDim` (discreto). O
 * contêiner reserva a largura máxima ("…" + 3 pontos) p/ o texto não "pular".
 */
function Loading(props: { readonly status: string; readonly frame: number }): React.ReactElement {
  const theme = useTheme();
  // UMA única cauda de pontinhos. ANTES o reticências base ("…") ficava SEMPRE E a cauda
  // animada (`` → `.` → `..` → `...`) era SOMADA por cima ⇒ no pico aparecia "…" + "..." =
  // DOIS reticências ("descobrindo MCP……"). Agora: SÓ a cauda animada quando o tema anima,
  // ou um reticências ESTÁTICO ("…"/"...") quando não. Um, nunca dois. (fix pedido pelo Tiago)
  const tail = theme.animate ? loadingDots(props.frame) : theme.unicode ? '…' : '...';
  // EST-1015 (pedido do dono) — quando o status é o GENÉRICO de carga ("carregando"), troca por
  // uma FRASE DIVERTIDA rotativa (não-relacionada ao produto). Um status ESPECÍFICO (ex.: uma
  // recusa/aviso que algum caller setou) é preservado. Sem animação (tema estático) ⇒ uma frase
  // FIXA (frame=0) p/ não "pular".
  const verb =
    props.status === 'carregando' ? splashQuip(theme.animate ? props.frame : 0) : props.status;
  return (
    <Box>
      <Role name="fgDim">
        {verb}
        {tail}
      </Role>
    </Box>
  );
}

/**
 * <BootPromptBox> — a pergunta de boot numa CAIXA centralizada e bem formatada (a
 * "caixa do DS" que o Tiago pediu). Em vez do `↻ … [S/n]` cru no meio da tela: uma
 * moldura arredondada (borderColor lido do papel `accent` — token, não cor crua;
 * Ink degrada p/ ASCII onde não há box-drawing), com TÍTULO em destaque, o corpo da
 * pergunta e a linha de OPÇÕES claras. Uma de cada vez. APRESENTAÇÃO pura: a tecla é
 * capturada pelo driver.
 */
export function BootPromptBox(props: {
  readonly prompt: BootPrompt;
  readonly columns: number;
}): React.ReactElement {
  const theme = useTheme();
  // Moldura: cor do papel `accent` (token do DS) — nunca cor crua. Em mono (NO_COLOR)
  // o papel não tem cor ⇒ a moldura sai sem cor (ainda visível: o box-drawing basta).
  const borderColor = theme.role('accent').color;
  // Largura da caixa: confortável mas contida (não cola nas bordas em telas largas;
  // encolhe em telas estreitas). Teto suave p/ legibilidade.
  const inner = Math.max(MIN_WORDMARK_COLS, Math.min(props.columns - 6, 56));

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      {...(borderColor !== undefined ? { borderColor } : {})}
      paddingX={2}
      paddingY={0}
      width={inner}
    >
      <Box paddingBottom={1}>
        <Role name="accent">{props.prompt.title}</Role>
      </Box>
      {props.prompt.body.map((line, i) => (
        <Box key={i}>
          <Text>{line}</Text>
        </Box>
      ))}
      <Box paddingTop={1}>
        <Role name="fgDim">{props.prompt.options}</Role>
      </Box>
    </Box>
  );
}
