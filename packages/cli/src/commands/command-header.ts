// F-CMD-HEADER (pedido do dono) — cabeçalho de MARCA compacto p/ os comandos NÃO-TUI
// (`aluy login`, `aluy config`, `aluy doctor`, `aluy whoami` etc.). Antes desta estória
// eles escreviam texto cru no stdout, sem NENHUMA identidade visual — pareciam um
// produto avulso, à parte da TUI (que abre com o wordmark `Λluy`, ver SplashScreen.tsx/
// Header.tsx). Este módulo imprime, UMA vez, no topo do comando: `Λluy · v<versão>`
// (fallback `Aluy · v<versão>` sem Unicode) — nada além disso.
//
// POR QUE NÃO REUSAR <Wordmark>/<ShadowedWordmark> (wordmark-3d.ts) DIRETO — lidos
// antes de escrever este módulo: `Wordmark.tsx` importa `ink`/`react`; `wordmark-3d.ts`
// é PURO por si só (só compõe uma grade {role,char}, ver seu próprio cabeçalho), mas
// importa `WORDMARK_MARK_BLOCK`/`WORDMARK_LUY_BLOCK` de `Wordmark.js` — que arrasta Ink
// na cadeia de módulos mesmo assim. E a arte GRANDE dos dois (6 linhas de block-art +
// sombra 3D) É a tela de SPLASH — pedido explícito do dono aqui foi o OPOSTO: "discreto,
// não uma tela de splash", 2-4 linhas no máximo. Os comandos deste módulo rodam como
// script puro de Node (sem Ink montado; muitos saem de `process.exit()` antes de
// qualquer render) — importar Ink só para descartar praticamente toda a árvore de
// componentes seria peso morto, e fura a disciplina de `cli-core`/`commands` ficarem
// portáveis (ADR-0053 §8; aqui não há o `no-restricted-imports` do eslint — ele só
// mira `cli-core/src` — mas o espírito é o mesmo, e o teste de fronteira abaixo prova).
// Em vez disso, este módulo reusa a MESMA grafia PLANA já usada pelo `VersionLine` do
// splash (`Λluy`/`Aluy`, ver SplashScreen.tsx) e o MESMO detector puro de Unicode do
// tema (`detectUnicode`, ui/theme/theme.ts) — nenhum dos dois importa Ink (só o próprio
// `theme.ts`, `glyphs.ts`, `palette.ts` etc., todos módulos de DADOS).
//
// SEM COR: o único precedente de comando NÃO-Ink que já formata texto (`aluy doctor`,
// doctor/render.ts) sai sem nenhum código ANSI — só glifo + texto puro. Este cabeçalho
// segue a MESMA disciplina (nenhum escape de cor): mais simples, sem risco de sujar um
// terminal que não entende SGR, sem duplicar a paleta do tema fora do Ink.
//
// GATE (requisito duro, NÃO relaxar) — o cabeçalho NUNCA pode:
//   (a) sair quando o stdout NÃO é um TTY (pipe/redirect/CI/serviço automatizado —
//       um `aluy doctor | jq` ou um cron do `aluy service` não pode ganhar 2 linhas de
//       marca no meio do que outro processo vai LER); nem
//   (b) sair quando o comando pediu saída ESTRUTURADA (`--json` — hoje `doctor`/
//       `config`/`models`) — aí quebraria QUALQUER parser, mesmo rodando num TTY de
//       verdade (alguém pode copiar `aluy doctor --json` interativo pro clipboard).
// `shouldPrintCommandHeader` isola essa decisão (PURA, testável sem I/O real) do efeito
// (`printCommandHeader`, que só escreve se o gate deixar).

import { detectUnicode } from '../ui/theme/theme.js';
import { CLI_VERSION } from '../version.js';

export interface CommandHeaderTextOptions {
  /** Env de onde detectar suporte a Unicode (default `process.env`). Injetável em teste. */
  readonly env?: NodeJS.ProcessEnv;
  /** Versão exibida (default `CLI_VERSION`, sincronizada do package.json). Injetável em teste. */
  readonly version?: string;
}

/**
 * As linhas do cabeçalho — PURO, sem I/O nenhum. Uma linha em branco (respiro entre o
 * prompt do shell e a marca) + `Λluy · v<versão>` (fallback `Aluy · v<versão>` sem
 * Unicode — MESMA grafia do `VersionLine` do splash, SplashScreen.tsx: nunca "Aluy Cli"
 * nem "Λ Aluy"). Compacto de propósito (2 linhas): a TUI já tem a arte grande; aqui é
 * só a assinatura, não uma segunda splash screen.
 */
export function buildCommandHeaderLines(opts: CommandHeaderTextOptions = {}): string[] {
  const env = opts.env ?? process.env;
  const version = opts.version ?? CLI_VERSION;
  const mark = detectUnicode(env) ? 'Λluy' : 'Aluy';
  return ['', `${mark} · v${version}`];
}

export interface CommandHeaderGateOptions {
  /** `true` quando o stdout do processo É um terminal interativo. */
  readonly isTTY: boolean;
  /** `true` quando o comando pediu saída ESTRUTURADA (`--json` e afins). */
  readonly json?: boolean;
}

/**
 * Decide se o cabeçalho PODE sair — PURA (não toca stream nenhuma), é o ramo que o
 * teste precisa exercitar SEM I/O real (requisito duro: provar que ele NÃO imprime).
 * `false` se `json` OU se não é TTY — cada um já basta sozinho pra recusar (não é um
 * "os dois juntos" — qualquer um dos dois veta).
 */
export function shouldPrintCommandHeader(opts: CommandHeaderGateOptions): boolean {
  if (opts.json === true) return false;
  return opts.isTTY;
}

export interface PrintCommandHeaderOptions extends CommandHeaderTextOptions {
  /**
   * Saída onde escrever — default `process.stdout`. Injetável em teste (stream fake,
   * sem tocar o stdout real do processo de teste).
   */
  readonly stream?: Pick<NodeJS.WritableStream, 'write'> & { readonly isTTY?: boolean };
  /** Repassado ao gate — `true` ⇒ nunca imprime (ver `shouldPrintCommandHeader`). */
  readonly json?: boolean;
}

/**
 * Imprime o cabeçalho no `stream` (default `process.stdout`) SE — e SÓ SE — o gate
 * deixar. Efeito único e fino (I/O); a decisão em si é PURA e mora em
 * `shouldPrintCommandHeader`/`buildCommandHeaderLines`, testável sem tocar stream nenhuma.
 * Chamado UMA vez, no topo do dispatch de cada comando não-TUI (`bin/aluy.ts`) — nunca
 * de dentro do próprio comando (mantém `runDoctor`/`runConfig`/etc. testáveis como hoje,
 * sem o cabeçalho aparecendo nos testes que chamam essas funções direto).
 */
export function printCommandHeader(opts: PrintCommandHeaderOptions = {}): void {
  const stream = opts.stream ?? process.stdout;
  // `exactOptionalPropertyTypes` — só inclui `json` na chamada quando ele veio de fato
  // (omitir a chave ≠ passar `undefined` explícito sob esse modo estrito do tsconfig).
  const gate = shouldPrintCommandHeader({
    isTTY: stream.isTTY === true,
    ...(opts.json !== undefined ? { json: opts.json } : {}),
  });
  if (!gate) return;
  for (const line of buildCommandHeaderLines(opts)) stream.write(`${line}\n`);
}
