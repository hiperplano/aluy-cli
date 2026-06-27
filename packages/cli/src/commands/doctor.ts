// EST-0970 — `aluy doctor` (shell): o MESMO health-check do `/doctor` da sessão, em
// TEXTO no stdout, com EXIT≠0 quando há ✗ (útil em script/CI). Read-only: só
// diagnostica + sugere o comando de conserto; NÃO conserta nada e NÃO gasta modelo
// (o único egress é o ping do broker em /healthz). Degrada: cada check é
// independente — um falhar não derruba os outros (o probe blinda cada gatherer).
//
// Estilo do `/doctor` do Claude Code (referência de DESIGN, sem cópia — Q9).

import { LoginService, AgentMemory } from '@aluy/cli-core';
import { realTerminalIO, type TerminalIO } from '../auth/io.js';
import { loadAuthConfig } from '../auth/config.js';
import { KeychainCredentialStore } from '../auth/keychain-store.js';
import { NodeWorkspace } from '../io/workspace.js';
import { NodeMemoryStore } from '../io/memory-store.js';
import { StdioMcpTransport } from '../mcp/stdio-transport.js';
import { gatherDoctorFacts, type DoctorProbeDeps, type MemoryCounter } from '../doctor/probe.js';
import {
  buildDoctorReport,
  buildSingleCheck,
  hasFailure,
  plannedCheckIds,
} from '../doctor/checks.js';
import { renderDoctor, ASCII_DOCTOR_GLYPHS } from '../doctor/render.js';
import { testTierLive } from '../doctor/tier-test.js';
import { UserConfigStore, resolveInitialTier } from '../io/user-config.js';
import { DEFAULT_TIER } from '../session/wiring.js';

export interface DoctorCommandDeps {
  readonly io?: TerminalIO;
  readonly env?: NodeJS.ProcessEnv;
  /**
   * EST-0970 (--deep / opt-in que GASTA modelo) — quando `true`, ADICIONA o teste do tier
   * ao vivo (1 chamada mínima ao modelo). Sem isto, o `aluy doctor` NÃO chama o modelo
   * (valida auth via GET). Em teste, `deps.probe.tierTester` substitui o tester real.
   */
  readonly deep?: boolean;
  /**
   * EST-0970 (--json) — quando `true`, em vez dos ticks progressivos, imprime no stdout
   * um JSON.stringify de um array {id, status, label, detail} com os checks. Sem --json,
   * a saída atual fica IGUAL.
   */
  readonly json?: boolean;
  /**
   * Override do probe inteiro (testes injetam fatos prontos sem tocar keychain/rede/
   * fs). Em produção, ausente ⇒ o `aluy doctor` monta os gatherers reais.
   */
  readonly probe?: DoctorProbeDeps;
}

/**
 * `aluy doctor` — diagnóstico read-only com VALIDAÇÃO ATIVA e ticks PROGRESSIVOS. Imprime
 * uma linha `◷ <check>: testando…` por item ANTES de rodar e, conforme cada check resolve,
 * imprime a linha final `✓/⚠/✗ <check>: <detalhe>` (+ a dica de conserto). Devolve o EXIT
 * CODE: `1` se há QUALQUER ✗, `0` caso contrário (tudo ok/⚠). É o contrato p/ CI/script.
 *
 * Com `--json`, não imprime ticks — coleta e imprime um JSON.stringify de um array
 * `{id, status, label, detail}` no stdout (stdout limpo p/ script). Exit code segue o mesmo
 * contrato (≠0 se ✗). O fix não é incluído no JSON.
 */
