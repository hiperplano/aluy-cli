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
  const pre = m[4] ? m[4].split('.').map((id) => (/^\d+$/.test(id) ? Number(id) : id)) : [];
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

// ── Autoupdate: dist-tag + decisão ──────────────────────────────────────────
// O pacote sai como prerelease `rc` (`1.0.0-rc.138`) OU estável (`1.0.0`), publicados
// no npm sob dist-tags DISTINTAS (`rc` / `latest`). SemVer puro não conhece canal:
// `isNewer('1.0.0', '1.0.0-rc.138')` dá `true` (estável > prerelease pela regra §11),
// mas uma instalação `rc` NUNCA deve saltar sozinha p/ `latest` estável nem o
// contrário — só quem decide isso é o dono, trocando de canal manualmente. Por isso
// a decisão de autoupdate não é só "isNewer": tem que ser MESMO CANAL.

/** Dist-tag do npm correspondente a esta versão: `'latest'` se estável (sem
 * prerelease), senão o PRIMEIRO identificador do prerelease (`'1.0.0-rc.138'` →
 * `'rc'`) — é assim que o `gen-version`/publish nomeia a tag no registry. Versão
 * ilegível ⇒ `'latest'` (mesmo default conservador do resto do módulo). */
export function distTagFor(version: string): string {
  const p = parseVersion(version);
  if (!p || p.pre.length === 0) return 'latest';
  const first = p.pre[0];
  return String(first);
}

/**
 * Decide se o autoupdate deve baixar `candidate` por cima de `installed`. Precisa
 * ser MAIS NOVA (nunca downgrade, nunca "igual") E do MESMO dist-tag — `rc` só
 * atualiza p/ `rc` mais novo, `latest` só p/ `latest` mais novo; um `rc` nunca pula
 * p/ `latest` estável nem o inverso, mesmo que `isNewer` diga que sim (semver não
 * conhece canal). Versão ilegível em qualquer lado ⇒ `false` (nunca instala às cegas).
 */
export function shouldAutoUpdate(installed: string, candidate: string): boolean {
  if (!parseVersion(installed) || !parseVersion(candidate)) return false;
  if (distTagFor(installed) !== distTagFor(candidate)) return false;
  return isNewer(candidate, installed);
}

// ── Achado real (rc.159): o NOME da dist-tag não é o canal ──────────────────
// O dono relatou "me parece que o autoupdate não funcionou". A lógica de decisão
// (`shouldAutoUpdate`) estava certa; quem estava errado era a DESCOBERTA do candidato:
// o autoupdate perguntava ao registry só pela tag com o NOME do canal instalado
// (`1.0.0-rc.159` → tag `rc`). Só que o registry tinha, no dia:
//
//     dist-tags = { rc: "1.0.0-rc.139", latest: "1.0.0-rc.156" }
//
// O topo REAL do canal rc (rc.156) morava na tag `latest` e a tag `rc` ficara 17
// versões para trás. Por quê (verificado no histórico de releases): o workflow de
// release falha desde a rc.139 — é ele quem publica com `--tag rc` — e de lá pra cá as
// versões saíram POR FORA dele, indo parar só no `latest`. Consequência: quem instalava
// pelo caminho documentado (`npm i -g`, que entrega o `latest`, ou seja rc.156)
// consultava a tag `rc`, recebia rc.139 — MAIS VELHA — e nunca atualizava; quem estava
// atrás subia só até rc.139 e congelava ali. Morto para todo mundo, sem nenhum erro.
//
// A lição: o nome da tag é convenção de PUBLICAÇÃO e pode ficar para trás; o CANAL é
// propriedade da VERSÃO (o identificador de prerelease). Por isso as funções abaixo
// recebem TODAS as versões promovidas pelo registry e deixam `shouldAutoUpdate` —
// que compara canal por versão, nunca por nome de tag — dizer quais valem.

/**
 * A versão mais NOVA de `published` que está no MESMO canal de `installed` — mesmo
 * que seja igual ou mais velha que a instalada (serve p/ diagnóstico: "o mais novo
 * publicado no seu canal é X"). `null` quando nenhuma é do canal (ou nada parseia).
 */
export function newestInChannel(installed: string, published: readonly string[]): string | null {
  const canal = parseVersion(installed) ? distTagFor(installed) : null;
  if (canal === null) return null;
  let melhor: string | null = null;
  for (const v of published) {
    if (!parseVersion(v) || distTagFor(v) !== canal) continue;
    if (melhor === null || compareVersions(v, melhor) === 1) melhor = v;
  }
  return melhor;
}

/**
 * O que o autoupdate deve instalar por cima de `installed`, dadas TODAS as versões que
 * o registry promoveu (os alvos de todas as dist-tags). É a mais nova do mesmo canal,
 * e só se `shouldAutoUpdate` a aprovar (estritamente mais nova, nunca downgrade, nunca
 * cruzando canal). `null` = nada a fazer.
 */
export function pickAutoUpdateCandidate(
  installed: string,
  published: readonly string[],
): string | null {
  const alvo = newestInChannel(installed, published);
  return alvo !== null && shouldAutoUpdate(installed, alvo) ? alvo : null;
}
