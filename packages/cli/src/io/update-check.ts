// Update-notifier: avisa no boot quando há versão mais nova do @hiperplano/aluy-cli
// no npm. Padrão "cache + refresh async" (igual ao update-notifier do npm): o boot
// LÊ o cache (instantâneo, offline) e mostra a nota se o cache já viu uma versão mais
// nova; em paralelo, REFRESCA o cache (no máx. 1x/dia) com um fetch FAIL-SOFT ao
// registry — o resultado aparece no PRÓXIMO boot. Nunca trava nem depende de rede no
// caminho do boot. I/O concreto (fs/net) ⇒ vive no @hiperplano/aluy-cli, não no core.
//
// Off por env: ALUY_NO_UPDATE_CHECK=1, NO_UPDATE_NOTIFIER=1, ou CI=true.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isNewer } from '@hiperplano/aluy-cli-core';

const PKG = '@hiperplano/aluy-cli';
const ALUY_DIR = join(homedir(), '.aluy');
const CACHE = join(ALUY_DIR, 'update-check.json');
const DAY_MS = 24 * 60 * 60 * 1000;

interface UpdateCache {
  readonly lastCheck: number;
  readonly latest: string;
}

function disabled(env: NodeJS.ProcessEnv): boolean {
  return (
    env['ALUY_NO_UPDATE_CHECK'] === '1' ||
    env['NO_UPDATE_NOTIFIER'] === '1' ||
    env['CI'] === 'true'
  );
}

function readCache(): UpdateCache | null {
  try {
    if (!existsSync(CACHE)) return null;
    const c = JSON.parse(readFileSync(CACHE, 'utf8')) as Partial<UpdateCache>;
    if (typeof c.lastCheck === 'number' && typeof c.latest === 'string') {
      return { lastCheck: c.lastCheck, latest: c.latest };
    }
  } catch {
    // cache corrompido/ilegível ⇒ ignora (refresca depois)
  }
  return null;
}

/**
 * Nota de update a partir do CACHE (síncrono, offline). `undefined` quando não há o que
 * avisar (sem cache, versão atual já é a mais nova, ou desligado por env).
 */
export function readUpdateNote(
  installed: string,
  env: NodeJS.ProcessEnv,
): string | undefined {
  if (disabled(env)) return undefined;
  const c = readCache();
  if (c && isNewer(c.latest, installed)) {
    return `nova versão ${c.latest} disponível (você tem ${installed}) — atualize: npm i -g ${PKG}`;
  }
  return undefined;
}

/**
 * Refresca o cache (no máx. 1x/dia) com o `latest` do npm. ASYNC, FAIL-SOFT: erro de
 * rede / offline / parse ⇒ silêncio (não escreve, não lança). Fire-and-forget no boot.
 */
export async function refreshUpdateCheck(
  installed: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  void installed; // (mantido p/ simetria de assinatura / futuro tracking)
  if (disabled(env)) return;
  const c = readCache();
  if (c && Date.now() - c.lastCheck < DAY_MS) return; // ainda fresco
  try {
    const url = `https://registry.npmjs.org/${PKG.replace('/', '%2f')}/latest`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(4000) });
    if (!resp.ok) return;
    const data = (await resp.json()) as { version?: unknown };
    const latest = data.version;
    if (typeof latest !== 'string') return;
    mkdirSync(ALUY_DIR, { recursive: true });
    writeFileSync(
      CACHE,
      JSON.stringify({ lastCheck: Date.now(), latest } satisfies UpdateCache),
      { mode: 0o600 },
    );
  } catch {
    // offline / timeout / erro ⇒ silêncio (o boot nunca depende disto)
  }
}
