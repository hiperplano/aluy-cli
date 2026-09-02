// Autoupdate: quando sai versão nova do @hiperplano/aluy-cli no npm, no MESMO CANAL
// da instalação atual, instala sozinho em SEGUNDO PLANO e deixa pronta uma
// nota pro rodapé — "atualizado, reinicie para usar" — a partir da PRÓXIMA abertura
// (o processo já rodando não troca de binário debaixo de si: `readAutoUpdateNote`
// só acende quando a versão em disco é mais nova que a versão EM MEMÓRIA deste
// processo). Decisão do dono (não é opt-in por padrão): instala e avisa.
//
// Desenho gêmeo do update-notifier (io/update-check.ts): cache + refresh async,
// fail-soft, rate-limit por janela (`CHECK_EVERY_MS`, hoje 15 min) e só após um check
// BEM-SUCEDIDO — uma falha de rede não consome a janela, tenta de novo. A diferença é o
// que faz com a versão nova: em vez de só sugerir `npm i -g`, ELE roda o `npm install -g`.
//
// LIMITE CONHECIDO (não consertado aqui): `runAutoUpdate` só é chamado UMA vez, no boot
// (`session/run.tsx`). A janela de 15 min é um rate-limit ENTRE aberturas, não um timer:
// uma sessão que fica aberta por dias checa uma única vez e nunca mais. Medido em
// 01/09: duas sessões do dono no ar desde 20/08 e 24/08, sem kill-switch, sem um segundo
// check. Fechar isso pede um intervalo na sessão — mexe em `run.tsx`, fora do escopo
// desta correção.
//
// ACHADO REAL (rc.159) — o dono relatou "me parece que o autoupdate não funcionou".
// Não era falso alarme: este módulo perguntava ao registry pela dist-tag com o NOME do
// canal instalado (`1.0.0-rc.159` → `GET /<pkg>/rc`). No dia do relato o registry tinha
// `{ rc: "1.0.0-rc.139", latest: "1.0.0-rc.156" }` — o topo REAL do canal rc (rc.156)
// estava na tag `latest` e a tag `rc` ficara 17 versões para trás (o workflow de release,
// que é quem publica com `--tag rc`, falha desde a rc.139; de lá pra cá as versões saíram
// por fora dele e só o `latest` andou). Quem instalava pelo caminho documentado
// (`npm i -g`, que entrega o `latest` = rc.156) consultava a tag `rc`, recebia rc.139
// (mais VELHA) e nunca atualizava; quem estivesse em rc.130 "atualizava" p/ rc.139 e
// congelava ali para sempre. Zero erro, zero aviso.
// Agora buscamos o MAPA INTEIRO de dist-tags (`/-/package/<pkg>/dist-tags`, um GET
// minúsculo) e o core escolhe entre TODAS as versões promovidas — o canal é propriedade
// da VERSÃO (identificador de prerelease), nunca do nome da tag.
//
// Salvaguardas — nenhuma é opcional:
//   1. MESMO CANAL — `pickAutoUpdateCandidate`/`shouldAutoUpdate` (core, puros) barram
//      rc↔latest cruzado, mesmo quando o semver "acharia" a outra mais nova (ADR:
//      prerelease `rc` nunca pula pra estável sozinho, nem o inverso). Olhar todas as
//      tags NÃO afrouxa isso: o filtro de canal continua sendo por versão.
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
//   5. O DESFECHO FICA REGISTRADO — o silêncio total do item 3 é a postura certa para
//      não travar o boot, mas era também o que impedia o dono de distinguir "checou e
//      não havia nada" de "tentou e falhou": as duas coisas escreviam o mesmo
//      `lastCheck` mudo. Agora o ciclo grava `lastOutcome`/`latestSeen` e, quando a
//      INSTALAÇÃO falha (o caso acionável), `readAutoUpdateNote` avisa no rodapé com o
//      comando para rodar à mão. Registry fora do ar segue mudo — é transitório.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isNewer, newestInChannel, pickAutoUpdateCandidate } from '@hiperplano/aluy-cli-core';

