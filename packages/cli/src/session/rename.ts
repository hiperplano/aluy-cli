// EST-0972 — `/rename <nome> [--cor <cor>]`: dá um RÓTULO amigável + uma COR de
// identificação à sessão corrente. Lógica PURA (sem Ink, sem I/O) — o parse do arg,
// a validação da cor e a derivação da cor DEFAULT (determinística pelo nome). O wiring
// (run.tsx/App) aplica o resultado no controller + persiste no record.
//
// REGRAS:
//   /rename <nome>             → rótulo = <nome>; cor = hash(<nome>) na paleta do DS.
//   /rename <nome> --cor <cor> → rótulo = <nome>; cor = <cor> (validada na paleta).
//   /rename                    → sem mudança: MOSTRA o rótulo+cor atuais + o uso.
//   /rename --limpar  (ou nome vazio com --cor)
//                              → LIMPA o rótulo (volta ao default sem rótulo).
//
// HG-2/CLI-SEC: nome + cor são DADO DE UI (um identificador), NÃO credencial nem
// provider. Seguro persistir no record (`~/.aluy/sessions/<id>.json`). Sem rede, sem
// efeito no agente — `/rename` é ato do USUÁRIO no composer (slash não é tool).

import {
  hashToSessionColor,
  isSessionColorName,
  SESSION_COLOR_NAMES,
  type SessionColorName,
} from '../ui/theme/session-colors.js';
import { displayWidth } from './visual-lines.js';

/** O RÓTULO efetivo da sessão (nome + cor). Ambos presentes quando há rótulo. */
export interface SessionLabel {
  /** Nome amigável (já saneado: trim + colapso de espaços + teto de tamanho). */
  readonly label: string;
  /** Cor de identificação (nome da paleta do DS). */
  readonly color: SessionColorName;
}

/** O resultado de rotear um `/rename`. PURO — o wiring decide o efeito. */
export type RenameResult =
  // define/troca o rótulo (nome + cor resolvida). O wiring aplica + persiste + confirma.
  // F176 — `notice` opcional: aviso NÃO-fatal a exibir junto (ex.: cor inválida ⇒ o
  // nome válido AINDA aplica, com a cor automática, e o aviso explica o descarte da cor).
  | { readonly kind: 'set'; readonly label: SessionLabel; readonly notice?: string }
  // LIMPA o rótulo (volta ao default — composer sem ●+nome). O wiring aplica + persiste.
  | { readonly kind: 'clear' }
  // `/rename` puro: só MOSTRA o estado atual (+ o uso). Não muda nada.
  | { readonly kind: 'show' }
  // erro de validação (cor inválida) — a `note` já lista as cores válidas.
  | { readonly kind: 'error'; readonly message: string };

/** Teto de tamanho do rótulo — cabe no composer denso sem roubar a linha. */
export const MAX_LABEL_LEN = 32;

/** Saneia o nome: colapsa espaços, apara, trunca no teto (sufixo `…`). PURO.
 * FIX (HUNT-RENDER): o teto é em COLUNAS DE EXIBIÇÃO, não em unidades UTF-16. Antes
 * `t.length`/`slice` deixava um nome de 32 CJK = 64 COLUNAS (cada CJK ocupa 2) roubar a
 * linha do composer/SessionTag, E podia PARTIR um emoji/astral no corte (surrogate órfão
 * `�`). Agora mede/corta por largura de exibição, iterando por code point. */
function sanitizeLabel(raw: string): string {
  const t = raw.replace(/\s+/g, ' ').trim();
  if (displayWidth(t) <= MAX_LABEL_LEN) return t;
  // reserva 1 coluna p/ o `…`; acumula code points até encher o orçamento.
  const budget = MAX_LABEL_LEN - 1;
  let acc = '';
  let used = 0;
  for (const ch of t) {
    const w = displayWidth(ch);
    if (used + w > budget) break;
    acc += ch;
    used += w;
  }
  return acc + '…';
}

/**
 * Extrai o flag `--cor <valor>` de uma string de args, devolvendo `{ rest, color }`
 * onde `rest` é o args SEM o flag e `color` é o valor cru (ou undefined). Aceita
 * `--cor azul` e `--cor=azul`. Só o PRIMEIRO `--cor` conta. PURO.
 */
function extractColorFlag(args: string): { readonly rest: string; readonly color?: string } {
  // forma `--cor=valor`
  const eq = /(?:^|\s)--cor=(\S+)/i.exec(args);
  if (eq) {
    const rest = args.replace(eq[0], ' ').replace(/\s+/g, ' ').trim();
    return { rest, color: eq[1] };
  }
  // forma `--cor valor` — HUNT-SLASH: o `--cor` precisa ser a flag INTEIRA, não um
  // PREFIXO de outra palavra. Sem a fronteira `(?=\s|$)`, um nome como `--corrida` (ou
  // `--correct`) casava `--cor` e era tratado como a flag (color='' ⇒ erro espúrio, e o
  // resto do token virava `rida`). Exigir whitespace/fim após `--cor` evita o misparse.
  const sp = /(?:^|\s)--cor(?=\s|$)(?:\s+(\S+))?/i.exec(args);
  if (sp) {
    const rest = args.replace(sp[0], ' ').replace(/\s+/g, ' ').trim();
    // `--cor` sem valor ⇒ color = '' (o caller trata como erro de uso).
    return { rest, color: sp[1] ?? '' };
  }
  return { rest: args.trim() };
}

