// LIVRO-CAIXA DE VERIFICAÇÃO — parte PURA do "pula a sonda se o agente já verificou".
//
// O self-check (self-check.ts) injeta uma sonda de auto-verificação antes de aceitar um
// "pronto". Ela custa uma chamada extra ao modelo (~10-15 s no tier custom). Quando o
// PRÓPRIO agente já conferiu o que fez (releu o arquivo que acabou de escrever, rodou o
// teste e passou), a sonda é redundante. Este módulo decide isso — sem I/O, sem modelo.
//
// O loop alimenta `record()` com cada tool-call (nome, input, ok). `canSkip()` só devolve
// `true` quando TODAS as condições abaixo valem (na dúvida, SONDA — o erro seguro é gastar
// a chamada, nunca aceitar um "pronto" sem lastro):
//  1. houve ao menos um EFEITO neste turno (edit_file/write_file ok, ou comando/tool que
//     possa alterar estado). Sem efeito não há o que "já ter verificado" ⇒ sonda (clássico);
//  2. TODO arquivo mutado por edit_file/write_file foi, DEPOIS, RELIDO com sucesso (read_file
//     ok do MESMO caminho normalizado, ou cat/head/tail/diff/... do caminho via run_command)
//     OU coberto por um teste/build/lint que PASSOU (run_tests exit 0, ou run_command de
//     teste/build/lint exit 0) rodado depois;
//  3. nenhum run_command com efeito colateral NÃO atribuível a arquivo (rm, mv, cp, `>`,
//     sed -i, npm install, git commit…) ocorreu depois da última verificação passante: só
//     um teste/build/lint passante posterior o cobre (um read_file não — não sabemos o que
//     mudou);
//  4. o ÚLTIMO teste/build/lint não falhou (falhou ⇒ sonda; só um passante posterior limpa);
//  5. tool desconhecida/MCP/subagente (efeito não auditável aqui) conta como efeito não
//     atribuível (regra 3).
// Reler OUTRO arquivo, ou o mesmo arquivo ANTES da última edição, NÃO conta.
//
// LIMITE CONHECIDO: não enxerga requisito OMITIDO (pedido em duas partes e o agente só fez
// e conferiu uma — nada mutado fica "sujo"). Por isso a regra é opt-in; o experimento em
// scripts/experiments/self-check mede esse risco.

/** Comando de teste/build/lint/typecheck (heurística conservadora, por segmento). */
const CHECK_CMD_RE =
  /(^|\s)(vitest|jest|mocha|pytest|tox|rspec|phpunit|eslint|ruff|flake8|mypy|tsc|shellcheck)(\s|$)|\b(npm|pnpm|yarn|bun)\s+(run\s+)?(test|build|lint|typecheck|check)\b|\b(go|cargo|dotnet|mvn|gradle|swift)\s+(test|build|check|vet|clippy)\b|\bmake\s+(test|check|build|lint)\b|\bnode\s+--test\b|\bpython3?\s+-m\s+(pytest|unittest)\b/;

/** Comandos de leitura que, citando um caminho, valem como RELEITURA dele. */
const READ_CMD_RE = /^\s*(cat|head|tail|less|more|wc|diff|cmp|nl|bat|md5sum|sha256sum)\b/;

const READ_ONLY_HEADS: ReadonlySet<string> = new Set([
  'cat',
  'head',
  'tail',
  'less',
  'more',
  'wc',
  'diff',
  'cmp',
  'grep',
  'rg',
  'nl',
  'bat',
  'stat',
  'ls',
  'pwd',
  'echo',
  'printf',
  'true',
  'test',
  '[',
  'cd',
  'file',
  'md5sum',
  'sha256sum',
  'which',
  'date',
  'sort',
  'uniq',
  'cut',
]);

