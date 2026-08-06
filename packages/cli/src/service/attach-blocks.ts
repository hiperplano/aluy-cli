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
  /**
   * FALHA-FANTASMA — índices de blocos JÁ emitidos que ainda NÃO tinham desfecho
   * (`running`). O tail avança por `slice(emittedCount)`: um bloco resolve IN PLACE
   * (o `resolveToolLine` do controller SUBSTITUI a linha viva, não empurra outra), então
   * sem isto o desfecho REAL nunca seria emitido — o dono ficaria com a linha "…" para
   * sempre. Guardamos o texto emitido p/ só reemitir quando MUDOU de verdade.
   */
  pendentes: Map<number, string>;
}

/** Estado inicial de um tail — SEM sessão vista ainda. */
export function newAttachBlockTailState(): AttachBlockTailState {
  return { emittedCount: 0, pendentes: new Map() };
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
    case 'tool': {
      // FALHA-FANTASMA (dogfooding real) — uma tool EM VOO chegava aqui como `err`
      // (o save demovia `running`→`err`; corrigido em `session-record.ts`). O dono via
      // `spawn_agent → err` no `runner.log` de um agente que estava trabalhando bem.
      // Agora o in-flight aparece pelo que É — no MESMO formato do transcript vivo
      // (`linear.ts`: "verbo alvo — gerúndio"), e sem ` → ` p/ não casar com o filtro
      // de erro do runner. O desfecho REAL chega depois, pela reemissão do
      // `pollNewServiceBlocks` (a linha resolve; não são dois eventos concorrentes).
      if (b.status === 'running') {
        const alvo = b.target !== '' ? ` ${b.target}` : '';
        return { role: 'tool', text: `${b.verb}${alvo} — ${b.verbGerund ?? 'rodando'}…` };
      }
      // ATTACH-CEGO (dogfooding real, palavras do dono: "tá dando erro e não consigo
      // ver") — esta linha usava `b.result || b.status`. Em ERRO o `result` vem VAZIO,
      // então caía no `status` e imprimia só `err`: o dono via "spawn_agent → err" e
      // não tinha COMO descobrir o motivo, nem pelo attach, nem pelo log, nem pela
      // transcrição. A razão SEMPRE existiu — `tool-reporter.ts` já a grava em
      // `output` (`truncate(result.observation)`) justamente quando `status === 'err'`
      // — e era DESCARTADA aqui, no último metro. Passa a ser exibida.
      const motivo = b.status === 'err' ? (b.output ?? '').trim() : '';
      const cauda = motivo !== '' ? `: ${motivo}` : '';
      return {
        role: 'tool',
        text: `${b.verb} ${b.target} → ${b.result || b.status}${cauda}`,
      };
    }
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
 * FALHA-FANTASMA — um bloco AINDA SEM DESFECHO. O autosave incremental (FASE 4) grava
 * a transcrição NO MEIO do turno, então o tail enxerga blocos vivos; eles resolvem
 * IN PLACE e precisam ser reemitidos quando isso acontecer. PURO.
 */
function estaEmVoo(b: SessionBlock): boolean {
  if (b.kind === 'tool' || b.kind === 'bang') return b.status === 'running';
  if (b.kind === 'aluy') return b.streaming === true;
  return false;
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
      state.pendentes.clear();
    }
    const rec = store.load(latest.id);
    if (rec === null) return [];
    const out: AttachBlockSummary[] = [];
    // FALHA-FANTASMA — ANTES dos blocos novos: os que já emitimos SEM desfecho. Um
    // `spawn_agent` de 11 min é emitido "…processando" e resolve IN PLACE; só aqui o
    // dono fica sabendo COMO terminou (e, em erro, POR QUÊ — a cauda do ATTACH-CEGO).
    // A ordem importa: num turno as atividades são sequenciais, então o desfecho do
    // bloco anterior precede os blocos novos.
    for (const [idx, jaEmitido] of [...state.pendentes].sort((a, b) => a[0] - b[0])) {
      const b = rec.blocks[idx];
      if (b === undefined) {
        state.pendentes.delete(idx); // bloco sumiu (rewind/compactação) — nada a dizer.
        continue;
      }
      const s = summarizeSessionBlockForAttach(b);
      if (s === undefined || s.text === jaEmitido) continue; // ainda em voo, sem novidade.
      out.push(s);
      // Só sai da lista quando chega a estado TERMINAL: um `running` que só mudou de
      // texto (gerúndio/alvo) segue sendo acompanhado até resolver de verdade.
      if (estaEmVoo(b)) state.pendentes.set(idx, s.text);
      else state.pendentes.delete(idx);
    }
    for (let i = state.emittedCount; i < rec.blocks.length; i++) {
      const b = rec.blocks[i];
      if (b === undefined) continue;
      const s = summarizeSessionBlockForAttach(b);
      if (s === undefined) continue;
      out.push(s);
      if (estaEmVoo(b)) state.pendentes.set(i, s.text);
    }
    state.emittedCount = rec.blocks.length;
    return out;
  } catch {
    return [];
  }
}
