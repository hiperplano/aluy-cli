// EST-0989 — DRIVER do SPLASH de boot (TTY-only): monta o <SplashScreen> com Ink,
// segura a cena enquanto o boot trabalha (config/MCP/recall/sessão/perfis) e
// apresenta as PERGUNTAS de boot (retomar `[S/n]`, confirmar `--yolo`) numa CAIXA
// formatada e centralizada — no lugar das frases soltas no meio da tela.
//
// Por que um driver à parte (≠ a App)?
//  · O boot do `run.tsx` é uma SEQUÊNCIA IMPERATIVA assíncrona (await isto, await
//    aquilo, pergunta, monta a TUI). Um componente React não casa com isso. Então
//    expomos uma API imperativa fininha (setStatus / promptYesNo / finish) que muda
//    um STORE observável; o <SplashApp> só REFLETE o store (React puro).
//  · Mantém o splash 100% no caminho de BOOT (run.tsx + estes dois arquivos) — NÃO
//    toca App/TurnBlock/Composer (o agente do cursor está lá; evitamos colisão).
//
// GATE TTY-only: o caller (run.tsx) só constrói o splash no ramo TTY. Em não-TTY/
// linear/CI o ramo retorna ANTES — sem splash, sem clear, comportamento intacto.
//
// promptYesNo: MESMO contrato do `defaultBootPrompt` (`(prompt) => Promise<boolean>`),
// então entra direto no `decideBootResume`/confirmação de YOLO sem mudar a assinatura.
// SINGLE-KEY consistente com a TUI (EST-0972): s/y/Enter ⇒ sim; n/Esc/Ctrl-C ⇒ não.
// O texto cru (`↻ … [S/n]`) é PARSEADO p/ a caixa (title/body/options) — a frase solta
// some, vira bloco formatado.
//
// TRANSIÇÃO LIMPA (anti-fantasma EST-0965/#118): ao `finish()`, desmonta o Ink do
// splash E re-emite o boot-clear (tela+scrollback) ANTES de a App montar — o Ink da
// App começa numa tela vazia, sem deixar o miolo do splash preso no scrollback.

import React, { useEffect, useSyncExternalStore } from 'react';
import { render, useApp, useInput, type Instance } from 'ink';
import { ThemeProvider } from '../ui/theme/index.js';
import type { Theme } from '../ui/theme/theme.js';
import { useTick } from '../ui/hooks/useTick.js';
import { SplashScreen, type BootPrompt } from '../ui/components/SplashScreen.js';
import { emitBootClear } from './run-clear.js';
import { CLI_VERSION } from '../version.js';

/** Cadência LENTA da cauda de pontinhos do "carregando" (ms). ~3 pontos/s — calmo,
 *  bem abaixo do tick de stream (anti-flicker: a marca não treme, só a cauda muda). */
export const SPLASH_DOTS_MS = 320;

/**
 * Piso de exibição do splash (ms). Com broker LOCAL o boot é quase instantâneo e a
 * frase divertida do splash mal aparece — este piso garante tempo de leitura.
 * Override por `ALUY_SPLASH_MIN_MS` (>=0; 0 desliga). Default 2000.
 */
export function resolveSplashMinMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.ALUY_SPLASH_MIN_MS;
  if (raw !== undefined) {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return 2000;
}

/** O estado observável do splash (verbo de carga + pergunta pendente). */
interface SplashState {
  readonly status: string;
  readonly prompt: BootPrompt | undefined;
  /** Resolver da pergunta corrente (setado enquanto há prompt; null fora dela). */
  readonly resolve: ((accept: boolean) => void) | null;
  /** Sinaliza que o splash terminou (a App vai montar) — o <SplashApp> desmonta. */
  readonly done: boolean;
}

/**
 * PARSE do texto cru do prompt de boot p/ a caixa formatada. Reconhece os dois
 * prompts que o boot faz hoje:
 *   · auto-oferta de retomada: `↻ retomar a conversa anterior (N mensagens, …)? [S/n]`
 *   · confirmação de YOLO (texto multi-linha do binário, contém "YOLO").
 * Qualquer outro texto cai no formato genérico (corpo = o texto sem o `[S/n]`). PURO.
 */
export function parseBootPrompt(raw: string): BootPrompt {
  const text = raw.trim();
  // Tira o sufixo de opções cru (`[S/n]`, `[s/N]`, …) — a caixa tem a sua própria
  // linha de opções clara; não repetimos o marcador no corpo.
  const body = text.replace(/\s*\[[sSnNyY/]+\]\s*$/u, '').trim();

  const lower = body.toLowerCase();
  if (lower.includes('yolo')) {
    return {
      title: '⚠ modo YOLO',
      body: splitLines(body),
      options: '[s] entrar em YOLO · [n] seguir normal',
    };
  }
  if (lower.includes('retomar')) {
    return {
      title: '↻ retomar sessão',
      body: splitLines(body),
      options: '[s] retomar · [n] nova sessão',
    };
  }
  return {
    title: 'aluy',
    body: splitLines(body),
    options: '[s] sim · [n] não',
  };
}

