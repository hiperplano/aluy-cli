// EST-0945 · CLI-SEC-3 — categorias SEMPRE-ASK não-relaxáveis (o DENTE da catraca).
//
// Estas categorias INSPECIONAM O INPUT do tool-call (o `command` do run_command,
// o `path` do edit_file/read_file) — NÃO só o nome da tool. Sem inspecionar o
// input, "permitir run_command" liberaria `rm -rf /` junto: por isso o classifier
// olha o conteúdo. Quando QUALQUER classifier casa, o veredito é `ask` (ou `deny`
// p/ paths sensíveis), e isso NÃO é relaxável por allow-list nem por hook-allow
// (CLI-SEC-3: "categorias sempre-ask, NÃO relaxáveis por config"). Só o BYPASS
// TOTAL `--unsafe` (precedência 0 da engine, opt-in explícito) passa por cima.
//
// Princípio de design: estes matchers são DELIBERADAMENTE conservadores (alto
// recall, fail-safe). Um falso-positivo custa uma confirmação a mais; um
// falso-negativo deixa um `curl|sh`/`rm -rf` passar silencioso — inaceitável
// (CLI-T1/T6). Quando em dúvida, casa. A *malha* concreta de egress/path-deny
// (allowlist real de hosts, redação) é a EST-0946; aqui a CATEGORIA já força ask.
//
// PORTÁVEL: regex/string puro, sem I/O nem `node:*`. Resolução de caminho
// absoluto (workspace confinement real com `fs`) é injetada pelo locus concreto
// (EST-0948) via `WorkspacePort`; aqui o classifier trabalha sobre o texto do
// path e sinaliza "fora do workspace" por heurística textual + a porta opcional.

import type { PermissionCategory } from './gate.js';
import {
  extractPathCandidates,
  inputHasNetworkSignal,
  isMcpToolName,
} from '../mcp/effect-signals.js';

/** Um acerto de categoria sempre-ask: a categoria + um motivo legível. */
export interface CategoryMatch {
  readonly category: PermissionCategory;
  readonly reason: string;
  /** `true` ⇒ a categoria pede DENY (não só ask) — ex.: leitura de segredo. */
  readonly deny?: boolean;
}

// ── Filesystem destrutivo + git push/--force + dd + escrita fora (CLI-SEC-3) ──
// Casam o COMANDO (texto). Conservador por construção.
const DESTRUCTIVE_PATTERNS: readonly { re: RegExp; why: string }[] = [
  // `rm` recursivo/forçado — RECALL ACIMA DE PRECISÃO (CLI-T1/T6: falso-negativo de
  // `rm -rf` é INACEITÁVEL). A versão antiga exigia a flag CURTA (`-rf`/`-fr`),
  // COLADA e ANTES do alvo — e ESCAPAVA (bug-hunt EST-0945, 2ª caça):
  //   `rm dir -rf`         — flag DEPOIS do operando (válido GNU/BSD)
  //   `rm --recursive dir` — long-form
  //   `rm --force dir`     — long-form
  //   `rm -R x` / `rm --dir x`
  // Agora cobrimos as 3 famílias, flag em QUALQUER posição:
  // (a) LONG-FORM destrutiva em qualquer lugar (`--recursive`/`--force`/`--dir`/
  //     `--no-preserve-root`/`--interactive=never`).
  {
    re: /\brm\b[^\n]*\s--(?:recursive|force|dir|no-preserve-root|interactive=never)\b/,
    why: 'rm recursivo/forçado (long-form)',
  },
  // (b) SHORT-FORM com r/f/R no bundle, em QUALQUER posição (antes OU depois do
  //     alvo): `-rf`, `-fr`, `-r`, `-f`, `-R`, `dir -rf`, `-r -f`. O `\brm\b` casa
  //     o `rm` em qualquer ponto (inclusive após `xargs`/pipe), e o bundle exige
  //     `-` seguido de letras-de-flag contendo r/f/R.
  { re: /\brm\b[^\n]*(?:^|\s)-[a-zA-Z]*[rfR]/, why: 'rm recursivo/forçado (short-form)' },
  // (c) `rm <alvo>` NÃO-recursivo (single file) — FAIL-SAFE: na dúvida, casa
  //     (doutrina linhas 11-14; falso-positivo = 1 confirmação, aceitável). Exige
  //     um operando que NÃO comece com `-` (uma flag pura já cai em (a)/(b)) e
  //     NÃO casa `rm.txt`/`alarm`/`confirm` (o `\brm\b` precisa de fronteira E o
  //     `\s+` de um espaço — `rm.txt` não tem; `alarm`/`confirm` não têm fronteira
  //     antes de `rm`).
  { re: /\brm\s+(?!-)[^\s]/, why: 'rm (remoção de arquivo)' },
  { re: /\brmdir\b/, why: 'remoção de diretório' },
  { re: /\bdd\b/, why: 'dd (escrita de bloco bruta)' },
  { re: /\bmkfs\b/, why: 'formatação de filesystem' },
  // `git push` com flags/opções intermediárias (`git -C /repo push`,
  //  `git -c k=v push`) ou destino URL (`git push https://h/r`). Antes exigia
  //  `git` colado a `push` e escapava (recall hole, EST-0945).
  { re: /\bgit\b(?:\s+-\S+(?:\s+\S+)?)*\s+push\b/, why: 'git push (efeito remoto)' },
  { re: /--force\b|(?:^|\s)-f\b(?=.*\bgit\b)|\bgit\b.*\s-f\b/, why: 'flag --force' },
  { re: /\bgit\s+reset\s+--hard\b/, why: 'git reset --hard (perda de trabalho)' },
  { re: /\bgit\s+clean\s+-\w*[fdx]/, why: 'git clean -fdx (apaga não-rastreados)' },
  { re: /\btruncate\b/, why: 'truncate' },
  { re: /\bshred\b/, why: 'shred' },
  { re: />\s*\/dev\/sd[a-z]/, why: 'escrita em device de disco' },
  // Deleção em massa via `find` — escapava o `\brm\b` por não invocar `rm`
  // diretamente (recall hole, EST-0945).
  { re: /\bfind\b[^\n]*\s-delete\b/, why: 'find -delete (deleção em massa)' },
  { re: /\bfind\b[^\n]*-exec\s+rm\b/, why: 'find -exec rm (deleção em massa)' },
  // `rm` alimentado por pipe/xargs (`ls | xargs rm -rf`) — o `rm` não está colado
  // a um path no comando, mas o efeito é idêntico.
  { re: /\bxargs\b[^\n]*\brm\b/, why: 'xargs rm (deleção em massa)' },
  // chmod recursivo amplamente permissivo (`chmod -R 777 ...`) — efeito destrutivo
  // de permissões em árvore inteira.
  {
    re: /\bchmod\b[^\n]*\s-R\b[^\n]*\b[0-7]{3,4}\b|\bchmod\b[^\n]*\b[0-7]{3,4}\b[^\n]*\s-R\b/,
    why: 'chmod -R (permissões recursivas)',
  },
];

