// ADR-0158 §11 (FASE 4 — attach) — "os blocos da conversa do turno em andamento",
// MELHOR ESFORÇO (missão explícita, item 2): o turno de cada ATIVIDADE do workflow
// roda como `aluy -p` em processo FILHO (`runner.ts`), gravando sessão via o autosave
// já existente, ESCOPADO ao serviço (`ALUY_SERVICE_HOME` ⇒ `SessionStore({baseDir:
// join(serviceDir,'.state')})` — ver `session/run.tsx`). Este módulo faz TAIL desse
// diretório: acha a sessão MAIS RECENTE e devolve só os blocos NOVOS desde a última
// leitura, resumidos a `{role, text}` (o formato que `attach-protocol.ts`, cli-core,
// carrega no evento `block`).
//
// GAP DOCUMENTADO (a via pragmática pediu isto explicitamente antes de degradar):
// desde a FASE 4, `run.tsx` assina o autosave incremental TAMBÉM no ramo headless
// `-p` (antes só salvava UMA vez, no fim do one-shot) — ver o comentário em
// `session/run.tsx` junto de `unsubHeadlessSave`. Isso faz os blocos aparecerem AO
// VIVO, não só ao fim de cada atividade. Se esse autosave incremental se prover
// indisponível num caminho específico (ex.: `--output-format stream-json`/`--cycle`
// não passam pelo `runHeadlessPrint` que fizemos assinar — CONFIRMADO: o runner só
// usa `-p ... --output-format json`, então o caminho coberto é exatamente o usado)
// os blocos só apareceriam ao FIM de cada atividade — ainda assim log+estado
// continuam ao vivo (nunca ficam bloqueados por este best-effort).
//
// I/O concreto (fs, via `SessionStore`) — mora no `cli` (ADR-0053 §8). PURO seria só
// o `summarizeSessionBlockForAttach`; mantido neste arquivo por ser pequeno e único
// consumidor — sem necessidade de um módulo cli-core à parte para uma função que não
// é reusada em nenhum outro lugar do protocolo.

import { join } from 'node:path';
import { SessionStore } from '../io/session-store.js';
import type { SessionBlock } from '../session/model.js';

export interface AttachBlockTailState {
  sessionId?: string;
  emittedCount: number;
}

/** Estado inicial de um tail — SEM sessão vista ainda. */
export function newAttachBlockTailState(): AttachBlockTailState {
  return { emittedCount: 0 };
}

export interface AttachBlockSummary {
  readonly role: string;
  readonly text: string;
}

/**
 * Reduz um `SessionBlock` a `{role, text}` p/ o evento `block` do attach — um espelho
 * TEXTUAL, não a estrutura rica que a TUI (`BlockView`, App.tsx) renderiza (isso
 * exigiria portar componentes Ink pro protocolo, fora de escopo da v1 — §11 fala em
 * "os MESMOS blocos que a TUI já sabe desenhar" como o ALVO de longo prazo; a v1
 * pragmática entrega o CONTEÚDO, não o CHROME). `undefined` p/ blocos que são só
 * UI/transientes (nada de novo pro dono ver no attach).
 */
export function summarizeSessionBlockForAttach(b: SessionBlock): AttachBlockSummary | undefined {
  switch (b.kind) {
    case 'you':
      return b.text.trim() === '' ? undefined : { role: 'you', text: b.text };
    case 'aluy':
      return b.text.trim() === '' ? undefined : { role: 'aluy', text: b.text };
    case 'tool':
      return {
        role: 'tool',
        text: `${b.verb} ${b.target} → ${b.result || b.status}`,
      };
    case 'bang':
      return { role: 'bang', text: `! ${b.command} (${b.status})` };
    case 'note':
      return { role: 'note', text: `${b.title}: ${b.lines.join(' ')}` };
    case 'inject':
      // F193 — o encaixe mid-turno É a fala do dono (mesma voz do `you`).
      return b.text.trim() === '' ? undefined : { role: 'you', text: b.text };
    case 'broker-error':
      return { role: 'erro', text: b.message };
    case 'deny':
    case 'doctor':
    case 'subagents':
    case 'testrun':
      // UI/sistema/transiente — sem sentido no espelho textual do attach (mesma
      // exclusão de `blocksToHistory`/`sanitizeBlocks` p/ `subagents`, e de
      // `deny`/`doctor` no contexto do modelo — aqui é o mesmo racional, aplicado à
      // exibição em vez de ao contexto).
      return undefined;
    default:
      return undefined;
  }
}

/**
 * Acha a sessão MAIS RECENTE do serviço (escopo `<serviceDir>/.state`, o MESMO
 * `baseDir` que `run.tsx` usa via `ALUY_SERVICE_HOME`) e devolve os blocos NOVOS
 * desde a última chamada com este `state` (mutado in-place — o caller mantém UMA
 * instância por conexão de attach ativa, ou uma só compartilhada no processo do
 * runner). NUNCA lança — qualquer falha de leitura devolve `[]` (best-effort; o
 * attach não pode travar por causa disto).
 */
export function pollNewServiceBlocks(
  serviceDir: string,
  state: AttachBlockTailState,
): readonly AttachBlockSummary[] {
  try {
    const store = new SessionStore({ baseDir: join(serviceDir, '.state') });
    const summaries = store.list(); // já ordenado por updatedAt DESC.
    const latest = summaries[0];
    if (latest === undefined) return [];
    if (latest.id !== state.sessionId) {
      // sessão NOVA (nova atividade do workflow abriu um turno-filho novo, sem
      // `--continue` — `runner.ts` spawna cada atividade como sessão fresca) ⇒
      // reseta o contador e emite TUDO dela desde o início.
      state.sessionId = latest.id;
      state.emittedCount = 0;
    }
    const rec = store.load(latest.id);
    if (rec === null) return [];
    const fresh = rec.blocks.slice(state.emittedCount);
    state.emittedCount = rec.blocks.length;
    const out: AttachBlockSummary[] = [];
    for (const b of fresh) {
      const s = summarizeSessionBlockForAttach(b);
      if (s !== undefined) out.push(s);
    }
    return out;
  } catch {
    return [];
  }
}
