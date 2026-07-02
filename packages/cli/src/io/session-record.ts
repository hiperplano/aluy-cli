// EST-0972 — funções PURAS do registro de sessão (sem I/O): saneamento dos blocos
// lidos do disco e a RECONSTRUÇÃO do histórico do loop a partir da transcrição.
//
// Separadas do store p/ serem testáveis sem fs e reusadas pelo run.tsx (ao retomar,
// reconstrói o `HistoryItem[]` que semeia o loop como CONTEXTO).
//
// CLI-SEC-4 (fronteira de proveniência) — ao reconstruir o histórico p/ o loop:
//   - `you`   → `goal`        (canal user; é a fala do PRÓPRIO usuário).
//   - `aluy`  → `model`       (canal assistant; é a fala do PRÓPRIO modelo).
//   - `tool`/`bang`/`broker-error` → `observation` (canal user ENVELOPADO como
//      DADO_NAO_CONFIAVEL por `buildMessages`). O conteúdo de tool/`!comando` foi
//      DADO ingerido do ambiente quando ocorreu; ao virar contexto, MANTÉM o
//      envelope original — NÃO é elevado a instrução só porque agora está numa
//      transcrição salva. A transcrição é o histórico da conversa; o que veio do
//      ambiente DENTRO dela continua sendo dado.
//   - `note`/`deny` → descartados do contexto do modelo (são UI/sistema, não
//      conversa com o modelo). Continuam na transcrição VISÍVEL (restaurada na tela),
//      só não viram mensagem p/ o broker.

import type { HistoryItem } from '@hiperplano/aluy-cli-core';
import type { SessionBlock } from '../session/model.js';

/**
 * Tipos de bloco reconhecidos (precisa casar o union `SessionBlock` do model.ts).
 *
 * HUNT-PERSIST (round-trip infiel) — `inject` e `doctor` são blocos VISÍVEIS da
 * transcrição (a nota "↳ encaixado" do mid-turn e a checklist do `/doctor`); ANTES
 * faltavam aqui ⇒ `sanitizeBlocks` os DESCARTAVA no save→load e a transcrição
 * retomada perdia esse conteúdo SILENCIOSAMENTE. Agora round-trippam. `subagents` é
 * DE PROPÓSITO omitido: é um INDICADOR VIVO/transiente (status por filho `running`)
 * sem sentido estático ao retomar — restaurá-lo pintaria um "rodando" eternamente
 * fantasma; o DADO real dos filhos já voltou ao pai como observação (blocksToHistory).
 */
const KNOWN_KINDS = new Set([
  'you',
  'aluy',
  'tool',
  'deny',
  'bang',
  'broker-error',
  'note',
  'inject',
  'doctor',
]);

/** `true` se `v` é uma string (sem `undefined`/null). */
function isStr(v: unknown): v is string {
  return typeof v === 'string';
}

/** `true` se `v` é um inteiro de contagem (finito, >= 0) — diffstat `added`/`removed`. */
function isCount(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0;
}

/** `true` se `v` é um array só de strings. */
function isStrArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

/** Status terminal de uma linha do `/doctor` restaurada (sem `pending` — não há probe vivo). */
function doctorStatusOf(v: unknown): 'ok' | 'warn' | 'fail' {
  return v === 'ok' || v === 'warn' || v === 'fail' ? v : 'warn';
}

/**
 * Saneia UMA linha da checklist do `/doctor` lida do disco. Exige `id`+`label`
 * strings; NORMALIZA o status p/ terminal (`pending` → `warn`: a sessão retomada é
 * inerte, não há check em voo p/ "acender"). `null` se a forma básica falhar.
 */
function sanitizeDoctorCheck(raw: unknown): {
  id: string;
  label: string;
  status: 'ok' | 'warn' | 'fail';
  detail?: string;
  fix?: string;
} | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (!isStr(o.id) || !isStr(o.label)) return null;
  return {
    id: o.id,
    label: o.label,
    status: doctorStatusOf(o.status),
    ...(isStr(o.detail) ? { detail: o.detail } : {}),
    ...(isStr(o.fix) ? { fix: o.fix } : {}),
  };
}

