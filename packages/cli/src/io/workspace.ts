// EST-0948 · CONFINAMENTO DE WORKSPACE REAL (cravada do `seguranca`, gate FORTE).
//
// O `looksOutsideWorkspace` textual da EST-0945 (categories.ts) é a 1ª linha de
// defesa — heurística sobre o TEXTO do path. O confinamento DURO mora AQUI, no
// I/O concreto do @hiperplano/aluy-cli, e é o que realmente impede um efeito de escapar a
// raiz do projeto:
//
//   - resolve o path absoluto e o CANONICALIZA (realpath quando o alvo existe;
//     resolve `..`/`.` léxico quando ainda não existe — ex.: edit que cria);
//   - resolve a RAIZ do workspace também canonicalizada (segue symlink da raiz);
//   - REJEITA qualquer caminho que, depois de resolvido, NÃO esteja contido na
//     raiz — `..` que escapa, path absoluto fora, symlink que aponta p/ fora.
//
// Fail-safe por construção: em QUALQUER dúvida (erro de fs ao canonicalizar um
// ancestral, race com symlink, etc.) ⇒ rejeita. O confinamento é a invariante;
// o conforto do usuário vem depois.
//
// PORTÁVEL? NÃO — este arquivo é I/O concreto (Node `fs`/`path`), por isso mora
// no @hiperplano/aluy-cli e não no core. É exatamente o "locus concreto" que a 0945 cita.
//
// EST-0982 · DIRETÓRIO DE TRABALHO DE SESSÃO (`sessionCwd`) — sem RELAXAR o
// confinamento. O `NodeWorkspace` agora owna um `sessionCwd` (absoluto, default =
// raiz) que TODOS os tools respeitam: o `shell` roda NELE e `resolveInside` resolve
// caminhos RELATIVOS contra ELE (não mais contra a raiz fixa). A INVARIANTE de
// segurança fica INTACTA: o `sessionCwd` é SEMPRE ⊆ raiz canonicalizada (o `setCwd`
// clampa na raiz — `cd ..`/`cd /etc` além da raiz NÃO escapa), e o `resolveInside`
// segue canonicalizando o alvo e REJEITANDO o que escapa a raiz. O cwd é só um
// PONTEIRO RELATIVO dentro da raiz; o teto do confinamento continua sendo a raiz.
//
// EST-0991 · ADR-0072 — YOLO (cerca DERRUBADA, disco inteiro). Sob `--yolo` o
// dono pediu "qualquer atividade na máquina": o root-set passa a ser `{ '/' }` (a
// raiz do filesystem; em Windows, a raiz do volume do cwd). A MECÂNICA é a MESMA —
// `resolveInside` segue canonicalizando (realpath/symlink/`..`, sem TOCTOU bug) e
// checando contenção; só que a RAIZ é `/`, então TUDO está "dentro". Não há um 2º
// caminho de I/O não-confinado: é o MESMO port, com a raiz aberta. Em normal/plan
// o root-set continua `{ cwd canonicalizado }` (EST-0948, intacto). O `cwd` de
// sessão sob YOLO começa no cwd REAL do processo (não em `/`), p/ não desorientar.
//
// EST-0982 · /add-dir — CONFINAMENTO MULTI-RAIZ (cravada do `seguranca`, gate FORTE).
// O confinamento deixa de ser 1 raiz fixa e passa a ser um CONJUNTO de raízes
// AUTORIZADAS DA SESSÃO: a raiz original (onde o aluy abriu) + as extras que o
// USUÁRIO autorizar via `/add-dir <path>`. As invariantes NÃO relaxam:
//   - a CONTENÇÃO segue DURA: todo alvo é canonicalizado (realpath — symlink/`..`
//     resolvidos) e REJEITADO se não cair dentro de ALGUMA raiz autorizada;
//   - SÓ O USUÁRIO amplia: `addRoot` é chamado EXCLUSIVAMENTE pelo slash `/add-dir`
//     (ato do humano na sessão). NÃO existe tool de agente que o alcance — o agente
//     não consegue se auto-ampliar, nem em `--unsafe` (mesma postura do write-deny
//     de `~/.aluy/`);
//   - o path-deny por TEXTO (journal `~/.aluy/`, sensitive-read) continua valendo
//     DENTRO das raízes extras — a catraca (engine) classifica pelo path e NUNCA
//     consulta as raízes (adicionar raiz não relaxa nenhuma categoria);
//   - escopo = SESSÃO: as raízes extras NÃO persistem (cada sessão nasce só com a
//     raiz original). Persistência opt-in é FU registrado na estória.
// Composição com o YOLO (EST-0991): sob `unconfined`, a raiz primária já é `/` —
// `addRoot` vira no-op idempotente (tudo já está contido); fora do YOLO, o
// multi-raiz é a ampliação CIRÚRGICA por diretório, sempre por ato do usuário.

