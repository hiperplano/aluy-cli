// EST-0972 — PALETA de identificação de SESSÃO (cor do `/rename`).
//
// Cada sessão pode ganhar uma COR de identificação (um ● colorido + o nome no
// composer e no /history). A cor sai DAQUI — uma paleta CURADA do Aluy DS, NÃO uma
// paleta crua inventada por tela. Regra mestra (igual ao resto da TUI): componente
// não acessa cor crua — lê um NOME de cor desta paleta, que resolve p/ truecolor
// (24-bit), 16-cores (fallback Ink/ANSI) e mono (degrada p/ texto/glifo, sem cor).
//
// As cores são as MESMAS famílias tonais do tema do DS (`palette.ts`/colors_and_type):
// o âmbar da marca (accent), o verde de sucesso, o teal de profundidade, o coral de
// perigo — MAIS alguns tons vizinhos da mesma temperatura (ardósia/violeta/rosa) p/
// dar N pistas DISTINGUÍVEIS sem sair do vocabulário do DS. Não há cor "nova de
// produto" aqui: é o DS estendido a um eixo de ROTULAGEM, não de SIGNIFICADO
// semântico (a cor da sessão é só um identificador, não carrega estado).
//
// HG-2/CLI-SEC: a cor (como o nome) é DADO DE UI — não é credencial nem provider.
// Seguro persistir no record da sessão (`~/.aluy/sessions/<id>.json`).

import type { ColorMode, Brightness } from './theme.js';
import type { RoleStyle } from './palette.js';

/** O NOME de uma cor da paleta de sessão (pt-BR; o que o `/rename --cor` aceita). */
export type SessionColorName =
  | 'ambar'
  | 'verde'
  | 'teal'
  | 'azul'
  | 'violeta'
  | 'rosa'
  | 'coral'
  | 'ardosia';

/** Uma cor da paleta resolvida para os três modos (truecolor/ansi16/mono). */
interface SessionColorDef {
  readonly name: SessionColorName;
  /** Hex truecolor — tema DARK (default). */
  readonly darkHex: string;
  /** Hex truecolor — tema LIGHT (escurecido p/ contraste AA sobre fundo claro). */
  readonly lightHex: string;
  /** Nome de cor do Ink/ANSI (fallback 16-cores). */
  readonly ansi: string;
}

/**
 * A PALETA — 8 cores distinguíveis, derivadas das famílias do DS. A ORDEM é estável
 * e importa: o hash do nome (`hashToSessionColor`) indexa NESTA ordem, então mexer na
 * ordem muda a cor default de sessões já nomeadas (evitar). Acréscimo no FIM é seguro.
 *
 * Os hex dark espelham/vizinham os papéis do tema dark (`TRUECOLOR_DARK`):
 *   ambar=accent · verde=success · teal=depth · coral=danger; azul/violeta/rosa/ardosia
 *   são tons vizinhos da mesma paleta (não cores cruas fora do DS). Os hex light são as
 *   versões escurecidas p/ piso AA sobre fundo claro (mesma regra do `TRUECOLOR_LIGHT`).
 */
export const SESSION_COLORS: readonly SessionColorDef[] = [
  { name: 'ambar', darkHex: '#DDA13F', lightHex: '#82530F', ansi: 'yellow' },
  { name: 'verde', darkHex: '#82CF9E', lightHex: '#1F6B3A', ansi: 'green' },
  { name: 'teal', darkHex: '#5BA8A2', lightHex: '#2E6E69', ansi: 'cyan' },
  { name: 'azul', darkHex: '#6FA8DC', lightHex: '#1F5C99', ansi: 'blue' },
  { name: 'violeta', darkHex: '#B08CD9', lightHex: '#6A3FA6', ansi: 'magenta' },
  { name: 'rosa', darkHex: '#E59BC0', lightHex: '#A63D74', ansi: 'magenta' },
  { name: 'coral', darkHex: '#E5897C', lightHex: '#B23A2A', ansi: 'red' },
  { name: 'ardosia', darkHex: '#9AA7B0', lightHex: '#4A5963', ansi: 'gray' },
];

/** Os NOMES válidos (p/ a validação do `/rename --cor` e a mensagem de erro). */
export const SESSION_COLOR_NAMES: readonly SessionColorName[] = SESSION_COLORS.map((c) => c.name);

/** `true` se `s` é um nome de cor VÁLIDO da paleta (type-guard). PURO. */
export function isSessionColorName(s: string): s is SessionColorName {
  return (SESSION_COLOR_NAMES as readonly string[]).includes(s.trim().toLowerCase());
}

/**
 * Hash DETERMINÍSTICO de uma string → ÍNDICE na paleta (FNV-1a 32-bit, estável entre
 * máquinas/execuções). MESMO nome ⇒ MESMA cor, sempre. PURO. (FNV-1a é simples e
 * espalha bem p/ N pequeno; não é critério de segurança — é só rotulagem.)
 */
export function hashToSessionColor(label: string): SessionColorName {
  let h = 0x811c9dc5; // offset basis
  const s = label.trim().toLowerCase();
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    // multiplica pelo prime FNV (32-bit), via Math.imul p/ overflow consistente.
    h = Math.imul(h, 0x01000193);
  }
  // >>> 0 normaliza p/ inteiro sem sinal antes do módulo.
  const idx = (h >>> 0) % SESSION_COLORS.length;
  return SESSION_COLORS[idx]!.name;
}

/**
 * Resolve um NOME de cor da paleta → `RoleStyle` p/ o modo/brilho do terminal. Em
 * `mono` (NO_COLOR) devolve um estilo SEM cor (o significado mora no glifo+nome —
 * a11y): a cor degrada graciosamente p/ texto. Nome desconhecido (record adulterado)
 * ⇒ a cor default determinística pelo próprio nome (fail-safe, nunca lança). PURO.
 */
export function sessionColorStyle(
  name: string,
  mode: ColorMode,
  brightness: Brightness,
): RoleStyle {
  const key = name.trim().toLowerCase();
  const def =
    SESSION_COLORS.find((c) => c.name === key) ??
    // fail-safe: nome fora da paleta ⇒ resolve pela cor determinística do nome (nunca
    // quebra a render por um record adulterado).
    SESSION_COLORS.find((c) => c.name === hashToSessionColor(key))!;
  if (mode === 'mono') {
    // NO_COLOR: sem cor — o ● + o nome continuam visíveis (a cor não carrega o
    // significado; é só um identificador). `bold` dá um leve realce sem usar cor.
    return { bold: true };
  }
  if (mode === 'truecolor') {
    return { color: brightness === 'light' ? def.lightHex : def.darkHex, bold: true };
  }
  // ansi16 — nome de cor do Ink (truncamento honesto p/ 16 cores).
  return { color: def.ansi, bold: true };
}
