// EST-1133 · ADR-0123 §2.2-ter — PROVISIONADOR DE SIDECARS (contrato puro).
//
// Define os TIPOS, interfaces e CONSTANTES DO CONTRATO de provisionamento
// de sidecars user-space. PORTÁVEL (ADR-0053 §8): ZERO I/O, ZERO import de
// `node:*`, ZERO sidecar, ZERO credencial. A implementação concreta
// (download, verificação, venv) mora no `@hiperplano/aluy-cli`.
//
// Invariantes (ADR-0123 §2.2-ter / EST-1133):
//   G2-C1  — Caminho confiável: destino absoluto ~/.aluy/, perms 0700/0600.
//   G2-H2  — Proveniência pinada: cada artefato com hash cravado; recusa se divergir.
//   CLI-SEC-H2 — Recusa root (uid 0 ⇒ aborta).
//   Idempotente — re-rodar não reinstala à toa.
//   Degradável — falha ⇒ piso heurístico / LEVE efetivo, não trava.

// ─── Perfil de provisionamento ─────────────────────────────────────────────
//
// O perfil do usuário controla SE o provisionamento dispara:
//   LEVE  = NUNCA provisiona nada.
//   TURBO = PROVISIONA segundo os toggles de sidecar abaixo.
// Default de fábrica = TURBO (ADR-0123 §2.2-bis: reconciliação default-ON).

/** Perfil de agente que controla o provisionamento de sidecars. */
export type AgentProfileTier = 'leve' | 'turbo';

/** Alvos de provisionamento (sidecars). Cada um pode ser ligado/desligado. */
export type SidecarTarget = 'ollama' | 'mem0' | 'headroom';

// ─── Manifesto de proveniência pinada ──────────────────────────────────────
//
// CADA artefato externo baixado tem hash cravado AQUI. A implementação
// concreta DEVE rejeitar qualquer artefato cujo SHA256 não bata.
// Estes valores são ATUALIZADOS quando as dependências mudam de versão,
// mas NUNCA são resolvidos em runtime (fonte fixada, CLI-SEC-H2).

/** Um artefato com proveniência pinada: fonte + hash esperado. */
export interface PinnedArtifact {
  /** URL de download (fonte FIXADA). */
  readonly url: string;
  /** SHA256 esperado (hex). */
  readonly sha256: string;
  /** Descrição legível (p/ log de erro). */
  readonly label: string;
}

/** Versão do Ollama a provisionar. */
export const OLLAMA_VERSION = '0.30.10';

/** Tag da release do Ollama no GitHub. */
export const OLLAMA_RELEASE_TAG = `v${OLLAMA_VERSION}`;

/**
 * Hash SHA256 do binário do Ollama linux-amd64 (v0.30.10).
 *
 * Obtido da release oficial do GitHub e CRAVADO aqui.
 * Qualquer divergência ⇒ ABORTA a instalação (CLI-SEC-H2).
 */
export const OLLAMA_BINARY_SHA256 =
  '046d8f28e58d58477a49558d8d1bcb2e81ca8b287f93c44b12ff919c10d178dd';

/** Nome do asset do binário Ollama na release do GitHub. */
export const OLLAMA_ASSET_NAME = 'ollama-linux-amd64.tar.zst';

/**
 * URL de download do binário do Ollama — DERIVADA de constantes,
 * NUNCA lida da API em runtime (CA-PROV-1 / CLI-SEC-H2: fonte FIXADA).
 */
export const OLLAMA_BINARY_URL = `https://github.com/ollama/ollama/releases/download/${OLLAMA_RELEASE_TAG}/${OLLAMA_ASSET_NAME}`;

/**
 * Modelo do judge engine (qwen2.5:0.5b — ~0.5B parâmetros).
 * Puxado via `ollama pull` após o binário estar instalado.
 */
export const JUDGE_MODEL = 'qwen2.5:0.5b';

/**
 * Modelo de embedding (nomic-embed-text).
 * Puxado via `ollama pull` após o binário estar instalado.
 */