import { realpathSync, statSync, lstatSync, readlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, resolve, relative, sep, dirname, parse as parsePath } from 'node:path';
import type { CwdPort } from '@hiperplano/aluy-cli-core';

/** Erro de confinamento: o alvo resolvido escapa a raiz do workspace. */
export class WorkspaceEscapeError extends Error {
  constructor(
    readonly requested: string,
    readonly reason: string,
  ) {
    super(
      `acesso fora do workspace bloqueado: "${requested}" (${reason}). ` +
        'o efeito foi recusado — o agente só atua dentro da raiz do projeto.',
    );
    this.name = 'WorkspaceEscapeError';
  }
}

/**
 * EST-0982 · /add-dir — erro de VALIDAÇÃO ao autorizar uma raiz extra (path não
 * existe, não é diretório, vazio). Distinto do `WorkspaceEscapeError` (que é o
 * confinamento bloqueando um EFEITO): aqui é o ATO DO USUÁRIO falhando com motivo
 * claro — o slash exibe `reason` direto.
 */
export class AddRootError extends Error {
  constructor(
    readonly requested: string,
    readonly reason: string,
  ) {
    super(`não foi possível autorizar "${requested}": ${reason}`);
    this.name = 'AddRootError';
  }
}

/**
 * Porta de confinamento de workspace. Resolve um path do agente para um path
 * absoluto CANONICALIZADO, garantindo que esteja contido na raiz. Lança
 * `WorkspaceEscapeError` se escapa. É a porta que o FS-port concreto consulta
 * ANTES de qualquer leitura/escrita, e que o egress/shell consultam para
 * sinalizar paths.
 */
export interface WorkspacePort {
  /**
   * A raiz PRIMÁRIA canonicalizada do workspace (onde o aluy abriu — nunca muda).
   * É a 1ª das `roots`; o que existia antes do multi-raiz continua relativo a ela
   * (memória de projeto, índice do `@`, AGENT.md).
   */
  readonly root: string;
  /**
   * EST-0982 · /add-dir — TODAS as raízes autorizadas da SESSÃO (a primária + as
   * extras que o USUÁRIO autorizou), canonicalizadas, primária primeiro. O TETO do
   * confinamento: um path resolve se contido em QUALQUER uma delas.
   */
  readonly roots: readonly string[];
  /**
   * EST-0982 · /add-dir — autoriza um diretório EXTRA como raiz da SESSÃO. ATO DO
   * USUÁRIO (slash `/add-dir`) — NUNCA exposto como tool ao agente. Valida (existe,
   * é diretório), canonicaliza (realpath — symlink resolvido) e adiciona ao conjunto;
   * já contido numa raiz existente ⇒ no-op idempotente. Lança `AddRootError` com
   * motivo claro se inválido. Devolve a raiz canonicalizada.
   */
  addRoot(requested: string): string;
  /**
   * EST-0982 — o DIRETÓRIO DE TRABALHO DE SESSÃO corrente (absoluto, ⊆ alguma raiz).
   * Default = raiz primária. Um caminho RELATIVO passado a `resolveInside` resolve
   * contra ELE; o shell roda NELE. Movido por `setCwd` (sempre clampado nas raízes).
   */
  readonly cwd: string;
  /**
   * EST-0982 — move o `sessionCwd` p/ `requested` (relativo ao cwd corrente, ou
   * absoluto). SEMPRE confinado: um alvo que escaparia TODAS as raízes é CLAMPADO na
   * raiz que contém o cwd corrente (não lança por escape — `cd ..` no topo fica na
   * raiz). Pode navegar ENTRE raízes autorizadas (path absoluto). Lança apenas se o
   * alvo, depois de confinado, não for um DIRETÓRIO existente. Devolve o novo cwd.
   */
  setCwd(requested: string): string;
  /**
   * Resolve+canonicaliza `requested` contra o `sessionCwd` (relativo) ou como
   * absoluto. Lança se escapa TODAS as raízes autorizadas. Devolve o path absoluto
   * seguro p/ o I/O concreto.
   */
  resolveInside(requested: string): string;
  /** `true` se `requested` resolve para dentro de alguma raiz (não lança). */
  contains(requested: string): boolean;
}