// ── Rede / egress (CLI-SEC-3 + base de CLI-SEC-5) ─────────────────────────────
const NETWORK_PATTERNS: readonly { re: RegExp; why: string }[] = [
  { re: /\bcurl\b/, why: 'curl' },
  { re: /\bwget\b/, why: 'wget' },
  { re: /\bssh\b/, why: 'ssh' },
  { re: /\bscp\b/, why: 'scp' },
  { re: /\bsftp\b/, why: 'sftp' },
  { re: /\brsync\b.*::|\brsync\b.*@/, why: 'rsync remoto' },
  { re: /\bnc\b|\bncat\b|\bnetcat\b/, why: 'netcat' },
  { re: /\btelnet\b/, why: 'telnet' },
  { re: /\bftp\b/, why: 'ftp' },
];

// ── Escalada de privilégio (CLI-SEC-3) ────────────────────────────────────────
const ESCALATION_PATTERNS: readonly { re: RegExp; why: string }[] = [
  { re: /\bsudo\b/, why: 'sudo (escalada de privilégio)' },
  // `su` — RECALL ALTO/FAIL-SAFE. A versão antiga (`\bsu\s+-?\b|\bsu\s+\w`) ESCAPAVA
  // (bug-hunt EST-0945): `su` PURO (sem argumento) e `su -` (o `-?\b` falha porque
  // `-` não é word-char ⇒ sem `\b` após o `-`). Agora QUALQUER `su` isolado como
  // comando casa: nu, `su -`, `su -l`, `su root`, `su - postgres`. O `\bsu\b`
  // exige fronteira de palavra (NÃO casa `issue`/`sumatra`/`business`).
  { re: /\bsu\b(?:\s|$)/, why: 'su (troca de usuário)' },
  { re: /\bdoas\b/, why: 'doas (escalada)' },
  { re: /\bpkexec\b/, why: 'pkexec (escalada via polkit)' },
  // `chmod` setuid/setgid — recall alto. Cobre simbólico (`u+s`/`g+s`/`+s`/`-s`) E
  // octal com bit especial 2/4/6/7 (`4755`, `04755`, `2755`, `6755`), tolerando
  // zeros à esquerda (`0*`). NÃO casa octal de permissão comum (`0755`/`644`/`777`)
  // nem sticky-only (`1777`).
  {
    re: /\bchmod\b[^\n]*(?:[ugoa]*\+s\b|[+-]s\b|(?:^|\s)0*[2467][0-7]{3}\b)/,
    why: 'chmod setuid/setgid',
  },
  // `chown root` / `chown root:root` / `chown :root` — toma posse p/ root (escalada
  // de propriedade). Fail-safe: o alvo `root` precedido de início/espaço/`:`.
  { re: /\bchown\b[^\n]*(?:^|\s|:)root\b/, why: 'chown root (posse de root)' },
  // `setcap` — concede capabilities de root a um binário (escalada equivalente).
  { re: /\bsetcap\b/, why: 'setcap (capabilities de root)' },
];

// ── Exec/instalação de pacote + curl|sh (CLI-SEC-3) ───────────────────────────
const PACKAGE_EXEC_PATTERNS: readonly { re: RegExp; why: string }[] = [
  { re: /\bnpm\s+(?:i|install|add|exec|x)\b/, why: 'npm install/exec' },
  { re: /\bnpx\b/, why: 'npx (exec de pacote)' },
  { re: /\b(?:pnpm|yarn)\s+(?:add|install|dlx)\b/, why: 'pnpm/yarn install' },
  { re: /\bpip3?\s+install\b/, why: 'pip install' },
  { re: /\b(?:uv|poetry)\s+(?:add|install|pip)\b/, why: 'uv/poetry install' },
  { re: /\bgem\s+install\b/, why: 'gem install' },
  { re: /\bcargo\s+install\b/, why: 'cargo install' },
  { re: /\bgo\s+install\b/, why: 'go install' },
  { re: /\bbrew\s+install\b/, why: 'brew install' },
  {
    re: /\bapt(?:-get)?\s+install\b|\byum\s+install\b|\bapk\s+add\b|\bdnf\s+install\b/,
    why: 'gerenciador de pacotes do SO',
  },
  // curl|sh / wget|bash — exec remoto: o pior caso (CLI-T1). Pega o PIPE p/ shell.
  {
    re: /\b(?:curl|wget|fetch)\b[^\n|]*\|\s*(?:sudo\s+)?(?:ba|z|da)?sh\b/,
    why: 'download | shell (exec remoto)',
  },
  {
    re: /\b(?:curl|wget)\b[^\n|]*\|\s*(?:sudo\s+)?python3?\b/,
    why: 'download | python (exec remoto)',
  },
];

