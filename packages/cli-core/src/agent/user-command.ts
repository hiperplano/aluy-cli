// EST-0974 · ADR-0053 §2.2 — COMANDOS CUSTOMIZADOS do usuário (parser PURO).
//
// Um arquivo `~/.aluy/commands/<nome>.md` vira o slash-command `/<nome>`. O
// conteúdo do `.md` é um TEMPLATE DE PROMPT (texto do usuário): ao invocar
// `/<nome> [args]`, o template é EXPANDIDO (com os args) e o resultado é submetido
// como OBJETIVO — exatamente como se o usuário tivesse digitado aquele texto.
//
// ╔══════════════════════════════════════════════════════════════════════════╗
// ║ FRONTEIRA DE PROVENIÊNCIA (o que o `seguranca` reconfere) — Parte 1:        ║
// ║  • O `.md` é CONFIG DO DONO (como o AGENT.md): config local, não dado       ║
// ║    externo não-confiável. Por isso o template pode virar texto-do-usuário.  ║
// ║  • O RESULTADO da expansão é só um OBJETIVO submetido PELO USUÁRIO — NÃO     ║
// ║    bypassa a catraca: cada tool que esse objetivo dispara passa por          ║
// ║    `decide()` normal (CLI-SEC-H1). Um comando `.md` NÃO executa nada por si. ║
// ║  • Os ARGS (`/<nome> arg1 arg2`) vêm do usuário no momento da invocação:     ║
// ║    são texto literal interpolado no template, nunca instrução privilegiada.  ║
// ╚══════════════════════════════════════════════════════════════════════════╝
//
// PORTÁVEL (ADR-0053 §8): parser de string PURO (sem `node:*`, sem I/O). A LEITURA
// confinada de `~/.aluy/commands/` (0700) é do locus concreto (@aluy/cli, io/).

/** Frontmatter OPCIONAL (chave: valor) no topo de um comando `.md`, entre `---`. */
export interface UserCommandMeta {
  /** Resumo curto exibido no menu/palette (default: derivado do nome). */
  readonly summary?: string;
}

/**
 * Um comando customizado já PARSEADO de um `.md`: o nome (derivado do arquivo, sem
 * a extensão), o resumo p/ o menu, e o TEMPLATE de prompt (corpo do `.md`).
 */
export interface UserCommand {
  /** Nome do slash-command, sem a barra (`deploy`, `revisar`). */
  readonly name: string;
  /** Resumo p/ o menu/palette (do frontmatter `summary:` ou um default). */
  readonly summary: string;
  /** O corpo do `.md` (template de prompt), já sem o frontmatter. */
  readonly template: string;
}

/**
 * Normaliza o NOME de um comando a partir do basename do arquivo (sem `.md`):
 * minúsculas, e só `[a-z0-9_-]` (qualquer outro vira `-`). Garante que o nome casa
 * a gramática de slash-command (`routeInput` faz `.toLowerCase()` no que vem após
 * `/`). Nome vazio após normalizar ⇒ `''` (o loader descarta). PURO.
 */
export function normalizeCommandName(basename: string): string {
  return basename
    .toLowerCase()
    .replace(/\.md$/, '')
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Separa o frontmatter YAML-MÍNIMO (bloco `---`…`---` no TOPO) do corpo. Só pares
 * `chave: valor` de 1 linha são reconhecidos (sem YAML aninhado — config simples,
 * sem dependência). Sem frontmatter ⇒ meta vazio + corpo inteiro. PURO.
 */
export function splitFrontmatter(raw: string): { meta: UserCommandMeta; body: string } {
  // Tolera BOM e CRLF. O bloco de frontmatter exige `---` na 1ª linha.
  const text = raw.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const fm = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (!fm) return { meta: {}, body: text.trim() };
  const meta: { summary?: string } = {};
  for (const line of fm[1]!.split('\n')) {
    const kv = /^\s*([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1]!.toLowerCase();
    // Tira aspas envolventes do valor (`summary: "x"` ⇒ `x`).
    const value = kv[2]!.trim().replace(/^["']|["']$/g, '');
    if (key === 'summary') meta.summary = value;
  }
  return { meta, body: text.slice(fm[0].length).trim() };
}

/**
 * Parseia o conteúdo cru de um `<nome>.md` num `UserCommand`. O `name` vem do
 * BASENAME do arquivo (não do conteúdo) — a fonte da verdade do nome é o filesystem
 * confinado, não algo auto-declarado no corpo (evita um `.md` "renomear-se" p/
 * colidir com um nativo; o loader ainda filtra colisões). `summary` cai p/ um
 * default legível. Corpo vazio ⇒ `null` (comando inútil, o loader descarta). PURO.
 */
export function parseUserCommand(basename: string, raw: string): UserCommand | null {
  const name = normalizeCommandName(basename);
  if (name === '') return null;
  const { meta, body } = splitFrontmatter(raw);
  if (body === '') return null;
  const summary =
    meta.summary && meta.summary !== '' ? meta.summary : `comando do usuário /${name}`;
  return { name, summary, template: body };
}

/**
 * EXPANDE o template de um comando com os ARGS do usuário (o texto após `/<nome>`).
 * Substituições suportadas (modelo Claude Code/OpenCode como REFERÊNCIA de design):
 *   • `$ARGUMENTS` — a string inteira de args (tudo após o nome do comando).
 *   • `$1`, `$2`, … — o N-ésimo arg posicional (split por espaço). Ausente ⇒ ''.
 * Se o template NÃO tem nenhum placeholder e há args, anexa os args ao fim (numa
 * linha em branco) — assim um `.md` simples ("revise o código") + `/<nome> foo.ts`
 * ainda leva o `foo.ts`. Sem args e sem placeholder ⇒ o template puro. PURO.
 *
 * O resultado é o OBJETIVO a submeter — texto do usuário, NÃO instrução de sistema.
 */
export function expandUserCommand(template: string, args: string): string {
  const trimmedArgs = args.trim();
  const positional = trimmedArgs === '' ? [] : trimmedArgs.split(/\s+/);
  const hasArguments = /\$ARGUMENTS\b/.test(template);
  const hasPositional = /\$\d+\b/.test(template);

  let out = template.replace(/\$ARGUMENTS\b/g, trimmedArgs);
  out = out.replace(/\$(\d+)\b/g, (_m, n: string) => {
    const idx = Number(n) - 1;
    return idx >= 0 && idx < positional.length ? positional[idx]! : '';
  });

  // Sem placeholder algum mas COM args ⇒ anexa (não some o que o usuário digitou).
  if (!hasArguments && !hasPositional && trimmedArgs !== '') {
    out = `${out}\n\n${trimmedArgs}`;
  }
  return out.trim();
}