/**
 * Canonicaliza um path que pode NÃO existir ainda (ex.: edit_file que cria um
 * arquivo novo): canonicaliza o ancestral existente mais próximo via realpath
 * (resolvendo symlinks reais) e re-anexa o sufixo léxico. Assim um symlink no
 * meio do caminho é resolvido, e um arquivo-folha inexistente não impede a
 * checagem. Qualquer erro inesperado de fs ⇒ propaga (o caller rejeita).
 *
 * FAIL-CLOSED (bug-hunt EST-0948) — SYMLINK PENDENTE (dangling). `realpathSync`
 * lança `ENOENT` em DOIS casos distintos que NÃO podem ser tratados igual:
 *   (a) o componente-folha ainda NÃO existe (edit que cria um arquivo novo);
 *   (b) o componente É um SYMLINK que existe mas cujo ALVO não existe (dangling).
 * No caso (b), reconstruir o path LEXICAMENTE (`resolve(realParent, ...suffix)`)
 * devolvia o caminho do próprio link — que `isContained` aprova como "dentro" —
 * mas uma escrita SEGUE o symlink e cai no ALVO (FORA da raiz). Era um ESCAPE de
 * confinamento: um link pendente `<root>/x → /fora/y` deixava `write_file x`
 * gravar em `/fora/y`. A correção: ao re-anexar o sufixo, se o 1º segmento (o
 * filho imediato do ancestral real) for um SYMLINK, RESOLVEMOS o seu alvo (mesmo
 * pendente) e re-canonicalizamos a partir dele — exatamente o que o `write`/`read`
 * faria ao segui-lo. Assim o alvo do link entra na checagem de contenção e um link
 * pendente p/ fora é REJEITADO (igual a um link já-resolvido p/ fora).
 */