// ── Edição de config/startup/hook (CLI-SEC-3) ─────────────────────────────────
// Casam o PATH (do edit_file) OU um path embutido num comando. Arquivos cuja
// edição muda o comportamento do shell/git/projeto no próximo start.
const CONFIG_STARTUP_PATH_RE =
  /(?:^|\/|~\/|\\)(?:\.bashrc|\.bash_profile|\.zshrc|\.zprofile|\.profile|\.bash_login|\.zshenv|\.zlogin|\.config\/fish\/config\.fish)$|(?:^|\/)\.git\/hooks\/[^/]+$|(?:^|\/)\.git\/config$|(?:^|\/)(?:\.npmrc|\.pypirc|\.netrc)$|(?:^|\/)(?:Makefile|justfile)$|(?:^|\/)(?:\.github\/workflows\/[^/]+\.ya?ml)$|(?:^|\/)(?:\.pre-commit-config\.ya?ml)$|(?:^|\/)(?:\.gitconfig)$|(?:^|\/)(?:crontab)$/i;

// package.json é config-startup APENAS por causa do campo `scripts` (exec no
// `npm run`). Sinalizamos sempre que package.json é tocado (conservador): a TUI
// mostra o diff exato, então o usuário vê se mexeu em `scripts`.
const PACKAGE_JSON_RE = /(?:^|\/)package\.json$/;

// ── Leitura de paths sensíveis (CLI-SEC-3 + base de CLI-SEC-6) ─────────────────
// Segredos/credenciais. `deny` p/ os mais críticos; `ask` p/ o resto. A malha
// real de path-deny + redação é a EST-0946; aqui a CATEGORIA já trava.
const SENSITIVE_READ: readonly { re: RegExp; why: string; deny: boolean }[] = [
  { re: /(?:^|\/|~\/)\.ssh(?:\/|$)/, why: 'chaves SSH (~/.ssh)', deny: true },
  { re: /(?:^|\/|~\/)\.aws(?:\/|$)/, why: 'credenciais AWS (~/.aws)', deny: true },
  { re: /(?:^|\/|~\/)\.gnupg(?:\/|$)/, why: 'chaves GPG (~/.gnupg)', deny: true },
  { re: /(?:^|\/|~\/)\.config\/gh\/hosts\.yml$/, why: 'token do gh CLI', deny: true },
  { re: /(?:^|\/|~\/)\.docker\/config\.json$/, why: 'credenciais Docker', deny: true },
  { re: /(?:^|\/|~\/)\.kube\/config$/, why: 'kubeconfig', deny: true },
  { re: /(?:^|\/)\.env(?:\.[\w.-]+)?$/, why: 'arquivo .env (segredos)', deny: false },
  {
    re: /(?:^|\/)[^/]*(?:secret|credential|token|apikey|api_key|password|passwd)[^/]*$/i,
    why: 'arquivo com nome sensível (token/secret)',
    deny: false,
  },
  { re: /(?:^|\/)id_(?:rsa|ed25519|ecdsa|dsa)\b/, why: 'chave privada', deny: true },
  { re: /\.pem$|\.p12$|\.pfx$|\.key$/i, why: 'material de chave privada', deny: true },
];

// ── Journal de undo `~/.aluy/` — path-deny de LEITURA (EST-0960a · R7) ─────────
// O journal de snapshot guarda o conteúdo-ANTES de cada edição (possível
// segredo). `~/.aluy/` (incl. `undo/` e seus blobs) é NEGADO p/ LEITURA por
// QUALQUER tool — read_file/grep/edit_file E `run_command` (cat/ls/grep no shell)
// — fechando a exfiltração via injeção (CLI-SEC-4/CLI-T2; ADR-0056 §5). É a HOME
// `.aluy`, NÃO um `.aluy/` qualquer no workspace: casamos só as formas que
// apontam p/ a home do usuário.
//
// Formas cobertas: `~/.aluy`, `~/.aluy/...`, `$HOME/.aluy...`, `${HOME}/.aluy...`,
// `/home/<u>/.aluy...`, `/Users/<u>/.aluy...`, `/root/.aluy...`. Conservador/
// fail-safe (R7): na dúvida, casa e nega.
// ⚠ B2 / CLI-SEC-H1 (gate FORTE do `seguranca`) — ESTE MATCHER TEXTUAL É
// BEST-EFFORT DE v1. Ele endurece contra normalização de path (`/./`, `//`,
// `/x/../`) e contra home-cd (`cd ~`/`cd $HOME` + path relativo `.aluy/`), mas
// NÃO é o confinamento DURO. O confinamento DURO — bash literalmente não alcança
// `~/.aluy/` no nível de SO (sandbox/namespace) — é o **CLI-SEC-H1** (gate de
// PROD), registrado como FU do H1 pelo orquestrador (não ADR novo). Até lá, este
// classifier é a fronteira textual conservadora/fail-safe (R7): na dúvida, nega.

/**
 * Normaliza um token de path TEXTUALMENTE (sem tocar o filesystem) p/ fechar os
 * vetores de B2 que furavam o matcher: colapsa `/./` → `/`, `//`→`/`, e resolve
 * `seg/../` removendo o segmento anterior. Preserva o prefixo `~`/`$HOME`/`/...`.
 * Best-effort puro sobre string (portável). Ex.:
 *   `~/./.aluy/x`      → `~/.aluy/x`
 *   `~//.aluy/x`       → `~/.aluy/x`
 *   `~/foo/../.aluy/x` → `~/.aluy/x`
 */
