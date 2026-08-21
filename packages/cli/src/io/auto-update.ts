// Autoupdate: quando sai versão nova do @hiperplano/aluy-cli no npm, no MESMO CANAL
// (dist-tag) da instalação atual, instala sozinho em SEGUNDO PLANO e deixa pronta uma
// nota pro rodapé — "atualizado, reinicie para usar" — a partir da PRÓXIMA abertura
// (o processo já rodando não troca de binário debaixo de si: `readAutoUpdateNote`
// só acende quando a versão em disco é mais nova que a versão EM MEMÓRIA deste
// processo). Decisão do dono (não é opt-in por padrão): instala e avisa.
//
// Desenho gêmeo do update-notifier (io/update-check.ts): cache + refresh async,
// fail-soft, rate-limit de 1x/dia (só após um check BEM-SUCEDIDO — uma falha de rede
// não trava o próximo boot 24h, tenta de novo). A diferença é o que faz com a versão
// nova: em vez de só sugerir `npm i -g`, ELE roda o `npm install -g`.
//
// Salvaguardas — nenhuma é opcional:
//   1. MESMO CANAL — `shouldAutoUpdate` (core, puro) barra rc↔latest cruzado, mesmo
//      quando o semver "acharia" a outra mais nova (ADR: prerelease `rc` nunca pula
//      pra estável sozinho, nem o inverso).
//   2. SÓ QUANDO INSTALADO POR NPM — `isNpmGlobalInstall`: rodando de um checkout do
//      repo (dev) nunca tenta instalar por cima de si mesmo.
//   3. NUNCA TRAVA — timeout curto no fetch (`FETCH_TIMEOUT_MS`) e teto duro no spawn
//      do npm (`INSTALL_TIMEOUT_MS`, mata o processo se passar); qualquer erro (rede,
//      sem npm no PATH, sem permissão de escrita global) é SILÊNCIO, nunca lança,
//      nunca propaga pro caller (é fire-and-forget no boot, igual `refreshUpdateCheck`).
//   4. DESLIGÁVEL por config — `autoUpdateEnabled` recebe o valor JÁ RESOLVIDO da
//      chave de config (este módulo não lê `~/.aluy/config.json`; quem chama injeta o
//      valor). Precedência: kill-switches globais do update-notifier (`ALUY_NO_UPDATE_
//      CHECK=1` / `NO_UPDATE_NOTIFIER=1` / `CI=true`, matam TUDO) > `ALUY_AUTO_UPDATE`
//      (override explícito de env/serviço, `0`/`1`) > `configValue` (chave `autoUpdate`
//      de `~/.aluy/config.json`) > default `true` (ligado — decisão do dono). Quem roda
//      `aluy` como serviço 24/7 e não pode trocar de versão sozinho: `ALUY_AUTO_UPDATE=0`
//      no ambiente do serviço, ou `autoUpdate: false` salvo em config.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { distTagFor, isNewer, shouldAutoUpdate } from '@hiperplano/aluy-cli-core';

const PKG = '@hiperplano/aluy-cli';
const ALUY_DIR = join(homedir(), '.aluy');
const STATE_PATH = join(ALUY_DIR, 'auto-update.json');
const DAY_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 4_000;
const INSTALL_TIMEOUT_MS = 60_000;

type SpawnFn = typeof spawn;

interface AutoUpdateState {
  readonly lastCheck: number;
  /** Versão que um `npm install -g` de segundo plano deixou no disco — pode ser
   * MAIOR que a versão que ESTE processo (já carregada em memória) está rodando. */
  readonly installedOnDisk?: string;
}

/** Dependências injetáveis (teste: fakes puros, sem fs/rede/child_process reais). */
export interface AutoUpdateDeps {
  readonly scriptPath?: string;
  readonly realpath?: (p: string) => string;
  readonly fetch?: typeof fetch;
  readonly spawn?: SpawnFn;
}

function killSwitch(env: NodeJS.ProcessEnv): boolean {
  return (
    env['ALUY_NO_UPDATE_CHECK'] === '1' || env['NO_UPDATE_NOTIFIER'] === '1' || env['CI'] === 'true'
  );
}

/**
 * Autoupdate está LIGADO? Ver precedência no cabeçalho do arquivo. `configValue` é o
 * campo `autoUpdate` de `UserConfig`, já lido por quem chama — este módulo não faz
 * I/O de config (fronteira: quem monta `~/.aluy/config.json` é o `io/user-config.ts`).
 */
export function autoUpdateEnabled(env: NodeJS.ProcessEnv, configValue: boolean | undefined): boolean {
  if (killSwitch(env)) return false;
  const raw = env['ALUY_AUTO_UPDATE']?.trim().toLowerCase();
  if (raw === '0' || raw === 'false') return false;
  if (raw === '1' || raw === 'true') return true;
  return configValue ?? true;
}

/**
 * `true` se o script rodando é uma instalação por NPM (global ou local) do pacote —
 * o caminho REAL (resolvido, symlinks seguidos) passa por
 * `node_modules/@hiperplano/aluy-cli/`. Rodando de um CHECKOUT do repo (ex.: `node
 * packages/cli/dist/bin/aluy.js`) não bate esse padrão ⇒ `false`: o autoupdate NUNCA
 * tenta instalar por cima de um ambiente de desenvolvimento. Fail-soft: caminho
 * ausente/ilegível/symlink quebrado ⇒ `false` (postura conservadora — na dúvida, não
 * instala).
 */
export function isNpmGlobalInstall(
  scriptPath: string | undefined,
  realpath: (p: string) => string = realpathSync,
): boolean {
  if (!scriptPath) return false;
  try {
    const real = realpath(scriptPath).replace(/\\/g, '/');
    return real.includes(`/node_modules/${PKG}/`);
  } catch {
    return false;
  }
}