const PKG = '@hiperplano/aluy-cli';
const ALUY_DIR = join(homedir(), '.aluy');
/** Nome do arquivo de estado — separado p/ compor com o dir INJETÁVEL (ver `aluyDir`). */
const STATE_FILE = 'auto-update.json';
const STATE_PATH = join(ALUY_DIR, STATE_FILE);
// INTERVALO ENTRE CHECAGENS — 15 min, por decisão do dono ("ele deveria checar a cada
// 15 minutos").
//
// Era 24h, herdado do update-notifier — onde faz sentido, porque lá o custo de avisar
// tarde é uma sugestão desatualizada. Aqui o custo é outro: num único dia saíram QUATRO
// versões, cada uma corrigindo algo que o dono acabara de reportar, e com a janela de 24h
// ele não receberia nenhuma sozinho — checaria uma vez no meio do dia e dormiria até o
// dia seguinte. Foi exatamente o que ele viu ("não estou vendo o autoupdate funcionar"),
// com tudo ligado e funcionando.
//
// Barato: um GET no registro do npm, timeout de 4s, fail-soft, só na abertura do
// processo. `ALUY_AUTO_UPDATE_EVERY_MS` ajusta (piso de 1 min, p/ um valor absurdo em
// config não virar martelo no registro).
const CHECK_EVERY_MS = 15 * 60 * 1000;
const FETCH_TIMEOUT_MS = 4_000;
const INSTALL_TIMEOUT_MS = 60_000;

type SpawnFn = typeof spawn;

/**
 * O que o ÚLTIMO ciclo de autoupdate fez. Existe por causa do relato do dono ("me
 * parece que o autoupdate não funcionou"): antes disto, "checou e não havia nada mais
 * novo" e "tentou e falhou" produziam EXATAMENTE a mesma coisa no disco — um
 * `lastCheck` mudo — e não havia como o dono (nem eu) distinguir os dois sem ler o
 * código. Silêncio ambíguo é defeito, mesmo quando a lógica está certa.
 */
export type AutoUpdateOutcome =
  | 'sem-novidade' // checou o registry; nada mais novo no canal — nada a fazer
  | 'instalado' // achou versão nova e o `npm install -g` completou
  | 'instalacao-falhou'; // achou versão nova e o `npm install -g` NÃO completou

interface AutoUpdateState {
  readonly lastCheck: number;
  /** Versão que um `npm install -g` de segundo plano deixou no disco — pode ser
   * MAIOR que a versão que ESTE processo (já carregada em memória) está rodando. */
  readonly installedOnDisk?: string;
  /** Desfecho do último ciclo (ver `AutoUpdateOutcome`). */
  readonly lastOutcome?: AutoUpdateOutcome;
  /** A mais nova versão PUBLICADA no canal da instalação, vista no último check —
   * inclusive quando é mais velha que a instalada (é o dado que responde "o npm
   * simplesmente não tem nada mais novo pra mim?"). */
  readonly latestSeen?: string;
  /** A versão cuja instalação falhou — o rodapé usa p/ dizer o que tentar à mão. */
  readonly failedVersion?: string;
}

/** Leitura crua do estado, p/ diagnóstico (`/doctor`, suporte). Nunca lança. */
export function readAutoUpdateStatus(): {
  readonly lastCheck: number;
  readonly lastOutcome?: AutoUpdateOutcome;
  readonly latestSeen?: string;
  readonly installedOnDisk?: string;
  readonly failedVersion?: string;
} | null {
  return readState();
}

