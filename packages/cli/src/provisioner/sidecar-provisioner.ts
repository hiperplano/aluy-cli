// EST-1133 · ADR-0123 §2.2-ter — PROVISIONADOR DE SIDECARS (implementação concreta).
//
// Implementa `SidecarProvisioner` do `@hiperplano/aluy-cli-core`. Faz I/O real:
// download, verificação de hash, extração, venv, pull de modelos.
// Roda no `@hiperplano/aluy-cli` (locus concreto com fs/child_process/net).
//
// Travas DURAS (G2 + CLI-SEC-H2):
//   - Proveniência/integridade: hash PINADO. Recusa se não bater.
//   - user-space, RECUSA root. Destino ~/.aluy/ perms 0700/0600.
//   - Passo EXPLÍCITO (nunca download no boot).
//   - Idempotente (re-rodar não reinstala à toa).
//   - Degradável (falha ⇒ piso heurístico / LEVE efetivo, não trava).

import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  chmodSync,
  writeFileSync,
  readFileSync,
  rmSync,
  copyFileSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir, userInfo } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  type SidecarProvisioner,
  type SidecarTarget,
  type ProvisionTargetResult,
  type ProvisionResult,
  type AgentProfileTier,
  type PinnedArtifact,
  OLLAMA_VERSION,
  OLLAMA_BINARY_SHA256,
  OLLAMA_BINARY_URL,
  OLLAMA_ASSET_NAME,
  OLLAMA_INSTALL_DIR,
  MEM0_VENV_DIR,
  MEM0_MIN_PYTHON,
  MEM0_PIP_PACKAGES,
  HEADROOM_VENV_DIR,
  HEADROOM_PIP_PACKAGES,
  HEADROOM_LOOPBACK_PORT,
  JUDGE_MODEL,
  QWEN_JUDGE_MODEL_DIGEST,
  EMBEDDER_MODEL,
  NOMIC_EMBEDDER_MODEL_DIGEST,
  OLLAMA_PULL_TIMEOUT_MS,
  OLLAMA_LOOPBACK_HOST,
  OLLAMA_LOOPBACK_PORT,
  verifySha256,
  isRoot,
  shouldProvision,
  resolveSidecarToggles,
} from '@hiperplano/aluy-cli-core';

// ─── Constantes ────────────────────────────────────────────────────────────

const ALUY_DIR = '.aluy';
const DIR_PERMS = 0o700;
const FILE_PERMS = 0o600;

// ─── Helpers puros ─────────────────────────────────────────────────────────

/** Caminho absoluto de ~/.aluy. */
function aluyDir(): string {
  return join(homedir(), ALUY_DIR);
}

/** Garante ~/.aluy/ com perms 0700. Idempotente. */
function ensureAluyDir(): string {
  const dir = aluyDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { mode: DIR_PERMS, recursive: true });
  }
  // Reaplicar perms mesmo se já existir (defesa contra umask/upgrade).
  try {
    chmodSync(dir, DIR_PERMS);
  } catch {
    // best-effort; se falhar, o provisionamento individual pode falhar depois
  }
  return dir;
}

/** Garante um subdiretório de ~/.aluy/ com perms 0700. */
function ensureSubdir(subdir: string): string {
  const parent = ensureAluyDir();
  const dir = join(parent, subdir);
  if (!existsSync(dir)) {
    mkdirSync(dir, { mode: DIR_PERMS });
  }
  try {
    chmodSync(dir, DIR_PERMS);
  } catch {
    // best-effort
  }
  return dir;
}

/** Computa SHA256 de um buffer. */
function sha256Buffer(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

// ─── Helpers de sistema ────────────────────────────────────────────────────

/** Verifica se python3 está disponível e >= MEM0_MIN_PYTHON. */
function checkPython(): { ok: boolean; version: string } {
  try {
    const r = spawnSync('python3', ['--version'], {
      encoding: 'utf8',
      timeout: 15_000,
    });
    const out = (r.stdout || '').trim() || (r.stderr || '').trim();
    // "Python 3.10.12"
    const m = out.match(/Python\s+(\d+)\.(\d+)/);
    if (!m) return { ok: false, version: out || 'desconhecido' };
    const major = parseInt(m[1], 10);
    const minor = parseInt(m[2], 10);
    const ok = major === 3 && minor >= 10;
    return { ok, version: `${major}.${minor}` };
  } catch {
    return { ok: false, version: 'não encontrado' };
  }
}

/** Verifica se zstd está disponível (p/ extrair .tar.zst). */
function checkZstd(): boolean {
  try {
    const r = spawnSync('zstd', ['--version'], { timeout: 10_000 });
    return r.status === 0;
  } catch {
    return false;
  }
}

/** Verifica se tar está disponível. */
function checkTar(): boolean {
  try {
    const r = spawnSync('tar', ['--version'], { timeout: 10_000 });
    return r.status === 0;
  } catch {
    return false;
  }
}

/** Verifica se pip está disponível. */
function checkPip(pythonPath: string): boolean {
  try {
    const r = spawnSync(pythonPath, ['-m', 'pip', '--version'], {
      timeout: 15_000,
    });
    return r.status === 0;
  } catch {
    return false;
  }
}

// ─── Download com verificação ──────────────────────────────────────────────

/**
 * Baixa um artefato, verifica o hash e salva. Retorna o caminho do arquivo salvo.
 * LANÇA se o hash não bater (CLI-SEC-H2).
 */
/** Lê o corpo da resposta STREAMANDO, com progresso no stderr. Fallback p/
 * `arrayBuffer()` quando nao ha body streamavel (mocks de teste). */
async function readBodyWithProgress(resp: Response, label: string): Promise<Buffer> {
  const body = resp.body as ReadableStream<Uint8Array> | null | undefined;
  if (!body || typeof body.getReader !== 'function') {
    return Buffer.from(await resp.arrayBuffer());
  }
  const total = Number(resp.headers?.get?.('content-length') ?? 0);
  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let received = 0;
  let lastPct = -1;
  const tty = Boolean(process.stderr.isTTY);
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    chunks.push(Buffer.from(value));
    received += value.length;
    const mb = (received / 1e6).toFixed(1);
    if (total > 0) {
      const pct = Math.floor((received / total) * 100);
      if (pct !== lastPct) {
        lastPct = pct;
        const tot = (total / 1e6).toFixed(1);
        process.stderr.write(`${tty ? '\r' : ''}  baixando ${label}... ${pct}% (${mb}/${tot} MB)${tty ? '' : '\n'}`);
      }
    } else {
      process.stderr.write(`${tty ? '\r' : ''}  baixando ${label}... ${mb} MB${tty ? '' : '\n'}`);
    }
  }
  if (tty) process.stderr.write('\n');
  return Buffer.concat(chunks);
}