/**
 * Roteia o ARG do `/rename`. PURO/determinístico (sem I/O). Resolve a cor:
 *  - `--cor <cor>` explícito → valida contra a paleta do DS; inválida ⇒ erro listando
 *    as válidas. Sem nome (`/rename --cor azul`) ⇒ erro de uso (cor exige nome).
 *  - sem `--cor` → cor DETERMINÍSTICA do nome (hash → índice na paleta). Mesmo nome ⇒
 *    mesma cor, estável entre execuções/máquinas.
 *  - `/rename --limpar` / `/rename limpar` / `/rename ""` → limpa o rótulo.
 *  - `/rename` puro → `show` (o wiring mostra o estado atual + o uso).
 */
export function routeRename(args: string): RenameResult {
  const { rest, color: rawColor } = extractColorFlag(args);
  const name = rest.trim();

  // `/rename` puro (sem nome e sem --cor) ⇒ MOSTRA o estado atual.
  if (name === '' && rawColor === undefined) {
    return { kind: 'show' };
  }

  // limpar: `/rename --limpar` ou `/rename limpar` (palavra reservada) ⇒ volta ao default.
  // (`name===''` puro sem --cor já caiu no `show` acima — `/rename` sozinho não limpa,
  // p/ não apagar um rótulo por engano; limpar é EXPLÍCITO.)
  if (rawColor === undefined && /^(--limpar|limpar|--clear|clear)$/i.test(name)) {
    return { kind: 'clear' };
  }

  // `--cor` sem nome ⇒ a cor identifica QUEM? exige um nome. Erro de uso claro.
  if (rawColor !== undefined && name === '') {
    return {
      kind: 'error',
      message: 'a cor identifica um nome — use `/rename <nome> --cor <cor>`.',
    };
  }

  let color: SessionColorName;
  let notice: string | undefined;
  if (rawColor !== undefined && rawColor !== '' && isSessionColorName(rawColor)) {
    color = rawColor.trim().toLowerCase() as SessionColorName;
  } else if (rawColor !== undefined) {
    // F176 — cor INVÁLIDA com NOME válido: NÃO descarta o rename (o nome é o principal;
    // a cor é secundária). Aplica o nome com a cor AUTOMÁTICA e AVISA que a cor caiu —
    // antes, um `--cor xyz` errado abortava o rename inteiro e o nome válido se perdia
    // silenciosamente (a mensagem só falava da cor, sem dizer que nada foi aplicado).
    color = hashToSessionColor(sanitizeLabel(name));
    const corLabel = rawColor === '' ? 'cor sem valor' : `cor inválida "${rawColor}"`;
    notice = `${corLabel} — usei a cor automática. cores válidas: ${SESSION_COLOR_NAMES.join(', ')}.`;
  } else {
    // sem --cor: cor DEFAULT determinística pelo nome saneado (mesmo nome ⇒ mesma cor).
    color = hashToSessionColor(sanitizeLabel(name));
  }

  return {
    kind: 'set',
    label: { label: sanitizeLabel(name), color },
    ...(notice !== undefined ? { notice } : {}),
  };
}

/** Saída mínima do `/rename` linear (não-TTY) — `process.stdout` ou um fake. */
export interface RenameLinearOut {
  write(chunk: string): void;
}

/** Dependências do `/rename` linear: aplica o rótulo e persiste (mesma ação do TTY). */
export interface RenameLinearDeps {
  /** Aplica (ou limpa, com `label===undefined`) o rótulo+cor no controller. */
  readonly setLabel: (label: string | undefined, color?: string) => void;
  /** Rótulo corrente (p/ o `show` sem arg). */
  readonly currentLabel?: string | undefined;
  /** Cor corrente (p/ o `show`). */
  readonly currentColor?: string | undefined;
  /** Persiste o record após aplicar (best-effort). */
  readonly persist: () => void;
}

/**
 * EST-0972 — `/rename` em modo NÃO-TTY (paridade com `/history` linear): sem render
 * interativo. Aplica o rótulo (set/clear), persiste e ECOA a confirmação no `out`.
 * `/rename` puro ⇒ mostra o estado atual + o uso. Cor inválida ⇒ a mensagem de erro
 * (já lista as válidas). Devolve `true` se TRATOU a linha (`/rename`/`/rename …`) —
 * o caller não a manda p/ o agente como objetivo. PURO quanto a render (sem Ink).
 */
export function runRenameLinear(
  goal: string | undefined,
  out: RenameLinearOut,
  deps: RenameLinearDeps,
): boolean {
  const line = (goal ?? '').trim();
  if (line !== '/rename' && !line.startsWith('/rename ')) return false;
  const args = line === '/rename' ? '' : line.slice('/rename '.length);
  const result = routeRename(args);
  switch (result.kind) {
    case 'set':
      deps.setLabel(result.label.label, result.label.color);
      deps.persist();
      // F176 — ecoa o aviso não-fatal (cor inválida → cor automática) ANTES do OK.
      if (result.notice !== undefined) out.write(`[rename] ${result.notice}\n`);
      out.write(`[rename] sessão: ● ${result.label.label} (cor: ${result.label.color})\n`);
      return true;
    case 'clear':
      deps.setLabel(undefined);
      deps.persist();
      out.write('[rename] rótulo removido — a sessão volta sem nome.\n');
      return true;
    case 'show':
      if (deps.currentLabel !== undefined) {
        out.write(
          `[rename] sessão: ● ${deps.currentLabel}${
            deps.currentColor ? ` (${deps.currentColor})` : ''
          }\n`,
        );
      } else {
        out.write(
          `[rename] sem rótulo. use \`/rename <nome> [--cor <cor>]\`. cores: ${SESSION_COLOR_NAMES.join(
            ', ',
          )}.\n`,
        );
      }
      return true;
    case 'error':
      out.write(`[rename] ${result.message}\n`);
      return true;
  }
}
