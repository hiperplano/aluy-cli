// EST · acabamento TUI — SYNTAX HIGHLIGHT puro, mapeado aos PAPÉIS do DS.
//
// Regra mestra (palette.ts / ADR-0041): NADA de cor crua nem tema externo. O
// realce de código deriva dos 7 papéis semânticos do tema de terminal. Aqui
// usamos `lowlight` (mantido) só p/ TOKENIZAR (devolve uma árvore hast com
// classes `hljs-*`); o RENDER é nosso, em papéis. Função PURA: string → lista
// de segmentos `{ text, role }`. Sem React, sem ANSI, sem I/O — testável.
//
// DS→syntax (decisão de design, comentada por papel):
//   keyword/built_in/literal  → accent     (a marca/âmbar = a "gramática" da fala)
//   string/regexp/char/subst  → success    (verde = valor literal, ecoa o `+` do diff)
//   comment/quote             → fgDim       (meta esmaecida, como a cronologia)
//   number/symbol/bullet      → accentDim   (âmbar calmo p/ constantes numéricas)
//   title/function/class/tag/section/name/attr → depth (petrol = estrutura/identidade)
//   type/params/selector-*/meta/attribute       → depth (idem: andaime do código)
//   deletion / important       → danger      (vermelho = remoção/erro, ecoa o `−`)
//   addition                   → success
//   (qualquer outra classe / sem classe)        → fg    (texto primário)
//
// Linguagens: registramos um conjunto curado (as que aparecem no dia-a-dia do
// agente). Linguagem desconhecida ⇒ degrada p/ texto cru em `fg` (fallback nº 1,
// nunca quebra). Em NO_COLOR/mono o RENDER (Role) já zera a cor — aqui só
// classificamos; o papel só "acende" se o tema tiver cor (palette MONO).

import { createLowlight } from 'lowlight';
import bash from 'highlight.js/lib/languages/bash';
import css from 'highlight.js/lib/languages/css';
import diff from 'highlight.js/lib/languages/diff';
import go from 'highlight.js/lib/languages/go';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import markdownLang from 'highlight.js/lib/languages/markdown';
import python from 'highlight.js/lib/languages/python';
import rust from 'highlight.js/lib/languages/rust';
import shell from 'highlight.js/lib/languages/shell';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';
import type { TermRole } from '../theme/palette.js';

/** Segmento de texto já classificado num PAPEL do DS (nunca cor crua). */
export interface HlSegment {
  readonly text: string;
  readonly role: TermRole;
}

// Conjunto curado + aliases comuns (o agente fala muito TS/JS/bash/json/diff).
const lowlight = createLowlight({
  bash,
  css,
  diff,
  go,
  javascript,
  json,
  markdown: markdownLang,
  python,
  rust,
  shell,
  sql,
  typescript,
  xml,
  yaml,
});

/** Aliases de fence → linguagem registrada (`ts`→typescript, `sh`→bash, …). */
const ALIASES: Readonly<Record<string, string>> = {
  ts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  sh: 'bash',
  zsh: 'bash',
  shell: 'shell',
  console: 'shell',
  py: 'python',
  rs: 'rust',
  golang: 'go',
  yml: 'yaml',
  html: 'xml',
  htm: 'xml',
  svg: 'xml',
  md: 'markdown',
  markdown: 'markdown',
  patch: 'diff',
};

/** Resolve o nome de linguagem de um fence p/ uma registrada, ou `null`. */
export function resolveLanguage(lang: string | undefined): string | null {
  if (!lang) return null;
  const key = lang.trim().toLowerCase();
  if (key === '') return null;
  const canon = ALIASES[key] ?? key;
  return lowlight.registered(canon) ? canon : null;
}

/**
 * Mapa `hljs-*` → PAPEL do DS. A árvore hast pode aninhar classes (`hljs-string`
 * contendo `hljs-subst`); pegamos a classe MAIS INTERNA (a folha vence) p/ o tom
 * mais específico. Classe não-mapeada (ou ausência de classe) ⇒ `fg`.
 */
