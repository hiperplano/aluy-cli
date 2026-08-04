// ADR-0158 (aceito, APR-0148) §1/§9 — REGISTRY/DESCOBERTA confinada dos SERVIÇOS
// instalados em `~/.aluy/services/<nome>/`. Espelha o `UserWorkflowsLoader`/
// `UserAgentsLoader`: lê o dir confinado (0700), parseia cada `service.md` com o
// parser PURO do core (`parseServiceManifest`) e devolve os serviços VÁLIDOS +
// os REJEITADOS (RES-MD-3 do parser OU falha de validação estrutural do dir).
//
// FRONTEIRA: `~/.aluy/services/*/service.md` é CONFIG DO DONO (ele que instalou —
// ADR-0158 §9, ato de confiança explícito). Dir ausente/ilegível ⇒ lista VAZIA,
// NUNCA lança (fail-safe — um serviço quebrado não derruba a listagem dos demais,
// mesma disciplina de `WorkflowLoadResult`).
//
// VALIDAÇÃO adicional (além do parser puro, que só valida FORMA):
//   • `schedule:` — 5 campos cron via `validateCronExpr` (reusa `commands/cron.ts`,
//     ADR-0158 §1: "Instalar… valida o frontmatter (cron via validateCronExpr…)").
//   • `workflow:` — precisa apontar para um `.md` EXISTENTE em `workflows/` do
//     próprio diretório do serviço (ADR-0158 §1).
//   • o NOME do diretório precisa bater com o `name:` do frontmatter (normalizado)
//     — evita o serviço "aparecer" sob um nome e "responder" por outro.
//
// Este módulo NÃO faz nada de `install`/`uninstall` (isso é `commands/service.ts`,
// que USA este registry para validar ANTES de ativar, ADR-0158 §9/§10).

import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { readdirSync, readFileSync, mkdirSync, statSync, existsSync, type Dirent } from 'node:fs';
import {
  parseServiceManifest,
  isServiceManifestError,
  normalizeServiceName,
  type ServiceManifest,
  type ServiceDaemonDeclared,
  type ServiceSkillDeclared,
} from '@hiperplano/aluy-cli-core';
import { validateCronExpr } from '../commands/cron.js';

/** Permissão restrita do dir `~/.aluy/services/` (espelha agents/workflows/commands). */
const DIR_MODE = 0o700;

/** Subdir (dentro de `~/.aluy/`) onde moram os serviços instalados. */
export const SERVICES_DIRNAME = 'services';

/** Teto defensivo de tamanho de um `service.md` (anti-arquivo-gigante). */
const MAX_SERVICE_MD_BYTES = 64 * 1024;

/** Teto defensivo de QUANTOS serviços carregar (anti-dir gigante). */
const MAX_SERVICES = 256;

/** Um serviço já VALIDADO (manifesto parseável + cron/workflow OK). */
export interface ServiceEntry {
  readonly name: string;
  /** Caminho absoluto do diretório do serviço. */
  readonly dir: string;
  readonly manifest: ServiceManifest;
}

/** Um serviço REJEITADO — nome do diretório + o motivo (RES-MD-3 ou validação estrutural). */
export interface ServiceEntryError {
  readonly dirName: string;
  readonly reason: string;
}

export interface ServicesListResult {
  readonly services: readonly ServiceEntry[];
  readonly errors: readonly ServiceEntryError[];
}

/** `true` se o resultado de `get()` é uma rejeição (§ dirName+reason, sem manifest). */
export function isServiceEntryError(e: ServiceEntry | ServiceEntryError): e is ServiceEntryError {
  return !('manifest' in e);
}

export interface UserServicesStoreOptions {
  /** Raiz do `~/.aluy/` (default: `<home>/.aluy`). Injetável p/ teste (tmpdir). */
  readonly baseDir?: string;
}

/**
 * Sanitiza um nome de serviço vindo de INPUT do usuário (`status <nome>`,
 * `uninstall <nome>`) contra path traversal — nunca deixa `/`, `\`, `.`/`..` puros
 * virarem parte do caminho resolvido. Devolve `undefined` quando o nome é hostil
 * (o caller trata como "serviço não encontrado", nunca resolve fora do dir). PURO.
 */
export function safeServiceDirName(raw: string): string | undefined {
  const n = raw.trim();
  if (n === '' || n === '.' || n === '..') return undefined;
  if (n.includes('/') || n.includes('\\') || n.includes('\0')) return undefined;
  return n;
}