/**
 * Saneia UM bloco desconhecido (vindo do JSON do disco) p/ um `SessionBlock` de
 * confiança, ou `null` se a forma não bate (descartado). Valida por `kind` os
 * campos mínimos de cada bloco. Conservador: campo ausente/errado ⇒ descarta o
 * bloco inteiro (não inventa default que mude o sentido da conversa).
 *
 * Nota: um bloco que estava `streaming`/`running` no disco (ex.: a sessão foi salva
 * no meio de um turno por algum motivo) é NORMALIZADO p/ um estado terminal estável
 * (`streaming:false`; status `running`→`err`) — a transcrição restaurada é inerte,
 * não há stream/tool em voo p/ retomar.
 */
export function sanitizeBlock(raw: unknown): SessionBlock | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const kind = o.kind;
  if (typeof kind !== 'string' || !KNOWN_KINDS.has(kind)) return null;
  switch (kind) {
    case 'you':
      return isStr(o.text) ? { kind: 'you', text: o.text } : null;
    case 'aluy':
      // sempre normaliza p/ NÃO-streaming (a restauração é estática).
      return isStr(o.text) ? { kind: 'aluy', text: o.text, streaming: false } : null;
    case 'tool': {
      if (!isStr(o.verb) || !isStr(o.target) || !isStr(o.result)) return null;
      const status = o.status === 'ok' || o.status === 'err' ? o.status : 'err';
      return {
        kind: 'tool',
        verb: o.verb,
        target: o.target,
        result: o.result,
        status, // 'running' restaurado vira 'err' (não há tool em voo).
        ...(isStr(o.output) ? { output: o.output } : {}),
        ...(isStr(o.verbGerund) ? { verbGerund: o.verbGerund } : {}),
        // HUNT-PERSIST (round-trip infiel — mesma classe do inject/doctor) — o DIFFSTAT
        // do edit/write (`added`/`removed`, EST-0982). Antes era DESCARTADO no save→load:
        // um edit retomado perdia o `+N/−M` (mostrava `+0/−0` no ActivityLog/FlowTree).
        // É DADO ESTÁVEL (a contagem definitiva do diff), não estado transiente — round-
        // trippa fiel agora. `liveOutput` (saída AO VIVO de um `running`) fica DE FORA de
        // propósito: é transiente, substituída pelo `result`/`output` final; a sessão
        // restaurada é inerte (sem comando em voo), então não há saída-ao-vivo a restaurar.
        ...(isCount(o.added) ? { added: o.added } : {}),
        ...(isCount(o.removed) ? { removed: o.removed } : {}),
      };
    }
    case 'deny':
      return isStr(o.verb) && isStr(o.exact)
        ? { kind: 'deny', verb: o.verb, exact: o.exact }
        : null;
    case 'bang': {
      if (!isStr(o.command)) return null;
      const status =
        o.status === 'ok' || o.status === 'err' || o.status === 'blocked' ? o.status : 'err';
      return {
        kind: 'bang',
        command: o.command,
        status, // 'running' restaurado vira 'err'.
        ...(isStr(o.output) ? { output: o.output } : {}),
      };
    }
    case 'broker-error':
      return isStr(o.message)
        ? {
            kind: 'broker-error',
            message: o.message,
            ...(typeof o.status === 'number' ? { status: o.status } : {}),
          }
        : null;
    case 'note':
      return isStr(o.title) && isStrArray(o.lines)
        ? { kind: 'note', title: o.title, lines: o.lines }
        : null;
    case 'inject':
      // HUNT-PERSIST — a nota "↳ encaixado" (mid-turn). É só UI (não vira contexto
      // do modelo — blocksToHistory a ignora), mas FAZ PARTE da transcrição visível;
      // antes sumia no round-trip. Round-trippa fiel agora.
      return isStr(o.text) ? { kind: 'inject', text: o.text } : null;
    case 'doctor': {
      // HUNT-PERSIST — a checklist do `/doctor`. Restaura só linhas válidas, com o
      // status NORMALIZADO p/ terminal (a sessão retomada é inerte — sem probe vivo
      // p/ resolver um `pending`). Sem checks válidos ⇒ descarta o bloco.
      if (!Array.isArray(o.checks)) return null;
      const checks = o.checks
        .map(sanitizeDoctorCheck)
        .filter((c): c is NonNullable<typeof c> => c !== null);
      if (checks.length === 0) return null;
      return {
        kind: 'doctor',
        checks,
        ...(isStr(o.summary) ? { summary: o.summary } : {}),
      };
    }
    default:
      return null;
  }
}

