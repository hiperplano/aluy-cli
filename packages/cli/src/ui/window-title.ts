// TÍTULO da janela do terminal (OSC 0). Quando o usuário dá `/rename <nome>`, além do
// rótulo local na TUI, setamos o TÍTULO da janela (`aluy · <nome>`) — assim dá pra
// distinguir várias janelas/abas do aluy pelo nome. Espelha o `BackgroundController`
// (OSC 11): escreve a sequência direto no stdout, só se for TTY. Best-effort: nunca lança.
//
// OSC 0 = ícone + título (o mais compatível; a maioria dos terminais mostra como título).
// `ESC ] 0 ; <title> BEL`. BEL (0x07) termina a sequência (mais compatível que ST).

/** ESC (0x1b) e BEL (0x07) construídos por código — evita mangling de escape na fonte. */
const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);

/** Monta a sequência OSC 0 p/ `title` (saneado: sem control chars que quebrariam o OSC). */
export function windowTitleSeq(title: string): string {
  // remove controles (código < 32 ou 0x7f, que quebrariam o OSC), colapsa espaços.
  const clean = Array.from(title)
    .filter((c) => {
      const n = c.charCodeAt(0);
      return n >= 32 && n !== 127;
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
  return `${ESC}]0;${clean}${BEL}`;
}

/** Reset: título vazio (o shell restaura no próximo prompt). */
export const WINDOW_TITLE_RESET = `${ESC}]0;${BEL}`;

/**
 * Aplica (ou reseta, com `title` vazio/undefined) o título da janela. Só em TTY — num
 * pipe/redirect não há janela e a sequência só sujaria a saída. Nunca lança.
 */
export function setWindowTitle(
  title: string | undefined,
  stdout: Pick<NodeJS.WriteStream, 'isTTY' | 'write'> = process.stdout,
): void {
  if (!stdout.isTTY) return;
  try {
    stdout.write(
      title !== undefined && title.trim() !== '' ? windowTitleSeq(title) : WINDOW_TITLE_RESET,
    );
  } catch {
    /* best-effort: título é cosmético, nunca derruba a sessão */
  }
}
