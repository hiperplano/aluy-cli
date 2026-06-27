// EST-0977 · ADR-0061 · CLI-SEC-11 (reaplicado) — `/agents` + `aluy agents`: o
// FORMATADOR PURO que lista os perfis de agente-`.md` que o aluy MAPEOU. Reusa o
// resultado dos MESMOS loaders confinados que o boot/`/doctor` consomem
// (`UserAgentsLoader`/`ProjectAgentsLoader` no @aluy/cli) — aqui só FORMATAMOS o DADO
// já parseado (perfis VÁLIDOS + erros RES-MD-3), sem reimplementar parse nem I/O.
//
// O que mostra (decisão do Tiago: "ver os agentes que ele mapeou"):
//   • VÁLIDOS (✓): por agente, NOME, ESCOPO (global `~/.aluy/agents/` vs projeto
//     `.claude/agents/`), as TOOLS declaradas (⊆ pai — ou "herda do pai" quando
//     ausente) e 1 linha da persona/descrição. NUNCA o `.md` inteiro (1 linha).
//   • REJEITADOS (⚠): nome do arquivo + o MOTIVO EXATO (a `reason` fail-closed do
//     parser, ex.: "tools ilegível ⇒ RES-MD-3") + a DICA de conserto.
//   • VAZIO: aponta onde criar (`~/.aluy/agents/<nome>.md`) e o frontmatter mínimo.
//
// PORTÁVEL (ADR-0053 §8): formatação de string PURA (sem `node:*`, sem I/O). A LEITURA
// confinada dos diretórios é do locus concreto (@aluy/cli, io/); ela ENTREGA os perfis
// + erros aqui. Determinístico/testável sem montar Ink nem tocar o filesystem.

import type { AgentProfile, AgentProfileError, AgentOrigin } from './agent-profile.js';
import { boxTable } from '../util/box-table.js';

/** Uma nota (título + linhas) — espelha o `SlashNote` do @aluy/cli, sem acoplar a ele. */
export interface AgentsListNote {
  readonly title: string;
  readonly lines: readonly string[];
}

/** O DADO já carregado pelos loaders confinados (boot/`/doctor` produzem o MESMO). */
export interface AgentsListInput {
  /** Perfis VÁLIDOS das DUAS camadas (origin distingue global/projeto). */
  readonly profiles: readonly AgentProfile[];
  /** Perfis REJEITADOS (RES-MD-3, fail-closed) das duas camadas — carga visível. */
  readonly errors: readonly AgentProfileError[];
  /**
   * O caminho do dir GLOBAL de agentes (`~/.aluy/agents/`), abreviado p/ exibição
   * (`~/.aluy/agents`). Usado na mensagem de estado VAZIO (onde criar). Opcional —
   * default `~/.aluy/agents`.
   */
  readonly globalDir?: string;
}

/** Rótulo legível do ESCOPO de um perfil (espelha o `originLabel` do MCP). */
export function agentOriginLabel(origin: AgentOrigin): string {
  return origin === 'global' ? 'global · ~/.aluy/agents/' : 'projeto · .claude/agents/';
}

/** Teto de chars da 1 linha de persona/descrição exibida (anti-despejo do `.md`). */
const MAX_PERSONA_LEN = 100;

/**
 * Deriva a 1 LINHA de persona exibida: prefere a `description` do frontmatter; sem
 * ela, a 1ª linha não-vazia do `systemPrompt` (corpo do `.md`). Colapsa espaços,
 * trunca com `…` no teto. NUNCA despeja o `.md` inteiro (regra do DoD). PURO.
 */
export function agentPersonaLine(profile: AgentProfile): string {
  const raw =
    profile.description !== undefined && profile.description.trim() !== ''
      ? profile.description
      : (profile.systemPrompt.split('\n').find((l) => l.trim() !== '') ?? '');
  const flat = raw.replace(/\s+/g, ' ').trim();
  if (flat.length <= MAX_PERSONA_LEN) return flat;
  return `${flat.slice(0, MAX_PERSONA_LEN - 1).trimEnd()}…`;
}

