// FOOTER-AGENTES — o LOTE de sub-agentes ao lado do painel de status, abaixo do composer.
//
// Pedido do dono: "e possivel colocar tambem os agentes abaixo do composer... para
// conseguirmos nao perder a visao dos agentes que podem ser adicionados ao longo de uma
// conversa", e depois "eu queria que vc desse uma representada na forma visual... poderia
// ser um desenho um pouco mais rico".
//
// O desenho combina três coisas que ele escolheu: CONECTORES de árvore (amarram o lote como
// galhos de um disparo só), SPINNER por agente (quem gira está vivo; quem parou tem ✔/✘) e
// o CONSUMO ao vivo. A barra de tokens foi cortada por ele — sobrou o número.
//
// O CABEÇALHO tem linha própria. Antes o rótulo `agentes` ficava na primeira linha e as
// demais alinhavam sob ele, o que custava NOVE colunas em toda linha e não deixava caber
// nome + atividade + tokens + tempo (medido: 61 colunas numa coluna de 48). Com o cabeçalho
// solto as linhas começam na margem e tudo cabe; o preço é uma linha a mais e a perda do
// alinhamento com a coluna de rótulos do painel — trocas conscientes.
//
// ALTURA CONSTANTE: o bloco tem SEMPRE `LINHAS_RODAPE_AGENTES` linhas quando aparece
// (cabeçalho + agentes + "+K" quando sobra gente). Um bloco que cresce a cada filho mudaria
// a altura do frame o tempo todo — o tremor que a rc.148 passou o dia consertando.
//
// A BARRA vertical é a borda nativa do Ink (`borderLeft` só), como no `<Composer>`: ela se
// repete por todas as linhas sozinha. Desenhá-la à mão já quebrou aqui antes.

import React from 'react';
import { Box } from 'ink';
import { Role, useTheme } from '../theme/index.js';
import type { LiveSubagent } from '../../session/model.js';
import { LINHAS_RODAPE_AGENTES } from '../../session/footer-agents-layout.js';

export { LINHAS_RODAPE_AGENTES };

/** Rótulo do cabeçalho, na gramática do `<StatusPanel>` (glifo + palavra). */
const ROTULO = 'agentes';

/** Recuo das linhas de agente sob o cabeçalho. */
const RECUO = 2;

/** Larguras dos campos, medidas para caber em 48 colunas (ver o cabeçalho). */
const COLS_NOME = 15;
const COLS_ATIV = 11;
const COLS_TOKENS = 7;

/**
 * O estado do agente: glifo + palavra. A PALAVRA vai junto sempre (a11y §3.3), e o
 * vocabulário é o da árvore de fluxo — `done`/`cancelled`/`failed` são terminais, o resto
 * ainda corre. Foi inventar um `'running'` que não existe que deixou este rodapé vazio na
 * primeira tentativa: a contagem dizia 3 e a lista vinha sempre sem ninguém.
 */
export function agenteVivo(a: LiveSubagent): boolean {
  return a.phase !== 'done' && a.phase !== 'failed' && a.phase !== 'cancelled';
}

