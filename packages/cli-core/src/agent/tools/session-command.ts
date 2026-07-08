// ADR-0147 — emenda o ADR-0127: o agente PASSA a poder disparar comandos de SESSÃO
// (`/doctor`, `/cycle`, `/clear`, …) por UMA via única — a tool nativa `session_command`
// — em vez de só RECOMENDAR o humano a digitar. Cada comando é CLASSIFICADO por efeito
// (`agentEffect`, campo do registro `SlashCommand` em `@hiperplano/aluy-cli`) e a
// classificação decide o roteamento pela MESMA catraca (`decide()`, CLI-SEC-H1):
//
//   read-only / session-effect ⇒ a tool executa DIRETO (allow); o efeito PRÓPRIO do
//     comando (ex.: os `run_command` de dentro de um `/cycle`) segue passando por
//     `decide()` normalmente — nada de novo na catraca além do que o comando já faz.
//   destructive ⇒ a PORTA re-passa `decide()` com um ToolCall SINTÉTICO
//     (`SESSION_COMMAND_DESTRUCTIVE_CALL_NAME`) que a engine (permission/engine.ts)
//     força p/ `ask`/`always-ask:destructive` — NUNCA auto-aprovável (CLI-SEC-3), nem
//     sob `--yolo`/`--unsafe` (o roteamento vive ACIMA da precedência do YOLO — ver o
//     comentário em `engine.ts`). O usuário confirma pelo MESMO `AskResolver` de
//     qualquer outro efeito; deny/timeout/não-interativo ⇒ fail-closed (nada executa).
//   human-only ⇒ DENY honesto (a tool nunca chega a rodar o comando) — comandos que só
//     fazem sentido no terminal do humano (tema/idioma/split/fullscreen/login/quit/…).
//   NÃO-classificado ⇒ DENY (fail-closed): um comando sem `agentEffect` declarado NUNCA
//     vira auto-executável (default seguro, GS-SC5).
//
// FRONTEIRA (ADR-0147 §5): a tool + os tipos + o roteamento pela catraca são CÓDIGO
// portável aqui (`@hiperplano/aluy-cli-core`, sem Ink/I-O de terminal). O REGISTRO
// (`NATIVE_COMMANDS`), a classe de efeito de CADA comando e o EXECUTOR concreto vivem
// no `@hiperplano/aluy-cli` (que possui o registro/TUI) — injetados aqui via a porta
// `SessionCommandPort`, no MESMO padrão de `spawn_agent`/`SubAgentPort`: sem a porta, a
// tool devolve erro (fail-safe — nenhum efeito).

import type { NativeTool, ToolPorts, ToolResult, ToolRunContext } from './types.js';

/** Nome estável da tool (FONTE ÚNICA — referenciado pela engine e pelos testes). */
export const SESSION_COMMAND_TOOL_NAME = 'session_command';

/**
 * ADR-0147 §3 (Q-2) — nome SINTÉTICO de um `ToolCall` que a PORTA (concreta, no
 * `@hiperplano/aluy-cli`) usa p/ RE-PASSAR `decide()` quando o comando classificado é
 * `destructive`. NUNCA é o nome de uma tool REGISTRADA (o loop nunca despacha um
 * tool-call com este nome — só a porta o constrói, internamente, p/ consultar a MESMA
 * `decide()` uma 2ª vez com a categoria certa). A engine (`permission/engine.ts`) o
 * reconhece e força `ask`/`always-ask:destructive`, ACIMA da precedência do `--yolo`
 * (CLI-SEC-3: destrutivo de sessão NUNCA auto-aprova, nem no bypass total).
 */
export const SESSION_COMMAND_DESTRUCTIVE_CALL_NAME = 'session_command:destructive';

/**
 * ADR-0147 §2 — a classe de efeito de um comando de sessão (campo `agentEffect` do
 * `SlashCommand`, `@hiperplano/aluy-cli`). Definida AQUI (core) como o TIPO ÚNICO — o
 * registro em `@hiperplano/aluy-cli` importa este tipo em vez de redeclará-lo (evita
 * drift entre o core, que roteia pela catraca, e o cli, que classifica os comandos).
 */
export type AgentCommandEffect = 'read-only' | 'session-effect' | 'destructive' | 'human-only';

/** O resultado de executar (ou recusar) um comando de sessão pela porta. */
export interface SessionCommandOutcome {
  readonly ok: boolean;
  /** Texto que volta ao modelo como observação (DADO, CLI-SEC-4). */
  readonly text: string;
  /** Pré-visualização exata do efeito (CLI-SEC-9), quando aplicável. */
  readonly display?: string;
}