/** Dependências injetáveis (teste: fakes puros, sem fs/rede/child_process reais). */
export interface AutoUpdateDeps {
  readonly scriptPath?: string;
  readonly realpath?: (p: string) => string;
  readonly fetch?: typeof fetch;
  readonly spawn?: SpawnFn;
  /**
   * Chamado quando a instalação em segundo plano TERMINA COM SUCESSO, ainda DENTRO da
   * sessão. Sem isto o sucesso é MUDO de ponta a ponta, e foi o que o dono viu em 01/09:
   * "tenho uma máquina na versão 158 e nada de mostrar a atualização".
   *
   * A nota do boot (`readAutoUpdateNote`) NÃO cobre este caso, e vale entender por quê:
   * ela é lida ANTES do `runAutoUpdate` da MESMA abertura, então no boot em que a
   * instalação acontece o estado ainda não existe; e no boot SEGUINTE o binário novo já
   * está rodando, logo `installedOnDisk` deixa de ser "mais novo que o rodando" e a nota
   * não dispara. Resultado: só a FALHA aparecia; o SUCESSO, nunca.
   */
  readonly aoInstalar?: (versao: string) => void;
  /**
   * Raiz do `~/.aluy/` — INJETÁVEL PARA TESTE, e não é conveniência: sem ela, a única
   * forma de isolar era dublar `homedir` do `node:os`, e esse dublê vale só para o grafo
   * de módulos do arquivo que o declara. Quando OUTRO teste do mesmo worker já carregou
   * este módulo, o dublê não se aplica — e o teste passa a ler (e poder ESCREVER) o
   * `~/.aluy/auto-update.json` REAL de quem roda a suíte.
   *
   * Foi medido em 02/09: o caso passava isolado e falhava junto dos vizinhos, porque caía
   * no estado real (com `lastCheck` recente ⇒ retorno antecipado). Um caminho injetável
   * remove a classe inteira — mesma disciplina do `baseDir` do TodoStore e do `vaultPath`
   * do cofre, ambos adotados depois de dano equivalente.
   */
  readonly aluyDir?: string;
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
export function autoUpdateEnabled(
  env: NodeJS.ProcessEnv,
  configValue: boolean | undefined,
): boolean {
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

/** Campos opcionais do estado — separados p/ `makeState` respeitar
 * `exactOptionalPropertyTypes` (chave AUSENTE, nunca `undefined` explícito). */
interface AutoUpdateExtras {
  readonly installedOnDisk?: string | undefined;
  readonly lastOutcome?: AutoUpdateOutcome | undefined;
  readonly latestSeen?: string | undefined;
  readonly failedVersion?: string | undefined;
}

/** Monta o estado omitindo cada campo opcional que não tem valor. */
function makeState(lastCheck: number, extras: AutoUpdateExtras = {}): AutoUpdateState {
  return {
    lastCheck,
    ...(extras.installedOnDisk === undefined ? {} : { installedOnDisk: extras.installedOnDisk }),
    ...(extras.lastOutcome === undefined ? {} : { lastOutcome: extras.lastOutcome }),
    ...(extras.latestSeen === undefined ? {} : { latestSeen: extras.latestSeen }),
    ...(extras.failedVersion === undefined ? {} : { failedVersion: extras.failedVersion }),
  };
}

const OUTCOMES: readonly string[] = ['sem-novidade', 'instalado', 'instalacao-falhou'];

function readState(dir?: string): AutoUpdateState | null {
  const alvo = dir !== undefined ? join(dir, STATE_FILE) : STATE_PATH;
  try {
    if (!existsSync(alvo)) return null;
    const s = JSON.parse(readFileSync(alvo, 'utf8')) as Partial<AutoUpdateState>;
    if (typeof s.lastCheck === 'number') {
      return makeState(s.lastCheck, {
        installedOnDisk: typeof s.installedOnDisk === 'string' ? s.installedOnDisk : undefined,
        // Estado escrito por uma versão ANTERIOR não tem `lastOutcome`, e um valor
        // desconhecido (versão futura) não pode virar nota — só aceita o que este
        // binário sabe interpretar.
        lastOutcome:
          typeof s.lastOutcome === 'string' && OUTCOMES.includes(s.lastOutcome)
            ? s.lastOutcome
            : undefined,
        latestSeen: typeof s.latestSeen === 'string' ? s.latestSeen : undefined,
        failedVersion: typeof s.failedVersion === 'string' ? s.failedVersion : undefined,
      });
    }
  } catch {
    // estado corrompido/ilegível ⇒ ignora (refaz o check depois)
  }
  return null;
}

function writeState(state: AutoUpdateState, dir?: string): void {
  try {
    const raiz = dir ?? ALUY_DIR;
    mkdirSync(raiz, { recursive: true });
    writeFileSync(join(raiz, STATE_FILE), JSON.stringify(state), { mode: 0o600 });
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
  // FALHA DE INSTALAÇÃO É VISÍVEL. O dono disse "me parece que o autoupdate não
  // funcionou" — e não tinha como saber, porque um `npm install -g` que morre (npm fora
  // do PATH, prefixo global sem permissão de escrita, timeout) era engolido igual a
  // "não havia nada novo". Aqui a diferença aparece: só o que é ACIONÁVEL vira nota.
  // Registry fora do ar continua MUDO de propósito — é transitório, o próximo boot
  // tenta de novo, e encher o rodapé de "não consegui falar com o npm" a cada blip de
  // rede treinaria o dono a ignorar o lugar onde a nota de verdade aparece.
  if (
    s?.lastOutcome === 'instalacao-falhou' &&
    s.failedVersion !== undefined &&
    isNewer(s.failedVersion, running)
  ) {
    return `a atualização automática para ${s.failedVersion} FALHOU (o \`npm install -g\` não completou) — atualize à mão: npm i -g ${PKG}@${s.failedVersion}`;
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
      // `cwd: homedir()` NÃO é detalhe: o npm lê `.npmrc` a partir do CWD e o
      // ./.npmrc do PROJETO tem precedência SOBRE o ~/.npmrc do usuário. O aluy roda
      // dentro do projeto do usuário, então herdar esse CWD deixa qualquer
      // `.npmrc` de repositório sequestrar o `prefix` e o `registry` do install
      // GLOBAL. Medido nesta máquina: dentro de um dir com `.npmrc`, `npm config get
      // prefix` devolve o do projeto; a partir do HOME devolve `/home/aluy/.aluy-npm`,
      // que é o prefixo real da instalação. Instalação global não tem nada a ver com o
      // diretório em que o agente por acaso foi aberto — daí o HOME.
      child = spawnImpl('npm', ['install', '-g', `${PKG}@${candidate}`], {
        stdio: 'ignore',
        cwd: homedir(),
      });
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
 * Busca TODAS as versões promovidas pelo npm (o mapa de dist-tags) e, se
 * `pickAutoUpdateCandidate` (core: mesmo canal da VERSÃO + estritamente mais nova)
 * apontar uma, dispara `npm install -g` em SEGUNDO PLANO. Grava o DESFECHO do ciclo no
 * estado — "checou e não havia nada" deixou de ser indistinguível de "tentou e falhou"
 * (era exatamente a dúvida do dono). Rate-limit: 1x a cada `CHECK_EVERY_MS`, mas SÓ
 * após um check bem-sucedido — uma falha de rede não consome a janela, tenta de novo no
 * próximo boot (mesma disciplina do `refreshUpdateCheck`).
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

  const prev = readState(deps.aluyDir);
  const intervaloMs = ((): number => {
    const bruto = Number.parseInt(env.ALUY_AUTO_UPDATE_EVERY_MS ?? '', 10);
    return Number.isFinite(bruto) && bruto >= 60_000 ? bruto : CHECK_EVERY_MS;
  })();
  if (prev && Date.now() - prev.lastCheck < intervaloMs) return; // checado há pouco

  try {
    // MAPA INTEIRO de dist-tags, não uma tag só (ver o achado da rc.159 no cabeçalho):
    // o nome da tag é convenção de publicação e pode ficar para trás; o canal é
    // propriedade da versão. Endpoint minúsculo (um objeto `{tag: versão}`), mesmo
    // custo de rede da consulta anterior.
    const url = `https://registry.npmjs.org/-/package/${PKG.replace('/', '%2f')}/dist-tags`;
    const fetchImpl = deps.fetch ?? fetch;
    const resp = await fetchImpl(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!resp.ok) return; // não bumpa o cache — tenta de novo no próximo boot

    const data = (await resp.json()) as Record<string, unknown>;
    const promovidas = Object.values(data ?? {}).filter((v): v is string => typeof v === 'string');
    if (promovidas.length === 0) return;

    // `latestSeen` é o mais novo do canal MESMO quando não serve (é o que responde
    // "o npm tem algo pra mim?" sem precisar ler código); `candidate` é o subconjunto
    // que o core aprova de fato instalar.
    const latestSeen = newestInChannel(installed, promovidas) ?? undefined;
    const candidate = pickAutoUpdateCandidate(installed, promovidas);

    let installedOnDisk = prev?.installedOnDisk;
    let outcome: AutoUpdateOutcome = 'sem-novidade';
    let failedVersion: string | undefined;
    if (candidate !== null) {
      const spawnImpl = deps.spawn ?? spawn;
      const ok = await installInBackground(candidate, spawnImpl);
      if (ok) {
        installedOnDisk = candidate;
        outcome = 'instalado';
        // AVISA JÁ, nesta sessão — ver `aoInstalar`: a nota do boot nunca cobre o sucesso.
        deps.aoInstalar?.(candidate);
      } else {
        outcome = 'instalacao-falhou';
        failedVersion = candidate;
      }
    }
    writeState(
      makeState(Date.now(), { installedOnDisk, lastOutcome: outcome, latestSeen, failedVersion }),
      deps.aluyDir,
    );
  } catch {
    // offline / timeout / registry fora / npm ausente ⇒ silêncio total, sem bumpar o cache
  }
}