async function downloadAndVerify(artifact: PinnedArtifact, destDir: string): Promise<string> {
  const destFile = join(destDir, artifact.label);

  // Se já existe e o hash bate, pula o download (idempotente).
  if (existsSync(destFile)) {
    const existing = readFileBytesSync(destFile);
    const existingHash = sha256Buffer(existing);
    if (verifySha256(existingHash, artifact.sha256)) {
      return destFile;
    }
    // Hash não bateu → remove e re-baixa.
    rmSync(destFile, { force: true });
  }

  // Download.
  const resp = await fetch(artifact.url);
  if (!resp.ok) {
    throw new Error(`Download falhou: HTTP ${resp.status} — ${artifact.url}`);
  }
  const body = await readBodyWithProgress(resp, artifact.label);

  // Verifica hash.
  const actualHash = sha256Buffer(body);
  if (!verifySha256(actualHash, artifact.sha256)) {
    throw new Error(
      `HASH DIVERGENTE para "${artifact.label}"!\n` +
        `  Esperado: ${artifact.sha256}\n` +
        `  Obtido:   ${actualHash}\n` +
        `  ABORTANDO instalação deste alvo (CLI-SEC-H2).`,
    );
  }

  // Salva com perms 0600.
  writeFileSync(destFile, body, { mode: FILE_PERMS });
  return destFile;
}

/** Lê um arquivo como Buffer (wrapper p/ mock em teste). */
function readFileBytesSync(path: string): Buffer {
  return readFileSync(path);
}

// ─── Resolução de assets ────────────────────────────────────────────────────

/** Nome do script servidor Mem0. */
const MEM0_SERVER_SCRIPT = 'aluy-mem0-server.py';

/**
 * Resolve o caminho absoluto do script servidor Mem0 no assets/ do pacote.
 *
 * Em modo de desenvolvimento (tsx / ts-node), o __dirname do .ts é
 * `packages/cli/src/provisioner/` e o asset está em
 * `packages/cli/assets/mem0/aluy-mem0-server.py`.
 *
 * Após compilação (tsc), o .js está em `dist/provisioner/` e o asset
 * em `assets/mem0/` — ambos dentro da raiz do pacote `@hiperplano/aluy-cli`.
 *
 * Tenta: 1) `<__dirname>/../../assets/mem0/${script}` (cobre dev + dist).
 *        2) `<__dirname>/../../../assets/mem0/${script}` (cobre bundling).
 */
function resolveMem0ServerScript(): string {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(__dirname, '..', '..', 'assets', 'mem0', MEM0_SERVER_SCRIPT),
    join(__dirname, '..', '..', '..', 'assets', 'mem0', MEM0_SERVER_SCRIPT),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  // Fallback: retorna o primeiro candidato (vai falhar com erro claro no copy).
  return candidates[0];
}

// ─── Provisionamento de alvos ──────────────────────────────────────────────