function canonicalize(absPath: string, depth = 0): string {
  // Tenta realpath do caminho inteiro (resolve symlinks se o alvo existe).
  try {
    return realpathSync(absPath);
  } catch {
    // Não existe (ainda) — sobe até o 1º ancestral que existe e canonicaliza ELE,
    // re-anexando os segmentos que faltam (resolvidos lexicamente por `resolve`).
    let current = absPath;
    const suffix: string[] = [];
    for (;;) {
      const parent = resolve(current, '..');
      if (parent === current) {
        // chegou na raiz do fs sem achar nada que exista — devolve o léxico.
        return absPath;
      }
      const base = current.slice(parent.length).replace(/^[/\\]/, '');
      suffix.unshift(base);
      let realParent: string;
      try {
        realParent = realpathSync(parent);
      } catch {
        current = parent;
        continue;
      }
      // O 1º segmento do sufixo é o filho imediato do ancestral REAL. Se ele for
      // um SYMLINK (que existe mas o alvo não — por isso o realpath da folha falhou),
      // NÃO basta re-anexar léxico: uma escrita SEGUIRIA o link p/ o seu alvo. Resolve
      // o alvo do link e re-canonicaliza a partir dele (depth-guard anti-ciclo). É o
      // que fecha o ESCAPE de confinamento via link pendente p/ fora da raiz.
      const firstSeg = suffix[0]!;
      const linkPath = resolve(realParent, firstSeg);
      if (depth < MAX_SYMLINK_HOPS && isSymlink(linkPath)) {
        let target: string;
        try {
          target = readlinkSync(linkPath);
        } catch {
          // não conseguimos ler o link ⇒ fail-closed: devolve o próprio link (será
          // checado contra a raiz; se o link sai da raiz, já está coberto, e se fica
          // dentro, o erro de leitura não amplia acesso).
          return resolve(realParent, ...suffix);
        }
        // alvo absoluto entra como veio; relativo resolve contra o dir REAL do link.
        const targetAbs = isAbsolute(target) ? target : resolve(dirname(linkPath), target);
        // re-canonicaliza o ALVO e re-anexa os segmentos APÓS o link (se houver).
        const rest = suffix.slice(1);
        const canonTarget = canonicalize(targetAbs, depth + 1);
        return rest.length > 0 ? resolve(canonTarget, ...rest) : canonTarget;
      }
      return resolve(realParent, ...suffix);
    }
  }
}

/** Teto de saltos de symlink pendente ao canonicalizar (anti-ciclo). */
const MAX_SYMLINK_HOPS = 40;

/** `true` se `p` existe como SYMLINK (lstat NÃO segue o link). Fail-safe: erro ⇒ false. */
function isSymlink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/** `true` se `child` está contido em `root` (ou é a própria raiz). */
function isContained(root: string, child: string): boolean {
  if (child === root) return true;
  const rel = relative(root, child);
  // Contido ⇔ o relativo não começa com `..` e não é absoluto.
  return rel !== '' && !rel.startsWith('..' + sep) && rel !== '..' && !isAbsolute(rel);
}

export interface NodeWorkspaceOptions {
  /** Raiz do workspace (default: `process.cwd()`). Canonicalizada na construção. */
  readonly root?: string;
  /**
   * EST-0991 · ADR-0072 — YOLO (cerca DERRUBADA). `true` ⇒ a RAIZ do confinamento
   * passa a ser a raiz do FILESYSTEM (`/`, ou a raiz do volume do `root`/cwd em
   * Windows), i.e. o root-set `{ '/' }`: TODO path canonicalizado está "dentro" ⇒
   * acesso ao disco inteiro. A canonicalização (realpath/symlink/`..`) PERMANECE —
   * é o MESMO `resolveInside`, sem TOCTOU bug, só sem a cerca de 1 raiz. O
   * `sessionCwd` ARRANCA no `root` informado (o cwd real do projeto), NÃO em `/`
   * (p/ não desorientar o agente). NUNCA persiste — deriva do modo `--yolo` da
   * sessão (opt-in explícito). Default `false` (confinamento de EST-0948 intacto).
   */
  readonly unconfined?: boolean;
}

/**
 * Implementação concreta com Node `fs`/`path`. A raiz é canonicalizada UMA vez
 * (segue symlink da raiz). `resolveInside` canonicaliza o alvo e checa contenção.
 */
export class NodeWorkspace implements WorkspacePort, CwdPort {
  readonly root: string;
  /**
   * EST-0982 · /add-dir — raízes EXTRAS autorizadas pelo USUÁRIO nesta sessão
   * (canonicalizadas). Mutável SÓ via `addRoot` (que o slash `/add-dir` chama).
   * Nenhuma tool de agente alcança isto — não existe caminho de auto-ampliação.
   */
  private extraRoots: string[] = [];
  /**
   * EST-0982 — o `sessionCwd` corrente (absoluto, canonicalizado, SEMPRE ⊆ alguma
   * raiz). Default = raiz primária. Mutável SÓ via `setCwd` (que clampa nas raízes).
   * É a ÚNICA fonte de verdade do cwd: o shell-port lê `workspace.cwd`, o
   * `resolveInside` resolve caminhos relativos contra ele, e o controller espelha
   * no StatusBar.
   */
  private sessionCwd: string;