/** Linha das TOOLS declaradas: lista (⊆ pai) ou "herda do pai" quando ausente. PURO. */
export function agentToolsLine(profile: AgentProfile): string {
  if (profile.tools === undefined) {
    return 'tools: herda do pai (⊆ sessão)';
  }
  if (profile.tools.length === 0) {
    // Lista vazia legítima nunca chega (o parser rejeita `tools:` vazio em RES-MD-3),
    // mas defendemos a exibição mesmo assim (nunca uma linha em branco enganosa).
    return 'tools: (nenhuma)';
  }
  return `tools: ${profile.tools.join(', ')} (⊆ pai)`;
}

/**
 * FORMATA a nota completa de `/agents` (e de `aluy agents`, via o mesmo builder): os
 * VÁLIDOS (✓, ordenados por escopo depois por nome) com nome/escopo/tools/persona, e os
 * REJEITADOS (⚠) com o motivo EXATO + a dica de conserto. Estado VAZIO ⇒ a dica de onde
 * criar. PURO/determinístico — o caller (slash OU shell) só empurra/imprime as linhas.
 *
 * `profiles` e `errors` vêm dos MESMOS loaders do boot/`/doctor` (o caller os carrega);
 * este builder NÃO lê o filesystem nem re-parseia — só estrutura o que já foi mapeado.
 */
export function buildAgentsNote(input: AgentsListInput): AgentsListNote {
  const globalDir = input.globalDir ?? '~/.aluy/agents';
  const lines: string[] = [];

  const valid = [...input.profiles].sort((a, b) => {
    // Globais antes de projeto (camada confiável primeiro); depois alfabético por nome.
    if (a.origin !== b.origin) return a.origin === 'global' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  const rejected = [...input.errors].sort((a, b) => a.file.localeCompare(b.file));

  // Estado VAZIO: nada mapeado (nem válido, nem rejeitado).
  if (valid.length === 0 && rejected.length === 0) {
    return {
      title: 'agents',
      lines: [
        `nenhum agente .md mapeado — crie um em ${globalDir}/<nome>.md`,
        'frontmatter mínimo: `name`, `description` e (opcional) `tools:` (lista ⊆ pai);',
        'o corpo do .md é a persona (system prompt) do sub-agente.',
        'são os perfis que o `spawn_agent` (sub-agentes) invoca por nome.',
      ],
    };
  }

  if (valid.length > 0) {
    lines.push(`válidos (${valid.length}) — perfis que o spawn_agent invoca por nome:`);
    const rows = valid.map((p) => [
      p.name,
      p.origin === 'global' ? 'global' : 'projeto',
      p.tools === undefined ? 'herda do pai' : p.tools.length ? p.tools.join(', ') : '(nenhuma)',
      agentPersonaLine(p),
    ]);
    lines.push(...boxTable(['agente', 'escopo', 'tools', 'sobre'], rows, { maxWidths: [18, 8, 24, 44] }));
  }

  if (rejected.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push(`rejeitados (${rejected.length}) — não foram carregados por estarem inválidos:`);
    const rows = rejected.map((e) => [e.file, e.reason]);
    lines.push(...boxTable(['arquivo', 'motivo'], rows, { maxWidths: [22, 52] }));
    lines.push('  conserto: o frontmatter precisa de `name`, corpo (persona) e — se declarar');
    lines.push('  `tools:` — uma LISTA legível (ex.: `tools: read_file, grep`).');
  }

  // Nota de proveniência/escopo (sempre que há algo a listar): global=auto-seleção,
  // projeto=DADO. Curta, 1 linha — orienta sem virar parede de texto.
  lines.push('');
  lines.push(
    'global (~/.aluy/agents/) = config do dono · projeto (.claude/agents/) = dado do repo.',
  );

  return { title: 'agents', lines };
}