/** Quebra o corpo em linhas (respeita quebras já presentes; descarta vazias do fim). */
function splitLines(body: string): string[] {
  const lines = body.split('\n').map((l) => l.trimEnd());
  while (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * Cria e MONTA o splash de boot. Devolve a API imperativa que o `run.tsx` usa.
 * `theme` é a fotografia 1 já resolvida no boot (mesma do <ThemeRoot>). `stdout` é o
 * MESMO fio do render da App. TTY-only por contrato (o caller só chama no ramo TTY).
 */
export function createBootSplash(opts: {
  readonly theme: Theme;
  readonly stdout: NodeJS.WriteStream;
}): BootSplash {
  const store = createSplashStore();
  const instance: Instance = render(
    <ThemeProvider theme={opts.theme}>
      <SplashApp store={store} />
    </ThemeProvider>,
    { stdout: opts.stdout, exitOnCtrlC: false },
  );
  return new BootSplash(store, instance, opts.stdout);
}

/** API imperativa do splash (o que o boot chama). */
export class BootSplash {
  constructor(
    private readonly store: SplashStore,
    private readonly instance: Instance,
    private readonly stdout: NodeJS.WriteStream,
  ) {}

  /** Atualiza o verbo de carga ("carregando" → "descobrindo MCP" → …). */
  setStatus(status: string): void {
    this.store.set((s) => ({ ...s, status }));
  }

  /**
   * Apresenta uma pergunta SIM/NÃO na caixa formatada e resolve no single-key.
   * MESMO contrato do `defaultBootPrompt`. Enquanto pendente, a caixa substitui a
   * linha "carregando"; ao decidir, volta p/ o "carregando" (próximo passo do boot).
   */
  promptYesNo = (raw: string): Promise<boolean> =>
    new Promise<boolean>((resolve) => {
      const prompt = parseBootPrompt(raw);
      const finish = (accept: boolean): void => {
        // Limpa a pergunta (volta p/ "carregando") e resolve UMA vez.
        this.store.set((s) => ({ ...s, prompt: undefined, resolve: null }));
        resolve(accept);
      };
      this.store.set((s) => ({ ...s, prompt, resolve: finish }));
    });

  /**
   * Encerra o splash: desmonta o Ink E re-emite o boot-clear ANTES de a App montar,
   * p/ a transição não deixar fantasma do splash no scrollback. Idempotente.
   */
  async finish(): Promise<void> {
    // 1) Marca `done` (para o tick e a captura de tecla) e RE-RENDERIZA o app p/ uma
    //    árvore VAZIA de forma SÍNCRONA (`rerender`). Sem isto, o `unmount` abaixo
    //    escreveria o ÚLTIMO frame do React PINTADO (a marca ainda viva) — o React só
    //    re-renderiza p/ `null` de forma assíncrona, então o `done` no store sozinho
    //    não chega a tempo. O `rerender(<></>)` força o frame vazio JÁ (sem race).
    this.store.set((s) => ({ ...s, done: true, prompt: undefined, resolve: null }));
    this.instance.rerender(<></>);
    // 2) `clear()` apaga a região viva (agora vazia) e `unmount()` desfaz o Ink. Como o
    //    frame corrente já é vazio, a desmontagem NÃO deixa fantasma do splash.
    //    NÃO esperamos `waitUntilExit()`: com `exitOnCtrlC:false` + raw-mode no stdin,
    //    a promise dele pode NUNCA resolver (deadlock observado no boot real) — o
    //    `unmount()` já é síncrono p/ a teardown do render. Esperar travaria o boot.
    this.instance.clear();
    this.instance.unmount();
    // 3) Deixa QUALQUER flush atrasado do Ink (o render throttle tem chamada de borda)
    //    pousar ANTES do clear final — senão ele pintaria POR CIMA do clear (o frame
    //    fantasma do #118). Um macro-task curto cobre a cadência (~32ms) do throttle.
    await new Promise((r) => setTimeout(r, 50));
    // 4) Re-clear FINAL: apaga tela + scrollback p/ a App montar do ZERO (sem nenhum
    //    resíduo do splash). É a última escrita antes do render da App.
    emitBootClear(this.stdout, true);
  }
}

// ── store observável fininho (fora do React; o <SplashApp> só reflete) ───────────

export interface SplashStore {
  get(): SplashState;
  set(fn: (s: SplashState) => SplashState): void;
  subscribe(listener: () => void): () => void;
}

export function createSplashStore(): SplashStore {
  let state: SplashState = { status: 'carregando', prompt: undefined, resolve: null, done: false };
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    set: (fn) => {
      state = fn(state);
      for (const l of listeners) l();
    },
    subscribe: (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
}

/**
 * O <SplashApp>: REFLETE o store. Mostra o <SplashScreen> centralizado; quando há
 * pergunta pendente, captura o single-key e chama o `resolve`. Desmonta-se quando o
 * store vira `done` (o `finish()` já chamou unmount, mas isto cobre o caminho do
 * Ctrl-C interno). PURO em relação ao store — não tem estado próprio além do tick.
 */
export function SplashApp(props: { readonly store: SplashStore }): React.ReactElement | null {
  const state = useSyncExternalStore(props.store.subscribe, props.store.get, props.store.get);
  const { exit } = useApp();

  // Tick LENTO só p/ a cauda de pontinhos (anti-flicker: cadência baixa, a marca não
  // treme). Desliga quando há pergunta (a caixa é estática — sem animação) ou done.
  const ticking = state.prompt === undefined && !state.done;
  const frame = useTick({ enabled: ticking, intervalMs: SPLASH_DOTS_MS });

  // Captura do single-key da pergunta. Consistente com a TUI/EST-0972: s/y/Enter ⇒
  // sim; n/Esc ⇒ não. Ink já trata Ctrl-C (mas com exitOnCtrlC:false aqui ⇒ mapeamos
  // p/ "não", sem derrubar o processo no meio do boot).
  //
  // O `useInput` fica SEMPRE ativo e o gate é DENTRO do handler (lê o `resolve`
  // pendente do store): alternar `isActive` de false→true descarta teclas na janela
  // da re-subscrição (flake observado no ink-testing) — manter ativo + gatear no
  // handler é mais robusto e não muda o comportamento (sem pergunta ⇒ `resolve` é null
  // ⇒ retorna). Antes da 1ª pergunta / depois de resolver ⇒ no-op.
  useInput((input, key) => {
    const resolve = props.store.get().resolve;
    if (!resolve) return;
    if (key.return) return resolve(true); // Enter = sim (default da auto-oferta).
    const ch = input.toLowerCase();
    if (ch === 's' || ch === 'y') return resolve(true);
    if (ch === 'n' || key.escape) return resolve(false);
    if (key.ctrl && ch === 'c') return resolve(false);
    // qualquer outra tecla: ignora (a pergunta segue na tela).
  });

  // Quando o store vira `done`, sai do Ink (cobre o caso de não ter chamado unmount).
  useEffect(() => {
    if (state.done) exit();
  }, [state.done, exit]);

  if (state.done) return null;

  return (
    <Splash
      status={state.status}
      frame={frame}
      {...(state.prompt !== undefined ? { prompt: state.prompt } : {})}
    />
  );
}

// EST-1015 (bug "tela quebra ao redimensionar" no boot) — o splash/resume lê
// `process.stdout.columns/rows`, mas sem ASSINAR o `'resize'` ele NÃO re-renderiza no
// SIGWINCH ⇒ a caixa (`↻ retomar sessão`/pergunta) fica na dimensão do BOOT e QUEBRA ao
// redimensionar (borda desalinha, texto parte no meio). `useSyncExternalStore` assina o
// resize e re-renderiza com a nova dimensão. Snapshot string `WxH` (estável quando igual).
function subscribeTerminalResize(cb: () => void): () => void {
  process.stdout.on('resize', cb);
  return () => {
    process.stdout.off('resize', cb);
  };
}
function terminalSizeSnapshot(): string {
  return `${process.stdout.columns ?? 80}x${process.stdout.rows ?? 24}`;
}

/** Lê columns/rows do stdout do Ink e monta o <SplashScreen> centralizado. */
function Splash(props: {
  readonly status: string;
  readonly frame: number;
  readonly prompt?: BootPrompt;
}): React.ReactElement {
  // O Ink injeta o stdout no contexto; mas p/ não acoplar a hook aqui, lemos do
  // process.stdout (este código só roda no ramo TTY real). Fallback 80×24. RE-LÊ no
  // resize via `useSyncExternalStore` (o `size` muda ⇒ re-render ⇒ nova dimensão).
  const size = useSyncExternalStore(
    subscribeTerminalResize,
    terminalSizeSnapshot,
    terminalSizeSnapshot,
  );
  const [colsRaw, rowsRaw] = size.split('x');
  const columns = Number(colsRaw) || 80;
  const rows = Number(rowsRaw) || 24;
  return (
    <SplashScreen
      columns={columns}
      rows={rows}
      status={props.status}
      frame={props.frame}
      version={CLI_VERSION}
      {...(props.prompt !== undefined ? { prompt: props.prompt } : {})}
    />
  );
}