export const EMBEDDER_MODEL = 'nomic-embed-text';

/**
 * Digest SHA256 da camada de peso do modelo judge (qwen2.5:0.5b).
 * Verificado após `ollama pull` — qualquer divergência ⇒ ABORTA.
 */
export const QWEN_JUDGE_MODEL_DIGEST =
  'sha256:c5396e06af294bd101b30dce59131a76d2b773e76950acc870eda801d3ab0515';

/**
 * Digest SHA256 da camada de peso do modelo embedder (nomic-embed-text).
 * Verificado após `ollama pull` — qualquer divergência ⇒ ABORTA.
 */
export const NOMIC_EMBEDDER_MODEL_DIGEST =
  'sha256:970aa74c0a90ef7482477cf803618e776e173c007bf957f635f1015bfcfef0e6';

/**
 * Timeout para `ollama pull` (ms). O download dos pesos leva tempo.
 */
export const OLLAMA_PULL_TIMEOUT_MS = 600_000; // 10 min

/** Porta loopback do Ollama (localhost, sem bind externo). */
export const OLLAMA_LOOPBACK_PORT = 11434;

/** Host loopback do Ollama. */
export const OLLAMA_LOOPBACK_HOST = '127.0.0.1';

/** URL base do Ollama em loopback. */
export const OLLAMA_BASE_URL = `http://${OLLAMA_LOOPBACK_HOST}:${OLLAMA_LOOPBACK_PORT}`;

/** Diretório de instalação do Ollama relativo a ~/.aluy/. */
export const OLLAMA_INSTALL_DIR = 'ollama';

/** Diretório do venv do Mem0 relativo a ~/.aluy/. */
export const MEM0_VENV_DIR = 'mem-venv';

/** Diretório do venv do Headroom relativo a ~/.aluy/ (ADR-0108). */
export const HEADROOM_VENV_DIR = 'hr-venv';

/**
 * Pacotes pip do Headroom (ADR-0108: OSS `chopratejas/headroom`, pacote `headroom-ai`).
 * Entrypoint `headroom` → roda `headroom proxy --port 8787` (loopback).
 *
 * F104 — VERSÃO PINADA (`==0.25.0`, a testada/deployada), igual à disciplina do Mem0
 * (`mem0ai==…`). Sem o pin, `pip install headroom-ai` puxava o LATEST do PyPI a cada
 * provisionamento ⇒ sem reprodutibilidade E exposto a um release novo malicioso/quebrado
 * ser instalado silenciosamente. ⚠ Continua SEM hash-pin (ao contrário do binário do
 * Ollama): proveniência por nome+versão+registry pip (HTTPS). Bump deliberado, como o Mem0.
 */
export const HEADROOM_PIP_PACKAGES: readonly string[] = ['headroom-ai==0.25.0'];

/** Porta loopback do proxy headroom (compressão de contexto, ADR-0108). */
export const HEADROOM_LOOPBACK_PORT = 8787;

/** Versão do Python requerida p/ o venv do Mem0. */
export const MEM0_MIN_PYTHON = '3.10';

/** Pacotes pip a instalar no venv do Mem0 (versões pinadas). */
export const MEM0_PIP_PACKAGES: readonly string[] = [
  'mem0ai==0.1.76',
  'chromadb==0.5.23',
  'ollama==0.4.7',
];

// ─── Tipos de status ───────────────────────────────────────────────────────

/** Estado de provisionamento de um alvo. */
export type ProvisionStatus =
  | 'not_provisioned' // nunca foi provisionado
  | 'provisioned' // já está provisionado (idempotente: não reinstala)
  | 'failed' // falhou na última tentativa (degrada)
  | 'provisioning'; // em andamento (exclusão mútua entre alvos)

/** Resultado do provisionamento de UM alvo. */
export interface ProvisionTargetResult {
  /** O alvo provisionado. */
  readonly target: SidecarTarget;
  /** Hash verificado com sucesso? */
  readonly hashOk: boolean;
  /** Instalação concluída com sucesso? */
  readonly installed: boolean;
  /** Mensagem legível (erro ou sucesso). */
  readonly message: string;
}