/** Carregador/registry dos serviços de `~/.aluy/services/<nome>/`. */
export class UserServicesStore {
  private readonly dir: string;

  constructor(opts: UserServicesStoreOptions = {}) {
    const base = opts.baseDir ?? join(homedir(), '.aluy');
    this.dir = join(base, SERVICES_DIRNAME);
  }

  /** O caminho do dir de serviços (p/ mensagens/teste). */
  get servicesDir(): string {
    return this.dir;
  }

  /** Garante `~/.aluy/services/` com mode 0700 (idempotente, best-effort). */
  ensureDir(): void {
    try {
      mkdirSync(this.dir, { mode: DIR_MODE, recursive: true });
    } catch {
      /* best-effort — fail-safe */
    }
  }

  /** Caminho absoluto de um serviço pelo nome — confinado (path traversal recusado). */
  resolveDir(name: string): string | undefined {
    const safe = safeServiceDirName(name);
    if (safe === undefined) return undefined;
    return join(this.dir, safe);
  }

  /**
   * Lê todos os DIRETÓRIOS diretos de `~/.aluy/services/` e devolve os serviços
   * VÁLIDOS + os REJEITADOS (RES-MD-3 do parser + validação estrutural: cron,
   * workflow existente, nome do dir batendo com o `name:`). Determinístico
   * (ordenado por nome do diretório). Dir ausente ⇒ vazio, NUNCA lança.
   */
  list(): ServicesListResult {
    let entries: Dirent[];
    try {
      entries = readdirSync(this.dir, { withFileTypes: true });
    } catch {
      return { services: [], errors: [] };
    }
    const dirNames = entries
      .filter((e) => e.isDirectory() || e.isSymbolicLink())
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b));

    const services: ServiceEntry[] = [];
    const errors: ServiceEntryError[] = [];
    for (const dirName of dirNames) {
      if (services.length + errors.length >= MAX_SERVICES) break;
      const result = this.readOne(dirName);
      if (result.kind === 'ok') services.push(result.entry);
      else errors.push(result.error);
    }
    return { services, errors };
  }

  /** Lê+valida UM serviço pelo nome do diretório. `undefined` = não encontrado/hostil. */
  get(name: string): ServiceEntry | ServiceEntryError | undefined {
    const safe = safeServiceDirName(name);
    if (safe === undefined) return undefined;
    let isDir = false;
    try {
      isDir = statSync(join(this.dir, safe)).isDirectory();
    } catch {
      return undefined;
    }
    if (!isDir) return undefined;
    const result = this.readOne(safe);
    return result.kind === 'ok' ? result.entry : result.error;
  }

  /** Lê+parseia+valida UM serviço (dirName = basename sob `~/.aluy/services/`). */
  private readOne(
    dirName: string,
  ): { kind: 'ok'; entry: ServiceEntry } | { kind: 'error'; error: ServiceEntryError } {
    const dir = join(this.dir, dirName);
    const mdPath = join(dir, 'service.md');

    let raw: string;
    try {
      const st = statSync(mdPath);
      if (!st.isFile() || st.size > MAX_SERVICE_MD_BYTES) {
        return { kind: 'error', error: { dirName, reason: 'service.md ausente/grande demais.' } };
      }
      raw = readFileSync(mdPath, 'utf8');
    } catch {
      return { kind: 'error', error: { dirName, reason: `sem "service.md" legível em ${dir}.` } };
    }

    const parsed = parseServiceManifest('service.md', raw);
    if (isServiceManifestError(parsed)) {
      return { kind: 'error', error: { dirName, reason: parsed.reason } };
    }

    // O nome do DIRETÓRIO precisa bater com o `name:` do frontmatter (normalizado) —
    // evita um serviço instalado sob um nome "responder" por outro internamente.
    if (normalizeServiceName(dirName) !== parsed.name) {
      return {
        kind: 'error',
        error: {
          dirName,
          reason:
            `o diretório "${dirName}" não bate com "name: ${parsed.name}" declarado no ` +
            `service.md — renomeie o diretório para "${parsed.name}" ou corrija o "name:".`,
        },
      };
    }

    if (parsed.schedule !== undefined) {
      const bad = validateCronExpr(parsed.schedule);
      if (bad !== undefined) {
        return {
          kind: 'error',
          error: { dirName, reason: `"schedule: ${parsed.schedule}" inválido — ${bad}` },
        };
      }
    }

    if (parsed.workflow !== undefined) {
      // 2ª CAMADA de confinamento do `workflow:` (a 1ª é a forma, recusada já no parser
      // por `isSafeWorkflowRef`). Aqui resolvemos de verdade e conferimos que o caminho
      // caiu DENTRO de `workflows/` do serviço — rede para qualquer forma de escape que
      // a validação textual não tenha previsto (symlink, normalização de plataforma).
      // Recusa vira "não encontrado": não confirmamos ao chamador que o alvo existe
      // fora da árvore.
      const wfRoot = resolve(dir, 'workflows');
      const wfPath = resolve(wfRoot, `${parsed.workflow}.md`);
      if (wfPath !== wfRoot && !wfPath.startsWith(wfRoot + sep)) {
        return {
          kind: 'error',
          error: {
            dirName,
            reason:
              `"workflow: ${parsed.workflow}" aponta para fora de workflows/ do serviço — recusado.`,
          },
        };
      }
      let wfExists = false;
      try {
        wfExists = statSync(wfPath).isFile();
      } catch {
        wfExists = false;
      }
      if (!wfExists) {
        return {
          kind: 'error',
          error: {
            dirName,
            reason: `"workflow: ${parsed.workflow}" não encontrado — esperado workflows/${parsed.workflow}.md`,
          },
        };
      }
    }

    return { kind: 'ok', entry: { name: parsed.name, dir, manifest: parsed } };
  }
}

