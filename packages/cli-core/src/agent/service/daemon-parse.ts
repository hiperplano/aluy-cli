// ADR-0158 §6 — RUNNER (fase 2): parser PURO de `daemons/<nome>/daemon.md` — a
// declaração MÍNIMA de um processo PRÓPRIO do usuário (mesma gramática frontmatter
// chave-valor de tudo no aluy; "nada além de chave-valor", §6). Campos: `command:`
// (obrigatório — sem ele não há o que dar `spawn`), `port:`/`health:` (opcionais,
// informativos — o aluy "só gerencia CICLO DE VIDA... NUNCA interpreta o que fazem",
// §6; `health` não é sondado por código nesta fase, só exibido).
//
// A fase 1 já tinha um extractor AD-HOC (`scanServiceDirForInstall`/`extractSimpleKey`
// em `packages/cli/src/io/services-store.ts`) usado só para o "manifesto visível" do
// `install` (exibição, tolera comando ausente). Este parser é o IRMÃO FORTE para a
// fase 2: o runner PRECISA de um `command:` válido para dar `spawn` — por isso FALHA
// FECHADA (RES-MD-3) quando ausente, ao contrário do extractor de exibição.
//
// PORTÁVEL (ADR-0053 §8): parser de string puro (sem `node:*`, sem I/O). A LEITURA
// confinada de `daemons/<nome>/daemon.md` é do locus concreto (`@hiperplano/aluy-cli`).

/** Um daemon PRÓPRIO do usuário já parseado (ADR-0158 §6). */
export interface DaemonManifest {
  /** A linha de comando a `spawn`-ar (shell, via `sh -c`/`cmd /c` no locus concreto). */
  readonly command: string;
  /** Porta declarada (informativa — o aluy não a usa para nada além de exibir/`/doctor`). */
  readonly port?: number;
  /** Health-check declarado (URL ou comando) — NÃO sondado nesta fase, só exibido. */
  readonly health?: string;
}

export interface DaemonManifestError {
  readonly kind: 'error';
  readonly reason: string;
}

export type DaemonManifestParse = DaemonManifest | DaemonManifestError;

export function isDaemonManifestError(p: DaemonManifestParse): p is DaemonManifestError {
  return (p as DaemonManifestError).kind === 'error';
}

const MAX_COMMAND_LEN = 4096;

/** Mesma tolerância a comentário inline dos demais parsers `.md` do aluy (aspas OU `\s#`). */
function stripInlineComment(raw: string): string {
  const quoted = /^(["'])((?:\\.|(?!\1).)*)\1/.exec(raw);
  if (quoted) return quoted[2]!;
  const hashIdx = raw.search(/\s#/);
  return (hashIdx === -1 ? raw : raw.slice(0, hashIdx)).trim();
}

/**
 * Parseia o `daemon.md` cru. `name` (identidade) vem do NOME DO DIRETÓRIO — não do
 * conteúdo (evita um `daemon.md` "responder" por outro nome, mesma disciplina de
 * `service-parse.ts`) — por isso não faz parte deste parser (o caller confinado o
 * atribui). Rejeita (RES-MD-3, fail-closed): `command:` ausente/vazio.
 */
export function parseDaemonManifest(raw: string): DaemonManifestParse {
  const text = raw.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  const fmBlock = m ? m[1]! : text; // tolera daemon.md SEM cerca `---` (só chave-valor cru).

  let command: string | undefined;
  let port: string | undefined;
  let health: string | undefined;
  for (const line of fmBlock.split('\n')) {
    const kv = /^\s*([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1]!.toLowerCase();
    const value = stripInlineComment(kv[2]!.trim());
    if (key === 'command') command = value;
    else if (key === 'port') port = value;
    else if (key === 'health') health = value;
  }

  if (command === undefined || command.trim() === '') {
    return {
      kind: 'error',
      reason: 'daemon.md sem "command:" — o runner não tem o que executar (ADR-0158 §6).',
    };
  }
  if (command.length > MAX_COMMAND_LEN) {
    return { kind: 'error', reason: `daemon.md: "command:" excede ${MAX_COMMAND_LEN} chars.` };
  }

  let portNum: number | undefined;
  if (port !== undefined && port.trim() !== '') {
    const n = Number(port.trim());
    if (!Number.isInteger(n) || n < 1 || n > 65535) {
      return { kind: 'error', reason: `daemon.md: "port: ${port}" inválida (use 1..65535).` };
    }
    portNum = n;
  }

  return {
    command: command.trim(),
    ...(portNum !== undefined ? { port: portNum } : {}),
    ...(health !== undefined && health.trim() !== '' ? { health: health.trim() } : {}),
  };
}
