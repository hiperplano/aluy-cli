// ADR-0158 — RESOLUÇÃO de I/O (concreta) do campo `workspace:` do service.md.
//
// O parser PURO do core (`@hiperplano/aluy-cli-core`, `service-parse.ts`) só valida a
// FORMA de cada entrada (`isSafeWorkspaceRef`) e devolve os valores CRUS — ainda sem
// `~` expandido, sem relativo resolvido, sem canonicalizar. Este módulo é o locus
// CONCRETO (tem `node:fs`/`node:path`/`node:os`) que faz o resto:
//
//   1. "~"/"~/x" expande p/ `home`;
//   2. RELATIVO resolve contra `serviceDir` (a pasta do PRÓPRIO service.md que
//      declarou a raiz — é dali que "../outro-projeto" faz sentido);
//   3. ABSOLUTO entra como veio — é o CASO DE USO (apontar pra fora da árvore do
//      serviço, ex.: "~/projects/fluider" do dono real que motivou esta feature);
//   4. CANONICALIZA (realpath — segue symlink) e EXIGE um DIRETÓRIO EXISTENTE:
//      ausente/arquivo ⇒ recusa fail-closed (nunca cria, nunca "assume que vai
//      existir depois" — mesma disciplina de `workflow:` em services-store.ts);
//   5. O PISO QUE NÃO CAI: nenhuma raiz pode cair DENTRO de `aluyHome` (o `~/.aluy/`
//      do dono, ou o equivalente injetado em teste) — "workspace: ~/.aluy" NUNCA
//      vira permissão de escrever a própria config/journal do agente, mesmo que o
//      diretório exista de verdade. `~/.aluy/services/<nome>/` (a pasta do PRÓPRIO
//      serviço) TAMBÉM cai dentro de `aluyHome` — mas ela já é raiz por outro
//      caminho (a raiz PRIMÁRIA do turno, `cwd`), então recusar uma redeclaração
//      dela aqui não perde nada; só fecha a porta de generalizar pra QUALQUER
//      outro arquivo do dono sob `~/.aluy/` (hooks.json, outros serviços, etc.).
//
// Qualquer falha REJEITA O CONJUNTO INTEIRO — mesma disciplina do `workflow:` no
// `services-store.ts`: um manifesto com UMA raiz hostil não entra "parcialmente
// válido" (senão o dono via de instalar vendo só as raízes "boas" e nunca saberia
// que uma foi descartada em silêncio).

import { realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, resolve, sep } from 'node:path';

export interface ResolvedWorkspaceRoots {
  readonly ok: true;
  /** Raízes ABSOLUTAS canonicalizadas, na ordem declarada, sem duplicata. */
  readonly roots: readonly string[];
}
export interface ResolvedWorkspaceRootsError {
  readonly ok: false;
  /** Motivo legível — inclui a entrada CRUA que falhou, p/ o dono corrigir o `.md`. */
  readonly reason: string;
}

export type ResolveServiceWorkspaceRootsResult =
  | ResolvedWorkspaceRoots
  | ResolvedWorkspaceRootsError;

/** `true` se `child` é `root` ou está contido nele (mesmo critério de `io/workspace.ts`). */
function isContainedOrEqual(root: string, child: string): boolean {
  return child === root || child.startsWith(root + sep);
}

/** `realpathSync` fail-safe — devolve `undefined` em vez de lançar (best-effort). */
function safeRealpath(p: string): string | undefined {
  try {
    return realpathSync(p);
  } catch {
    return undefined;
  }
}

/**
 * Resolve as raízes `workspace:` DECLARADAS (cru, de `ServiceManifest.workspaceRoots`)
 * contra `serviceDir`. `declared` ausente/vazio ⇒ `{ ok:true, roots:[] }`
 * (comportamento IDÊNTICO ao de hoje — nenhuma raiz extra, só a própria pasta).
 *
 * `aluyHome` é o `~/.aluy/` (o PISO que nenhuma raiz pode alcançar) — passado pelo
 * CALLER (não lido daqui via `homedir()` direto) para que `UserServicesStore` possa
 * injetar um `baseDir` de teste isolado (o mesmo mecanismo que já existe para o
 * resto do registry) e a suíte NUNCA precise tocar o `~/.aluy/` real da máquina.
 * `home` (p/ expandir "~"/"~/x" nas entradas declaradas) é separadamente
 * injetável — default `os.homedir()`.
 */
export function resolveServiceWorkspaceRoots(
  serviceDir: string,
  declared: readonly string[] | undefined,
  aluyHome: string,
  home: string = homedir(),
): ResolveServiceWorkspaceRootsResult {
  if (declared === undefined || declared.length === 0) return { ok: true, roots: [] };

  // O PISO é canonicalizado quando possível (segue symlink — mesma disciplina do
  // `resolveInside` de `io/workspace.ts`); se `aluyHome` ainda não existe no disco
  // (raro — implicaria nenhum serviço instalado), o valor CRU ainda serve de piso
  // textual (fail-safe: na dúvida, mais restritivo, nunca menos).
  const aluyHomeCanonical = safeRealpath(aluyHome) ?? aluyHome;

  const seen = new Set<string>();
  const roots: string[] = [];

  for (const raw of declared) {
    const expanded = raw === '~' ? home : raw.startsWith('~/') ? resolve(home, raw.slice(2)) : raw;
    const abs = isAbsolute(expanded) ? resolve(expanded) : resolve(serviceDir, expanded);

    let canonical: string;
    try {
      canonical = realpathSync(abs);
    } catch {
      return {
        ok: false,
        reason: `"workspace: ${raw}" — o diretório não existe (resolvido para "${abs}").`,
      };
    }

    let isDir = false;
    try {
      isDir = statSync(canonical).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) {
      return { ok: false, reason: `"workspace: ${raw}" — não é um diretório ("${canonical}").` };
    }

    if (isContainedOrEqual(aluyHomeCanonical, canonical)) {
      return {
        ok: false,
        reason:
          `"workspace: ${raw}" — cai dentro de "~/.aluy/" (config/journal do próprio agente); ` +
          `uma raiz de workspace nunca pode alcançar essa pasta, mesmo que o diretório exista.`,
      };
    }

    if (!seen.has(canonical)) {
      seen.add(canonical);
      roots.push(canonical);
    }
  }

  return { ok: true, roots };
}