/**
 * ADR-0158 §9/§10 — ESCANEIA (I/O) um diretório-candidato a serviço p/ montar o
 * "manifesto visível" exigido antes do `install` confirmar: daemons declarados
 * (comando+porta, best-effort — `daemon.md` malformado só mostra "não declarado",
 * NUNCA derruba o scan), skills COM script próprio (qualquer arquivo além do
 * `SKILL.md`), e presença de `mcp.json`. Fail-safe: subpasta ausente ⇒ lista vazia.
 */
export function scanServiceDirForInstall(dir: string): {
  readonly daemons: readonly ServiceDaemonDeclared[];
  readonly skills: readonly ServiceSkillDeclared[];
  readonly hasMcp: boolean;
} {
  const daemons: ServiceDaemonDeclared[] = [];
  try {
    const daemonsDir = join(dir, 'daemons');
    const entries = readdirSync(daemonsDir, { withFileTypes: true }).filter((e) => e.isDirectory());
    for (const e of entries) {
      const daemonMdPath = join(daemonsDir, e.name, 'daemon.md');
      let command: string | undefined;
      let port: string | undefined;
      try {
        const raw = readFileSync(daemonMdPath, 'utf8');
        command = extractSimpleKey(raw, 'command');
        port = extractSimpleKey(raw, 'port');
      } catch {
        /* daemon.md ausente/ilegível — o daemon ainda aparece, campos "não declarado". */
      }
      daemons.push({
        name: e.name,
        ...(command !== undefined ? { command } : {}),
        ...(port !== undefined ? { port } : {}),
      });
    }
  } catch {
    /* sem daemons/ — nenhum declarado. */
  }

  const skills: ServiceSkillDeclared[] = [];
  try {
    const skillsDir = join(dir, 'skills');
    const entries = readdirSync(skillsDir, { withFileTypes: true }).filter((e) => e.isDirectory());
    for (const e of entries) {
      let hasScript = false;
      try {
        const inner = readdirSync(join(skillsDir, e.name), { withFileTypes: true });
        hasScript = inner.some((f) => f.isFile() && f.name.toLowerCase() !== 'skill.md');
      } catch {
        hasScript = false;
      }
      skills.push({ name: e.name, hasScript });
    }
  } catch {
    /* sem skills/ — nenhuma declarada. */
  }

  const hasMcp = existsSync(join(dir, 'mcp.json'));

  return { daemons, skills, hasMcp };
}

/** Extrai `chave: valor` de 1 linha de um `.md` frontmatter-mínimo (best-effort, exibição só). */
function extractSimpleKey(raw: string, key: string): string | undefined {
  const re = new RegExp(`^\\s*${key}\\s*:\\s*(.+)$`, 'im');
  const m = re.exec(raw);
  if (!m) return undefined;
  const value = m[1]!.trim().replace(/^["']|["']$/g, '');
  return value !== '' ? value : undefined;
}