function normalizePathToken(p: string): string {
  // 1) colapsa `/./` e `//` repetidamente (`~/././/.aluy` → `~/.aluy`).
  let s = p;
  let prev: string;
  do {
    prev = s;
    s = s.replace(/\/\.(?=\/)/g, '/').replace(/\/{2,}/g, '/');
  } while (s !== prev);
  // 2) resolve `seg/../`: anda segmento a segmento, descartando o anterior num
  //    `..`. Mantém `..` inicial (não há anterior a descartar) e o 1º segmento
  //    (prefixo `~`/`$HOME`/`` p/ absoluto). Não emite `.` residual.
  const parts = s.split('/');
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const seg = parts[i]!;
    if (
      seg === '..' &&
      out.length > 0 &&
      out[out.length - 1] !== '..' &&
      out[out.length - 1] !== ''
    ) {
      out.pop();
    } else {
      out.push(seg);
    }
  }
  return out.join('/');
}

/**
 * `true` se `p` aponta p/ o journal `~/.aluy/` na HOME do usuário (não um
 * `.aluy/` qualquer dentro do workspace). Exige o ÂNCORA de home antes do
 * `.aluy` — `~`, `$HOME`/`${HOME}`, ou uma raiz de home absoluta. NORMALIZA o
 * path antes de testar (B2): `~/./.aluy`, `~//.aluy`, `~/foo/../.aluy` casam.
 */
function looksLikeAluyJournal(p: string): boolean {
  if (p === '') return false;
  const n = normalizePathToken(p);
  // `~/.aluy...` ou `~user/.aluy...`
  if (/^~[^/]*\/\.aluy(?:\/|$)/.test(n)) return true;
  // `$HOME/.aluy...` / `${HOME}/.aluy...`
  if (/\$\{?HOME\}?\/\.aluy(?:\/|$)/.test(n)) return true;
  // `/home/<u>/.aluy...`, `/Users/<u>/.aluy...`
  if (/^\/(?:home|Users)\/[^/]+\/\.aluy(?:\/|$)/.test(n)) return true;
  // `/root/.aluy...`
  if (/^\/root\/\.aluy(?:\/|$)/.test(n)) return true;
  return false;
}

/**
 * `true` se o TEXTO de um comando NOMEIA o journal `~/.aluy/` em QUALQUER posição
 * (não-ancorado), como rede de segurança caso a tokenização perca o path. Casa
 * `... ~/.aluy/...`, `... $HOME/.aluy ...`, `... /home/u/.aluy ...`, `/root/.aluy`.
 * NORMALIZA o comando inteiro antes (B2: `~/./.aluy`, `~//.aluy`, `~/foo/../.aluy`).
 * Também detecta o HOME-CD encadeado (`cd ~ && cat .aluy/...`, `cd $HOME; cat
 * .aluy/...`, `HOME=...; cat .aluy/...`) onde o path vira relativo `.aluy/` após
 * trocar o CWD p/ a home. Conservador (R7): redundante com o token-check, fecha.
 */