  constructor(opts: NodeWorkspaceOptions = {}) {
    const raw = opts.root ?? process.cwd();
    // O cwd REAL do projeto (canonicalizado) — onde a sessão arranca em QUALQUER modo.
    const projectDir = canonicalize(resolve(raw));
    if (opts.unconfined === true) {
      // EST-0991 · ADR-0072 — YOLO: a raiz do confinamento é a raiz do FILESYSTEM
      // (root-set `{ '/' }`). `parsePath(...).root` dá `/` (POSIX) ou `C:\` (Win) do
      // cwd do projeto — assim TODO path canonicalizado fica contido ⇒ disco inteiro.
      // A canonicalização e a checagem de contenção do `resolveInside` NÃO mudam.
      this.root = canonicalize(parsePath(projectDir).root);
      // Mas o `sessionCwd` arranca no DIRETÓRIO DO PROJETO (não em `/`).
      this.sessionCwd = projectDir;
    } else {
      // A raiz DEVE existir e ser canonicalizável; senão não há workspace seguro.
      this.root = projectDir;
      // Arranca na raiz (comportamento idêntico ao pré-0982 até o 1º `change_dir`).
      this.sessionCwd = this.root;
    }
  }

  /** EST-0982 — o `sessionCwd` corrente (absoluto, ⊆ alguma raiz autorizada). */
  get cwd(): string {
    return this.sessionCwd;
  }

  /** EST-0982 · /add-dir — todas as raízes autorizadas (primária primeiro). */
  get roots(): readonly string[] {
    return [this.root, ...this.extraRoots];
  }

  /**
   * EST-0982 · /add-dir — autoriza uma raiz EXTRA (ato do USUÁRIO; ver contrato no
   * `WorkspacePort`). Expande `~` (conforto do slash — `~/projects/aluy`),
   * canonicaliza via realpath REAL (o alvo DEVE existir: symlink é resolvido ANTES
   * de virar raiz — uma raiz nunca é um alias que aponta p/ outro lugar) e exige
   * diretório. Já contida em raiz existente ⇒ devolve sem duplicar (idempotente).
   */
  addRoot(requested: string): string {
    const trimmed = requested.trim();
    if (trimmed === '') {
      throw new AddRootError(requested, 'path vazio');
    }
    // Conforto: `~`/`~/x` expande p/ a home do usuário (é o USUÁRIO digitando).
    const expanded =
      trimmed === '~'
        ? homedir()
        : trimmed.startsWith('~/')
          ? resolve(homedir(), trimmed.slice(2))
          : trimmed;
    // Relativo resolve contra o cwd de SESSÃO (onde o usuário "está" na TUI).
    const abs = isAbsolute(expanded) ? resolve(expanded) : resolve(this.sessionCwd, expanded);
    // Canonicaliza com realpath ESTRITO: a raiz DEVE existir (não há raiz "futura").
    let canonical: string;
    try {
      canonical = realpathSync(abs);
    } catch {
      throw new AddRootError(requested, 'o diretório não existe');
    }
    let isDir = false;
    try {
      isDir = statSync(canonical).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) {
      throw new AddRootError(requested, 'não é um diretório');
    }
    // Já contido numa raiz autorizada ⇒ idempotente (não duplica nem aninha).
    if (this.rootContaining(canonical) !== null) {
      return canonical;
    }
    this.extraRoots.push(canonical);
    return canonical;
  }

