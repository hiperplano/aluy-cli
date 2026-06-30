// EST-1109 · ADR-0061 — NOTA de agentes DISPONÍVEIS no contexto do modelo.
// O agente (modelo) PRECISA conhecer o próprio time: quais sub-agentes nomeados
// existem p/ delegar via `spawn_agent` (campo `agent: <nome>`). Esta função monta
// uma nota COMPACTA (cabeçalho instrutivo + 1 linha por agente VÁLIDO) que o caller
// injeta no canal `system` como CONFIG CONFIÁVEL (do dono, como o AGENT.md).
//
// PORTÁVEL (ADR-0053 §8): formatação de string PURA (sem `node:*`, sem I/O). O
// caller (locus concreto, @hiperplano/aluy-cli) alimenta com `agentRegistry.list()` que já
// filtrou os VÁLIDOS (os rejeitados RES-MD-3 NUNCA entram aqui).

import type { AgentProfile } from './agent-profile.js';
import { sanitizeUntrustedDoc } from './tools/tool-param-docs.js';

/** Cabeçalho da seção de agentes disponíveis no `system`. Estável p/ verificação de canal. */
export const AVAILABLE_AGENTS_HEADER =
  'AGENTES DISPONÍVEIS — você tem um TIME de sub-agentes especializados. A CADA tarefa,' +
  ' AVALIE se ela se beneficia de DELEGAR (por especialização ou paralelismo) e, se sim,' +
  ' USE-OS PROATIVAMENTE via a tool `spawn_agent` (campo `agent: <nome>`) — NÃO espere ser' +
  ' pedido. Ex.: feature full-stack ⇒ dev-backend + dev-frontend (+ qa) em paralelo; revisão' +
  ' ⇒ revisor; análise de segurança/arquitetura ⇒ seguranca + arquiteto. Tarefa simples/' +
  'trivial você faz sozinho (não delegue à toa). Cada agente tem persona/tools/tier próprios. O time:';

/** Teto de chars da persona truncada por agente (anti-despejo do `.md` inteiro). */
const MAX_AGENT_LINE_CHARS = 80;

/**
 * Monta a NOTA de agentes disponíveis p/ o canal `system`. Uma linha por agente
 * VÁLIDO: `<nome> — <persona truncada ~80 chars>`. Sem agentes ⇒ `undefined`
 * (não injeta nada — não-regressão). PURO.
 */
export function buildAvailableAgentsNote(profiles: readonly AgentProfile[]): string | undefined {
  if (profiles.length === 0) return undefined;
  const lines = [AVAILABLE_AGENTS_HEADER];
  for (const p of profiles) {
    const rawPersona =
      p.description?.trim() || p.systemPrompt.split('\n').find((l) => l.trim() !== '') || '';
    // GOVERNANÇA-AUTÔNOMA (decisão do dono) — agentes de PROJETO (`.aluy/agents/`) deixam de
    // ter a descrição OMITIDA. Sem ela o modelo não casava tarefa↔especialidade e o dono tinha
    // de NOMEAR o agente toda vez ("preciso dizer toda hora pro agente spawnar agentes"). A
    // `description` de projeto é DADO DE TERCEIRO ⇒ passa por `sanitizeUntrustedDoc` (neutraliza
    // marcadores de cerca / forja de tool-call) e leva a tag ` [projeto]` (proveniência visível).
    // A guarda REAL continua ESTRUTURAL e não exige o dono nomear nada: `toolScope ⊆ pai` (a
    // description pode mentir, mas o agente NUNCA ganha tool fora do escopo do pai) + confirmação
    // de homônimo com agente global. Os GLOBAIS (`~/.aluy/agents/`, dono) seguem sem sanitizar.
    const persona = p.origin === 'project' ? sanitizeUntrustedDoc(rawPersona) : rawPersona;
    const flat = persona.replace(/\s+/g, ' ').trim();
    const truncated =
      flat.length <= MAX_AGENT_LINE_CHARS
        ? flat
        : `${flat.slice(0, MAX_AGENT_LINE_CHARS - 1).trimEnd()}…`;
    const tag = p.origin === 'project' ? ' [projeto]' : '';
    lines.push(`- ${p.name}${tag} — ${truncated}`);
  }
  return lines.join('\n');
}