function commandTouchesAluyJournal(command: string): boolean {
  const c = normalizePathToken(command);
  if (
    /(?:^|[\s=><:'"(])~[^/\s]*\/\.aluy(?:\/|\b)/.test(c) ||
    /\$\{?HOME\}?\/\.aluy(?:\/|\b)/.test(c) ||
    /\/(?:home|Users)\/[^/\s]+\/\.aluy(?:\/|\b)/.test(c) ||
    /\/root\/\.aluy(?:\/|\b)/.test(c)
  ) {
    return true;
  }
  // HOME-CD + path relativo `.aluy/` no MESMO comando encadeado (B2). Um `cd ~`,
  // `cd $HOME`/`cd ${HOME}`, ou um `HOME=...` que troca o CWD/var p/ a home, e
  // DEPOIS um `.aluy/` relativo, resolve p/ o journal da home. Exige o ÂNCORA de
  // home (não super-bloqueia um `.aluy/` relativo do workspace SEM `cd ~`).
  if (commandHomeCdThenRelativeAluy(c)) return true;
  return false;
}

/**
 * `true` se o comando TROCA o CWD p/ a home (`cd ~`, `cd $HOME`, `cd ${HOME}`, ou
 * um `HOME=...` exportado) e, no MESMO comando encadeado, referencia um path
 * RELATIVO começando em `.aluy/` (ou nu `.aluy`). Aí o `.aluy/` resolve p/ o
 * journal da home, furando o matcher ancorado. Conservador: o gatilho é o
 * ÂNCORA de home — um `.aluy/` relativo SEM `cd ~`/`HOME=` NÃO casa (workspace
 * legítimo). Texto puro; o confinamento DURO é o CLI-SEC-H1.
 */
function commandHomeCdThenRelativeAluy(command: string): boolean {
  // troca CWD p/ a home: `cd` sozinho, `cd ~`, `cd $HOME`/`${HOME}`, `cd ~/`,
  // OU atribuição/here de `HOME=...`/`export HOME=...`.
  //
  // ⚠ B2 / família "BARRA FINAL" (gate FORTE do `seguranca`): o âncora anterior
  // exigia que o token de home (`~`/`$HOME`) fosse SEGUIDO IMEDIATAMENTE de
  // `\s*` e um separador — então QUALQUER `/` (ou `.`, ou aspas) colado ao token
  // FURAVA. Os 6 vetores que escapavam:
  //   `cd ~/`           — barra final pós-`~`
  //   `cd ${HOME}/`     — barra final pós-`${HOME}`
  //   `cd "$HOME"/`     — aspas + barra final
  //   `cd ~/&&cat …`    — barra final + separador COLADO (sem espaço)
  //   `cd ~/.`          — barra + ponto (ainda é a home)
  //   `cd ~/ ;` / `cd ~/ | ` — barra final + espaço + separador
  // Endurecido: depois do token de home, tolera aspas de fechamento + uma
  // sequência de `/` e `.` (`~/`, `~/.`, `${HOME}/`), e a fronteira aceita
  // separador COLADO (`&&`/`||`/`|`/`&`/`;`) OU espaço+separador OU fim. Continua
  // exigindo o 2º clause (`.aluy` relativo) p/ disparar — não super-bloqueia.
  const homeToken = `(?:~|['"]?\\$\\{?HOME\\}?['"]?)`;
  const homeAnchor =
    new RegExp(`(?:^|[;&|]|\\|\\||&&)\\s*cd\\s+${homeToken}['"]?[/.]*\\s*(?:[;&|]|$)`).test(
      command,
    ) || /(?:^|[;&|]|\|\||&&|\s)(?:export\s+)?HOME=/.test(command);
  if (!homeAnchor) return false;
  // path relativo `.aluy` / `.aluy/...` referenciado em qualquer ponto: precedido
  // por início/separador/operador de redirect, NÃO por `/` nem `.` (senão seria
  // `/.aluy` absoluto ou `x.aluy`, já cobertos/benignos).
  return /(?:^|[\s=<>;&|'"(])\.aluy(?:\/|\b)/.test(command);
}

/** Extrai a string `command` de um input de tool, ou '' se ausente. */
function commandOf(input: Readonly<Record<string, unknown>>): string {
  const c = input['command'];
  return typeof c === 'string' ? c : '';
}

/** Extrai a string `path` de um input de tool, ou '' se ausente. */
function pathOf(input: Readonly<Record<string, unknown>>): string {
  const p = input['path'];
  return typeof p === 'string' ? p : '';
}

/** Extrai uma string `key` de um input de tool, ou '' se ausente (EST-0971). */
function pickStr(input: Readonly<Record<string, unknown>>, key: string): string {
  const v = input[key];
  return typeof v === 'string' ? v : '';
}

/**
 * Heurística textual de "escrita FORA do workspace" (CLI-SEC-3). Sem `fs` aqui
 * (portável): sinaliza caminhos ABSOLUTOS fora de padrões de projeto e os que
 * sobem com `..` ou apontam a HOME/system. O confinamento REAL (resolver o path
 * absoluto contra a raiz do workspace) é reforçado pelo locus concreto
 * (`WorkspacePort`, EST-0948); esta é a primeira linha, conservadora.
 */
function looksOutsideWorkspace(path: string): boolean {
  if (path === '') return false;
  // sobe de diretório explicitamente
  if (/(?:^|\/)\.\.(?:\/|$)/.test(path)) return true;
  // home de outro usuário (~outro/...) OU a própria home via `~`/`~/...`
  // (`~/notes.txt`, `~/.config/foo`). Escrever na HOME é FORA do workspace por
  // padrão — o confinamento REAL (saber se o workspace está sob a home) é do
  // WorkspacePort (EST-0948); aqui, conservador/fail-safe: ~ ⇒ ask.
  if (/^~(?:$|\/|[^/])/.test(path)) return true;
  // HOME absoluta do usuário (`/home/<user>/...`, `/Users/<user>/...`,
  //  `/root/...`). Antes só pegava raízes de sistema e deixava a home escapar.
  if (/^\/(?:home|Users)\/[^/]+(?:\/|$)/.test(path)) return true;
  if (
    /^(?:\/etc|\/usr|\/bin|\/sbin|\/var|\/root|\/boot|\/sys|\/proc|\/dev|\/opt|\/Library|\/System|\/Applications|\/Windows|[A-Za-z]:\\)/.test(
      path,
    )
  ) {
    return true;
  }
  return false;
}

/**
 * Classifica um tool-call contra TODAS as categorias sempre-ask, inspecionando o
 * INPUT. Devolve TODOS os acertos (a engine usa o conjunto p/ o motivo e p/
 * decidir ask vs deny). Vazio ⇒ nenhuma categoria não-relaxável disparou.
 *
 * @param name  nome da tool (read_file/edit_file/run_command/grep/…)
 * @param input input já parseado do tool-call
 */
export function classifyAlwaysAsk(
  name: string,
  input: Readonly<Record<string, unknown>>,
): readonly CategoryMatch[] {
  const matches: CategoryMatch[] = [];
  const command = commandOf(input);
  const path = pathOf(input);

  // EST-0971 · CLI-SEC-13 — tools NATIVAS de REDE (web_fetch/web_search). O EFEITO é
  // egress: SEMPRE `always-ask:network`, não-relaxável por allow-list/hook (só o
  // `--unsafe` de precedência 0 passa por cima). O modo Plan as nega ANTES disso
  // (ADR-0055: rede = exfiltração em Plan). Casa pelo NOME (o input é url/query, não
  // um `command` de shell, então a malha de comando abaixo não as alcançaria). Isto
  // dá COERÊNCIA: a tool de rede do agente recebe o MESMO veredito de catraca que um
  // `curl` no shell (ambos `always-ask:network`).
  if (name === 'web_fetch' || name === 'web_search') {
    const target = name === 'web_fetch' ? pickStr(input, 'url') : pickStr(input, 'query');
    matches.push({
      category: 'always-ask:network',
      reason: `rede: ${name}${target ? ` (${target})` : ''}`,
    });
  }

  // EST-1015 (POC headroom) — `headroom_retrieve` faz EGRESS ao proxy headroom LOCAL
  // (`POST /v1/retrieve`). É rede ⇒ MESMO veredito que `web_fetch`/`curl`:
  // `always-ask:network` (Plan-deny, não-relaxável por allow-list/hook; só `--unsafe`
  // passa). Casa pelo NOME (input é `hash`/`query`, não um `command` de shell). Sem
  // isto cairia no default "tool desconhecida=ask" (RELAXÁVEL por grant) — fraco demais
  // p/ egress. Loopback NÃO é exceção: o proxy pode baixar modelo/ONNX e o conteúdo
  // (observações de tool) sai do processo.
  if (name === 'headroom_retrieve') {
    matches.push({
      category: 'always-ask:network',
      reason: `rede: headroom_retrieve${pickStr(input, 'hash') ? ` (hash=${pickStr(input, 'hash')})` : ''}`,
    });
  }

  // ── EST-0970 · ADR-0058 (E-B2) · CLI-SEC-12 — TOOLS MCP (mcp__<server>__<tool>) ─
  // Generaliza o FU que estava registrado: toda tool MCP é EFEITO por padrão e a
  // classificação vem de SINAIS NÃO-CONFIÁVEIS DO INPUT (rede/path), NUNCA do rótulo
  // `readonly`/`effect` auto-declarado pelo server (E-B2). O resultado MÍNIMO é
  // sempre `always-ask:mcp-effect` (⇒ ask, não-relaxável); quando o input mostra
  // um sinal específico, ANEXAMOS a categoria correspondente — inclusive DENY
  // (`journal-read-deny`/`aluy-config-write-deny`/`sensitive-read` crítico) — para
  // a engine dar o veredito certo (a engine eleva os DENY acima do `--unsafe`).
  //
  // ⚠ Esta classificação roda no `decide()` a CADA chamada (não na descoberta):
  // RE-HANDSHAKE RE-CLASSIFICA (sem cache "já aprovei esta tool"). Um server que se
  // diz "readonly" mas manda um path de `~/.aluy`/`.ssh` ou uma URL ainda cai em
  // ask/deny — porque olhamos o INPUT, não a auto-declaração.
  if (isMcpToolName(name)) {
    // baseline NÃO-relaxável: MCP = efeito ⇒ ask (deny-por-padrão do desconhecido).
    matches.push({
      category: 'always-ask:mcp-effect',
      reason: `tool MCP de terceiro "${name}" — efeito não-confiável (classificado por sinais do input)`,
    });
    // sinal de REDE no input ⇒ egress (mesma malha do web_fetch/curl): always-ask:network.
    if (inputHasNetworkSignal(input)) {
      matches.push({
        category: 'always-ask:network',
        reason: 'rede: tool MCP com destino remoto detectado no input',
      });
    }
    // sinais de PATH no input ⇒ inspeciona com os MESMOS matchers das tools nativas
    // (journal `~/.aluy` write/read-deny, path sensível, fora do workspace). Reusa a
    // mesma fronteira textual (E-B2: o server não escolhe o veredito).
    for (const candidate of extractPathCandidates(input)) {
      for (const m of classifyMcpPathCandidate(candidate)) matches.push(m);
    }
  }

  // 1) Comando de shell: inspeciona o TEXTO do comando.
  if (command) {
    for (const { re, why } of NETWORK_PATTERNS) {
      if (re.test(command)) {
        matches.push({ category: 'always-ask:network', reason: `rede: ${why}` });
        break;
      }
    }
    for (const { re, why } of DESTRUCTIVE_PATTERNS) {
      if (re.test(command)) {
        matches.push({ category: 'always-ask:destructive', reason: `destrutivo: ${why}` });
        break;
      }
    }
    for (const { re, why } of ESCALATION_PATTERNS) {
      if (re.test(command)) {
        matches.push({ category: 'always-ask:escalation', reason: `escalada: ${why}` });
        break;
      }
    }
    for (const { re, why } of PACKAGE_EXEC_PATTERNS) {
      if (re.test(command)) {
        matches.push({ category: 'always-ask:package-exec', reason: `exec de pacote: ${why}` });
        break;
      }
    }
    // EST-0960a · R7 — LEITURA do journal `~/.aluy/` via shell (`cat ~/.aluy/...`,
    // `ls ~/.aluy/undo`, `grep x ~/.aluy/...`) ⇒ DENY. Fecha a exfiltração do
    // conteúdo-antes (possível segredo) por bash (CLI-T2). Independe do verbo:
    // QUALQUER comando que NOMEIE um path do journal é negado (não dá p/ o agente
    // alcançar o journal por nenhum canal). Conservador/fail-safe.
    const shellPaths = extractPathsFromCommand(command);
    const touchesAluy = shellPaths.some(looksLikeAluyJournal) || commandTouchesAluyJournal(command);
    if (touchesAluy) {
      matches.push({
        category: 'always-ask:journal-read-deny',
        reason: 'acesso ao journal de undo (~/.aluy/) é proibido',
        deny: true,
      });
    }
    // EST-0974 · ADR-0053 §2.2 — ESCRITA na config local `~/.aluy/` via shell ⇒ DENY.
    // Editar `~/.aluy/hooks.json`/`commands/`/`config` = ato do USUÁRIO, não do agente:
    // senão um README malicioso plantaria um hook que roda sempre. Dispara quando o
    // comando ESCREVE (redirect/cp/mv/tee/install/ln/sed -i/mkdir/touch/rm/chmod/...) E
    // o alvo é `~/.aluy/`. (A LEITURA de `~/.aluy/` já é DENY acima; aqui marcamos o
    // motivo PRECISO de ESCRITA p/ auditoria/painel — a decisão é DENY de qualquer modo.)
    if (
      touchesAluy &&
      /(?:>|>>|\btee\b|\bcp\b|\bmv\b|\binstall\b|\bln\b|\bsed\b[^\n]*\s-i|\bmkdir\b|\btouch\b|\brm\b|\brmdir\b|\bchmod\b|\bchown\b|\bdd\b|\btruncate\b)/.test(
        command,
      )
    ) {
      matches.push({
        category: 'always-ask:aluy-config-write-deny',
        reason:
          'escrita na config local do Aluy (~/.aluy/ — hooks.json/commands/config) é proibida ao agente',
        deny: true,
      });
    }
    // edição de config via shell (ex.: `echo >> ~/.bashrc`, `chmod +x .git/hooks/...`)
    if (shellPaths.some((p) => CONFIG_STARTUP_PATH_RE.test(p) || PACKAGE_JSON_RE.test(p))) {
      matches.push({
        category: 'always-ask:config-startup',
        reason: 'comando toca arquivo de config/startup/hook',
      });
    }
    if (
      shellPaths.some(looksOutsideWorkspace) &&
      /(?:>|>>|\bcp\b|\bmv\b|\btee\b|\binstall\b|\bln\b)/.test(command)
    ) {
      matches.push({
        category: 'always-ask:outside-workspace',
        reason: 'comando escreve FORA do workspace',
      });
    }
  }

  // 2) Edição/escrita de arquivo: inspeciona o PATH. EST-0944 — `write_file` (criar/
  // reescrever, full content) recebe a MESMA inspeção de path que o `edit_file`
  // (str_replace): ambos são ESCRITA no fs e não podem plantar config/hook nem
  // escrever fora do workspace por canal nenhum.
  if ((name === 'edit_file' || name === 'write_file') && path) {
    // EST-0974 · ADR-0053 §2.2 — ESCRITA na config local `~/.aluy/` (hooks.json,
    // commands/, config) ⇒ DENY. Editar a config de HOOK é ato do USUÁRIO, não do
    // agente: senão um README malicioso faria o agente plantar um hook que roda
    // sempre. (A LEITURA de `~/.aluy/` já é DENY abaixo, via journal-read-deny — aqui
    // damos o motivo PRECISO de ESCRITA, avaliado primeiro.) DENY não-relaxável,
    // acima até do `--unsafe` (a engine eleva esta categoria, como o journal).
    if (looksLikeAluyJournal(path)) {
      matches.push({
        category: 'always-ask:aluy-config-write-deny',
        reason:
          'escrita na config local do Aluy (~/.aluy/ — hooks.json/commands/config) é proibida ao agente',
        deny: true,
      });
    }
    if (CONFIG_STARTUP_PATH_RE.test(path)) {
      matches.push({
        category: 'always-ask:config-startup',
        reason: 'edita arquivo de config/startup/hook',
      });
    }
    if (PACKAGE_JSON_RE.test(path)) {
      matches.push({
        category: 'always-ask:config-startup',
        reason: 'edita package.json (scripts podem rodar no npm run)',
      });
    }
    if (looksOutsideWorkspace(path)) {
      matches.push({
        category: 'always-ask:outside-workspace',
        reason: 'escreve FORA do workspace',
      });
    }
  }

  // FU (EST-0946/0948) — NÃO implementar em v1, só registrado: inspeção GENÉRICA
  // de `input.path` p/ tools MCP futuras. Hoje só 4 tools nativas
  // (read_file/edit_file/grep/run_command) têm path/command inspecionados; uma
  // tool MCP arbitrária com um campo de caminho ainda não é coberta aqui (sem
  // exposição em v1, pois não há tool MCP nativa com efeito de path). Quando
  // entrarem tools MCP, generalizar a extração de path do input.

  // 3) Leitura/edição de path sensível: read_file, edit_file, write_file E grep (que lê).
  if (
    (name === 'read_file' || name === 'edit_file' || name === 'write_file' || name === 'grep') &&
    path
  ) {
    // EST-0960a · R7 — o journal `~/.aluy/` é NEGADO p/ LEITURA por read_file/grep.
    // DENY, não-relaxável. Avaliado ANTES das categorias SENSITIVE_READ p/ o motivo
    // ser específico do journal. NOTA (EST-0974): o `edit_file` (ESCRITA) em `~/.aluy/`
    // já é DENY pela categoria `aluy-config-write-deny` (case 2, motivo PRECISO de
    // escrita) — por isso aqui o journal-READ-deny cobre só as tools de leitura. A
    // decisão (DENY) é a mesma; só o motivo difere (read vs write).
    if ((name === 'read_file' || name === 'grep') && looksLikeAluyJournal(path)) {
      matches.push({
        category: 'always-ask:journal-read-deny',
        reason: 'acesso ao journal de undo (~/.aluy/) é proibido',
        deny: true,
      });
    }
    for (const s of SENSITIVE_READ) {
      if (s.re.test(path)) {
        matches.push({
          category: 'always-ask:sensitive-read',
          reason: `path sensível: ${s.why}`,
          deny: s.deny,
        });
        break;
      }
    }
  }

  return matches;
}

/**
 * EST-0970 · ADR-0058 (E-B2) · CLI-SEC-12 — inspeciona UM candidato a path do input
 * de uma tool MCP com os MESMOS matchers das tools nativas. Devolve os acertos de
 * categoria (DENY p/ `~/.aluy` write/journal e segredo crítico; ask p/ config-
 * startup/fora-do-workspace/segredo). Conservador (fail-safe): o server NÃO escolhe
 * o veredito — a fronteira textual é a mesma de read_file/edit_file/run_command.
 *
 * NOTA: tratamos o path de uma tool MCP como POTENCIAL ESCRITA — uma tool MCP que
 * mente "readonly" e escreve em `~/.aluy/` deve cair em `aluy-config-write-deny`
 * (DENY, acima do `--unsafe`), igual ao `edit_file`. Por isso `~/.aluy/` ⇒
 * `aluy-config-write-deny` (write-deny), não só o read-deny do journal.
 */
function classifyMcpPathCandidate(candidate: string): CategoryMatch[] {
  const out: CategoryMatch[] = [];
  if (candidate === '') return out;
  // `~/.aluy/` — DENY (write-deny, acima do --unsafe). Cobre o pior caso E-B1: uma
  // tool MCP que se diz readonly mas escreve na config de confiança do Aluy.
  if (looksLikeAluyJournal(candidate)) {
    out.push({
      category: 'always-ask:aluy-config-write-deny',
      reason: 'tool MCP toca a config local do Aluy (~/.aluy/) — proibido ao agente (E-B1/E-B2)',
      deny: true,
    });
  }
  // path sensível (.ssh/.aws/.env/chave/etc.) — deny p/ os críticos, ask p/ o resto.
  for (const s of SENSITIVE_READ) {
    if (s.re.test(candidate)) {
      out.push({
        category: 'always-ask:sensitive-read',
        reason: `tool MCP toca path sensível: ${s.why}`,
        deny: s.deny,
      });
      break;
    }
  }
  // arquivo de config/startup/hook (.bashrc, .git/hooks, Makefile, package.json…).
  if (CONFIG_STARTUP_PATH_RE.test(candidate) || PACKAGE_JSON_RE.test(candidate)) {
    out.push({
      category: 'always-ask:config-startup',
      reason: 'tool MCP toca arquivo de config/startup/hook',
    });
  }
  // fora do workspace (absoluto/`..`/home).
  if (looksOutsideWorkspace(candidate)) {
    out.push({
      category: 'always-ask:outside-workspace',
      reason: 'tool MCP toca caminho FORA do workspace',
    });
  }
  return out;
}

// Nomes-base de arquivos de config/startup que importam MESMO sem `./` nem `/`
// na frente (ex.: `tee Makefile`, `echo > package.json`, `crontab -`). A regex
// de path (`CONFIG_STARTUP_PATH_RE`/`PACKAGE_JSON_RE`) ancora em `(?:^|\/)`, então
// um nome-base nu já casa — só precisamos EMITIR o token. Conservador (fail-safe):
// na dúvida, emitir o token e deixar a categoria decidir.
const BARE_CONFIG_BASENAME_RE =
  /^(?:Makefile|justfile|crontab|package\.json|\.bashrc|\.bash_profile|\.zshrc|\.zprofile|\.profile|\.bash_login|\.zshenv|\.zlogin|\.npmrc|\.pypirc|\.netrc|\.gitconfig|\.pre-commit-config\.ya?ml)$/i;

/**
 * Extrai tokens que parecem caminhos de um comando de shell (best-effort, p/ os
 * matchers de config/outside-workspace). Não é um parser de shell — pega tokens
 * com `/`, `~/`, dotfiles MULTI-SEGMENTO (`.git/hooks/...`, `.github/...`) e
 * nomes-base de config conhecidos (`Makefile`, `package.json`, `crontab`...).
 * Conservador: mais tokens ⇒ mais chance de casar uma categoria (fail-safe).
 *
 * BLOQUEANTE/recall (EST-0945): antes, a alternativa de dotfile parava no 1º `/`,
 * então `.git/hooks/pre-commit` virava só `.git` e ESCAPAVA a categoria
 * config-startup sob allow-list. Agora o dotfile consome o caminho INTEIRO, e
 * nomes-base nus (sem `./`) também são emitidos.
 */
export function extractPathsFromCommand(command: string): string[] {
  const out: string[] = [];
  // 1) tokens com `/`, `~/`, `./`, `../` OU dotfile (agora MULTI-SEGMENTO: o
  //    dotfile inicial pode ser seguido de `/...`, capturando `.git/hooks/x`).
  //
  // BLOQUEANTE/recall (EST-0945, 3ª iter — SEGURANÇA): o BOUNDARY de início do token
  // tinha só `[\s=>]` (espaço · assign `=` · redirect-saída `>`). Faltavam os
  // metacaracteres de shell que colam ANTES de um path SEM espaço: o redirect-ENTRADA
  // `<` (`cat <~/.aluy/x`), as ASPAS (`cat "~/.aluy/x"` / `'…'` — forma COMUM, não-
  // adversarial) e o pipe `|`. Sem eles, o path nunca era EXTRAÍDO ⇒ a categoria-DENY
  // (`journal-read-deny` `~/.aluy` · `sensitive-read` `.ssh`) NÃO casava e o veredito
  // CAÍA de DENY p/ ASK (`cat <~/.ssh/id_rsa` virava ask-aprovável em vez de deny duro).
  // Agora o boundary é a CLASSE COMPLETA de separadores/metacaracteres de shell — a MESMA
  // da parte-2 abaixo. Ampliar o boundary é FAIL-SAFE puro: só ABRE mais posições de
  // match (o grupo capturado segue idêntico) — nunca casa um benigno a menos.
  const tokenRe =
    /(?:^|[\s"'=;|&()<>{}`])((?:~\/|\.{0,2}\/|\/)[^\s"';|&]+|\.[a-zA-Z][\w.-]*(?:\/[^\s"';|&]+)?)/g;
  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(command)) !== null) {
    if (m[1]) out.push(m[1]);
  }
  // 2) nomes-base de config nus (sem `/` nem `./`): `tee Makefile`, `crontab -`,
  //    `echo > package.json`. Varremos os "words" do comando e emitimos os que
  //    casam um basename de config conhecido.
  //
  // BLOQUEANTE/recall (EST-0945, 2ª iter): a classe de split tinha SÓ
  // `[\s"';|&()]` — faltavam os operadores de REDIRECT/ASSIGN/SUBST que colam ao
  // nome-base sem espaço, deixando `printf x>Makefile`, `cat>package.json`,
  // `echo>>justfile`, `2>package.json` escaparem como um único token
  // (`x>Makefile`) que nunca casa o basename ⇒ caía no allow-list ⇒ allow.
  // Fechamos a CLASSE COMPLETA de separadores/metacaracteres de shell que podem
  // estar adjacentes a um token (não só os 3 reportados), p/ não voltar numa 4ª
  // iteração: whitespace · aspas `"` `'` · controle/pipe `;` `|` `&` · grupo/
  // subshell `(` `)` `{` `}` · redirect `<` `>` · assign/here-string `=` ·
  // substituição `` ` ``. O basename RE é ancorado (`^…$`), então split a mais
  // só pode AJUDAR a isolar o token — nunca casa um benigno (`out.txt`,
  // `err.log`, `MakefileX` continuam miss). Fail-safe por construção.
  for (const word of command.split(/[\s"';|&()<>={}`]+/)) {
    if (word && !word.includes('/') && BARE_CONFIG_BASENAME_RE.test(word)) {
      out.push(word);
    }
  }
  return out;
}