export async function runDoctor(deps: DoctorCommandDeps = {}): Promise<number> {
  const io = deps.io ?? realTerminalIO();
  const env = deps.env ?? process.env;
  const jsonMode = deps.json === true;

  // Em produção monta os gatherers reais (token p/ os probes autenticados + validação de
  // credencial via GET + handshake MCP real + memória local). Testes passam `deps.probe`.
  const base: DoctorProbeDeps = deps.probe ?? buildRealProbeDeps(env, deps.deep === true);
  // O `--deep` é deduzido da presença do `tierTester` (igual à sessão) — coerente entre
  // o probe real e o injetado em teste.
  const deep = base.tierTester !== undefined;

  if (!jsonMode) {
    // ── caminho NORMAL (texto com ticks) ──
    io.out('aluy doctor — diagnóstico');
    io.out('');
    for (const p of plannedCheckIds(deep)) io.out(`◷ ${p.label}: testando…`);

    const probeDeps: DoctorProbeDeps = {
      ...base,
      onCheck: (id, facts) => {
        const check = buildSingleCheck(id, facts);
        if (!check) return;
        const g =
          check.status === 'ok'
            ? ASCII_DOCTOR_GLYPHS.ok
            : check.status === 'warn'
              ? ASCII_DOCTOR_GLYPHS.warn
              : ASCII_DOCTOR_GLYPHS.fail;
        io.out(`${g} ${check.label}: ${check.detail}`);
        if (check.status !== 'ok' && check.fix !== undefined) io.out(`    → ${check.fix}`);
      },
    };

    const facts = await gatherDoctorFacts(probeDeps);
    const report = buildDoctorReport(facts);
    const lines = renderDoctor(report, ASCII_DOCTOR_GLYPHS);
    io.out('');
    io.out(lines[lines.length - 1] ?? '');

    return hasFailure(report) ? 1 : 0;
  }

  // ── caminho JSON: sem ticks, sem onCheck — coleta tudo e despeja JSON.stringify ──
  const facts = await gatherDoctorFacts(base);
  const report = buildDoctorReport(facts);
  const jsonArr = report.checks.map((c) => ({
    id: c.id,
    status: c.status,
    label: c.label,
    detail: c.detail,
  }));
  io.out(JSON.stringify(jsonArr));
  return hasFailure(report) ? 1 : 0;
}

/** Monta as dependências REAIS do probe p/ o shell (token + memória local + MCP connect). */
function buildRealProbeDeps(env: NodeJS.ProcessEnv, deep: boolean): DoctorProbeDeps {
  return {
    env,
    getAccessToken: () => realAccessToken(env),
    memory: realMemoryCounter(),
    // CONECTA de verdade cada server MCP (mesmo transport stdio do boot; environ mínimo +
    // cwd no cwd corrente — CLI-SEC-7/FU-VAU-11-bis). Timeout curto por server (degrada).
    makeMcpTransport: () => new StdioMcpTransport({ cwd: process.cwd(), parentEnv: env }),
    // --deep (opt-in que GASTA modelo): teste do tier ao vivo. Sem a flag, ausente ⇒ o
    // probe NÃO chama o modelo. O tier corrente do shell é o default resolvido do env.
    ...(deep
      ? {
          tierTester: () =>
            testTierLive({
              tier: resolveShellTier(),
              login: realLogin(env),
              env,
            }),
        }
      : {}),
  };
}

/** Constrói o `LoginService` real (keychain) p/ token/validação/teste de tier. */
function realLogin(env: NodeJS.ProcessEnv): LoginService {
  const cfg = loadAuthConfig(env);
  const store = new KeychainCredentialStore();
  return new LoginService({ ...cfg, baseUrl: cfg.identityBaseUrl, store });
}

/** Provedor de token (best-effort) p/ os probes autenticados do catálogo/custom + auth. */
function realAccessToken(env: NodeJS.ProcessEnv): Promise<string> {
  return realLogin(env).getAccessToken();
}

/**
 * Tier corrente p/ o teste `--deep` do shell: o salvo no `~/.aluy/config.json` (fail-safe)
 * ou o `DEFAULT_TIER`. O shell não tem sessão viva, então usa a preferência persistida.
 */
function resolveShellTier(): string {
  try {
    const cfg = new UserConfigStore({}).load();
    return resolveInitialTier(undefined, cfg, DEFAULT_TIER);
  } catch {
    return DEFAULT_TIER;
  }
}

/**
 * Contador de memória sobre o store local (global + projeto do cwd). Só conta os
 * fatos — NÃO despeja conteúdo (DoD). Store ilegível ⇒ `null` (vira ✗ "memória").
 */
function realMemoryCounter(): MemoryCounter {
  return {
    async count() {
      try {
        const workspace = new NodeWorkspace({});
        const store = new NodeMemoryStore({ workspace });
        const memory = new AgentMemory({ store });
        return (await memory.list()).length;
      } catch {
        return null;
      }
    },
  };
}
