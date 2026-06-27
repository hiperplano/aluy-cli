// EST-0957 — helpers PUROS de composição do `@` no input do composer.
//
// O picker `@` abre quando o usuário digita um `@` e filtra pelo que vem DEPOIS
// dele (o "trailing mention" — o trecho `@auth/sess` no fim do input). Estas
// funções extraem/removem esse trecho sem I/O, p/ a App e os testes raciocinarem
// igual. O `@` válido é o ÚLTIMO `@` no input que esteja no começo ou após espaço
// (não um `@` no meio de uma palavra, ex.: `e-mail@host`).

/** A menção em digitação no FIM do input: `{ at, query }` ou null se não há. */
export interface TrailingMention {
  /** Índice do `@` no input. */
  readonly at: number;
  /** Texto após o `@` até o fim (a query do picker). */
  readonly query: string;
}

/**
 * Detecta uma menção `@` sendo digitada no FIM do input. Devolve null se o último
 * `@` não está numa borda (início/após espaço) ou se há espaço depois dele (a
 * menção "fechou" — não filtramos mais). A query pode ter `/`, `.`, `-`, `_` e
 * alfanuméricos (caracteres de caminho); um espaço encerra.
 */
export function trailingMention(input: string): TrailingMention | null {
  const at = input.lastIndexOf('@');
  if (at < 0) return null;
  // Borda: `@` no começo ou logo após whitespace.
  const before = at > 0 ? input[at - 1] : ' ';
  if (before !== ' ' && before !== '\n' && before !== '\t') return null;
  const query = input.slice(at + 1);
  // Um espaço na query encerra a menção (o usuário seguiu digitando texto).
  if (/\s/.test(query)) return null;
  return { at, query };
}

/**
 * Remove a menção `@query` em digitação do FIM do input (após confirmar/cancelar
 * o picker), deixando o texto antes dela SEM espaço pendente à direita (o chip já
 * representa o anexo; o composer fica limpo p/ o usuário seguir digitando).
 */
export function stripTrailingMention(input: string): string {
  const m = trailingMention(input);
  if (!m) return input;
  return input.slice(0, m.at).replace(/\s+$/, '');
}
