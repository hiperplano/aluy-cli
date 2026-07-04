// `aluy config` — VISÃO CONSOLIDADA, read-only, da configuração efetiva.
//
// Motivação (achado do dono): o `~/.aluy/config.json` é ESPARSO (só grava o que foi mudado
// do default), então abri-lo no editor "não mostra tudo" e dá a impressão de que falta
// unificação. Na verdade o schema JÁ unifica a configuração durável num arquivo; o que faltava
// era DESCOBERTA. Este comando lista cada chave efetiva, o VALOR e a ORIGEM
// (default / env ALUY_* / config.json), na precedência real `flag > env > config.json > default`
// — SEM materializar defaults no arquivo nem colapsar as fronteiras de segurança (segredos no
// keychain, MCP no mcp.json, hooks no hooks.json ficam de propósito FORA do config.json).
//
// Read-only: NÃO escreve nada, NÃO gasta modelo, NÃO toca rede. `--json` p/ script.

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_MAX_TOKENS,
  DEFAULT_MAX_ITERATIONS,
  DEFAULT_MAX_MEMORY_WRITES_PER_SESSION,
  MAX_SUBAGENTS_PER_CALL,
  DEFAULT_MAX_CONCURRENCY,
  DEFAULT_SUBAGENT_IDLE_TIMEOUT_MS,
  DEFAULT_CYCLE_DURATION_MS,
  DEFAULT_CYCLE_ITERATIONS,
  DEFAULT_CYCLE_INTERVAL_MS,
} from '@hiperplano/aluy-cli-core';
import { realTerminalIO, type TerminalIO } from '../auth/io.js';
import { UserConfigStore } from '../io/user-config.js';
import { DEFAULT_GC_MAX_AGE_MS, DEFAULT_GC_MAX_COUNT } from '../io/session-store.js';
import { DEFAULT_AUTORESUME_WINDOW_MS } from '../session/resume.js';
import { resolveLocalProviderConfig, resolveModelBackend } from '../model/local/config.js';
import {
  DEFAULT_MCP_CONNECT_TIMEOUT_MS,
  DEFAULT_MCP_CALL_TIMEOUT_MS,
} from '../mcp/stdio-transport.js';

export interface ConfigCommandDeps {
  readonly io?: TerminalIO;
  readonly env?: NodeJS.ProcessEnv;
  /** Raiz do `~/.aluy/` (default: `<home>/.aluy`). Injetável p/ teste. */
  readonly baseDir?: string;
  /** Override do store de config (testes injetam um config pronto). */
  readonly configStore?: UserConfigStore;
  /** `--json`: imprime um JSON estável em vez da tabela (stdout limpo p/ script). */
  readonly json?: boolean;
}

type Origin = 'default' | 'env' | 'config.json';

interface Setting {
  /** Nome lógico da chave (ex.: `backend`, `localProvider`). */
  readonly key: string;
  /** Valor EFETIVO já resolvido. */
  readonly value: string;
  /** De onde o valor veio, pela precedência. */
  readonly origin: Origin;
  /** Fonte concreta: a env var (se origin=env) ou o campo do config.json. */
  readonly source: string;
}

/**
 * Resolve um setting env-sobreponível: env ALUY_* > config.json > default. `sourcePath`
 * é o rótulo da origem em config.json (default `config.${key}`); passado explícito p/
 * chaves ANINHADAS (ex.: `limits.maxTokens` mora em `config.limits.maxTokens`, F185).
 */
function pickEnvConfig(
  key: string,
  envVar: string,
  envVal: string | undefined,
  configVal: unknown,
  defaultVal: string,
  sourcePath?: string,
): Setting {
  const e = envVal?.trim();
  if (e !== undefined && e !== '') return { key, value: e, origin: 'env', source: envVar };
  if (configVal !== undefined && configVal !== null)
    return {
      key,
      value: String(configVal),
      origin: 'config.json',
      source: sourcePath ?? `config.${key}`,
    };
  return { key, value: defaultVal, origin: 'default', source: '—' };
}

/** Resolve um setting SÓ de config (sem env): config.json > default. */
function pickConfig(key: string, configVal: unknown, defaultVal: string): Setting {
  if (configVal !== undefined && configVal !== null)
    return { key, value: String(configVal), origin: 'config.json', source: `config.${key}` };
  return { key, value: defaultVal, origin: 'default', source: '—' };
}