/** `m:ss` — curto o bastante para caber ao lado do consumo. */
export function formataDuracao(ms: number): string {
  const seg = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(seg / 60))}:${String(seg % 60).padStart(2, '0')}`;
}

/** `14.1k` — o consumo cabe em 6 colunas até a casa dos milhões. */
export function formataTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n < 1000) return String(Math.trunc(n));
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/**
 * ORDEM: quem está VIVO primeiro, depois quem falhou, e os prontos por último.
 *
 * A coluna tem teto, então a ordem decide o que aparece — e a primeira versão desta função
 * punha as FALHAS na frente. Parecia certo no papel ("falha é o que exige ação"), e o
 * desenho mostrou o erro na hora: num lote com 5 falhas e 2 rodando, as falhas ocupavam
 * todos os lugares e quem estava TRABALHANDO ia para o "+K" — o spinner, que é a razão de
 * ser deste bloco, nunca aparecia.
 *
 * Enquanto há trabalho, quem trabalha é a notícia. Quando tudo termina, não sobra ninguém
 * vivo e as falhas sobem sozinhas para o topo — a regra se ajusta sem precisar de modo.
 *
 * "Pronto" fica por último porque é o caso em que não há nada a fazer. Estável dentro de
 * cada grupo (preserva a ordem de disparo, que é como se pensa neles).
 */
export function ordenaParaRodape(agentes: readonly LiveSubagent[]): readonly LiveSubagent[] {
  const peso = (a: LiveSubagent): number =>
    agenteVivo(a) ? 0 : a.phase === 'failed' || a.phase === 'cancelled' ? 1 : 2;
  return [...agentes]
    .map((a, i) => ({ a, i }))
    .sort((x, y) => peso(x.a) - peso(y.a) || x.i - y.i)
    .map((e) => e.a);
}

/** Corta com reticência, preservando a largura da coluna. */
function campo(texto: string, cols: number): string {
  const chars = [...texto];
  if (chars.length > cols) return chars.slice(0, cols - 1).join('') + '…';
  return texto + ' '.repeat(cols - chars.length);
}

/** Alinha à direita (o consumo lê melhor com as unidades na mesma coluna). */
function direita(texto: string, cols: number): string {
  const chars = [...texto];
  return chars.length >= cols ? texto : ' '.repeat(cols - chars.length) + texto;
}

/**
 * O TEXTO de uma linha de agente, sem o glifo de estado (que é colorido à parte).
 * PURO e exportado: a medição de altura usa a mesma composição que o render desenha.
 */
export function linhaAgente(a: LiveSubagent): string {
  const atividade = agenteVivo(a)
    ? a.activity !== undefined
      ? `${a.activity.tool} ${a.activity.target}`
      : 'pensando'
    : a.phase === 'done'
      ? 'concluído'
      : a.phase === 'cancelled'
        ? 'parado'
        : 'falhou';
  const tokens = direita(formataTokens(a.tokens ?? 0), COLS_TOKENS);
  const tempo = a.durationMs !== undefined ? ` · ${formataDuracao(a.durationMs)}` : '';
  return `${campo(a.label, COLS_NOME)} ${campo(atividade, COLS_ATIV)}${tokens}${tempo}`;
}

/** Quantos agentes cabem, dado o teto de linhas (uma delas é o cabeçalho). */
export function agentesQueCabem(): number {
  return Math.max(1, LINHAS_RODAPE_AGENTES - 1);
}

export interface FooterAgentsProps {
  readonly agentes: readonly LiveSubagent[];
  /** Largura da COLUNA da esquerda (a dos agentes). */
  readonly largura: number;
  /** Frame do tique central — anima o spinner de cada agente VIVO. */
  readonly frame?: number;
  /** O painel de status, que passa a viver à DIREITA da barra. */
  readonly children: React.ReactNode;
}

/**
 * O rodapé com os agentes à esquerda, barra vertical, e o painel de status à direita.
 *
 * SEM agentes é PASSAGEM DIRETA: devolve os filhos como estavam, sem caixa nem coluna. Não
 * é economia de código — é o que garante que a tela de quem nunca dispara um agente fique
 * byte a byte igual à de antes.
 */
export function FooterAgents(props: FooterAgentsProps): React.ReactElement {
  const theme = useTheme();
  if (props.agentes.length === 0) return <>{props.children}</>;

  const largura = Math.max(24, props.largura);
  const frame = props.frame ?? 0;
  const ordenados = ordenaParaRodape(props.agentes);
  const cabem = agentesQueCabem();
  const mostrados = ordenados.length <= cabem ? ordenados : ordenados.slice(0, cabem - 1);
  const sobra = ordenados.length - mostrados.length;

  // Conectores de árvore. Em perfil ASCII eles viram espaço: desenhar `┌` num terminal que
  // não o tem é o tofu que o modo ASCII existe para evitar (F-ASCII-DE-VERDADE).
  const conector = (i: number, ultimo: boolean): string => {
    if (!theme.unicode) return ' ';
    if (mostrados.length === 1) return '─';
    return i === 0 ? '┌' : ultimo ? '└' : '├';
  };

  const linhas: React.ReactElement[] = mostrados.map((a, i) => {
    const vivo = agenteVivo(a);
    const ultimo = i === mostrados.length - 1 && sobra === 0;
    const glifo = vivo
      ? theme.animate
        ? (theme.spinnerFrames[(frame + i) % theme.spinnerFrames.length] ?? '·')
        : theme.glyph('clock')
      : a.phase === 'done'
        ? theme.glyph('ok')
        : theme.glyph('err');
    const papel = vivo ? 'accentDim' : a.phase === 'done' ? 'success' : 'danger';
    return (
      <Box key={`${a.label}:${String(i)}`}>
        <Role name="fgDim">{' '.repeat(RECUO) + conector(i, ultimo) + ' '}</Role>
        <Role name={papel}>{glifo}</Role>
        <Role name="fgDim">{' ' + linhaAgente(a)}</Role>
      </Box>
    );
  });

  if (sobra > 0) {
    linhas.push(
      <Box key="sobra">
        <Role name="fgDim">
          {' '.repeat(RECUO) + (theme.unicode ? '└' : ' ') + ` +${String(sobra)} outros`}
        </Role>
      </Box>,
    );
  }
  // Completa até a altura fixa — é isto que mantém o bloco estável quando um filho termina.
  // O preenchimento precisa TER CONTEÚDO: um `<Box/>` vazio ocupa ZERO linha no Ink, e a
  // altura voltava a variar com o tamanho do lote (o teste pegou: 3 alturas diferentes).
  while (linhas.length < LINHAS_RODAPE_AGENTES - 1) {
    linhas.push(
      <Box key={`vazio:${String(linhas.length)}`}>
        <Role name="fgDim">{' '}</Role>
      </Box>,
    );
  }

  return (
    <Box>
      <Box width={largura} flexDirection="column">
        <Box>
          <Role name="fgDim">{`${theme.glyph('clock')} ${ROTULO}`}</Role>
        </Box>
        {linhas}
      </Box>
      <Box
        flexDirection="column"
        borderStyle={theme.unicode ? 'single' : 'classic'}
        borderTop={false}
        borderRight={false}
        borderBottom={false}
        borderColor={theme.role('fgDim').color}
        paddingLeft={1}
      >
        {props.children}
      </Box>
    </Box>
  );
}