/** Quebra uma linha de shell em segmentos por `;`, `&&`, `||`, `|`, `\n` (sem entender aspas). */
function splitShell(cmd: string): string[] {
  return cmd
    .split(/&&|\|\||;|\||\n/)
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

/** Segmento claramente SÓ-LEITURA: cabeça na allowlist, sem redirecionamento/substituição. */
function readOnlySegment(seg: string): boolean {
  const head = seg.split(/\s+/)[0] ?? '';
  if (!READ_ONLY_HEADS.has(head)) return false;
  const stripped = seg.replace(/\d*>&\d+/g, '').replace(/\d*>\s*\/dev\/null/g, '');
  if (stripped.includes('>')) return false;
  if (/\$\(|`/.test(seg)) return false; // substituição de comando: opaca
  return true;
}

export class VerificationLedger {
  private readonly dirty = new Set<string>();
  private unattributed = false;
  private mutated = false;
  private lastCheckFailed = false;

  /**
   * `true` se a tool-call, SE bem-sucedida, produz/pode produzir um EFEITO (escrita de
   * arquivo, comando não só-leitura, tool não auditável). Leitura, busca e teste/build/lint
   * passante NÃO são efeito. Usado pela UX do self-check: uma passada de verificação que só
   * lê e reconfirma é CONFIRMAÇÃO, não "achou pendências". PURO.
   */
  static isEffect(name: string, input: unknown): boolean {
    const l = new VerificationLedger();
    l.record(name, input, true);
    return l.mutated;
  }

  /** Normaliza caminho p/ comparação (`./a/../b.txt` ⇒ `b.txt`). */
  static normPath(p: string): string {
    const parts: string[] = [];
    for (const seg of p.trim().replace(/\\/g, '/').split('/')) {
      if (seg === '' || seg === '.') continue;
      if (seg === '..') {
        if (parts.length > 0 && parts[parts.length - 1] !== '..') parts.pop();
        else parts.push('..');
        continue;
      }
      parts.push(seg);
    }
    return parts.join('/');
  }

  private pathOf(input: unknown): string | undefined {
    if (typeof input !== 'object' || input === null) return undefined;
    const o = input as Record<string, unknown>;
    for (const k of ['path', 'file', 'filename']) {
      const v = o[k];
      if (typeof v === 'string' && v.trim() !== '') return VerificationLedger.normPath(v);
    }
    return undefined;
  }

  private checkPassed(): void {
    this.lastCheckFailed = false;
    this.dirty.clear();
    this.unattributed = false;
  }

  /** Registra o desfecho de uma tool-call. */
  record(name: string, input: unknown, ok: boolean): void {
    switch (name) {
      case 'edit_file':
      case 'write_file': {
        if (!ok) return; // falhou ⇒ sem efeito
        const p = this.pathOf(input);
        this.mutated = true;
        if (p === undefined) this.unattributed = true;
        else this.dirty.add(p);
        return;
      }
      case 'read_file': {
        if (!ok) return;
        const p = this.pathOf(input);
        if (p !== undefined) this.dirty.delete(p);
        return;
      }
      case 'grep':
      case 'glob':
      case 'change_dir':
      case 'web_fetch':
      case 'web_search':
      case 'perguntar':
      case 'capabilities':
        return; // sem efeito de arquivo e sem valor de verificação
      case 'run_tests': {
        if (ok) this.checkPassed();
        else this.lastCheckFailed = true;
        return;
      }
      case 'run_command': {
        const cmd =
          typeof input === 'object' && input !== null
            ? String((input as Record<string, unknown>).command ?? '')
            : '';
        this.recordCommand(cmd, ok);
        return;
      }
      default:
        // Tool não auditável (MCP, subagente, memória…): efeito não atribuível.
        if (ok) {
          this.mutated = true;
          this.unattributed = true;
        }
    }
  }

  private recordCommand(cmd: string, ok: boolean): void {
    const segs = splitShell(cmd);
    const isCheck = (s: string): boolean => CHECK_CMD_RE.test(s);
    const allSafe = segs.length > 0 && segs.every((s) => isCheck(s) || readOnlySegment(s));
    if (allSafe && segs.some(isCheck)) {
      if (ok) this.checkPassed();
      else this.lastCheckFailed = true;
      return;
    }
    if (allSafe) {
      // só leitura: cat/head/diff/... citando um caminho sujo vale como RELEITURA.
      if (!ok) return;
      for (const seg of segs) {
        if (!READ_CMD_RE.test(seg)) continue;
        for (const tok of seg.split(/\s+/).slice(1)) {
          if (tok.startsWith('-')) continue;
          this.dirty.delete(VerificationLedger.normPath(tok.replace(/^['"]|['"]$/g, '')));
        }
      }
      return;
    }
    // Pode ter efeito colateral (mesmo falho, pode ter agido parcialmente).
    this.mutated = true;
    this.unattributed = true;
  }

  /** `true` ⇒ há evidência de verificação pós-último-efeito: pode dispensar a sonda. */
  canSkip(): boolean {
    return this.mutated && this.dirty.size === 0 && !this.unattributed && !this.lastCheckFailed;
  }
}
