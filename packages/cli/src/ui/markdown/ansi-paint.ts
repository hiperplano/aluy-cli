// F-ECO-PINTADO — pintura de linha dentro de uma caixa de fundo.
//
// Módulo próprio porque o problema que ele resolve aparece em TODO bloco que vive dentro
// de uma caixa pintada — parágrafo, lista, código e tabela — e a solução tem de ser a
// mesma nos quatro, senão um deles volta a abrir buraco no fundo.

/**
 * Um trecho de texto vestido com códigos ANSI de reset SELETIVO.
 *
 * Existe por causa de um detalhe do Ink: componentes de estilo aninhados (`<Text bold>`,
 * `<Role dimColor>`) fecham com reset TOTAL (`ESC[0m`), e reset total apaga o FUNDO junto
 * com a cor. Dentro de uma caixa pintada isso abria um vão sem fundo depois de cada trecho
 * estilizado — o "quadradinho branco a cada linha de bullet", que aparecia logo após o
 * marcador justamente porque o marcador é o pedaço colorido.
 *
 * Os fechamentos usados aqui são cirúrgicos: `ESC[39m` devolve só a cor de frente,
 * `ESC[22m` desliga só o peso. Nenhum deles toca no fundo, então a linha inteira pode ser
 * emitida como UMA string dentro de um único `<Text backgroundColor>` — sem aninhamento,
 * sem reset total, sem buraco.
 */
export function vestir(
  texto: string,
  estilo: { readonly color?: string | undefined; readonly bold?: boolean; readonly dim?: boolean },
): string {
  if (texto === '') return '';
  let abre = '';
  let fecha = '';
  if (estilo.bold === true) {
    abre += '\u001B[1m';
    fecha = '\u001B[22m' + fecha;
  }
  if (estilo.dim === true) {
    abre += '\u001B[2m';
    fecha = '\u001B[22m' + fecha;
  }
  const rgb = hexParaRgb(estilo.color);
  if (rgb !== undefined) {
    abre += `\u001B[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m`;
    fecha = '\u001B[39m' + fecha;
  }
  return abre + texto + fecha;
}

/** `#RRGGBB` ⇒ `[r,g,b]`. Qualquer outra coisa ⇒ `undefined` (sem cor, sem inventar). */
export function hexParaRgb(hex: string | undefined): readonly [number, number, number] | undefined {
  if (hex === undefined || !/^#[0-9a-fA-F]{6}$/.test(hex)) return undefined;
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}

