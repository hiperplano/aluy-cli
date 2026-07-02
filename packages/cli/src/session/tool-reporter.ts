// EST-0948 — reporta tool-calls executadas à TUI como linhas `⏺` (§2.5/§2.6).
//
// O loop (EST-0944) executa `tool.run(...)` APÓS o gate liberar (allow ou ask
// aprovado). Para a TUI mostrar a linha `⏺ verbo alvo resultado ✓/✗` no momento
// certo, envolvemos cada `NativeTool` num wrapper que, ao terminar o `run`,
// emite um `ToolLineBlock` derivado do `ToolResult` (`display`/`observation`/`ok`).
//
// PORTÁVEL? Este wrapper é do @hiperplano/aluy-cli (liga ao render), mas só usa o contrato
// do core (`NativeTool`/`ToolResult`) — não toca I/O.

import { QUESTION_TOOL_NAME, type NativeTool, type ToolPorts, type ToolResult, type ToolRunContext } from '@hiperplano/aluy-cli-core';
import { clampTarget, type ToolLineBlock } from './model.js';

/** Para onde as linhas de tool são emitidas (a UI). */
export interface ToolReporter {
  report(line: ToolLineBlock): void;
}

/** Verbo curto da tool p/ a linha `⏺` (read/edit/bash/grep/…). */
function verbOf(name: string): string {
  switch (name) {
    case 'read_file':
      return 'read';
    case 'edit_file':
      return 'edit';
    case 'write_file':
      return 'write';
    case 'run_command':
      return 'bash';
    case 'grep':
      return 'grep';
    case 'change_dir':
      return 'cd';
    default:
      return name;
  }
}

/**
 * Alvo legível (path/comando/padrão/pergunta) a partir do input. SEMPRE clampado a
 * 1 linha (`clampTarget`): um batch/heredoc como `command` não pode despejar 100+
 * linhas no transcript — o alvo identifica a ação, não a reproduz.
 */
function targetOf(input: Readonly<Record<string, unknown>>): string {
  const cmd = input['command'];
  if (typeof cmd === 'string') return clampTarget(cmd);
  const path = input['path'];
  if (typeof path === 'string') return clampTarget(path);
  const pattern = input['pattern'];
  if (typeof pattern === 'string') return clampTarget(`/${pattern}/`);
  // `perguntar`: o "alvo" é a própria pergunta (curta, entre aspas) — assim o histórico
  // fica `⏺ perguntar "Qual stack?" → React`, e não um `⏺ perguntar  ok` mudo.
  const q = input['question'] ?? input['prompt'] ?? input['text'] ?? input['message'];
  if (typeof q === 'string' && q.trim() !== '') {
    const t = q.trim();
    return `"${t.length > 48 ? `${t.slice(0, 47)}…` : t}"`;
  }
  return '';
}

/**
 * Resultado QUANTIFICADO a partir da observação/ok (§2.5: nunca vago). Best-effort:
 * extrai uma contagem reconhecível (linhas/hits/exit) ou cai p/ "ok"/"erro".
 */
function quantify(name: string, result: ToolResult): string {
  const obs = result.observation;
  if (name === 'run_command') {
    const m = obs.match(/exit=(-?\d+)/);
    const code = m ? Number(m[1]) : result.ok ? 0 : 1;
    return code === 0 ? '0 erros' : `exit ${code}`;
  }
  if (name === 'read_file') {
    const lines = obs.split('\n').length;
    return `${lines} linhas`;
  }
  if (name === 'grep') {
    if (/nenhum acerto/.test(obs)) return '0 hits';
    const hits = obs.split('\n').filter(Boolean).length;
    return `${hits} hits`;
  }
  if (name === 'edit_file' || name === 'write_file') {
    return result.ok ? 'aplicado' : 'falhou';
  }
  if (name === 'change_dir') {
    return result.ok ? 'ok' : 'falhou';
  }
  // `perguntar`: o resultado É a resposta escolhida (CLI-SEC: `display` traz só a escolha,
  // sem o texto contextual da observação). Mostra `→ <escolha>` no histórico.
  if (name === QUESTION_TOOL_NAME) {
    const chosen = typeof result.display === 'string' ? result.display.trim() : '';
    return chosen !== '' ? `→ ${chosen}` : result.ok ? 'respondido' : 'sem resposta';
  }
  return result.ok ? 'ok' : 'erro';
}

/**
 * EST-0982 (Fase 0) — DIFFSTAT de um `edit_file`/`write_file` (EST-0944): conta linhas
 * `+`/`−` do DIFF unificado que a tool de edição/escrita expõe em `result.display`
 * (CLI-SEC-9). Ignora os cabeçalhos do diff (`+++`/`---`). Best-effort: se a tool não
 * editou ou não há diff, devolve `undefined` (degrada — sem `+/−`). Os números não
 * carregam segredo (só contagem).
 */
function diffstatOf(
  name: string,
  result: ToolResult,
): { added: number; removed: number } | undefined {
  if ((name !== 'edit_file' && name !== 'write_file') || !result.ok) return undefined;
  const diff = result.display;
  if (typeof diff !== 'string' || diff === '') return undefined;
  let added = 0;
  let removed = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) added++;
    else if (line.startsWith('-')) removed++;
  }
  return { added, removed };
}

/**
 * Envolve uma tool nativa p/ reportar a linha `⏺` ao terminar. NÃO altera a
 * semântica: delega o `run` e devolve o MESMO `ToolResult` (o loop não percebe).
 */
export function withToolReport(
  tool: NativeTool<ToolPorts>,
  reporter: ToolReporter,
): NativeTool<ToolPorts> {
  return {
    name: tool.name,
    effect: tool.effect,
    description: tool.description,
    // EST-0982 — REPASSA o `ctx` (signal de abort + streaming `onShellChunk`) à tool
    // envolvida: sem isto, o wrapper engoliria o contexto e um `run_command` do AGENTE
    // perderia o abort dirigido e a saída ao vivo. O wrapper é transparente: só observa
    // o resultado p/ emitir a linha `⏺` (não altera a semântica da execução).
    async run(input, ports, ctx?: ToolRunContext): Promise<ToolResult> {
      const result = await tool.run(input, ports, ctx);
      const status: 'ok' | 'err' = result.ok ? 'ok' : 'err';
      // EST-0982 — diffstat best-effort do edit (alimenta a atividade rica da FlowTree).
      const stat = diffstatOf(tool.name, result);
      const block: ToolLineBlock = {
        kind: 'tool',
        verb: verbOf(tool.name),
        target: targetOf(input),
        result: quantify(tool.name, result),
        status,
        ...(stat ? { added: stat.added, removed: stat.removed } : {}),
        ...(status === 'err' ? { output: truncate(result.observation) } : {}),
      };
      reporter.report(block);
      return result;
    },
  };
}

function truncate(text: string, maxLines = 6): string {
  const lines = text.split('\n');
  if (lines.length <= maxLines) return text;
  return `${lines.slice(0, maxLines).join('\n')}\n… (${lines.length - maxLines} linhas a mais)`;
}