/** Constrói a lista de settings efetivos com origem (a precedência real do boot). */
export function collectSettings(
  env: NodeJS.ProcessEnv,
  config: ReturnType<UserConfigStore['load']>,
): Setting[] {
  // Defaults puros: resolve com env/config VAZIOS p/ extrair o que o catálogo/domínio default.
  const def = resolveLocalProviderConfig({ env: {}, config: {} });
  const defaultBaseUrl = def.baseUrl ?? '—';

  const settings: Setting[] = [
    pickEnvConfig(
      'backend',
      'ALUY_BACKEND',
      env.ALUY_BACKEND,
      config.backend,
      resolveModelBackend({ env: {}, config: {} }),
    ),
    pickEnvConfig(
      'localProvider',
      'ALUY_LOCAL_PROVIDER',
      env.ALUY_LOCAL_PROVIDER,
      config.localProvider,
      def.provider,
    ),
    pickEnvConfig(
      'localModel',
      'ALUY_LOCAL_MODEL',
      env.ALUY_LOCAL_MODEL,
      config.localModel,
      def.model,
    ),
    pickEnvConfig('localAuth', 'ALUY_LOCAL_AUTH', env.ALUY_LOCAL_AUTH, config.localAuth, def.auth),
    pickEnvConfig(
      'localBaseUrl',
      'ALUY_LOCAL_BASE_URL',
      env.ALUY_LOCAL_BASE_URL,
      config.localBaseUrl,
      defaultBaseUrl,
    ),
    pickConfig('profile', config.profile, 'turbo'),
    pickConfig('sidecar.ollama', config.sidecarToggles?.ollama, 'on (default)'),
    pickConfig('sidecar.mem0', config.sidecarToggles?.mem0, 'on (default)'),
    pickConfig('sidecar.headroom', config.sidecarToggles?.headroom, 'on (default)'),
    pickConfig('lang', config.lang, 'auto'),
    pickConfig('theme', config.theme, 'default'),
    // F185 — limites/orçamento (ADR-0150 balde a): env ALUY_MAX_* > config.limits > default.
    // Estavam AUSENTES da view de config efetiva, apesar de o doctor os mostrar e serem
    // env-sobreponíveis — quem depurava orçamento não via o valor efetivo nem a origem.
    pickEnvConfig(
      'maxTokens',
      'ALUY_MAX_TOKENS',
      env.ALUY_MAX_TOKENS,
      config.limits?.maxTokens,
      String(DEFAULT_MAX_TOKENS),
      'config.limits.maxTokens',
    ),
    pickEnvConfig(
      'maxOutputTokens',
      'ALUY_MAX_OUTPUT_TOKENS',
      env.ALUY_MAX_OUTPUT_TOKENS,
      config.limits?.maxOutputTokens,
      '— (do servidor/tier)',
      'config.limits.maxOutputTokens',
    ),
    pickEnvConfig(
      'maxIterations',
      'ALUY_MAX_ITERATIONS',
      env.ALUY_MAX_ITERATIONS,
      config.limits?.maxIterations,
      String(DEFAULT_MAX_ITERATIONS),
      'config.limits.maxIterations',
    ),
    // ADR-0150 (balde b) — os 10 tunables NOVOS (Tier 1): mesmo padrão pickEnvConfig/
    // pickConfig acima. Cada um tem um teto-teto hardcoded no core/cli (não aparece
    // aqui — só o valor EFETIVO + origem, como os demais).
    pickEnvConfig(
      'limits.maxMemoryWritesPerSession',
      'ALUY_MAX_MEMORY_WRITES_PER_SESSION',
      env.ALUY_MAX_MEMORY_WRITES_PER_SESSION,
      config.limits?.maxMemoryWritesPerSession,
      String(DEFAULT_MAX_MEMORY_WRITES_PER_SESSION),
      'config.limits.maxMemoryWritesPerSession',
    ),
    pickEnvConfig(
      'subagents.maxPerCall',
      'ALUY_SUBAGENT_MAX_PER_CALL',
      env.ALUY_SUBAGENT_MAX_PER_CALL,
      config.subagents?.maxPerCall,
      String(MAX_SUBAGENTS_PER_CALL),
      'config.subagents.maxPerCall',
    ),
    pickEnvConfig(
      'subagents.maxConcurrency',
      'ALUY_SUBAGENT_MAX_CONCURRENCY',
      env.ALUY_SUBAGENT_MAX_CONCURRENCY,
      config.subagents?.maxConcurrency,
      String(DEFAULT_MAX_CONCURRENCY),
      'config.subagents.maxConcurrency',
    ),
    pickEnvConfig(
      'subagents.idleTimeoutMs',
      'ALUY_SUBAGENT_IDLE_TIMEOUT',
      env.ALUY_SUBAGENT_IDLE_TIMEOUT,
      config.subagents?.idleTimeoutMs,
      String(DEFAULT_SUBAGENT_IDLE_TIMEOUT_MS),
      'config.subagents.idleTimeoutMs',
    ),
    pickConfig(
      'cycle.defaultDurationMs',
      config.cycle?.defaultDurationMs,
      String(DEFAULT_CYCLE_DURATION_MS),
    ),
    pickConfig(
      'cycle.defaultIterations',
      config.cycle?.defaultIterations,
      String(DEFAULT_CYCLE_ITERATIONS),
    ),
    pickConfig(
      'cycle.defaultIntervalMs',
      config.cycle?.defaultIntervalMs,
      String(DEFAULT_CYCLE_INTERVAL_MS),
    ),
    pickEnvConfig(
      'mcp.connectTimeoutMs',
      'ALUY_MCP_CONNECT_TIMEOUT_MS',
      env.ALUY_MCP_CONNECT_TIMEOUT_MS,
      config.mcp?.connectTimeoutMs,
      String(DEFAULT_MCP_CONNECT_TIMEOUT_MS),
      'config.mcp.connectTimeoutMs',
    ),
    pickEnvConfig(
      'mcp.callTimeoutMs',
      'ALUY_MCP_TIMEOUT_MS',
      env.ALUY_MCP_TIMEOUT_MS,
      config.mcp?.callTimeoutMs,
      String(DEFAULT_MCP_CALL_TIMEOUT_MS),
      'config.mcp.callTimeoutMs',
    ),
    pickConfig('session.gcMaxAgeMs', config.session?.gcMaxAgeMs, String(DEFAULT_GC_MAX_AGE_MS)),
    pickConfig('session.gcMaxCount', config.session?.gcMaxCount, String(DEFAULT_GC_MAX_COUNT)),
    pickConfig(
      'session.autoResumeWindowMs',
      config.session?.autoResumeWindowMs,
      String(DEFAULT_AUTORESUME_WINDOW_MS),
    ),
  ];
  return settings;
}

