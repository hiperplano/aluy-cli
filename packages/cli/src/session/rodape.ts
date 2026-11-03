// RODAPÉ `parcial` — a linha ÚNICA com o essencial, no lugar do painel de status inteiro.
//
// PURO (sem Ink): decide QUAIS segmentos aparecem e cabem em `columns`. Os AVISOS (yolo,
// sidecar caído, pausa por cota) têm a maior prioridade e só saem por último — o modo compacto
// nunca esconde um aviso de segurança. Ordem de corte (primeiro a sair → último): dicas,
// tokens, janela, caminho, modelo, avisos.

export type RodapeRole = 'fg' | 'fgDim' | 'danger' | 'accent';

export interface RodapeSegmento {
  readonly texto: string;
  readonly role: RodapeRole;
  /** Maior = sai por último. */
  readonly prioridade: number;
}

export interface RodapeParcialEntrada {
  readonly model?: string | undefined;
  readonly cwd: string;
  readonly home?: string | undefined;
  readonly windowPct: number;
  readonly tokens: number;
  /** Modo yolo (catraca desligada). */
  readonly unsafe: boolean;
  /** Algum sidecar ligou e caiu. */
  readonly sidecarCaido: boolean;
  /** Pausa por cota ativa. */
  readonly cotaPausada: boolean;
  /** Segmento curto de dicas (cortado primeiro). */
  readonly dicas?: string | undefined;
  readonly columns: number;
}

const SEP = ' · ';

/** Caminho com `~` no lugar do HOME e, se longo, cortado pela CABEÇA (`…/pasta/projeto`). */
export function caminhoCurto(cwd: string, home: string | undefined, max: number): string {
  let p = cwd;
  if (home !== undefined && home !== '' && (p === home || p.startsWith(home + '/'))) {
    p = '~' + p.slice(home.length);
  }
  if (p.length <= max) return p;
  const corte = p.slice(p.length - Math.max(1, max - 1));
  const barra = corte.indexOf('/');
  return '…' + (barra > 0 && barra < corte.length - 1 ? corte.slice(barra) : corte);
}

function compacto(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
}

/** Os segmentos que cabem em `columns` (já sem o recuo do bloco). */
export function segmentosParcial(a: RodapeParcialEntrada): RodapeSegmento[] {
  const todos: RodapeSegmento[] = [];
  if (a.model !== undefined && a.model !== '')
    todos.push({ texto: a.model, role: 'fg', prioridade: 5 });
  todos.push({ texto: caminhoCurto(a.cwd, a.home, 32), role: 'fgDim', prioridade: 4 });
  todos.push({ texto: `${String(a.windowPct)}% janela`, role: 'fgDim', prioridade: 3 });
  if (a.tokens > 0) todos.push({ texto: compacto(a.tokens), role: 'fgDim', prioridade: 2 });
  if (a.cotaPausada) todos.push({ texto: '⏸ cota', role: 'accent', prioridade: 9 });
  if (a.sidecarCaido) todos.push({ texto: '⚠ sidecar', role: 'accent', prioridade: 9 });
  if (a.unsafe) todos.push({ texto: '⚠ yolo', role: 'danger', prioridade: 10 });
  if (a.dicas !== undefined && a.dicas !== '')
    todos.push({ texto: a.dicas, role: 'fgDim', prioridade: 1 });

  const largura = (s: readonly RodapeSegmento[]): number =>
    s.reduce((n, x) => n + [...x.texto].length, 0) + Math.max(0, s.length - 1) * SEP.length;
  let atual = [...todos];
  while (atual.length > 1 && largura(atual) > a.columns) {
    // remove o de MENOR prioridade (o último empatado, p/ preservar a ordem de leitura)
    let idx = 0;
    for (let i = 0; i < atual.length; i++) {
      if (atual[i]!.prioridade <= atual[idx]!.prioridade) idx = i;
    }
    atual = atual.filter((_, i) => i !== idx);
  }
  return atual;
}

/** Texto plano da linha (testes / medição). */
export function linhaParcial(a: RodapeParcialEntrada): string {
  return segmentosParcial(a)
    .map((s) => s.texto)
    .join(SEP);
}