  /** A raiz autorizada que CONTÉM `canonical`, ou `null` se nenhuma contém. */
  private rootContaining(canonical: string): string | null {
    for (const r of this.roots) {
      if (isContained(r, canonical)) return r;
    }
    return null;
  }

  /**
   * EST-0982 — move o `sessionCwd`. CONFINAMENTO PRESERVADO por construção:
   *  1. resolve `requested` contra o cwd CORRENTE (relativo) ou como absoluto;
   *  2. canonicaliza (resolve `..`/`.`/symlink) — pega o real;
   *  3. CLAMPA nas raízes: alvo contido em QUALQUER raiz autorizada ⇒ vale (pode
   *     navegar ENTRE raízes); alvo que escaparia TODAS ⇒ o cwd vira a raiz que
   *     contém o cwd CORRENTE (não escapa — `cd ..` no topo fica na raiz daquela
   *     árvore; `cd /etc` cai nela);
   *  4. exige que o alvo (já confinado) seja um DIRETÓRIO existente — senão lança
   *     (não navega p/ um arquivo nem p/ um dir inexistente). Fail-safe: qualquer
   *     erro de fs ⇒ não muda o cwd, lança.
   */
  setCwd(requested: string): string {
    if (requested === '') {
      throw new WorkspaceEscapeError(requested, 'path vazio');
    }
    // 1+2 — resolve contra o cwd CORRENTE (não a raiz: `cd` é relativo ao cwd) e
    // canonicaliza. Absoluto entra como veio (e depois é clampado nas raízes).
    const abs = isAbsolute(requested) ? resolve(requested) : resolve(this.sessionCwd, requested);
    let canonical: string;
    try {
      canonical = canonicalize(abs);
    } catch {
      throw new WorkspaceEscapeError(requested, 'falha ao canonicalizar o caminho');
    }
    // 3 — CLAMP nas raízes: o `sessionCwd` NUNCA escapa o conjunto autorizado. Em vez
    // de lançar (um `cd ..` no topo é navegação legítima, não um ataque), o cwd
    // fica/volta à raiz da árvore CORRENTE. O `resolveInside` (o gate DURO de
    // FS/exec) é quem rejeita escapes reais.
    const confined =
      this.rootContaining(canonical) !== null
        ? canonical
        : (this.rootContaining(this.sessionCwd) ?? this.root);
    // 4 — o alvo confinado DEVE ser um diretório existente.
    let isDir = false;
    try {
      isDir = statSync(confined).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) {
      throw new WorkspaceEscapeError(requested, 'não é um diretório existente dentro do projeto');
    }
    this.sessionCwd = confined;
    return this.sessionCwd;
  }

  resolveInside(requested: string): string {
    if (requested === '') {
      throw new WorkspaceEscapeError(requested, 'path vazio');
    }
    // EST-0982 — um path RELATIVO resolve contra o `sessionCwd` (não mais a raiz
    // fixa): é o que faz `edit_file data/x.json` ir p/ `<sessionCwd>/data/x.json`.
    // Um path ABSOLUTO entra como veio. Em ambos, a CONTENÇÃO abaixo (⊆ ALGUMA raiz
    // autorizada) é o gate DURO — o cwd só muda a ORIGEM do relativo, e o `/add-dir`
    // (ato do USUÁRIO) é o único que muda o conjunto de raízes.
    const abs = isAbsolute(requested) ? resolve(requested) : resolve(this.sessionCwd, requested);
    let canonical: string;
    try {
      canonical = canonicalize(abs);
    } catch {
      // fail-safe: erro ao canonicalizar ⇒ rejeita.
      throw new WorkspaceEscapeError(requested, 'falha ao canonicalizar o caminho');
    }
    if (this.rootContaining(canonical) === null) {
      throw new WorkspaceEscapeError(
        requested,
        'caminho resolve para fora das raízes autorizadas do workspace',
      );
    }
    return canonical;
  }

  contains(requested: string): boolean {
    try {
      this.resolveInside(requested);
      return true;
    } catch {
      return false;
    }
  }
}