/** Os OUTROS arquivos de `~/.aluy/` (fora do config.json DE PROPÓSITO) + seu papel. */
function fileMap(baseDir: string): Array<{ path: string; role: string; exists: boolean }> {
  const f = (rel: string, role: string) => {
    const path = join(baseDir, rel);
    return { path, role, exists: existsSync(path) };
  };
  return [
    f('config.json', 'configuração durável (este comando)'),
    f('mcp.json', 'servers MCP (interop; sem credencial — CLI-SEC-7)'),
    f('hooks.json', 'hooks (fronteira de execução; o agente nunca escreve)'),
    f('providers.json', 'catálogo de providers (override do usuário)'),
    f('update-check.json', 'estado/cache (reescrito pela máquina)'),
    // F186 — estado do usuário que faltava na descoberta: sessões (histórico das
    // conversas), auditoria (trilha dos efeitos — CLI-SEC), agendamentos, exports e undo.
    f('sessions', 'histórico das sessões/conversas (retomável com --resume)'),
    f('audit.jsonl', 'trilha de auditoria dos efeitos (append-only — CLI-SEC)'),
    f('cron', 'tarefas agendadas (aluy cron)'),
    f('exports', 'transcrições exportadas (/export)'),
    f('undo', 'pilha de undo das edições do agente'),
    f('memory', 'store do mem0 (chromadb + history)'),
    f('logs', 'logs dos sidecars (mem0/ollama/headroom)'),
  ];
}

const ORIGIN_GLYPH: Record<Origin, string> = {
  env: 'env',
  'config.json': 'config',
  default: 'default',
};

/**
 * `aluy config` — imprime a configuração efetiva (valor + origem) num lugar só. Read-only.
 * Exit 0 sempre (é diagnóstico, não há falha a reportar). `--json` ⇒ JSON estável no stdout.
 */
export function runConfig(deps: ConfigCommandDeps = {}): number {
  const io = deps.io ?? realTerminalIO();
  const env = deps.env ?? process.env;
  const baseDir = deps.baseDir ?? join(homedir(), '.aluy');
  const store = deps.configStore ?? new UserConfigStore({ baseDir });
  const config = store.load();
  const settings = collectSettings(env, config);
  const files = fileMap(baseDir);

  if (deps.json === true) {
    io.out(
      JSON.stringify(
        {
          configPath: join(baseDir, 'config.json'),
          settings: settings.map((s) => ({
            key: s.key,
            value: s.value,
            origin: s.origin,
            source: s.source,
          })),
          files: files.map((x) => ({ path: x.path, role: x.role, exists: x.exists })),
        },
        null,
        2,
      ),
    );
    return 0;
  }

  io.out('aluy config — configuração efetiva (read-only)');
  io.out(`  arquivo durável: ${join(baseDir, 'config.json')}`);
  io.out('  precedência: flag > env (ALUY_*) > config.json > default');
  io.out('');

  // Tabela: chave · valor · origem · fonte.
  const keyW = Math.max(...settings.map((s) => s.key.length), 3);
  const valW = Math.max(...settings.map((s) => s.value.length), 5);
  for (const s of settings) {
    const origin = ORIGIN_GLYPH[s.origin];
    const src = s.origin === 'default' ? '' : `  (${s.source})`;
    io.out(`  ${s.key.padEnd(keyW)}  ${s.value.padEnd(valW)}  [${origin}]${src}`);
  }

  io.out('');
  io.out('  outros arquivos (fora do config.json de propósito — segredo/interop/execução):');
  for (const x of files) {
    const mark = x.exists ? '·' : '○';
    io.out(`    ${mark} ${x.path}  — ${x.role}`);
  }
  io.out('');
  io.out('  segredos (chave de API/token) ficam no keychain do SO, NUNCA no config.json.');
  return 0;
}