/** Provisiona o binário do Ollama + pesos dos modelos. */
async function provisionOllama(): Promise<ProvisionTargetResult> {
  const targetDir = ensureSubdir(OLLAMA_INSTALL_DIR);
  const binDir = join(targetDir, 'bin');
  const ollamaBin = join(binDir, 'ollama');

  // 1. Baixa e verifica o binário do Ollama.
  //    URL derivada de constantes (D2: fonte FIXADA, NÃO lida da API).
  const artifact: PinnedArtifact = {
    url: OLLAMA_BINARY_URL,
    sha256: OLLAMA_BINARY_SHA256,
    label: OLLAMA_ASSET_NAME,
  };

  let archivePath: string;
  try {
    archivePath = await downloadAndVerify(artifact, targetDir);
  } catch (err) {
    return {
      target: 'ollama',
      hashOk: false,
      installed: false,
      message: `Falha no download/verificação do Ollama: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // 2. Verifica dependências de sistema.
  if (!checkZstd()) {
    return {
      target: 'ollama',
      hashOk: true,
      installed: false,
      message: 'zstd não encontrado — necessário para extrair .tar.zst. Instale: apt install zstd',
    };
  }
  if (!checkTar()) {
    return {
      target: 'ollama',
      hashOk: true,
      installed: false,
      message: 'tar não encontrado — necessário para extrair o binário.',
    };
  }

  // 3. Extrai o binário (idempotente).
  if (!existsSync(ollamaBin)) {
    const extract = spawnSync(
      'tar',
      ['--use-compress-program=zstd', '-xf', archivePath, '-C', targetDir],
      { timeout: 60_000, encoding: 'utf8' },
    );
    if (extract.status !== 0) {
      return {
        target: 'ollama',
        hashOk: true,
        installed: false,
        message: `Falha ao extrair binário do Ollama: ${extract.stderr || extract.stdout || 'erro desconhecido'}`,
      };
    }
    // Garante perms 0700 no binário.
    try {
      chmodSync(ollamaBin, 0o700);
    } catch {
      // best-effort
    }
  }

  if (!existsSync(ollamaBin)) {
    return {
      target: 'ollama',
      hashOk: true,
      installed: false,
      message: 'Binário do Ollama extraído mas executável não encontrado.',
    };
  }

  // 4. Pull + verificação dos pesos dos modelos (D1: CA-G2-11).
  //    Inicia ollama serve, faz pull, verifica digests, desliga.
  const pullResult = await pullAndVerifyModels(ollamaBin, binDir);
  if (!pullResult.ok) {
    return {
      target: 'ollama',
      hashOk: true,
      installed: false,
      message: pullResult.message,
    };
  }

  return {
    target: 'ollama',
    hashOk: true,
    installed: true,
    message: `Ollama ${OLLAMA_VERSION} provisionado em ${targetDir} com pesos verificados (${JUDGE_MODEL} + ${EMBEDDER_MODEL}).`,
  };
}

/** mediaType da layer de PESO no manifest do ollama (o blob que de fato é carregado). */
export const OLLAMA_MODEL_MEDIA_TYPE = 'application/vnd.ollama.image.model';

/**
 * F102 (CLI-SEC-H2) — confirma que o digest PINADO é o da layer de PESO (`mediaType`
 * `application/vnd.ollama.image.model`), NÃO de "qualquer layer".
 *
 * O check antigo (`layers.some(l => l.digest === expected)`) passava se o digest esperado
 * aparecesse em QUALQUER layer. Um registry comprometido/MITM poderia servir o peso REAL
 * como uma layer-DECOY (ex.: `license`/`params`) e o peso MALICIOSO como a layer `model`:
 * o `some()` acharia o decoy ⇒ verificação "passa", mas o ollama carregaria o peso
 * malicioso da layer `model`. Isso DEFEITA o pin de digest (cujo propósito é exatamente
 * NÃO confiar no registry). Aqui checamos a layer `model` ESPECIFICAMENTE.
 *
 * PURO. Retorna mensagem de erro (string) ou `null` (ok).
 */
export function verifyManifestModelDigest(
  manifestJson: unknown,
  expectedDigest: string,
  modelLabel: string,
): string | null {
  const layers = (manifestJson as Record<string, unknown>)?.layers;
  if (!Array.isArray(layers) || layers.length === 0) {
    return `Manifest de "${modelLabel}" não contém layers.`;
  }
  const modelLayers = layers.filter(
    (l: unknown) => (l as Record<string, unknown>)?.mediaType === OLLAMA_MODEL_MEDIA_TYPE,
  ) as Record<string, unknown>[];
  if (modelLayers.length === 0) {
    return `Manifest de "${modelLabel}" sem layer de peso (${OLLAMA_MODEL_MEDIA_TYPE}).`;
  }
  // F137 (CLI-SEC-H2, completa o F102) — um manifest HONESTO tem EXATAMENTE UMA layer de
  // peso (model). MAIS de uma é AMBÍGUO: o `find` antigo verificava só a 1ª, então um
  // registry MITM podia servir um DECOY-model com o digest pinado (passa a verificação)
  // + um 2º model MALICIOSO — e não há garantia de QUAL o ollama carrega. O verificador
  // NÃO confia no registry (esse é o ponto do pin): manifest com >1 layer model é sinal
  // de adulteração ⇒ RECUSA (não assume que o ollama carrega o que verificamos).
  if (modelLayers.length > 1) {
    return (
      `Manifest de "${modelLabel}" tem ${modelLayers.length} layers de peso (model) — ` +
      `AMBÍGUO: um registry honesto serve EXATAMENTE uma; >1 indica adulteração e não dá ` +
      `p/ garantir qual o ollama carrega — ABORTANDO (CLI-SEC-H2).`
    );
  }
  const modelLayer = modelLayers[0]!;
  if (modelLayer.digest !== expectedDigest) {
    return (
      `DIGEST DIVERGENTE para "${modelLabel}"! A layer de peso (model) tem ` +
      `"${String(modelLayer.digest)}", esperado "${expectedDigest}" — ABORTANDO (CLI-SEC-H2).`
    );
  }
  return null;
}

/**
 * Inicia ollama serve em background, faz pull dos modelos,
 * verifica os digests contra os pinados no contrato e desliga.
 *
 * D1 / CA-G2-11: pull é passo de instalação, NUNCA deferido ao boot.
 * Retorna { ok: true } se ambos os modelos foram puxados e verificados.
 */

/** Extrai name e tag de uma string modelo Ollama (ex.: "qwen2.5:0.5b"). */
function parseModelName(model: string): { name: string; tag: string } {
  const colonIdx = model.lastIndexOf(':');
  if (colonIdx === -1) return { name: model, tag: 'latest' };
  return { name: model.substring(0, colonIdx), tag: model.substring(colonIdx + 1) };
}

async function pullAndVerifyModels(
  ollamaBin: string,
  binDir: string,
): Promise<{ ok: boolean; message: string }> {
  // Inicia ollama serve em background.
  const env = {
    ...process.env,
    OLLAMA_HOST: `${OLLAMA_LOOPBACK_HOST}:${OLLAMA_LOOPBACK_PORT}`,
    OLLAMA_MODELS: join(homedir(), ALUY_DIR, OLLAMA_INSTALL_DIR, 'models'),
    HOME: homedir(),
  };

  // spawn retorna imediatamente com detached + stdio ignore. `.unref()` p/ o processo
  // PAI (o `aluy bootstrap`) PODER SAIR — senão o serve mantém o event loop vivo, o
  // bootstrap nunca termina e o instalador trava ANTES de abrir a sessão (achado do dono).
  const serveProc = spawn(ollamaBin, ['serve'], {
    detached: true,
    stdio: 'ignore',
    env,
  });
  serveProc.unref();

  // Aguarda o servidor ficar pronto (polling no endpoint).
  const baseUrl = `http://${OLLAMA_LOOPBACK_HOST}:${OLLAMA_LOOPBACK_PORT}`;
  let ready = false;
  for (let i = 0; i < 30; i++) {
    try {
      const resp = await fetch(`${baseUrl}/api/tags`);
      if (resp.ok) {
        ready = true;
        break;
      }
    } catch {
      // servidor ainda não respondeu.
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  if (!ready) {
    try {
      serveProc.kill();
    } catch {
      /* ignore */
    }
    return {
      ok: false,
      message: 'Ollama serve não respondeu em 15s. Verifique se outra instância está rodando.',
    };
  }

  // Função auxiliar: faz pull e verifica o digest.
  async function pullAndCheck(model: string, expectedDigest: string): Promise<string | null> {
    // Faz o pull.
    process.stderr.write(`  baixando modelo ${model} (ollama pull)...\n`);
    const pull = spawnSync(ollamaBin, ['pull', model], {
      timeout: OLLAMA_PULL_TIMEOUT_MS,
      stdio: 'inherit',
      env,
      cwd: binDir,
    });
    if (pull.status !== 0) {
      return `Pull de "${model}" falhou (exit ${pull.status}). Veja a saida acima.`;
    }

    // Verifica o digest pelo manifest no disco.
    // O manifest vive em $OLLAMA_MODELS/manifests/registry.ollama.ai/library/<name>/<tag>
    // e contém layers[].digest — o digest REAL do peso.
    const { name, tag } = parseModelName(model);
    const modelsDir = env.OLLAMA_MODELS!;
    const manifestPath = join(modelsDir, 'manifests', 'registry.ollama.ai', 'library', name, tag);

    if (!existsSync(manifestPath)) {
      return `Manifest não encontrado para "${model}" em ${manifestPath}.`;
    }

    let manifestJson: unknown;
    try {
      const raw = readFileSync(manifestPath, 'utf-8');
      manifestJson = JSON.parse(raw);
    } catch (err) {
      return `Falha ao ler/parsear manifest de "${model}": ${err instanceof Error ? err.message : String(err)}`;
    }

    // F102 — verifica o digest da layer de PESO (mediaType `model`), não "qualquer layer".
    return verifyManifestModelDigest(manifestJson, expectedDigest, model);
  }

  // Pull e verificação do judge.
  const judgeErr = await pullAndCheck(JUDGE_MODEL, QWEN_JUDGE_MODEL_DIGEST);
  if (judgeErr) {
    try {
      serveProc.kill();
    } catch {
      /* ignore */
    }
    return { ok: false, message: judgeErr };
  }

  // Pull e verificação do embedder.
  const embedderErr = await pullAndCheck(EMBEDDER_MODEL, NOMIC_EMBEDDER_MODEL_DIGEST);
  if (embedderErr) {
    try {
      serveProc.kill();
    } catch {
      /* ignore */
    }
    return { ok: false, message: embedderErr };
  }

  // Desliga o servidor.
  try {
    serveProc.kill();
  } catch {
    /* ignore */
  }

  return { ok: true, message: '' };
}

/** Provisiona o venv do Mem0. */
async function provisionMem0(): Promise<ProvisionTargetResult> {
  const pythonCheck = checkPython();
  if (!pythonCheck.ok) {
    return {
      target: 'mem0',
      hashOk: false, // não aplicável (sem download), mas marca como não-ok p/ indicar falha
      installed: false,
      message: `Python ${MEM0_MIN_PYTHON}+ requerido (encontrado: ${pythonCheck.version}). Instale python3.10+.`,
    };
  }

  const venvDir = join(aluyDir(), MEM0_VENV_DIR);
  const pythonBin = join(venvDir, 'bin', 'python3');

  // Idempotente: se o venv já existe com pip funcional E o script servidor
  // está presente, pula. Se o script falta, copia-o (atualização).
  if (existsSync(pythonBin) && checkPip(pythonBin)) {
    const serverScript = join(venvDir, MEM0_SERVER_SCRIPT);
    if (existsSync(serverScript)) {
      return {
        target: 'mem0',
        hashOk: true,
        installed: true,
        message: `Venv do Mem0 já provisionado em ${venvDir}.`,
      };
    }
    // Script ausente — copia do asset (provisionamento incremental).
    const assetScript = resolveMem0ServerScript();
    try {
      copyFileSync(assetScript, serverScript);
      chmodSync(serverScript, 0o700);
      return {
        target: 'mem0',
        hashOk: true,
        installed: true,
        message: `Venv do Mem0 já existente; script ${MEM0_SERVER_SCRIPT} copiado para ${venvDir}.`,
      };
    } catch (copyErr) {
      return {
        target: 'mem0',
        hashOk: false,
        installed: false,
        message: `Venv existe mas falha ao copiar script: ${copyErr instanceof Error ? copyErr.message : String(copyErr)}`,
      };
    }
  }

  // Cria venv.
  ensureAluyDir();
  const createVenv = spawnSync('python3', ['-m', 'venv', venvDir], {
    timeout: 60_000,
    encoding: 'utf8',
  });

  if (createVenv.status !== 0) {
    const errMsg = createVenv.stderr || createVenv.stdout || 'erro desconhecido';
    // F103 (CLI-SEC-H2) — quando `ensurepip` falta, o aluy NÃO baixa-e-executa get-pip
    // remoto. O fallback antigo era `python -c 'exec(urlopen("…/get-pip.py").read())'` —
    // o antipadrão "curl | python": código remoto NÃO-verificado rodando com o privilégio
    // do usuário ⇒ RCE se `bootstrap.pypa.io` for comprometido/MITM. Contradizia o próprio
    // CLI-SEC-H2 ("proveniência: hash pinado, recusa se não bater") que o resto deste
    // arquivo segue. FAIL-CLOSED: o usuário instala o pip pelo gerenciador do SO (pacote
    // ASSINADO pela distro — o caminho seguro), e re-roda o provisioning.
    const hint = errMsg.includes('ensurepip')
      ? 'ensurepip/pip indisponível neste Python. Instale o pip pelo gerenciador do SO ' +
        '(ex.: `apt install python3-venv python3-pip`, `dnf install python3-pip`) e tente de novo. ' +
        'O aluy NÃO baixa-e-executa get-pip remoto sem verificação de integridade (CLI-SEC-H2).'
      : errMsg;
    return {
      target: 'mem0',
      hashOk: false,
      installed: false,
      message: `Falha ao criar venv: ${hint}`,
    };
  }

  // Garante perms 0700 no venv.
  try {
    chmodSync(venvDir, DIR_PERMS);
  } catch {
    // best-effort
  }

  // Instala pacotes pinados.
  const pipPath = join(venvDir, 'bin', 'pip');
  if (!checkPip(join(venvDir, 'bin', 'python3'))) {
    return {
      target: 'mem0',
      hashOk: false,
      installed: false,
      message: 'Pip não disponível no venv após criação.',
    };
  }

  process.stderr.write('  instalando mem0 (pip)...\n');
  const install = spawnSync(pipPath, ['install', ...MEM0_PIP_PACKAGES], {
    timeout: 300_000,
    stdio: 'inherit',
  });

  if (install.status !== 0) {
    return {
      target: 'mem0',
      hashOk: false,
      installed: false,
      message: `Falha ao instalar pacotes pip do mem0 (veja a saida acima).`,
    };
  }

  // Copia o script servidor para o venv (EST-1138 C4).
  const assetScript = resolveMem0ServerScript();
  const serverScriptDest = join(venvDir, MEM0_SERVER_SCRIPT);
  try {
    copyFileSync(assetScript, serverScriptDest);
    chmodSync(serverScriptDest, 0o700);
  } catch (copyErr) {
    return {
      target: 'mem0',
      hashOk: false,
      installed: false,
      message: `Pip ok mas falha ao copiar script servidor: ${copyErr instanceof Error ? copyErr.message : String(copyErr)}`,
    };
  }

  return {
    target: 'mem0',
    hashOk: true,
    installed: true,
    message: `Venv do Mem0 provisionado em ${venvDir} com ${MEM0_PIP_PACKAGES.length} pacotes + ${MEM0_SERVER_SCRIPT}.`,
  };
}

/**
 * Provisiona o venv do Headroom (ADR-0108): `pip install headroom-ai` num venv
 * `~/.aluy/hr-venv`. O entrypoint `headroom` (console_script do pacote) roda
 * `headroom proxy --port 8787`. ⚠ Sem hash pinado (proveniência por registry pip).
 * Caminhos Unix (`bin/`): só roda NATIVO no Linux — Windows entra via delegação.
 */
async function provisionHeadroom(): Promise<ProvisionTargetResult> {
  const pythonCheck = checkPython();
  if (!pythonCheck.ok) {
    return {
      target: 'headroom',
      hashOk: false,
      installed: false,
      message: `Python ${MEM0_MIN_PYTHON}+ requerido (encontrado: ${pythonCheck.version}). Instale python3.10+.`,
    };
  }

  const venvDir = join(aluyDir(), HEADROOM_VENV_DIR);
  const pythonBin = join(venvDir, 'bin', 'python3');
  const entrypoint = join(venvDir, 'bin', 'headroom');

  // Idempotente: venv com pip + entrypoint headroom presente ⇒ já provisionado.
  if (existsSync(entrypoint) && existsSync(pythonBin) && checkPip(pythonBin)) {
    return {
      target: 'headroom',
      hashOk: true,
      installed: true,
      message: `Headroom já provisionado em ${venvDir}.`,
    };
  }

  // Cria venv (idempotente — reusa se já existe).
  ensureAluyDir();
  if (!existsSync(pythonBin)) {
    const createVenv = spawnSync('python3', ['-m', 'venv', venvDir], {
      timeout: 60_000,
      encoding: 'utf8',
    });
    if (createVenv.status !== 0) {
      return {
        target: 'headroom',
        hashOk: false,
        installed: false,
        message: `Falha ao criar venv do headroom: ${createVenv.stderr || createVenv.stdout || 'erro desconhecido'}`,
      };
    }
  }
  try {
    chmodSync(venvDir, DIR_PERMS);
  } catch {
    // best-effort
  }

  if (!checkPip(pythonBin)) {
    return {
      target: 'headroom',
      hashOk: false,
      installed: false,
      message: 'Pip não disponível no venv do headroom após criação.',
    };
  }

  const pipPath = join(venvDir, 'bin', 'pip');
  process.stderr.write('  instalando headroom (pip)...\n');
  const install = spawnSync(pipPath, ['install', ...HEADROOM_PIP_PACKAGES], {
    timeout: 300_000,
    stdio: 'inherit',
  });
  if (install.status !== 0) {
    return {
      target: 'headroom',
      hashOk: false,
      installed: false,
      message: `Falha ao instalar ${HEADROOM_PIP_PACKAGES.join(', ')} (veja a saida acima).`,
    };
  }

  if (!existsSync(entrypoint)) {
    return {
      target: 'headroom',
      hashOk: false,
      installed: false,
      message: `Pip ok mas o entrypoint 'headroom' não apareceu em ${venvDir}/bin.`,
    };
  }

  return {
    target: 'headroom',
    hashOk: true,
    installed: true,
    message: `Headroom instalado em ${venvDir} (serviço local em :${HEADROOM_LOOPBACK_PORT}).`,
  };
}

// ─── Implementação do SidecarProvisioner ───────────────────────────────────

/** Opções do `NodeSidecarProvisioner` (EST-1133-bis). */
export interface NodeSidecarProvisionerOptions {
  /**
   * SO-alvo (default `process.platform`). Determina se há ARTEFATO PINADO p/ o
   * provisionamento direto. Hoje o artefato pinado é `ollama-linux-amd64.tar.zst`
   * (+ venv Unix do Mem0) ⇒ só `linux`. Em qualquer outro SO, sem `agentInstaller`,
   * o provisionamento direto não roda (instrui o usuário).
   */
  readonly platform?: NodeJS.Platform;
  /**
   * EST-1133-bis — INSTALADOR VIA AGENTE. Quando presente E o SO não tem artefato
   * pinado, `provision()` DELEGA ao agente (em vez de baixar o tarball errado).
   * Injetável p/ teste; o default (via `runProvisioner({useAgent:true})`) roda
   * `aluy -p "<goal>" --yolo` e VERIFICA o estado real do sidecar depois.
   */
  readonly agentInstaller?: (target: SidecarTarget) => Promise<ProvisionTargetResult>;
}

/**
 * Provisionador concreto de sidecars. Usa fs/child_process/fetch reais.
 * Injetável em teste via constructor (substituindo métodos por stubs).
 */
export class NodeSidecarProvisioner implements SidecarProvisioner {
  private readonly platform: NodeJS.Platform;
  private readonly agentInstaller:
    | ((target: SidecarTarget) => Promise<ProvisionTargetResult>)
    | undefined;

  constructor(opts: NodeSidecarProvisionerOptions = {}) {
    this.platform = opts.platform ?? process.platform;
    this.agentInstaller = opts.agentInstaller;
  }

  /** Há artefato pinado p/ o SO atual? Hoje só Linux (ollama-linux-amd64 + venv Unix). */
  private hasPinnedArtifact(): boolean {
    return this.platform === 'linux';
  }

  /**
   * Verifica se um alvo já está provisionado.
   */
  async isProvisioned(target: SidecarTarget): Promise<boolean> {
    switch (target) {
      case 'ollama': {
        const ollamaBin = join(aluyDir(), OLLAMA_INSTALL_DIR, 'bin', 'ollama');
        return existsSync(ollamaBin);
      }
      case 'mem0': {
        const pythonBin = join(aluyDir(), MEM0_VENV_DIR, 'bin', 'python3');
        return existsSync(pythonBin) && checkPip(pythonBin);
      }
      case 'headroom': {
        const entrypoint = join(aluyDir(), HEADROOM_VENV_DIR, 'bin', 'headroom');
        return existsSync(entrypoint);
      }
      default:
        return false;
    }
  }

  /**
   * Provisiona UM alvo específico.
   */
  async provision(target: SidecarTarget): Promise<ProvisionTargetResult> {
    // G2-C1 / CLI-SEC-H2: recusa root.
    const uid = userInfo().uid;
    if (isRoot(uid)) {
      return {
        target,
        hashOk: false,
        installed: false,
        message: `RECUSA ROOT (uid=0): provisionamento de sidecars é user-space. Execute como usuário normal.`,
      };
    }

    // O AGENTE EMBUTIDO é o instalador PREFERIDO em QUALQUER SO/distro (decisão do dono):
    // ele detecta o ambiente, instala os PRÉ-REQUISITOS que faltam (python3.10+/pip/venv,
    // zstd/tar — via o gerenciador da distro, com sudo) E o sidecar, e ACOMPANHA/trata os
    // problemas — que num parque heterogêneo (apt/dnf/pacman/zypper/brew) são a regra, não a
    // exceção. O caminho rígido (tarball pinado) só era robusto no Linux com python já pronto.
    // Por isso, havendo `agentInstaller`, ele VENCE — inclusive no Linux e mesmo com python
    // presente (o agente parte do que existe e completa o que falta).
    if (this.agentInstaller) {
      return this.agentInstaller(target);
    }
    // Sem agente (--no-agent): caminho direto do tarball pinado (Linux); nos demais SOs,
    // instrui (sem fingir/baixar errado).
    if (!this.hasPinnedArtifact()) {
      return {
        target,
        hashOk: false,
        installed: false,
        message:
          `SO '${this.platform}' sem artefato pinado p/ provisionamento direto. ` +
          'Rode `aluy bootstrap` (o aluy instala via o próprio agente, ⚠ --yolo) ' +
          'ou instale manualmente.',
      };
    }

    switch (target) {
      case 'ollama':
        return provisionOllama();
      case 'mem0':
        return provisionMem0();
      case 'headroom':
        return provisionHeadroom();
      default:
        return {
          target,
          hashOk: false,
          installed: false,
          message: `Alvo desconhecido: ${String(target)}`,
        };
    }
  }

  /**
   * Provisiona TODOS os alvos conforme perfil + toggles.
   *
   * LEVE ⇒ não provisiona nada (retorna resultado vazio).
   * TURBO ⇒ provisiona cada sidecar cujo toggle está ON.
   *
   * Degradável: falha de um alvo não trava os demais.
   */
  async provisionAll(
    profile: AgentProfileTier,
    toggles: ReadonlySet<SidecarTarget>,
  ): Promise<ProvisionResult> {
    if (!shouldProvision(profile)) {
      return {
        profile,
        targets: [],
        anySuccess: false,
        allFailed: false,
      };
    }

    const results: ProvisionTargetResult[] = [];
    for (const target of toggles) {
      const result = await this.provision(target);
      results.push(result);
    }

    const anySuccess = results.some((r) => r.installed);
    const allFailed = results.length > 0 && results.every((r) => !r.installed);

    return { profile, targets: results, anySuccess, allFailed };
  }
}

// ─── Delegação ao agente (EST-1133-bis) ─────────────────────────────────────

/**
 * Dica de versão de Python p/ os venvs (mem0/headroom): as deps nativas
 * (onnx/torch/mem0ai/headroom-ai) não têm wheels p/ 3.13+/3.14 ⇒ orienta o
 * agente a usar 3.11/3.12 e a RECRIAR o venv se estiver numa versão incompatível.
 */
const PY_COMPAT_HINT =
  'na faixa 3.10–3.12 (NÃO use 3.13+/3.14 — as dependências nativas não têm wheels e o ' +
  'pip falha ao compilar; no Windows prefira `py -3.12` ou `py -3.11`). Se NÃO houver um ' +
  'Python 3.10–3.12 instalado, INSTALE primeiro (no Windows: `winget install -e --id ' +
  'Python.Python.3.12 --accept-source-agreements --accept-package-agreements`; no Linux/macOS ' +
  'use o gerenciador do sistema). Se já existir um venv nesse caminho numa versão incompatível ' +
  '(ex.: 3.14), APAGUE e recrie com a versão certa';

/** Objetivo de instalação por alvo, passado ao agente do aluy. */
/**
 * Preâmbulo de PRÉ-REQUISITOS de sistema para o agente instalar adaptativamente ANTES do
 * sidecar (decisão do dono: o agente cuida do que falta, não importa a distro). `pkgs` são
 * os pacotes de sistema necessários (ex.: python3, python3-venv, python3-pip / zstd, tar).
 *
 * Cobre a "variedade de configurações" do parque Unix e a questão do sudo:
 *  - detecta a distro/gerenciador (apt/dnf/pacman/zypper no Linux; brew no macOS);
 *  - usa `sudo` p/ pacotes de sistema; se o `sudo -n` (sem senha) falhar, PEDE a senha ao
 *    usuário (stdio interativo) em vez de abortar — o usuário está ciente e consentiu.
 */
function prereqPreamble(pkgs: readonly string[]): string {
  return (
    `PRIMEIRO garanta os pré-requisitos de sistema (${pkgs.join(', ')}). ` +
    `Detecte o gerenciador de pacotes da máquina (apt/dnf/pacman/zypper no Linux; brew no ` +
    `macOS; winget/instalador no Windows) e instale só o que FALTAR — parta do que já existe. ` +
    `Pacotes de sistema exigem privilégio: tente \`sudo -n true\` p/ ver se o sudo é sem-senha; ` +
    `se exigir senha, PEÇA a senha ao usuário e rode com \`sudo\` (não aborte). Se algo falhar ` +
    `(repo, lock do apt, nome de pacote diferente na distro), DIAGNOSTIQUE e contorne — você é ` +
    `o instalador adaptativo, trate o problema em vez de desistir. `
  );
}

function agentInstallGoal(target: SidecarTarget): string {
  if (target === 'ollama') {
    return (
      'Provisione o sidecar OLLAMA do aluy, detectando o SO. ' +
      prereqPreamble(['zstd', 'tar']) +
      `Teste GET http://${OLLAMA_LOOPBACK_HOST}:${OLLAMA_LOOPBACK_PORT}/api/tags. ` +
      'Se o serviço não responder, instale o Ollama (Linux: script oficial `curl -fsSL ' +
      'https://ollama.com/install.sh | sh`; Windows: `winget install --id Ollama.Ollama -e ' +
      '--accept-source-agreements --accept-package-agreements`; macOS: brew ou instalador) e ' +
      'garanta o serviço rodando. ' +
      `DEPOIS, puxe os modelos do TURBO (senão o judge/embedder não funcionam): ` +
      `\`ollama pull ${JUDGE_MODEL}\` (judge) e \`ollama pull ${EMBEDDER_MODEL}\` (embedder). ` +
      `Confirme que ambos aparecem em \`ollama list\`. Seja conciso.`
    );
  }
  if (target === 'mem0') {
    const venvDir = join(aluyDir(), MEM0_VENV_DIR);
    return (
      `Provisione o sidecar MEM0 do aluy. ` +
      prereqPreamble(['python3 (>=3.10)', 'python3-venv', 'python3-pip']) +
      `DEPOIS crie um venv em "${venvDir}" usando um Python ` +
      `${PY_COMPAT_HINT} e garanta pip funcional (Scripts\\pip.exe no Windows, bin/pip no Unix). ` +
      `Instale TODAS as deps no venv: ${MEM0_PIP_PACKAGES.join(', ')} (não só mem0ai — o ` +
      `servidor importa chromadb e ollama). Confirme que 'import mem0, chromadb, ollama' ` +
      `roda sem erro. Seja conciso.`
    );
  }
  if (target === 'headroom') {
    const venvDir = join(aluyDir(), HEADROOM_VENV_DIR);
    return (
      `Provisione o sidecar HEADROOM do aluy (proxy de compressão). ` +
      prereqPreamble(['python3 (>=3.10)', 'python3-venv', 'python3-pip']) +
      `DEPOIS crie um venv em "${venvDir}" usando um Python ${PY_COMPAT_HINT}, ` +
      `instale o pacote ${HEADROOM_PIP_PACKAGES.join(', ')} (pip install) e confirme que o ` +
      "entrypoint 'headroom' existe no venv (Scripts\\headroom.exe no Windows, bin/headroom no Unix). " +
      `No Windows o core Rust não tem wheel: o proxy só sobe com HEADROOM_REQUIRE_RUST_CORE=false ` +
      `(modo Python-degradado). Opcional: suba 'headroom proxy --port ${HEADROOM_LOOPBACK_PORT}'. Seja conciso.`
    );
  }
  return `Provisione o sidecar "${String(target)}" do aluy, detectando o SO. Seja conciso.`;
}

/**
 * Verifica o ESTADO REAL do sidecar após a delegação (integridade honesta: nunca
 * reporta "instalado" sem checar). Ollama ⇒ porta loopback respondendo; Mem0 ⇒
 * python do venv presente (layout por SO).
 */
async function verifyTargetHealthy(
  target: SidecarTarget,
  platform: NodeJS.Platform,
): Promise<boolean> {
  if (target === 'ollama') {
    try {
      const resp = await fetch(`http://${OLLAMA_LOOPBACK_HOST}:${OLLAMA_LOOPBACK_PORT}/api/tags`);
      if (!resp.ok) return false;
      // "usável" ≠ só porta up: o JUDGE_MODEL precisa estar baixado, senão o
      // judge degrada p/ heurística (o turbo não usa o Ollama de fato).
      const data = (await resp.json()) as { models?: Array<{ name?: string }> };
      const names = (data.models ?? []).map((m) => m.name ?? '');
      return names.some((n) => n.startsWith(JUDGE_MODEL));
    } catch {
      return false;
    }
  }
  if (target === 'mem0') {
    const venvDir = join(aluyDir(), MEM0_VENV_DIR);
    const py =
      platform === 'win32'
        ? join(venvDir, 'Scripts', 'python.exe')
        : join(venvDir, 'bin', 'python3');
    if (!existsSync(py)) return false;
    // NÃO basta o venv existir: as DEPS precisam IMPORTAR (pega "venv ok mas falta
    // chromadb/ollama"). E o script do servidor precisa estar no venv p/ o boot subir.
    const imp = spawnSync(py, ['-c', 'import mem0, chromadb, ollama'], { timeout: 60_000 });
    if (imp.status !== 0) return false;
    return existsSync(join(venvDir, MEM0_SERVER_SCRIPT));
  }
  if (target === 'headroom') {
    // Saudável = proxy respondendo OU entrypoint instalado no venv (layout por SO).
    try {
      const resp = await fetch(`http://127.0.0.1:${HEADROOM_LOOPBACK_PORT}/health`);
      if (resp.ok) return true;
    } catch {
      // proxy não está rodando — checa o entrypoint instalado.
    }
    const venvDir = join(aluyDir(), HEADROOM_VENV_DIR);
    const entry =
      platform === 'win32'
        ? join(venvDir, 'Scripts', 'headroom.exe')
        : join(venvDir, 'bin', 'headroom');
    return existsSync(entry);
  }
  return false;
}

/**
 * Instalador via AGENTE (default p/ `runProvisioner({useAgent:true})`): roda o
 * PRÓPRIO aluy headless (`aluy -p "<goal>" --yolo`) p/ instalar o sidecar de forma
 * adaptativa ao SO, e VERIFICA o estado real depois. ⚠ `--yolo` = acesso total à
 * máquina (consentimento dado pela flag `aluy init --agent`).
 */
async function defaultAgentInstaller(target: SidecarTarget): Promise<ProvisionTargetResult> {
  const goal = agentInstallGoal(target);
  const aluyScript = process.argv[1];
  if (!aluyScript) {
    return {
      target,
      hashOk: false,
      installed: false,
      message: 'Não foi possível localizar o binário do aluy p/ delegar ao agente.',
    };
  }
  // CLEAR de tela ANTES de cada complemento: cada instalação começa numa tela limpa,
  // sem o output do anterior empilhado por cima (pedido do dono — "coisas em cima de
  // coisas"). `2J` limpa a tela, `3J` o scrollback, `H` volta o cursor ao topo.
  process.stdout.write('\x1b[2J\x1b[3J\x1b[H');
  // O usuário PRECISA ver a EVOLUÇÃO (saber que está indo). A saída do agente é VISÍVEL
  // (`stdio:'inherit'`): o download/instalação aparece (winget/pip, pull de modelos).
  process.stdout.write(`  ── Instalando o complemento "${target}" ── (acompanhe abaixo; pode levar alguns minutos)\n\n`);
  const run = spawnSync(
    process.execPath,
    [aluyScript, '-p', goal, '--yolo', '--no-self-check'],
    {
      stdio: 'inherit',
      timeout: 900_000,
      // Ambiente de saída LIMPA para o agente interno:
      //  • ALUY_OVERWRITE_RENDER=0 / ALUY_SYNC_OUTPUT=0 — desligam o redesenho
      //    "overwrite-in-place"; sem isso o agente reescreve por cima das linhas do
      //    bootstrap e tudo embaralha ("coisas em cima de coisas"). Append-only é legível.
      //  • ALUY_NO_WEAK_YOLO_WARN=1 — silencia o aviso de modo-autônomo NESTE agente
      //    interno (a tarefa é nossa e confiável; o aviso é só ruído durante o install).
      env: {
        ...process.env,
        ALUY_OVERWRITE_RENDER: '0',
        ALUY_SYNC_OUTPUT: '0',
        ALUY_NO_WEAK_YOLO_WARN: '1',
      },
    },
  );
  // mem0: o caminho via agente NÃO copia o script do servidor (só o nativo copia).
  // Garantimos aqui — sem ele o boot não tem o que rodar em :11435.
  if (target === 'mem0') {
    try {
      const venvDir = join(aluyDir(), MEM0_VENV_DIR);
      const dest = join(venvDir, MEM0_SERVER_SCRIPT);
      if (existsSync(venvDir) && !existsSync(dest)) {
        copyFileSync(resolveMem0ServerScript(), dest);
      }
    } catch {
      // best-effort; a verificação de deps/script abaixo reporta se faltar.
    }
  }
  // ollama: garante os MODELOS do turbo (judge + embedder) de forma DETERMINÍSTICA
  // via a API do Ollama — NÃO depende do agente lembrar de puxar (era o gap: o
  // serviço subia mas o judge model ficava de fora ⇒ o judge degradava p/ heurística).
  if (target === 'ollama') {
    await ensureOllamaModels();
  }
  // O agente PODE deixar um `pip install` rodando em BACKGROUND (watch_command) e
  // retornar antes dele terminar — verificar UMA vez aqui daria falso-negativo. Por
  // isso fazemos POLL do estado real por uma janela curta antes de concluir ✗.
  let healthy = await verifyTargetHealthy(target, process.platform);
  for (let i = 0; i < AGENT_VERIFY_POLLS && !healthy; i++) {
    await sleep(AGENT_VERIFY_INTERVAL_MS);
    healthy = await verifyTargetHealthy(target, process.platform);
  }
  // A saída do agente já foi mostrada ao vivo (inherit) — o usuário viu o que aconteceu.
  void run; // (status do processo não é confiável p/ background pip/winget; vale o health-check)
  return {
    target,
    hashOk: healthy,
    installed: healthy,
    message: healthy
      ? `complemento "${target}" instalado e verificado.`
      : `o complemento "${target}" ainda não respondeu como esperado. O Aluy CLI ` +
        `funciona sem ele; você pode tentar de novo depois com \`aluy bootstrap\`.`,
  };
}

/** Poll de verificação pós-agente (cobre `pip install`/`winget` deixado em background).
 *  ~12min: o `winget install Ollama` baixa centenas de MB + o serviço sobe + os modelos
 *  do turbo são puxados; 5min dava falso 0/3 em conexões lentas (achado do dono). */
const AGENT_VERIFY_POLLS = 144;
const AGENT_VERIFY_INTERVAL_MS = 5_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Puxa os modelos do TURBO (judge + embedder) via a API do Ollama (`POST /api/pull`,
 * `stream:false` bloqueia até concluir). DETERMINÍSTICO — não depende do agente. Idempotente
 * (re-pull de modelo já presente é rápido). Best-effort: erro ⇒ `verifyTargetHealthy` reporta.
 */
async function ensureOllamaModels(): Promise<void> {
  for (const model of [JUDGE_MODEL, EMBEDDER_MODEL]) {
    try {
      const resp = await fetch(`http://${OLLAMA_LOOPBACK_HOST}:${OLLAMA_LOOPBACK_PORT}/api/pull`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: model, stream: false }),
      });
      await resp.text(); // drena/aguarda a conclusão do pull.
    } catch {
      // best-effort.
    }
  }
}

// ─── Função de entrada principal ───────────────────────────────────────────

/**
 * Roda o provisionamento completo a partir da config do usuário.
 *
 * Lê o perfil (TURBO/LEVE) e os toggles de sidecar do `UserConfig`,
 * e provisiona conforme necessário. É a função chamada pelo `aluy init`.
 *
 * @param configProfile - Perfil lido da config (undefined ⇒ default TURBO).
 * @param configToggles - Toggles lidos da config (undefined ⇒ default todos ON).
 * @param opts - EST-1133-bis: `useAgent` habilita a delegação ao agente em SO sem
 *               artefato pinado (não-Linux); `platform` injeta o SO (teste).
 */
/** O módulo `venv` do Python está disponível? (mem0/headroom criam virtualenv). */
function checkVenvModule(): boolean {
  try {
    const r = spawnSync('python3', ['-m', 'venv', '--help'], { timeout: 10_000 });
    return r.status === 0;
  } catch {
    return false;
  }
}

/** O `pip` do python3 do SISTEMA está disponível? (necessário p/ semear o venv). */
function checkSystemPip(): boolean {
  try {
    const r = spawnSync('python3', ['-m', 'pip', '--version'], { timeout: 10_000 });
    return r.status === 0;
  } catch {
    return false;
  }
}

/**
 * PRÉ-FLIGHT do turbo: checa os pré-requisitos de SO dos sidecars selecionados e
 * devolve linhas a IMPRIMIR (vazio = tudo presente). Ollama precisa de zstd+tar
 * (binário); mem0/headroom precisam de python3.10+ + venv + pip (serviços Python).
 * NÃO aborta — os sidecars são independentes (o ollama instala mesmo sem Python);
 * só AVISA na hora o que falta + o comando, em vez de falhar por-sidecar no escuro.
 */
function preflightPrereqs(toggles: ReadonlySet<SidecarTarget>): string[] {
  const missing: string[] = [];
  const apt: string[] = [];
  if (toggles.has('ollama')) {
    if (!checkZstd()) {
      missing.push('zstd (extrair o Ollama)');
      apt.push('zstd');
    }
    if (!checkTar()) {
      missing.push('tar (extrair o Ollama)');
      apt.push('tar');
    }
  }
  if (toggles.has('mem0') || toggles.has('headroom')) {
    const py = checkPython();
    if (!py.ok) {
      missing.push(`python3 >= ${MEM0_MIN_PYTHON} para mem0/headroom (encontrado: ${py.version || 'nenhum'})`);
      apt.push('python3', 'python3-venv', 'python3-pip');
    } else {
      if (!checkVenvModule()) {
        missing.push('módulo venv do Python (mem0/headroom criam um virtualenv)');
        apt.push('python3-venv');
      }
      if (!checkSystemPip()) {
        missing.push('pip do Python (mem0/headroom instalam pacotes)');
        apt.push('python3-pip');
      }
    }
  }
  if (missing.length === 0) return [];
  const aptUniq = [...new Set(apt)];
  return [
    'Faltam pré-requisitos para o modo turbo (o que conseguir, instala; o resto fica de fora):',
    ...missing.map((m) => `  • ${m}`),
    `Instale e rode \`aluy bootstrap\` de novo:  sudo apt install -y ${aptUniq.join(' ')}`,
    '',
  ];
}

export async function runProvisioner(
  configProfile?: 'turbo' | 'leve',
  configToggles?: { ollama?: boolean; mem0?: boolean },
  opts?: { useAgent?: boolean; platform?: NodeJS.Platform },
): Promise<ProvisionResult> {
  const profile: AgentProfileTier = configProfile ?? 'turbo';
  const toggles = resolveSidecarToggles(configToggles ?? {});
  // O AGENTE EMBUTIDO é o instalador DEFAULT (decisão do dono): ele detecta o ambiente e
  // instala os pré-requisitos que faltam adaptativamente (qualquer distro, com sudo). Só
  // `useAgent:false` (--no-agent) força o caminho direto do tarball pinado (Linux).
  const useAgent = opts?.useAgent !== false;
  const provisioner = new NodeSidecarProvisioner({
    ...(opts?.platform ? { platform: opts.platform } : {}),
    ...(useAgent ? { agentInstaller: defaultAgentInstaller } : {}),
  });
  // O preflight (avisar "instale python na mão") só vale no caminho DIRETO — no caminho do
  // AGENTE é ELE quem instala os pré-requisitos, então o aviso seria contraditório. Só avisamos
  // quando o agente está desligado.
  if (!useAgent) {
    for (const line of preflightPrereqs(toggles)) process.stderr.write(line + '\n');
  }
  return provisioner.provisionAll(profile, toggles);
}