function classToRole(className: string | undefined): TermRole {
  if (!className) return 'fg';
  // só nos importam as `hljs-*`; tiramos o prefixo e o sub-escopo (`title.function`).
  const raw = className.replace(/^hljs-/, '');
  const base = raw.split(/[.\s]/)[0] ?? raw;
  switch (base) {
    case 'keyword':
    case 'built_in':
    case 'literal':
    case 'operator':
      return 'accent';
    case 'string':
    case 'regexp':
    case 'char':
    case 'subst':
    case 'addition':
      return 'success';
    case 'comment':
    case 'quote':
    case 'meta': // shebang/diretiva: meta esmaecida
      return 'fgDim';
    case 'number':
    case 'symbol':
    case 'bullet':
    case 'link':
      return 'accentDim';
    case 'title':
    case 'function':
    case 'class':
    case 'name':
    case 'tag':
    case 'attr':
    case 'attribute':
    case 'type':
    case 'params':
    case 'property':
    case 'selector':
    case 'section':
    case 'variable':
      return 'depth';
    case 'deletion':
      return 'danger';
    default:
      return 'fg';
  }
}

// Nó hast (subconjunto que lowlight emite: root/element/text).
interface HastText {
  readonly type: 'text';
  readonly value: string;
}
interface HastElement {
  readonly type: 'element';
  readonly properties?: { readonly className?: readonly string[] | string };
  readonly children: readonly HastNode[];
}
type HastNode =
  | HastText
  | HastElement
  | { readonly type: string; readonly children?: readonly HastNode[] };

function classNameOf(node: HastElement): string | undefined {
  const cn = node.properties?.className;
  if (Array.isArray(cn)) return cn[cn.length - 1]; // folha: a classe mais específica
  if (typeof cn === 'string') return cn;
  return undefined;
}

/** Achata a árvore hast em segmentos, herdando o papel do ancestral mais próximo. */
function flatten(node: HastNode, inherited: TermRole, out: HlSegment[]): void {
  if (node.type === 'text') {
    const text = (node as HastText).value;
    if (text !== '') out.push({ text, role: inherited });
    return;
  }
  const el = node as HastElement;
  const own = el.type === 'element' ? classToRole(classNameOf(el)) : inherited;
  const role = el.type === 'element' && own !== 'fg' ? own : inherited;
  for (const child of el.children ?? []) flatten(child, role, out);
}

/** Coalesce segmentos adjacentes de mesmo papel (saída enxuta p/ snapshot). */
function coalesce(segs: readonly HlSegment[]): HlSegment[] {
  const out: HlSegment[] = [];
  for (const s of segs) {
    const last = out[out.length - 1];
    if (last && last.role === s.role)
      out[out.length - 1] = { text: last.text + s.text, role: s.role };
    else out.push(s);
  }
  return out;
}

/**
 * Realça `code` na `lang` dada → segmentos em PAPÉIS. Linguagem desconhecida ⇒
 * um único segmento `fg` (texto cru, fallback). NUNCA lança: erro de tokenização
 * degrada p/ texto cru (o realce é acabamento, jamais ponto de falha do render).
 */
export function highlightToSegments(code: string, lang: string | undefined): HlSegment[] {
  if (code === '') return [];
  const resolved = resolveLanguage(lang);
  if (!resolved) return [{ text: code, role: 'fg' }];
  try {
    const tree = lowlight.highlight(resolved, code) as unknown as HastNode;
    const out: HlSegment[] = [];
    flatten(tree, 'fg', out);
    const coalesced = coalesce(out);
    return coalesced.length > 0 ? coalesced : [{ text: code, role: 'fg' }];
  } catch {
    return [{ text: code, role: 'fg' }];
  }
}