/** Saneia uma lista de blocos: descarta os inválidos, mantém a ordem. PURO. */
export function sanitizeBlocks(raw: unknown): SessionBlock[] {
  if (!Array.isArray(raw)) return [];
  const out: SessionBlock[] = [];
  for (const item of raw) {
    const b = sanitizeBlock(item);
    if (b) out.push(b);
  }
  return out;
}

/** Rótulo de origem da observação reconstruída (p/ o modelo saber a procedência). */
const RESTORED_TOOL_LABEL = 'sessão-anterior';

/**
 * Reconstrói o `HistoryItem[]` p/ semear o loop ao RETOMAR uma sessão. É o contexto
 * que volta como histórico da PRÓPRIA conversa. Preserva a separação de canais
 * (CLI-SEC-4): tool/`!`/erro-de-broker viram `observation` (DADO, envelopado por
 * `buildMessages`); `note`/`deny` são UI e não entram no contexto do modelo.
 *
 * O conteúdo do `tool`/`bang` (resultado + saída) é o DADO que veio do ambiente —
 * mantém o envelope ao voltar; NÃO vira instrução. PURO (sem I/O).
 */
export function blocksToHistory(blocks: readonly SessionBlock[]): HistoryItem[] {
  const out: HistoryItem[] = [];
  for (const b of blocks) {
    switch (b.kind) {
      case 'you':
        out.push({ role: 'goal', text: b.text });
        break;
      case 'aluy':
        if (b.text.trim() !== '') out.push({ role: 'model', text: b.text });
        break;
      case 'tool': {
        // resultado quantificado + (se houve) a saída — tudo como DADO do ambiente.
        const parts = [`${b.verb} ${b.target} → ${b.result || b.status}`];
        if (b.output) parts.push(b.output);
        out.push({ role: 'observation', toolName: RESTORED_TOOL_LABEL, text: parts.join('\n') });
        break;
      }
      case 'bang': {
        const parts = [`! ${b.command} (${b.status})`];
        if (b.output) parts.push(b.output);
        out.push({ role: 'observation', toolName: RESTORED_TOOL_LABEL, text: parts.join('\n') });
        break;
      }
      case 'broker-error':
        out.push({
          role: 'observation',
          toolName: RESTORED_TOOL_LABEL,
          // F184 — rótulo backend-aware (BYO ⇒ "provider local", não "broker").
          text: `(${b.backend === 'local' ? 'erro do provider local' : 'erro de broker'} anterior: ${b.message})`,
        });
        break;
      // `note`/`deny`/`subagents` são UI/sistema — não viram mensagem p/ o modelo
      // (ficam só na transcrição visível). O bloco `subagents` (EST-0969 display) é
      // um INDICADOR transiente de status por filho; o DADO real dos filhos já
      // voltou ao pai como observação via `spawn_agent` (CLI-SEC-4). Sem default que
      // reintroduza dado por engano.
      // EST-0982 (mid-turn) — `inject` é a NOTA "↳ encaixado" (UI): o `user_inject`
      // correspondente já entrou no contexto do turno VIVO (e foi persistido pela
      // continuação do modelo). Restaurar a nota NÃO re-injeta no modelo — só UI.
      // HUNT-PERSIST — `doctor` é UI/sistema (saída de slash-command), igual a
      // `note`: NÃO vira mensagem p/ o modelo (fica só na transcrição visível).
      case 'note':
      case 'deny':
      case 'subagents':
      case 'doctor':
      case 'inject':
        break;
    }
  }
  return out;
}
