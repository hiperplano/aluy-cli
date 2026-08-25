// FOOTER-AGENTES — os sub-agentes VIVOS ao lado do painel de status, abaixo do composer.
//
// Pedido do dono: "e possivel colocar tambem os agentes abaixo do composer, aonde fica o
// footer hoje, pergunto isso para conseguirmos nao perder a visao dos agentes que podem ser
// adicionados ao longo de uma conversa e ai embaixo deles fica essas informacoes e vc move
// todo o conteudo do header pra direita separando por uma barra vertical".
//
// A contagem no indicador de trabalho responde "há trabalho"; ela não responde QUEM nem
// FAZENDO O QUÊ. Numa conversa em que agentes entram ao longo do caminho, é a segunda
// pergunta que se perde — e era ela que o dono não queria perder de vista.
//
// ALTURA CONSTANTE, de propósito. O bloco tem SEMPRE `LINHAS_RODAPE` linhas quando aparece:
// os agentes que couberem e, se sobrar gente, a última linha vira "+K". Um bloco que cresce
// com o número de agentes mudaria a altura do frame a cada filho que nasce ou termina — e
// altura que oscila é o tremor que a rc.148 passou o dia consertando. Aqui a altura só muda
// DUAS vezes: quando o bloco entra e quando sai (e o `liveSubagents` já tem histerese para
// que entrar-e-sair entre dois lotes não aconteça).
//
// A BARRA vertical é a borda nativa do Ink (`borderLeft` só), o mesmo recurso do
// `<Composer>`: ela se repete por todas as linhas sozinha, inclusive se a coluna da direita
// crescer. Desenhá-la à mão, linha a linha, é o que já quebrou aqui antes.

import React from 'react';
import { Box } from 'ink';
import { Role, useTheme } from '../theme/index.js';
import type { LiveSubagent } from '../../session/model.js';

/** Altura FIXA do bloco quando visível. Ver o cabeçalho: altura constante é anti-tremor. */
export const LINHAS_RODAPE_AGENTES = 4;

/** Rótulo da coluna, na mesma gramática do `<StatusPanel>` (glifo + rótulo alinhado). */
const ROTULO = 'agentes';

/**
 * O TEXTO de uma linha de agente. PURO e exportado: o orçamento de altura mede a mesma
 * composição que o render desenha, e um teste ancora as duas na mesma frase.
 */
export function linhaAgente(a: LiveSubagent, largura: number): string {
  const corta = (t: string): string =>
    t.length <= largura ? t : largura <= 1 ? '…' : t.slice(0, largura - 1) + '…';

  // ORDEM POR PRIORIDADE, não por gosto. A coluna é estreita e o corte vem da direita,
  // então o que fica à direita é o primeiro a morrer. QUEM (o rótulo) e HÁ QUANTO TEMPO
  // são o que responde "isto travou?" — a pergunta que faz o dono apertar F8. O QUE ele
  // está fazendo é detalhe: informa, mas não decide. Na primeira versão a atividade vinha
  // antes e comia o relógio (`read clim…`), justamente o inverso.
  const tempo = a.durationMs !== undefined ? `  ${formataDuracao(a.durationMs)}` : '';
  const base = `${a.label}${tempo}`;
  // A atividade só entra se couber um PEDAÇO ÚTIL dela. Sem este piso, `base` de 25 numa
  // coluna de 26 devolvia `historiador-fiction  0:31…` — e a reticência colada no relógio
  // lê como "o tempo foi cortado", quando o que ficou de fora foi a atividade. Reticência
  // que aponta para o campo errado é pior que campo ausente.
  const MIN_ATIVIDADE = 5;
  if (base.length + 2 + MIN_ATIVIDADE > largura) return corta(base);
  const atividade = a.activity !== undefined ? `${a.activity.tool} ${a.activity.target}` : 'rodando';
  return corta(`${base}  ${atividade}`);
}

/** `m:ss` — curto o bastante para caber ao lado do rótulo. */
export function formataDuracao(ms: number): string {
  const seg = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(seg / 60);
  const s = seg % 60;
  return `${String(m)}:${String(s).padStart(2, '0')}`;
}

/**
 * As LINHAS que o bloco mostra, dado o elenco vivo. PURO — decide o corte e o "+K" sem
 * tocar em React, para o teste poder provar a altura constante sem renderizar.
 */
export function linhasDoRodape(
  agentes: readonly LiveSubagent[],
  largura: number,
): readonly string[] {
  if (agentes.length === 0) return [];
  const cabem = agentes.length <= LINHAS_RODAPE_AGENTES
    ? agentes
    : agentes.slice(0, LINHAS_RODAPE_AGENTES - 1);
  const linhas = cabem.map((a) => linhaAgente(a, largura));
  const sobra = agentes.length - cabem.length;
  if (sobra > 0) linhas.push(`+${String(sobra)} outros`);
  // Completa até a altura fixa com linhas vazias — é isso que mantém a altura constante
  // quando um filho termina e os outros seguem.
  while (linhas.length < LINHAS_RODAPE_AGENTES) linhas.push('');
  return linhas;
}

export interface FooterAgentsProps {
  readonly agentes: readonly LiveSubagent[];
  /** Largura da COLUNA da esquerda (a dos agentes). */
  readonly largura: number;
  /** O painel de status, que passa a viver à DIREITA da barra. */
  readonly children: React.ReactNode;
}

/**
 * O rodapé com agentes à esquerda, barra vertical, e o painel de status à direita.
 *
 * SEM agentes vivos ele é PASSAGEM DIRETA: devolve os filhos como estavam, sem caixa,
 * sem borda, sem coluna. Isso não é economia de código — é o que garante que a tela de
 * quem nunca dispara um agente fique byte a byte igual à de antes.
 */
export function FooterAgents(props: FooterAgentsProps): React.ReactElement {
  const theme = useTheme();
  if (props.agentes.length === 0) return <>{props.children}</>;
  const largura = Math.max(12, props.largura);
  // O rótulo ocupa a primeira linha da coluna; as demais ficam alinhadas sob ele.
  const linhas = linhasDoRodape(props.agentes, largura - ROTULO.length - 3);
  return (
    <Box>
      <Box width={largura} flexDirection="column">
        {linhas.map((linha, i) => (
          <Box key={i}>
            <Role name="fgDim">{i === 0 ? `${theme.glyph('clock')} ${ROTULO} ` : ' '.repeat(ROTULO.length + 3)}</Role>
            <Role name={linha.startsWith('+') ? 'fgDim' : 'accentDim'}>{linha}</Role>
          </Box>
        ))}
      </Box>
      <Box
        flexDirection="column"
        // F-ASCII-DE-VERDADE — como no `<Composer>`: em perfil ASCII o `bold` desenharia
        // `┃`, que é o que esse modo existe para evitar.
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
