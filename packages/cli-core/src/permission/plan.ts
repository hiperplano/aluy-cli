// EST-0959 · ADR-0055 — o TETO read-only do modo Plan (a garantia testável).
//
// Plan é o degrau ABAIXO de `ask`: nesta sessão NÃO há efeito permitido. O agente
// lê e analisa para planejar; nada é escrito, nenhum comando de efeito roda. Não é
// rótulo de UI — é POLÍTICA da engine, avaliada no TOPO de `decide()` (precedência
// 0, antes de categoria/allow-list/hook/`--unsafe`).
//
// ╔══════════════════════════════════════════════════════════════════════════╗
// ║ R1 — ALLOW-LIST FECHADA, DEFAULT-DENY. O que Plan PERMITE vem desta lista   ║
// ║ FECHADA de tools NATIVAS de leitura (nomes), NUNCA de um flag `readonly`/   ║
// ║ `effect` auto-reportado pela tool. Toda tool que não está POSITIVAMENTE na  ║
// ║ lista — inclusive qualquer tool MCP de terceiro, mesmo que se declare       ║
// ║ "readonly" — é EFEITO ⇒ DENY. Marca de efeito auto-reportada NÃO é confiável.║
// ║ R2 — REDE NEGADA em Plan v1: egress (web_fetch/leitura remota) = exfiltração.║
// ║ Plan = leitura LOCAL só. Mesmo uma tool da allow-list cujo alvo pareça uma   ║
// ║ URL/host remoto é tratada como rede ⇒ DENY.                                  ║
// ║ → o `seguranca` (AG-0008) reconfere ISTO com lupa: é a prova "Plan sem-efeito".║
// ╚══════════════════════════════════════════════════════════════════════════╝
//
// PORTÁVEL: só dado + string puro (sem I/O, sem `node:*`).

import type { ToolCall } from './gate.js';
import { RECALL_TOOL_NAME } from '../agent/memory/contract.js';
import { PLAN_TOOL_NAME } from '../agent/tools/plan.js';
import { QUESTION_TOOL_NAME } from '../agent/tools/question.js';

/**
 * R1 — a ALLOW-LIST FECHADA de tools NATIVAS de LEITURA LOCAL permitidas em Plan.
 * É uma lista de NOMES (positiva), não uma classe de efeito auto-reportado. As 4
 * tools nativas de leitura local do Aluy CLI (EST-0944) + `ls`/`glob` (ADR-0055 §3
 * — registradas aqui mesmo antes de existirem como tool nativa, p/ a garantia já
 * cobri-las quando entrarem). QUALQUER nome fora deste Set é efeito ⇒ deny em Plan.
 *
 * Mudar esta lista é mudar a GARANTIA read-only ⇒ é CÓDIGO (kernel-de-cliente),
 * muda só por release. Não é editável em runtime nem por config/hook.
 */
export const PLAN_READ_ALLOWLIST: ReadonlySet<string> = new Set([
  'read_file',
  'grep',
  'ls',
  'glob',
  // EST-0982 — `change_dir` (cd) é NAVEGAÇÃO de sessão, SEM efeito: não escreve, não
  // executa, não faz rede. Permitida em Plan p/ o agente NAVEGAR multi-pasta enquanto
  // PLANEJA (ler/analisar uma subpasta) sem precisar sair do teto read-only. O cwd é
  // sempre ⊆ raiz (clampado) — navegar não vaza nada e não muta o FS. → o `seguranca`
  // (AG-0008) reconfere: `change_dir` move só um ponteiro relativo dentro da raiz.
  'change_dir',
  // EST-0983 (extensão · recall) — `recall` (consulta da memória de agente) é LEITURA
  // LOCAL pura: lê SÓ os fatos da própria conta/máquina (`searchFacts`), sem path, sem
  // efeito, sem REDE (R2 não morde — não há alvo remoto). Permitida em Plan p/ o agente
  // CONSULTAR o que já sabe enquanto PLANEJA, sem sair do teto read-only. Os fatos voltam
  // como DADO (B): consultar não autoriza nada — qualquer efeito derivado re-passa a
  // catraca. → o `seguranca` reconfere: read-only da memória local, sem egress.
  RECALL_TOOL_NAME,
  // EST-1015 — `update_plan` (checklist) é declaração de INTENÇÃO do próprio agente, SEM
  // efeito externo (não escreve, não executa, não faz rede, não fala com outro agente; o
  // input do modelo é normalizado com tetos). Permitida em Plan porque é JUSTAMENTE no modo
  // Plan que declarar/refinar um plano faz mais sentido (o agente planeja read-only e mostra
  // os passos). R2 (alvo remoto) nunca morde — não há URL/host. → sinalizado ao `seguranca`
  // (AG-0008): mexe na allow-list do ADR-0055, mas a tool é estado de UI local sem egress.
  PLAN_TOOL_NAME,
  // EST-1110 · ADR-0114 — `perguntar` é PERGUNTA ao usuário, SEM efeito externo (não
  // escreve, não executa, não faz rede, não fala com outro agente). Permitida em Plan
  // porque esclarecer COM o usuário é exatamente o que se quer durante o planejamento
  // read-only. R2 (alvo remoto) nunca morde — não há URL/host. → sinalizado ao
  // `seguranca` (AG-0008): estado de UI local, mesma classe do `update_plan`.
  QUESTION_TOOL_NAME,
]);

/**
 * R2 — detecta se a chamada (mesmo de uma tool da allow-list) tem um ALVO REMOTO
 * (URL/host). Em Plan v1 toda rede é negada (egress = exfiltração). Conservador
 * (fail-safe): qualquer input que pareça uma URL `http(s)://`, um `scheme://`, ou
 * um `user@host`/`host:porta` remoto ⇒ rede ⇒ deny. Só dado/string (portável).
 */
export function looksRemote(call: ToolCall): boolean {
  for (const v of Object.values(call.input)) {
    if (typeof v !== 'string') continue;
    if (/\bhttps?:\/\//i.test(v)) return true;
    // qualquer esquema de URL remoto (ftp://, ssh://, ws://, gs://, s3://, …),
    // EXCETO `file://` (que é LOCAL e permitido).
    if (/\b(?!file:)[a-z][a-z0-9+.-]*:\/\//i.test(v)) return true;
    // user@host (scp/ssh-like) com um host que tem ponto (FQDN) ou dois-pontos+porta.
    if (/\b[\w.-]+@[\w.-]+\.[\w.-]+/.test(v)) return true;
    if (/\b[\w.-]+\.[\w.-]+:\d+\b/.test(v)) return true;
  }
  return false;
}

/**
 * O CORAÇÃO de Plan (R1+R2+R4): uma chamada é PERMITIDA em Plan SE-E-SÓ-SE o NOME
 * está na allow-list fechada de leitura local E o alvo NÃO é remoto. Tudo o mais
 * (efeito, tool não-marcada, tool MCP de terceiro, rede) ⇒ NÃO permitida ⇒ a
 * engine devolve DENY (não ask). É deny-por-default: a função só diz "sim" para o
 * conjunto positivamente marcado.
 */
export function isPlanReadAllowed(call: ToolCall): boolean {
  if (!PLAN_READ_ALLOWLIST.has(call.name)) return false; // R1: default-deny
  if (looksRemote(call)) return false; // R2: rede negada em Plan v1
  return true;
}