/** Resultado agregado do provisionamento (todos os alvos). */
export interface ProvisionResult {
  /** Perfil ativo (LEVE/TURBO). */
  readonly profile: AgentProfileTier;
  /** Resultados por alvo. */
  readonly targets: readonly ProvisionTargetResult[];
  /** Se houve pelo menos um alvo provisionado com sucesso. */
  readonly anySuccess: boolean;
  /** Se TODOS os alvos falharam. */
  readonly allFailed: boolean;
}

// ─── Interface do provisionador (porta abstrata) ───────────────────────────
//
// Esta interface define O QUE o provisionador faz, sem COMO.
// A implementação concreta mora no `@hiperplano/aluy-cli` e faz I/O real.
// Testável com mock/stub injetando implementação fake.

/**
 * Porta ABSTRATA do provisionador de sidecars.
 *
 * Contrato puro em `@hiperplano/aluy-cli-core` — ZERO I/O, ZERO sidecar.
 * A implementação concreta (download, extração, venv, pull de modelos)
 * mora no `@hiperplano/aluy-cli`.
 */
export interface SidecarProvisioner {
  /**
   * Verifica SE um alvo já está provisionado (idempotente).
   * Retorna `true` se o alvo está pronto p/ uso, `false` caso contrário.
   */
  isProvisioned(target: SidecarTarget): Promise<boolean>;

  /**
   * Provisiona UM alvo específico.
   *
   * DEVE verificar proveniência (hash pinado) antes de concluir.
   * DEVE recusar root (uid 0 ⇒ lança erro).
   * DEVE gravar em ~/.aluy/ com perms 0700/0600.
   * DEVE ser idempotente (se já provisionado, retorna sucesso sem reinstalar).
   */
  provision(target: SidecarTarget): Promise<ProvisionTargetResult>;

  /**
   * Provisiona TODOS os alvos cujos toggles estão ON, segundo o perfil.
   *
   * LEVE ⇒ não provisiona nada (retorna resultado vazio).
   * TURBO ⇒ provisiona conforme toggles.
   *
   * Degradável: falha de um alvo não trava os demais.
   */
  provisionAll(
    profile: AgentProfileTier,
    toggles: ReadonlySet<SidecarTarget>,
  ): Promise<ProvisionResult>;
}

// ─── Funções puras (testáveis sem I/O) ────────────────────────────────────

/**
 * Verifica se um hash SHA256 bate com o esperado.
 * Pura — não faz I/O. Útil p/ testar a lógica de verificação.
 */
export function verifySha256(actual: string, expected: string): boolean {
  // Comparação constante em tempo (evita timing attack, mesmo aqui sendo local).
  if (actual.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i++) {
    diff |= actual.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Verifica se o UID atual é root (0).
 * Retorna `true` se for root — o provisionador DEVE recusar.
 */
export function isRoot(uid: number): boolean {
  return uid === 0;
}

/**
 * Determina se o provisionamento DEVE ocorrer.
 * LEVE ⇒ nunca; TURBO ⇒ sempre (mas cada sidecar depende do toggle).
 */
export function shouldProvision(profile: AgentProfileTier): boolean {
  return profile === 'turbo';
}

/**
 * Resolve o conjunto de toggles de sidecar ativos a partir de flags booleanas.
 * Pura — útil p/ testar a resolução de toggles.
 */
export function resolveSidecarToggles(opts: {
  ollama?: boolean;
  mem0?: boolean;
  headroom?: boolean;
}): ReadonlySet<SidecarTarget> {
  const toggles = new Set<SidecarTarget>();
  // Default ON: se não especificado, provisiona (reconciliação default-ON, §2.2-bis).
  if (opts.ollama !== false) toggles.add('ollama');
  if (opts.mem0 !== false) toggles.add('mem0');
  if (opts.headroom !== false) toggles.add('headroom');
  return toggles;
}
