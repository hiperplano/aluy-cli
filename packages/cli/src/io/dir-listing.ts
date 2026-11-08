// Listagem ASSÍNCRONA de subpastas para o seletor do `/add-dir` (só leitura, sem efeito).
//
// Vive em `packages/cli` de propósito: o cli-core não toca o disco (teste de fronteira).
// Nada aqui decide permissão — quem autoriza a pasta é `workspace.addRoot`, via o mesmo
// `/add-dir <path>` digitado. Isto só ENUMERA o que o usuário pode escolher.
//
// Garantias:
//  - assíncrono (fs/promises): não bloqueia o render;
//  - só diretórios, ordenados (sem diferenciar maiúsculas), ocultos fora por padrão;
//  - teto por listagem (`DIR_LISTING_CAP`), com o excedente contado em `overflow`;
//  - pasta ilegível NÃO derruba: vira `unreadable` (entrada) ou `error: 'denied'` (listagem);
//  - symlink: o destino é resolvido (realpath) — laço (ELOOP), quebrado ou apontando p/ arquivo
//    some da lista; o caminho devolvido é o REAL, então um laço nunca gera caminho infinito.

import { access, readdir, realpath, stat, constants } from 'node:fs/promises';
import { join } from 'node:path';

export const DIR_LISTING_CAP = 500;

export interface DirEntryInfo {
  readonly name: string;
  /** Caminho absoluto canônico (symlink já resolvido). */
  readonly path: string;
  /** Não dá para listar/entrar (sem permissão de leitura/execução). */
  readonly unreadable: boolean;
}

export interface DirListing {
  readonly path: string;
  readonly entries: readonly DirEntryInfo[];
  /** Quantas pastas passaram do teto e não estão em `entries`. */
  readonly overflow: number;
  /** `denied` = sem permissão para ler esta pasta; `missing` = não existe / não é pasta. */
  readonly error?: 'denied' | 'missing';
}

export interface ListSubdirsOptions {
  readonly showHidden?: boolean;
  readonly cap?: number;
}

const byName = (a: string, b: string): number =>
  a.toLowerCase().localeCompare(b.toLowerCase()) || (a < b ? -1 : a > b ? 1 : 0);

export async function listSubdirs(dir: string, opts: ListSubdirsOptions = {}): Promise<DirListing> {
  const cap = opts.cap ?? DIR_LISTING_CAP;
  let dirents;
  try {
    dirents = await readdir(dir, { withFileTypes: true });
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return {
      path: dir,
      entries: [],
      overflow: 0,
      error: code === 'EACCES' || code === 'EPERM' ? 'denied' : 'missing',
    };
  }
  const candidates = dirents
    .filter((d) => opts.showHidden === true || !d.name.startsWith('.'))
    .filter((d) => d.isDirectory() || d.isSymbolicLink())
    .map((d) => ({ name: d.name, link: d.isSymbolicLink() }))
    .sort((a, b) => byName(a.name, b.name));
  const resolved: DirEntryInfo[] = [];
  let overflow = 0;
  for (const c of candidates) {
    // Já passou do teto: só conta (symlinks não são verificados — evita I/O inútil).
    if (resolved.length >= cap) {
      overflow++;
      continue;
    }
    const full = join(dir, c.name);
    let path = full;
    if (c.link) {
      try {
        path = await realpath(full);
        if (!(await stat(path)).isDirectory()) continue;
      } catch {
        continue; // laço (ELOOP), quebrado ou sem acesso ao alvo
      }
    }
    const unreadable = await access(path, constants.R_OK | constants.X_OK).then(
      () => false,
      () => true,
    );
    resolved.push({ name: c.name, path, unreadable });
  }
  return { path: dir, entries: resolved, overflow };
}

/** Resolve `target` para um diretório existente canônico, ou `null`. Nunca lança. */
export async function resolveDir(target: string): Promise<string | null> {
  try {
    const real = await realpath(target);
    return (await stat(real)).isDirectory() ? real : null;
  } catch {
    return null;
  }
}