/** Monta o estado respeitando `exactOptionalPropertyTypes`: `installedOnDisk`
 * AUSENTE (não `undefined` explícito) quando não há versão instalada conhecida. */
function makeState(lastCheck: number, installedOnDisk?: string): AutoUpdateState {
  return installedOnDisk === undefined ? { lastCheck } : { lastCheck, installedOnDisk };
}

function readState(): AutoUpdateState | null {
  try {
    if (!existsSync(STATE_PATH)) return null;
    const s = JSON.parse(readFileSync(STATE_PATH, 'utf8')) as Partial<AutoUpdateState>;
    if (typeof s.lastCheck === 'number') {
      return makeState(s.lastCheck, typeof s.installedOnDisk === 'string' ? s.installedOnDisk : undefined);
    }
  } catch {
    // estado corrompido/ilegível ⇒ ignora (refaz o check depois)
  }
  return null;
}

function writeState(state: AutoUpdateState): void {
  try {
    mkdirSync(ALUY_DIR, { recursive: true });
    writeFileSync(STATE_PATH, JSON.stringify(state), { mode: 0o600 });
  } catch {
    // fail-soft — perder o cache só custa um check a mais no próximo boot
  }
}

/**
 * Nota pronta pro rodapé/StatusBar (mesmo formato de `readUpdateNote`: síncrona,
 * offline, `string | undefined`). Acende quando um `npm install -g` de segundo plano
 * JÁ TERMINOU e deixou no disco uma versão MAIS NOVA que a que ESTE processo (em
 * memória) está rodando — ou seja, a instalação já rodou, só falta reiniciar pra
 * valer. `undefined` quando não há o que avisar (nunca instalou, versão em disco é a
 * mesma que já está rodando, ou desligado pelos kill-switches globais).
 */
export function readAutoUpdateNote(running: string, env: NodeJS.ProcessEnv): string | undefined {
  if (killSwitch(env)) return undefined;
  const s = readState();
  if (s?.installedOnDisk && isNewer(s.installedOnDisk, running)) {
    return `atualizado para ${s.installedOnDisk} em segundo plano — reinicie para usar (esta sessão segue em ${running}).`;
  }
  return undefined;
}

/** Roda `npm install -g @pkg@candidate` com TETO DURO de tempo — mata o processo se
 * passar de `INSTALL_TIMEOUT_MS` (nunca deixa um `npm` pendurado). `true` só no exit
 * code 0; qualquer outro desfecho (timeout, exit≠0, ENOENT — sem npm no PATH, sem
 * permissão) devolve `false`, sem lançar. */
function installInBackground(candidate: string, spawnImpl: SpawnFn): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    let child: ReturnType<SpawnFn>;
    try {
      child = spawnImpl('npm', ['install', '-g', `${PKG}@${candidate}`], { stdio: 'ignore' });
    } catch {
      resolve(false);
      return;
    }
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try {
        child.kill();
      } catch {
        // já morto / sem permissão de sinal ⇒ segue
      }
      resolve(false);
    }, INSTALL_TIMEOUT_MS);
    child.once('error', () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(false); // ex.: ENOENT — sem npm no PATH
    });
    child.once('exit', (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
}

/**
 * Busca a versão publicada no npm sob o MESMO dist-tag da instalação atual (`rc`→
 * `rc`, estável→`latest` — `distTagFor`, core) e, se `shouldAutoUpdate` (core, mesmo
 * canal + estritamente mais nova) confirmar, dispara `npm install -g` em SEGUNDO
 * PLANO. Rate-limit: no máx. 1x/dia, mas SÓ após um check bem-sucedido (uma falha de
 * rede não bloqueia 24h — tenta de novo no próximo boot, igual `refreshUpdateCheck`).
 * FAIL-SOFT em CADA etapa: sem rede, sem npm, sem permissão ⇒ silêncio total, nunca
 * lança. Fire-and-forget no boot (`void runAutoUpdate(...)`), nunca aguardado.
 */
export async function runAutoUpdate(
  installed: string,
  env: NodeJS.ProcessEnv,
  configValue: boolean | undefined,
  deps: AutoUpdateDeps = {},
): Promise<void> {
  if (!autoUpdateEnabled(env, configValue)) return;

  const scriptPath = deps.scriptPath ?? process.argv[1];
  if (!isNpmGlobalInstall(scriptPath, deps.realpath)) return; // rodando do repo — nunca instala

  const prev = readState();
  if (prev && Date.now() - prev.lastCheck < DAY_MS) return; // check recente ⇒ nada a fazer ainda

  try {
    const tag = distTagFor(installed);
    const url = `https://registry.npmjs.org/${PKG.replace('/', '%2f')}/${tag}`;
    const fetchImpl = deps.fetch ?? fetch;
    const resp = await fetchImpl(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!resp.ok) return; // não bumpa o cache — tenta de novo no próximo boot

    const data = (await resp.json()) as { version?: unknown };
    const candidate = data.version;
    if (typeof candidate !== 'string') return;

    let installedOnDisk = prev?.installedOnDisk;
    if (shouldAutoUpdate(installed, candidate)) {
      const spawnImpl = deps.spawn ?? spawn;
      const ok = await installInBackground(candidate, spawnImpl);
      if (ok) installedOnDisk = candidate;
    }
    writeState(makeState(Date.now(), installedOnDisk));
  } catch {
    // offline / timeout / registry fora / npm ausente ⇒ silêncio total, sem bumpar o cache
  }
}
