// Compare de versões SemVer (mínimo, sem dependência) — base do update-notifier.
// PORTÁVEL: lógica pura de string/número, sem I/O. O fetch ao registry + cache vivem
// no @hiperplano/aluy-cli (locus concreto).
//
// Regras SemVer (semver.org §11): compara major.minor.patch numérico; em empate, uma
// versão SEM prerelease > COM prerelease; entre prereleases, compara identificador a
// identificador (numéricos por valor; alfanuméricos por ASCII; numérico < alfanumérico;
// o conjunto mais CURTO perde no empate de prefixo — `1.0.0-rc` < `1.0.0-rc.1`).

export interface ParsedVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly pre: readonly (string | number)[];
}

/** Parseia `M.m.p[-pre]` (ignora build-metadata `+...`). `null` se não casar. */
export function parseVersion(v: string): ParsedVersion | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(v.trim());
  if (!m) return null;
  const pre = m[4]
    ? m[4].split('.').map((id) => (/^\d+$/.test(id) ? Number(id) : id))
    : [];
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre };
}

/** -1 se a<b, 0 se a=b, 1 se a>b. `null` se algum não parseia. */
export function compareVersions(a: string, b: string): number | null {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return null;
  for (const k of ['major', 'minor', 'patch'] as const) {
    if (pa[k] !== pb[k]) return pa[k] < pb[k] ? -1 : 1;
  }
  if (pa.pre.length === 0 && pb.pre.length === 0) return 0;
  if (pa.pre.length === 0) return 1; // estável > prerelease
  if (pb.pre.length === 0) return -1;
  const n = Math.max(pa.pre.length, pb.pre.length);
  for (let i = 0; i < n; i++) {
    const x = pa.pre[i];
    const y = pb.pre[i];
    if (x === undefined) return -1; // conjunto mais curto perde
    if (y === undefined) return 1;
    if (x === y) continue;
    const xNum = typeof x === 'number';
    const yNum = typeof y === 'number';
    if (xNum && yNum) return (x as number) < (y as number) ? -1 : 1;
    if (xNum) return -1; // numérico < alfanumérico
    if (yNum) return 1;
    return (x as string) < (y as string) ? -1 : 1;
  }
  return 0;
}

/** `candidate` é ESTRITAMENTE mais novo que `current`? Falso se algum não parseia. */
export function isNewer(candidate: string, current: string): boolean {
  return compareVersions(candidate, current) === 1;
}