/**
 * Porta de EXECUÇÃO injetada pelo `@hiperplano/aluy-cli` (que possui o registro
 * `NATIVE_COMMANDS`/a classe de efeito/o executor concreto — `slash/handlers.ts` +
 * `session/controller.ts`). PORTÁVEL no tipo; o CONCRETO faz o roteamento por
 * `agentEffect` (allow direto / RE-PASSA `decide()` p/ destrutivo / deny p/
 * human-only / deny p/ não-classificado) e a execução real. Sem a porta, a tool
 * devolve erro (fail-safe — nenhum efeito), no MESMO padrão do `SubAgentPort`.
 */
export interface SessionCommandPort {
  /**
   * `command` — o nome do comando de sessão SEM a barra (ex.: `cycle`, `doctor`,
   * `clear`), já normalizado (lowercase, trim) pela tool ANTES de chamar a porta.
   * `args` — os argumentos LITERAIS, exatamente como iriam após o comando no
   * composer (ex.: `5m "revisar os testes"` p/ `/cycle`; `full` p/ `/clear`). Texto
   * NÃO-confiável (input do modelo) — nunca instrução privilegiada; a porta concreta
   * o trata como DADO (o mesmo tratamento de um `run_command`).
   */
  run(command: string, args: string, ctx?: ToolRunContext): Promise<SessionCommandOutcome>;
}

// ── validação de input (boundary; input do modelo = NÃO-confiável) ────────────
function parseInput(
  input: Readonly<Record<string, unknown>>,
): { command: string; args: string } | string {
  const rawCommand = input['command'];
  if (typeof rawCommand !== 'string' || rawCommand.trim() === '') {
    return 'session_command requer "command": o nome do comando de sessão SEM a barra (ex.: "doctor", "cycle").';
  }
  // Normaliza: lowercase, tira a barra inicial se o modelo mandar `/doctor` por engano,
  // e trim. A "gramática de slash" (ADR-0147 §1) — o comando é sempre SEM barra aqui.
  const command = rawCommand.trim().toLowerCase().replace(/^\/+/, '');
  const rawArgs = input['args'];
  const args = typeof rawArgs === 'string' ? rawArgs : '';
  return { command, args };
}

const SESSION_COMMAND_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  properties: {
    command: {
      type: 'string',
      description:
        'OBRIGATÓRIO. O nome do comando de sessão SEM a barra (ex.: "doctor", "cycle", "clear"). ' +
        'Os nomes válidos são os mesmos que aparecem em "COMANDOS DA SESSÃO" no seu system prompt.',
    },
    args: {
      type: 'string',
      description:
        'OPCIONAL. Os argumentos LITERAIS, exatamente como iriam após o comando no composer ' +
        '(ex.: \'5m "revisar os testes"\' para "cycle"; "full" para "clear").',
    },
  },
  required: ['command'],
});

/**
 * A tool `session_command` (ADR-0147). `effect: 'exec'` — é uma via genérica de
 * execução (pode disparar QUALQUER comando de sessão) — mas o roteamento REAL pela
 * catraca é por CLASSE, dentro da porta (ver o cabeçalho deste arquivo + `engine.ts`).
 * A tool em si NUNCA decide sozinha: ela só valida o input e delega à porta.
 */
export const sessionCommandTool: NativeTool<ToolPorts> = {
  name: SESSION_COMMAND_TOOL_NAME,
  effect: 'exec',
  group: 'execucao',
  parameters: SESSION_COMMAND_SCHEMA,
  when: 'disparar um comando de SESSÃO listado em "COMANDOS DA SESSÃO" (ex.: /doctor, /cycle, /compact)',
  description:
    'Dispara um comando de SESSÃO (os mesmos comandos que aparecem em "COMANDOS DA SESSÃO" no seu ' +
    'system prompt, sem a barra). Input: { "command": string, "args"?: string }. Comandos read-only/ ' +
    'de efeito de sessão RODAM DIRETO. Comandos DESTRUTIVOS (ex.: "clear full", "clear memory", ' +
    '"logout", "cron rm") SEMPRE pedem confirmação do usuário antes de executar (CLI-SEC-3) — isso é ' +
    'esperado, não um erro. Comandos que só fazem sentido no terminal do humano (tema, idioma, split, ' +
    'fullscreen, login, quit) são RECUSADOS — recomende ao usuário digitá-los. Um comando desconhecido ' +
    'ou não-classificado também é recusado.',
  async run(input, ports, ctx): Promise<ToolResult> {
    const parsed = parseInput(input);
    if (typeof parsed === 'string') return { ok: false, observation: parsed };

    const port = ports.sessionCommand;
    if (!port) {
      return {
        ok: false,
        observation:
          'session_command indisponível: nenhuma porta de comandos de sessão injetada neste locus (fail-safe — nenhum efeito).',
      };
    }

    try {
      const outcome = await port.run(parsed.command, parsed.args, ctx);
      return {
        ok: outcome.ok,
        observation: outcome.text,
        ...(outcome.display !== undefined ? { display: outcome.display } : {}),
      };
    } catch (e) {
      return {
        ok: false,
        observation: `session_command falhou: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  },
};
