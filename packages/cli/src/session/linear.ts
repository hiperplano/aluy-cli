// EST-0948 — modo LINEAR (não-TTY): a saída SEM Ink/ANSI quando não há TTY (§6/§9,
// item de a11y do DoD). Vive separado do `run.tsx` (render/spawn Ink, I/O puro) p/
// ser LÓGICA testável: serializa cada bloco da sessão numa linha rotulada de texto
// plano — sem box, sem códigos de escape ANSI. Em não-TTY NÃO há ask interativo ⇒
// o AskResolver nega por fail-safe (deny por inação); o agente segue e a linha
// registra a recusa.

import {
  cleanAluyForDisplay,
  type HistoryItem,
  type TierCatalogEntry,
} from '@hiperplano/aluy-cli-core';
import type { SessionController } from './controller.js';
import type { SessionBlock } from './model.js';
import { parseAtMentions, stripMentions, type AttachReader } from '../attach/index.js';
import { FALLBACK_TIERS, tierLine, applyTierLiteral } from '../model/catalog.js';
import type { UndoOutcome } from './undo-controller.js';
import { buildThemeEffect, buildLangEffect, buildProviderEffect } from '../slash/handlers.js';
import { parseMemoryCommand, runMemoryCommand } from '../slash/memory.js';
import { parseTodoCommand, runTodoCommand } from '../slash/todo.js';
import { parseClearCommand, runClearCommand, isDestructiveClear } from '../slash/clear.js';
import type { ThemeName } from '../ui/theme/themes.js';
import type { Lang } from '../i18n/index.js';
import type { AgentMemory } from '@hiperplano/aluy-cli-core';

/**
 * F184 — rótulo do diagnóstico de erro de chamada ao modelo, backend-aware. No BYO
 * (`backend === 'local'`) NÃO há broker ⇒ "erro do provider local" (a mensagem do bloco
 * já diz "…provider local"; o prefixo fixo "erro de broker" a contradizia). Ausente ⇒
 * "erro de broker" (retrocompat: blocos/testes sem o campo mantêm o rótulo original).
 */
function brokerErrorLabel(backend: 'local' | 'broker' | undefined): string {
  return backend === 'local' ? 'erro do provider local' : 'erro de broker';
}

/** Saída mínima p/ a escrita linear — `process.stdout` ou um fake de teste. */
export interface LinearOut {
  write(chunk: string): void;
}

// EST-0987 — separador SUTIL entre turnos no modo linear (não-TTY): traço CURTO de
// texto PURO (sem ANSI/box) — equivalente plano da divisória sutil da TUI. Emitido
// ANTES de cada `[você]` que não abre a saída. ASCII puro (a11y/piped/CI).
const TURN_SEP = '-'.repeat(12);

/** Opções do modo linear (EST-0957: fallback `@path` literal sem TTY). */
export interface RunLinearOptions {
  /** Leitor confinado p/ resolver `@path` LITERAL no objetivo (não-TTY). */
  readonly attachReader?: AttachReader;
  /**
   * EST-0972 — histórico de uma sessão RETOMADA (`--continue`/`--resume`) a SEMEAR
   * no contexto do loop ANTES do objetivo. São `HistoryItem` reconstruídos da
   * transcrição salva (já com a separação de canais — observação fica como dado).
   * O loop os trata como qualquer `attachment`: inertes, só contexto.
   */
  readonly seedHistory?: readonly HistoryItem[];
  /**
   * EST-1007 — SILENCIA o PROGRESSO human-readable no STDERR (stderr fica limpo).
   * `false` (default) ⇒ emite linhas de progresso no stderr durante o loop headless
   * (text/json). Só afeta o ramo text/json (`runHeadlessPrint`); no `stream-json`
   * o progresso já vai no stdout e o quiet é sempre efetivo.
   * LIGADO por default — o usuário VÊ o progresso; `--quiet` para scripts mudos.
   */
  readonly quiet?: boolean;
  /**
   * VERBOSO — mostra, no progresso do stderr, o COMANDO/alvo de cada tool (`b.target`) e o
   * RESULTADO/saída ao concluir, em vez de só `· bash ✓`. Ligado pelo instalador de sidecars
   * (`ALUY_PRINT_VERBOSE=1`) p/ o dono ACOMPANHAR o que o agente roda (apt/pip/curl). Default:
   * `process.env.ALUY_PRINT_VERBOSE === '1'`.
   */
  readonly verbose?: boolean;
}

/**
 * EST-0957 — resolve as menções `@path` LITERAIS de um objetivo (não-TTY). Cada
 * `@caminho` plausível é lido pelo reader confinado/path-deny; os anexos OK viram
 * `HistoryItem` (dado rotulado), os rejeitados são AVISADOS em `notes` (linha
 * `[anexo] …`). Devolve o goal SEM as menções + os itens + as notas de rejeição.
 */
export async function resolveLinearMentions(
  goal: string,
  reader: AttachReader | undefined,
): Promise<{ goal: string; items: readonly HistoryItem[]; notes: readonly string[] }> {
  const mentions = parseAtMentions(goal);
  if (!reader || mentions.length === 0) return { goal, items: [], notes: [] };
  const items: HistoryItem[] = [];
  const notes: string[] = [];
  for (const m of mentions) {
    const res = await reader.attach(m.path);
    if (res.kind === 'ok') {
      items.push(res.item);
      notes.push(`[anexo] @${res.path}${res.truncated ? ' (truncado)' : ''}`);
    } else {
      notes.push(`[anexo recusado] @${m.path} — ${res.reason}`);
    }
  }
  return { goal: stripMentions(goal, mentions), items, notes };
}

/**
 * Roda o loop e imprime cada bloco numa linha rotulada de texto plano (§9), sem
 * box/ANSI. Sem objetivo ⇒ orienta o uso e retorna (nada a fazer sem TTY).
 *
 * SUTILEZA do streaming (bug do E2E não-TTY): o bloco `aluy` é EMPURRADO vazio no
 * `onStart` e depois MUTADO IN-PLACE (mesmo índice) a cada delta até o `onDone`.
 * Imprimir "o que é novo por índice" no 1º snapshot pegava o bloco AINDA VAZIO e
 * nunca via os deltas que chegam depois — o stdout saía só com o `[você]`. Em
 * não-TTY não há render incremental token-a-token útil (saída piped/CI), então a
 * regra é: imprime um bloco quando ele ESTABILIZA. O último bloco, se for um
 * `aluy` ainda em `streaming`, fica PENDENTE (não imprime) até finalizar ou até
 * surgir um bloco depois dele; ao fim do turno, dá FLUSH no que sobrou. Assim a
 * fala final do modelo (o "pong") sempre sai — uma vez, com o texto completo.
 */
export async function runLinear(
  controller: SessionController,
  goal: string | undefined,
  out: LinearOut,
  opts: RunLinearOptions = {},
): Promise<void> {
  if (goal === undefined || goal.trim() === '') {
    out.write('aluy: sem objetivo e sem TTY — nada a fazer. Use `aluy "objetivo"`.\n');
    return;
  }
  // EST-0958 — `!comando` LITERAL no não-TTY (decisão do DoD): roda o atalho de
  // shell ATRÁS DA CATRACA (mesma do run_command), em vez de tratar como objetivo p/
  // o modelo. Sem TTY NÃO há ask interativo ⇒ o AskResolver nega por fail-safe: a
  // leitura pura (`!ls`) roda e a saída sai; o efeito (`!rm -rf`) é BLOQUEADO (deny
  // por inação) — a catraca NÃO é contornada por ser não-TTY. A saída sai linear.
  const bangGoal = goal.trim();
  if (bangGoal.startsWith('!')) {
    const command = bangGoal.slice(1).trim();
    if (command === '') {
      out.write('aluy: `!` sem comando — nada a rodar.\n');
      return;
    }
    let printedBang = 0;
    const unsub = controller.subscribe((state) => {
      for (let i = printedBang; i < state.blocks.length; i++) {
        const b = state.blocks[i]!;
        // Só emite o bloco bang quando ESTABILIZA (não `running`) — evita a linha
        // parcial do in-flight (mesma regra do streaming/tool acima).
        if (b.kind === 'bang' && b.status === 'running') break;
        const line = linearize(b);
        if (line !== '') out.write(line + '\n');
        printedBang = i + 1;
      }
    });
    try {
      await controller.runBang(command);
    } finally {
      unsub();
    }
    return;
  }
  // EST-0957 — resolve `@path` literais ANTES do loop (fallback não-TTY). As notas
  // de anexo/recusa saem primeiro (transparência: o usuário vê o que foi anexado).
  const resolved = await resolveLinearMentions(goal, opts.attachReader);
  for (const note of resolved.notes) out.write(note + '\n');
  const effectiveGoal = resolved.goal.trim() === '' ? goal : resolved.goal;
  // EST-0981 — a mecânica de streaming linear (segura-último-mutável + flush final) é
  // a MESMA do `/cycle` não-TTY; vive em `streamBlocksLinear` (sem duplicar a regra).
  await streamBlocksLinear(controller, out, async () => {
    // EST-0972 — semeia o histórico da sessão retomada ANTES dos anexos do turno.
    // O loop ingere ambos como contexto (observação = dado); a ordem preserva a
    // cronologia: conversa anterior, depois os `@anexos` do objetivo atual.
    const attachments =
      opts.seedHistory && opts.seedHistory.length > 0
        ? [...opts.seedHistory, ...resolved.items]
        : resolved.items;
    await controller.submit(effectiveGoal, attachments);
  });
}

/** EST-1007 — resultado de um turno HEADLESS (`-p`): o texto final + o veredito. */
export interface HeadlessPrintResult {
  /** O texto final do assistente (já limpo p/ exibição), pronto p/ o stdout. */
  readonly result: string;
  /** `true` = turno OK; `false` = houve falha (broker-error / objetivo negado). */
  readonly ok: boolean;
  /** Diagnóstico curto da falha (vai p/ o STDERR, nunca p/ o stdout). undefined se OK. */
  readonly diagnostic?: string;
}

/**
 * EST-1007 — modo HEADLESS one-shot (`aluy -p "prompt"`, igual `claude -p`). Roda o
 * objetivo pelo MESMO loop/catraca do não-TTY (`controller.submit`) e devolve SÓ o
 * TEXTO FINAL do assistente — sem o chrome rotulado do `runLinear` (`[aluy]`/`[tool]`/
 * notas), pronto p/ pipe/script. NÃO escreve nada no stdout por si: o caller decide o
 * destino (stdout p/ o resultado, stderr p/ diagnóstico) e o exit code (a partir de `ok`).
 *
 * SEGURANÇA (fail-closed, sinalizado ao `seguranca`): o headless NÃO tem TTY p/
 * perguntar ⇒ o caller DEVE pôr o `AskResolver` em não-interativo ANTES (deny por
 * inação). Aqui só consumimos o resultado: a catraca (`decide`/CLI-SEC-H1) é intocada.
 *
 * O VEREDITO (`ok`) vem da presença de um bloco `broker-error` (1ª chamada falhou:
 * sem credencial/402/5xx) — caso em que `result` fica VAZIO e o diagnóstico (HG-2,
 * neutro) vai p/ o `diagnostic`. Sem fala final do modelo (turno só-tool sem prosa)
 * também conta como falha "vazia" (script precisa de um $? confiável).
 *
 * PROGRESSO HUMAN-READABLE: quando `opts.quiet !== true`, ASSINA o controller ANTES
 * do submit e emite linhas curtas no STDERR (process.stderr.write) a cada transição
 * relevante: mudança de fase, tool que inicia/termina. O stdout (resultado final)
 * NÃO é poluído — PRINCÍPIO UNIX: stdout = dado, stderr = progresso. No formato
 * stream-json NÃO duplica (o stream-json já emite tudo no stdout).
 */
export async function runHeadlessPrint(
  controller: SessionController,
  goal: string,
  opts: RunLinearOptions = {},
): Promise<HeadlessPrintResult> {
  // Resolve `@path` literais do objetivo (mesmo fallback confinado do não-TTY). As
  // notas de anexo/recusa são DIAGNÓSTICO (stderr-bound) — não poluem o resultado.
  const resolved = await resolveLinearMentions(goal, opts.attachReader);
  const effectiveGoal = resolved.goal.trim() === '' ? goal : resolved.goal;
  const attachments =
    opts.seedHistory && opts.seedHistory.length > 0
      ? [...opts.seedHistory, ...resolved.items]
      : resolved.items;

  // EST-1007 — PROGRESSO NO STDERR (default ligado). Assina o controller ANTES do
  // submit e emite linhas human-readable no stderr a cada transição relevante.
  // Só ativo quando `quiet !== true` (padrão: quiet = false ⇒ progresso ligado).
  // Progresso é BEST-EFFORT: só assina se o controller expõe `subscribe` (a TUI/produto
  // sempre expõe; stubs mínimos de teste do resultado headless podem não — não quebrar
  // por isso). `--quiet` desliga; sem subscribe ⇒ pula silenciosamente.
  const showProgress = opts.quiet !== true && typeof controller.subscribe === 'function';
  // VERBOSO (ALUY_PRINT_VERBOSE=1, ligado pelo instalador): mostra o comando + a saída.
  const verbose = opts.verbose ?? process.env.ALUY_PRINT_VERBOSE === '1';
  /** Trunca p/ uma linha de progresso legível (sem poluir). */
  const oneLine = (s: string, max: number): string => {
    const flat = s.replace(/\s+/g, ' ').trim();
    return flat.length > max ? flat.slice(0, max - 1) + '…' : flat;
  };
  let unsubProgress: (() => void) | undefined;
  if (showProgress) {
    const emitted = new Set<string>();
    let lastPhase: string | undefined;

    unsubProgress = controller.subscribe((state) => {
      // Mudança de fase
      if (state.phase !== lastPhase) {
        lastPhase = state.phase;
        if (state.phase !== 'idle' && state.phase !== 'boot') {
          process.stderr.write(`» ${state.phase}\n`);
        }
      }
      // Blocos novos ou com status alterado
      for (let i = 0; i < state.blocks.length; i++) {
        const b = state.blocks[i]!;
        const status =
          b.kind === 'aluy'
            ? b.streaming
              ? 'streaming'
              : 'stable'
            : b.kind === 'tool'
              ? b.status
              : b.kind === 'subagents'
                ? b.children.some((c) => c.status === 'running')
                  ? 'running'
                  : 'done'
                : 'stable';
        const key = `${i}::${b.kind}::${status}`;
        if (emitted.has(key)) continue;
        emitted.add(key);

        // tool running
        if (b.kind === 'tool' && b.status === 'running') {
          // VERBOSO: mostra o comando/alvo (`sudo apt install …`, `curl …`); senão só o verbo.
          const what = verbose && b.target ? ` ${oneLine(b.target, 120)}` : '…';
          process.stderr.write(`· ${b.verb}${what}\n`);
        }
        // tool done/error
        if (b.kind === 'tool' && b.status !== 'running') {
          const ok = b.status === 'ok';
          const head = verbose && b.target ? `${b.verb} ${oneLine(b.target, 100)}` : b.verb;
          process.stderr.write(`  ${ok ? '✓' : '✗'} ${head}\n`);
          // VERBOSO: a saída relevante (resultado quantificado + cauda do output), indentada.
          if (verbose) {
            const out = b.result || b.output || b.liveOutput;
            if (out) process.stderr.write(`      ${oneLine(out, 200)}\n`);
          }
        }
      }
    });
  }

  try {
    await controller.submit(effectiveGoal, attachments);
  } finally {
    if (unsubProgress) unsubProgress();
  }

  // EST-0947 — parada por budget (headless): o BudgetGate pausa o loop. Como o
  // AskResolver não-interativo nega por inação, o turno termina SEM fala final.
  // A fonte do dado é o StopReason retornado pelo loop (AgentRunResult.stop),
  // exposto via `controller.lastRunResult` — a leitura de phase/pendingBudget
  // do observer NÃO é confiável em headless (setBudget pode não disparar).
  const stop = controller.lastRunResult?.stop;
  if (stop && stop.kind === 'limit') {
    return {
      result: '',
      ok: false,
      diagnostic: `parado por limite de budget: ${stop.message}`,
    };
  }

  const blocks = controller.blocks;
  // Falha de broker (1ª chamada): o resultado é vazio; o diagnóstico (neutro, HG-2)
  // vai p/ o stderr e o exit code reflete a falha. É o "broker fora / sem credencial".
  const brokerError = [...blocks].reverse().find((b) => b.kind === 'broker-error');
  if (brokerError && brokerError.kind === 'broker-error') {
    return {
      result: '',
      ok: false,
      diagnostic: `${brokerErrorLabel(brokerError.backend)}: ${brokerError.message}${
        brokerError.status !== undefined ? ` (${brokerError.status})` : ''
      }`,
    };
  }
  // O texto final = a ÚLTIMA fala `aluy` ESTABILIZADA (não streaming), já limpa dos
  // marcadores de protocolo (cleanAluyForDisplay) — a MESMA limpeza do `[aluy]` linear,
  // só que SEM o rótulo. É o "resultado" scriptável.
  let finalText = '';
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i]!;
    if (b.kind === 'aluy' && b.streaming !== true) {
      finalText = cleanAluyForDisplay(b.text).trim();
      if (finalText !== '') break;
    }
  }
  if (finalText === '') {
    // Turno sem fala final (só-tool, ou negado sem prosa). Não há resultado a imprimir;
    // o script precisa de um $?≠0 confiável + um diagnóstico no stderr.
    return {
      result: '',
      ok: false,
      diagnostic: 'o objetivo não produziu uma resposta final do assistente.',
    };
  }
  return { result: finalText, ok: true };
}

/**
 * EST-1007 — stream-json: emite EVENTOS AO VIVO como NDJSON no stdout durante o
 * loop headless. Assina o controller ANTES de submeter o objetivo, faz diff dos
 * blocks a cada notificação de estado e emite 1 JSON por linha para cada bloco
 * NOVO ou que MUDOU de status. Ao fim, emite o evento `result`.
 *
 * O stdout contém APENAS NDJSON válido (nada de texto solto). Diagnóstico (notas
 * de anexo/recusa) vai para o stderr.
 */
export async function runHeadlessStreamJson(
  controller: SessionController,
  goal: string,
  out: LinearOut,
  opts: RunLinearOptions = {},
): Promise<HeadlessPrintResult> {
  // Resolve `@path` literais (diagnóstico vai para o stderr, não polui o stdout NDJSON).
  const resolved = await resolveLinearMentions(goal, opts.attachReader);
  const effectiveGoal = resolved.goal.trim() === '' ? goal : resolved.goal;
  const attachments =
    opts.seedHistory && opts.seedHistory.length > 0
      ? [...opts.seedHistory, ...resolved.items]
      : resolved.items;

  // Rastreador de blocos já emitidos: chave = `${index}::${kind}::${status||streaming}`
  const emitted = new Set<string>();
  let lastPhase: string | undefined;

  /** Emite um evento NDJSON se ainda não foi emitido (pela chave). */
  const emitIfNew = (block: SessionBlock, index: number): void => {
    const status =
      block.kind === 'aluy'
        ? block.streaming
          ? 'streaming'
          : 'stable'
        : block.kind === 'tool'
          ? block.status
          : block.kind === 'subagents'
            ? block.children.some((c) => c.status === 'running')
              ? 'running'
              : 'done'
            : 'stable';
    const key = `${index}::${block.kind}::${status}`;
    if (emitted.has(key)) return;
    emitted.add(key);

    switch (block.kind) {
      case 'tool': {
        if (block.status === 'running') {
          out.write(
            JSON.stringify({
              type: 'tool_call',
              name: block.verb,
              status: 'running',
            }) + '\n',
          );
        } else {
          const isErr = block.status === 'err';
          out.write(
            JSON.stringify({
              type: 'tool_result',
              name: block.verb,
              status: isErr ? 'error' : 'done',
              ...(isErr ? {} : { exitCode: 0 }),
            }) + '\n',
          );
        }
        break;
      }
      case 'aluy': {
        if (!block.streaming && block.text.trim() !== '') {
          // Só emite texto quando estável (não-streaming) — evita fragmentos parciais.
          out.write(
            JSON.stringify({
              type: 'text',
              text: block.text,
            }) + '\n',
          );
        }
        break;
      }
      case 'broker-error': {
        out.write(
          JSON.stringify({
            type: 'error',
            message: block.message,
            ...(block.status !== undefined ? { status: block.status } : {}),
          }) + '\n',
        );
        break;
      }
      // tool_line, deny, bang, subagents, note, doctor, inject — não emitem eventos
      // específicos no stream-json (ou são cobertos por outros tipos ou são UI interna).
      default:
        break;
    }
  };

  const unsub = controller.subscribe((state) => {
    // Emite mudança de fase
    if (state.phase !== lastPhase) {
      lastPhase = state.phase;
      if (state.phase !== 'idle' && state.phase !== 'boot') {
        out.write(JSON.stringify({ type: 'phase', phase: state.phase }) + '\n');
      }
    }
    // Diff dos blocks: emite blocos novos ou com status alterado
    for (let i = 0; i < state.blocks.length; i++) {
      emitIfNew(state.blocks[i]!, i);
    }
  });

  try {
    await controller.submit(effectiveGoal, attachments);
  } finally {
    unsub();
  }

  // EST-0947 — parada por budget (headless stream-json): usa o StopReason
  // retornado pelo loop (AgentRunResult.stop), exposto via controller.lastRunResult.
  const stop = controller.lastRunResult?.stop;
  if (stop && stop.kind === 'limit') {
    out.write(
      JSON.stringify({
        type: 'result',
        result: '',
        ok: false,
        stop: stop.kind,
        reason: stop.message,
        limit: stop.limit,
      }) + '\n',
    );
    return {
      result: '',
      ok: false,
      diagnostic: `parado por limite de budget: ${stop.message}`,
    };
  }

  // Determina o resultado final (mesma lógica do runHeadlessPrint)
  const blocks = controller.blocks;
  const brokerError = [...blocks].reverse().find((b) => b.kind === 'broker-error');
  if (brokerError && brokerError.kind === 'broker-error') {
    const result = {
      result: '',
      ok: false,
      diagnostic: `${brokerErrorLabel(brokerError.backend)}: ${brokerError.message}${brokerError.status !== undefined ? ` (${brokerError.status})` : ''}`,
    };
    out.write(JSON.stringify({ type: 'result', result: '', ok: false }) + '\n');
    return result;
  }

  let finalText = '';
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i]!;
    if (b.kind === 'aluy' && b.streaming !== true) {
      finalText = cleanAluyForDisplay(b.text).trim();
      if (finalText !== '') break;
    }
  }

  const ok = finalText !== '';
  if (!ok) {
    out.write(JSON.stringify({ type: 'result', result: '', ok: false }) + '\n');
    return {
      result: '',
      ok: false,
      diagnostic: 'o objetivo não produziu uma resposta final do assistente.',
    };
  }

  out.write(JSON.stringify({ type: 'result', result: finalText, ok: true }) + '\n');
  return { result: finalText, ok: true };
}

/**
 * EST-0981 — DRIVER de streaming linear COMPARTILHADO (extraído do `runLinear`):
 * assina o controller, imprime cada bloco quando ESTABILIZA (segura o último
 * enquanto mutável — `aluy` streaming / `tool` running / `subagents` com filho
 * rodando), roda a `action` (submit ou cycle) e dá o FLUSH final do que sobrou. NÃO
 * duplica a regra de emissão — `runLinear` E `runCycleLinear` usam a MESMA mecânica.
 */
export async function streamBlocksLinear(
  controller: SessionController,
  out: LinearOut,
  action: () => Promise<void>,
): Promise<void> {
  let printed = 0;
  let lastBlocks: readonly SessionBlock[] = [];
  let emittedAny = false;
  const emit = (block: SessionBlock): void => {
    const line = linearize(block);
    // Bloco que serializa vazio (ex.: turno aluy só-tool, sem fala) não vira
    // uma linha em branco no stdout — simplesmente não imprime.
    if (line === '') return;
    // EST-0987 — RESPIRO entre turnos no não-TTY: um turno começa num bloco `you`;
    // antes de cada `you` que NÃO é o 1º emitido, um traço CURTO de texto plano
    // separa o turno anterior do novo (equivalente linear da divisória sutil da
    // TUI). Sem ANSI/box — texto puro `-` (a11y/piped/CI), nunca a régua cheia.
    if (block.kind === 'you' && emittedAny) out.write(TURN_SEP + '\n');
    out.write(line + '\n');
    emittedAny = true;
  };
  const flush = (blocks: readonly SessionBlock[], upTo: number): void => {
    for (let i = printed; i < upTo; i++) emit(blocks[i]!);
    if (upTo > printed) printed = upTo;
  };
  const unsubscribe = controller.subscribe((state) => {
    lastBlocks = state.blocks;
    // Imprime tudo que já ESTABILIZOU: todos menos o último se ele ainda está
    // MUTÁVEL (vai mudar e sairia parcial). Seguramos:
    //  - um `aluy` em `streaming` (texto ainda chegando), e
    //  - uma `tool` em `running` (in-flight: a linha final c/ resultado vem depois,
    //    via atualização IN-PLACE — §6/§9: em não-TTY emite SÓ a linha concluída).
    const last = state.blocks[state.blocks.length - 1];
    const holdLast =
      last !== undefined &&
      ((last.kind === 'aluy' && last.streaming) ||
        (last.kind === 'tool' && last.status === 'running') ||
        // EST-0969 (display): segura o indicador de sub-agentes enquanto QUALQUER
        // filho roda — emite UMA vez, com o status final por filho (não a cada
        // transição parcial). Mesma regra do aluy streaming / tool in-flight.
        (last.kind === 'subagents' && last.children.some((c) => c.status === 'running')));
    flush(state.blocks, holdLast ? state.blocks.length - 1 : state.blocks.length);
  });
  try {
    await action();
    // FLUSH final: o último bloco (a fala final do modelo / a nota de parada do
    // ciclo) finaliza no `onDone`, mas se o último snapshot ainda o segurou como
    // `streaming` (corrida de timing) ele não saiu — garante a saída a partir do
    // ÚLTIMO estado observado.
    flush(lastBlocks, lastBlocks.length);
  } finally {
    unsubscribe();
  }
}

/**
 * EST-0981 · ADR-0062 (APR-0067) · CLI-SEC-14 — `/cycle` em modo NÃO-TTY (§9). Roteia
 * pela MESMA mecânica do TTY (`controller.cycle(args)` → `CycleEngine`/`SharedBudget`),
 * NUNCA cai no agente como objetivo. Sem isto, `aluy "/cycle rode para sempre"` piped
 * virava um OBJETIVO p/ o modelo (a LLM criava um `cycle_forever.sh`) em vez de RECUSAR
 * por falta de teto. As paradas DURAS valem IDÊNTICAS no linear (CLI-SEC-14, RES-L-*):
 *   • sem-teto ⇒ `NoCeilingError` ⇒ nota "NÃO inicia" (zero ciclos, zero broker);
 *   • tetos (duração/iterações/budget agregado) e anti-loop-vazio param o motor;
 *   • parável pelo MESMO freio (interrupt) — herdado do `controller.cycle`.
 * Em não-TTY os asks por-ciclo já auto-negam (AskResolver não-interativo = fail-safe).
 * Cada bloco (o eco `/cycle …`, os turnos de cada ciclo, a nota de parada) sai linear
 * pela MESMA `streamBlocksLinear` do `runLinear`. Devolve `true` se TRATOU a linha.
 */
export async function runCycleLinear(
  controller: SessionController,
  goal: string | undefined,
  out: LinearOut,
): Promise<boolean> {
  const line = (goal ?? '').trim();
  if (line !== '/cycle' && !line.startsWith('/cycle ')) return false;
  const args = line === '/cycle' ? '' : line.slice('/cycle '.length).trim();
  // Espelha o TTY (run.tsx): SEM argumento ⇒ a nota de USO + o lembrete anti-runaway
  // (sem teto, o /cycle NÃO inicia). NÃO cai no agente, NÃO chama o motor.
  if (args === '') {
    out.write(
      '[/cycle] uso: `/cycle <intervalo|--por dur> "tarefa"` — ' +
        'ex.: `/cycle 5m "rode os testes e corrija o que quebrar"`.\n',
    );
    out.write(
      '[/cycle] sem teto (duração/iterações/intervalo), o /cycle NÃO inicia ' +
        '— é uma proteção contra execução sem fim.\n',
    );
    return true;
  }
  // Roda os ciclos pela MESMA mecânica do TTY. O `controller.cycle` já trata o
  // sem-teto (NoCeilingError ⇒ nota, zero ciclos), os tetos, o anti-loop-vazio e a
  // parabilidade — tudo emitido linear pela `streamBlocksLinear` (eco + ciclos + nota).
  await streamBlocksLinear(controller, out, async () => {
    await controller.cycle(args);
  });
  return true;
}

/**
 * EST-0962 — fonte mínima do catálogo p/ o `/model` linear (não-TTY). O cliente do
 * broker a satisfaz; em teste injeta-se um stub. Falha ⇒ fallback de tiers conhecidos.
 */
export interface LinearCatalog {
  list(): Promise<readonly TierCatalogEntry[]>;
}

/** Controle mínimo de tier p/ o `/model <tier>` linear (o controller o satisfaz). */
export interface LinearTierControl {
  setTier(tier: string, model?: string): void;
}

/**
 * EST-0962 — `/model` em modo NÃO-TTY (§9, DoD): sem picker. SEM argumento ⇒ LISTA
 * os tiers (uma linha por tier, `[model] Strata · … · padrão`, marcando o ativo);
 * com argumento (`/model aluy-deep`) ⇒ TROCA o tier e confirma. O catálogo vem do
 * broker; falha (offline/sem scope) ⇒ FALLBACK de tiers conhecidos + aviso NEUTRO
 * (HG-2: "broker", nunca o provider). Devolve `true` se TRATOU um `/model`.
 */
export async function runModelLinear(
  goal: string | undefined,
  out: LinearOut,
  deps: { catalog: LinearCatalog; tier: LinearTierControl; currentTier: string },
): Promise<boolean> {
  const line = (goal ?? '').trim();
  if (line !== '/model' && !line.startsWith('/model ')) return false;
  const arg = line === '/model' ? '' : line.slice('/model '.length).trim();

  if (arg !== '') {
    // `/model <tier>` LITERAL: troca direto (sem rede — o broker valida na chamada).
    const note = applyTierLiteral((t, m) => deps.tier.setTier(t, m), arg);
    for (const l of note.lines) out.write(`[${note.title}] ${l}\n`);
    return true;
  }

  // `/model` sem arg: lista os tiers do catálogo (ou fallback).
  let entries: readonly TierCatalogEntry[];
  let fellBack = false;
  try {
    const fetched = await deps.catalog.list();
    entries = fetched.length > 0 ? fetched : FALLBACK_TIERS;
    fellBack = fetched.length === 0;
  } catch {
    // HG-2: erro NEUTRO — qualquer falha de broker cai no fallback de tiers conhecidos.
    entries = FALLBACK_TIERS;
    fellBack = true;
  }
  for (const e of entries) {
    const active = e.key === deps.currentTier ? ' (ativo)' : '';
    out.write(`[model] ${tierLine(e)}${active}\n`);
  }
  if (fellBack) {
    out.write('[model] ◍ catálogo do broker indisponível — tiers conhecidos\n');
  }
  return true;
}

/** Controle mínimo de `/undo`/`/redo` p/ o modo linear (o UndoController o satisfaz). */
export interface LinearUndoControl {
  undo(force?: boolean): Promise<UndoOutcome>;
  redo(): Promise<UndoOutcome>;
}

/**
 * EST-0960b — `/undo`/`/redo` em modo NÃO-TTY (§9, DoD). Sem TTY NÃO há prompt
 * interativo de confirmação: em edição concorrente (CA-3) o linear EMITE o aviso e
 * NÃO sobrescreve (fail-safe — confirmar exige um TTY; nunca decide sozinho perder
 * trabalho do usuário). O aviso de barreira já vem REDIGIDO (R9) do controller. Cada
 * linha sai rotulada `[undo]`/`[redo]`. Devolve `true` se TRATOU a linha.
 */
export async function runUndoLinear(
  goal: string | undefined,
  out: LinearOut,
  undoControl: LinearUndoControl,
): Promise<boolean> {
  const line = (goal ?? '').trim().toLowerCase();
  if (line !== '/undo' && line !== '/redo') return false;
  const outcome = line === '/undo' ? await undoControl.undo() : await undoControl.redo();
  // `confirm` (concorrência) no não-TTY: emite o aviso e PÁRA (não há como confirmar
  // sem TTY) — acrescenta a nota explícita de que nada foi escrito.
  const lines =
    outcome.kind === 'confirm'
      ? [...outcome.note.lines, 'sem TTY — não há confirmação interativa; nada foi alterado.']
      : outcome.note.lines;
  for (const l of lines) out.write(`[${outcome.note.title}] ${l}\n`);
  return true;
}

/**
 * EST-0966 — `/theme` em modo NÃO-TTY (§9): sem picker, sem OSC 11 (não há terminal
 * a quem perguntar). SEM argumento ⇒ LISTA os temas marcando o ativo. Com argumento
 * (`/theme light`) ⇒ registra a troca pretendida (a sessão não-TTY não re-renderiza
 * — saída piped/CI; o tema vale num terminal interativo). Devolve `true` se TRATOU.
 */
export function runThemeLinear(
  goal: string | undefined,
  out: LinearOut,
  deps: { currentTheme: ThemeName },
): boolean {
  const line = (goal ?? '').trim();
  if (line !== '/theme' && !line.startsWith('/theme ')) return false;
  const arg = line === '/theme' ? '' : line.slice('/theme '.length).trim();
  const effect = buildThemeEffect(arg, deps.currentTheme);
  if (effect.kind === 'theme') {
    for (const l of effect.note.lines) out.write(`[${effect.note.title}] ${l}\n`);
  }
  return true;
}

/**
 * EST-0989 (i18n) — `/lang`/`/lang <code>` LITERAL no NÃO-TTY (sem picker; sem
 * re-render): lista os idiomas ou registra a troca pretendida e retorna. Espelha o
 * `runThemeLinear`. O idioma ATIVO no não-TTY é o resolvido no boot (flag>config>auto-
 * detect>pt-BR) — passado em `deps.currentLang`. Devolve `true` se TRATOU a linha
 * (`/lang …`) ⇒ NÃO é objetivo p/ o modelo. A persistência da pref é do caller (run.tsx).
 */
export function runLangLinear(
  goal: string | undefined,
  out: LinearOut,
  deps: { currentLang: Lang },
): boolean {
  const line = (goal ?? '').trim();
  if (line !== '/lang' && !line.startsWith('/lang ')) return false;
  const arg = line === '/lang' ? '' : line.slice('/lang '.length).trim();
  const effect = buildLangEffect(arg, deps.currentLang);
  if (effect.kind === 'lang') {
    for (const l of effect.note.lines) out.write(`[${effect.note.title}] ${l}\n`);
  }
  return true;
}

/**
 * EST-0962 · /provider — `/provider`/`/provider <name>` LITERAL no NÃO-TTY (§9): sem
 * picker. SEM argumento ⇒ LISTA os providers marcando o ativo. Com argumento
 * (`/provider deepseek`) ⇒ SETA o provider via `deps.setProvider` e confirma. O provider
 * ATIVO no não-TTY vem do controller (`deps.currentProvider`; `undefined` = nenhum setado).
 * Espelha o `runThemeLinear`/`runLangLinear`. Devolve `true` se TRATOU a linha (`/provider
 * …`) ⇒ NÃO é objetivo p/ o modelo. HG-2: só o NOME — o broker resolve a credencial.
 */
export function runProviderLinear(
  goal: string | undefined,
  out: LinearOut,
  deps: {
    currentProvider: string | undefined;
    setProvider: (name: string) => void;
  },
): boolean {
  const line = (goal ?? '').trim();
  if (line !== '/provider' && !line.startsWith('/provider ')) return false;
  const arg = line === '/provider' ? '' : line.slice('/provider '.length).trim();
  const effect = buildProviderEffect(arg, deps.currentProvider);
  if (effect.kind === 'provider') {
    // Provider VÁLIDO e novo (`effect.provider` definido) ⇒ aplica no controller. Lista/
    // inválido/igual ⇒ `provider` undefined: só ecoa a nota (não muda nada).
    if (effect.provider !== undefined) deps.setProvider(effect.provider);
    for (const l of effect.note.lines) out.write(`[${effect.note.title}] ${l}\n`);
  }
  return true;
}

/**
 * EST-0983 — `/memory` em modo NÃO-TTY (§9): roteia pela MESMA mecânica do TTY
 * (`parseMemoryCommand`/`runMemoryCommand` sobre a `AgentMemory` interna) — NUNCA
 * cai no agente como objetivo, NUNCA toca a memória por `cat` (read-deny mantido).
 * Sem isto, `aluy "/memory"` piped virava um OBJETIVO p/ o modelo (a LLM dizia "vou
 * ler a memória…") em vez de rodar o comando interno. As mutações (esquecer/editar/
 * fixar) são NEGADAS em Plan, idêntico ao TTY (ADR-0055). Cada linha sai rotulada
 * `[<título>]`. Devolve `true` se TRATOU a linha (`/memory …`). PT-BR + sinônimos.
 */
export async function runMemoryLinear(
  goal: string | undefined,
  out: LinearOut,
  deps: { memory: AgentMemory; isPlan: boolean },
): Promise<boolean> {
  const line = (goal ?? '').trim();
  if (line !== '/memory' && !line.startsWith('/memory ')) return false;
  const args = line === '/memory' ? '' : line.slice('/memory '.length).trim();
  const cmd = parseMemoryCommand(args);
  const note = await runMemoryCommand(cmd, deps.memory, deps.isPlan);
  for (const l of note.lines) out.write(`[${note.title}] ${l}\n`);
  return true;
}

/**
 * EST-1108 — `/todo` em modo NÃO-TTY (§9): roteia pela MESMA mecânica do TTY
 * (`parseTodoCommand`/`runTodoCommand` sobre o `TodoStorePort` interno) — NUNCA
 * cai no agente como objetivo. Sem isto, `aluy "/todo"` piped virava um OBJETIVO
 * p/ o modelo. As mutações (done/clear) são NEGADAS em Plan, idêntico ao TTY
 * (ADR-0055). Cada linha sai rotulada `[<título>]`. Devolve `true` se TRATOU a
 * linha (`/todo …`). Comandos em INGLÊS (done/clear).
 */
export async function runTodoLinear(
  goal: string | undefined,
  out: LinearOut,
  deps: { store: import('@hiperplano/aluy-cli-core').TodoStorePort; isPlan: boolean },
): Promise<boolean> {
  const line = (goal ?? '').trim();
  if (line !== '/todo' && !line.startsWith('/todo ')) return false;
  const args = line === '/todo' ? '' : line.slice('/todo '.length).trim();
  const cmd = parseTodoCommand(args);
  const note = await runTodoCommand(cmd, deps.store, deps.isPlan);
  for (const l of note.lines) out.write(`[${note.title}] ${l}\n`);
  return true;
}

/**
 * EST-0983 — `/clear [full|memory]` em modo NÃO-TTY (§9). O `/clear` puro é inócuo num
 * one-shot (sem sessão viva a zerar) mas roteado p/ NÃO cair no agente como objetivo. Os
 * destrutivos (`full`/`memory`) são FAIL-CLOSED no pipe: a confirmação é de 2 passos
 * (a 2ª invocação confirma) e num one-shot NÃO há 2ª invocação ⇒ passamos sempre
 * `armed=false`, então eles só MOSTRAM o aviso e NÃO apagam nada (segurança: ação
 * destrutiva exige confirmação interativa). Devolve `true` se TRATOU a linha.
 */
export async function runClearLinear(
  goal: string | undefined,
  out: LinearOut,
  deps: { memory: AgentMemory; clearSession: () => void },
): Promise<boolean> {
  const line = (goal ?? '').trim();
  if (line !== '/clear' && !line.startsWith('/clear ')) return false;
  const args = line === '/clear' ? '' : line.slice('/clear '.length).trim();
  const cmd = parseClearCommand(args);
  // FAIL-CLOSED: no pipe nunca há a 2ª invocação que confirma ⇒ `armed=false` sempre.
  // Assim `full`/`memory` apenas avisam (não apagam) — a confirmação é interativa.
  const outcome = await runClearCommand(cmd, deps, false);
  const lines = outcome.note.lines.length > 0 ? outcome.note.lines : ['sessão limpa.']; // o `/clear` puro não tem nota no TTY (tela limpa); no pipe ecoa.
  for (const l of lines) out.write(`[${outcome.note.title}] ${l}\n`);
  if (isDestructiveClear(cmd) && outcome.armed) {
    out.write(
      `[clear] modo não-interativo: rode \`/clear ${cmd.kind}\` numa sessão (TTY) p/ confirmar.\n`,
    );
  }
  return true;
}

/** Serializa um bloco em texto linear rotulado (§9: `[tool] read … 48 linhas ok`). */
export function linearize(block: SessionBlock): string {
  switch (block.kind) {
    case 'testrun': {
      const s = block.score;
      return s.unknownFormat
        ? `[testes] placar indisponível (formato não reconhecido)`
        : `[testes] ${s.passed} ✓ ${s.failed} ✗ (${s.total})`;
    }
    case 'you':
      return `[você] ${block.text}`;
    case 'aluy': {
      // EST-0965 — esconde os marcadores CRUS do protocolo (bloco completo +
      // prefixo a meio-chegar): mostra só a prosa limpa. Texto armazenado intacto.
      const text = cleanAluyForDisplay(block.text);
      return text.trim() === '' ? '' : `[aluy] ${text}`;
    }
    case 'tool': {
      // `running` (in-flight) normalmente é segurado até resolver; se aparecer no
      // flush final (tool sem report), emite a transição `rodando` honesta (§9).
      if (block.status === 'running') {
        return `[tool] ${block.verb} ${block.target} — ${block.verbGerund ?? 'rodando'}`;
      }
      return `[tool] ${block.verb} ${block.target} — ${block.result} ${block.status === 'ok' ? 'ok' : 'erro'}`;
    }
    case 'bang': {
      // EST-0958 — `!comando` no não-TTY: linha rotulada `[shell]` com o comando
      // exato + estado (rodando/ok/erro/bloqueado). A saída crua vai junto (§9).
      if (block.status === 'running') {
        return `[shell] $ ${block.command} — rodando`;
      }
      const label =
        block.status === 'blocked' ? 'bloqueado' : block.status === 'ok' ? 'ok' : 'erro';
      const out = block.output && block.output.trim() !== '' ? `\n${block.output}` : '';
      return `[shell] $ ${block.command} — ${label}${out}`;
    }
    case 'subagents': {
      // EST-0969 (display) — no não-TTY, IDEM ao TTY: linhas de STATUS por filho,
      // NUNCA os tokens crus dos N filhos misturados (que viravam lixo no stdout
      // piped/CI). Cabeçalho `[sub-agentes] N:` + uma linha por filho rotulada por
      // origem com estado (rodando/pronto/falhou) e o resumo curto quando concluído.
      const head = `[sub-agentes] ${block.children.length}:`;
      const lines = block.children.map((c) => {
        const word =
          c.status === 'running'
            ? 'rodando'
            : c.status === 'done'
              ? 'pronto'
              : c.stop === 'timeout'
                ? 'timeout'
                : c.stop === 'limit'
                  ? 'teto'
                  : 'falhou';
        // ADR-0146 (D5) — tier/modelo RESOLVIDO: mostrado também no não-TTY
        // (piped/`--print`/CI), na mesma posição do `<ChildLine>` do TTY (antes do
        // `summary`, independente do status).
        const modelPart = c.model !== undefined ? ` · ${c.model}` : '';
        const tail = c.summary !== undefined && c.status !== 'running' ? ` · ${c.summary}` : '';
        return `  [${c.label}] ${word}${modelPart}${tail}`;
      });
      return [head, ...lines].join('\n');
    }
    case 'deny':
      return `[negado] ${block.verb} ${block.exact}`;
    case 'broker-error':
      return `[${brokerErrorLabel(block.backend)}] ${block.message}${block.status !== undefined ? ` (${block.status})` : ''}`;
    case 'note':
      return `[${block.title}] ${block.lines.join(' · ')}`;
    case 'doctor': {
      // EST-0970 (não-TTY) — a checklist do `/doctor` em texto linear: cabeçalho +
      // uma linha por check com o glifo do estado (✓/⚠/✗, ◷ p/ pending) + detalhe + a
      // dica de conserto. No piped/CI o estado vem com o GLIFO + a palavra (a11y).
      const head = `[doctor]`;
      const lines = block.checks.flatMap((c) => {
        const g =
          c.status === 'ok' ? '✓' : c.status === 'warn' ? '⚠' : c.status === 'fail' ? '✗' : '◷';
        const detail = c.detail !== undefined && c.detail !== '' ? `: ${c.detail}` : ': testando…';
        const row = `  ${g} ${c.label}${detail}`;
        return c.status !== 'ok' && c.status !== 'pending' && c.fix !== undefined
          ? [row, `    → ${c.fix}`]
          : [row];
      });
      const tail = block.summary !== undefined ? [`  resumo: ${block.summary}`] : [];
      return [head, ...lines, ...tail].join('\n');
    }
    case 'inject':
      // EST-0982 (mid-turn) — a confirmação "↳ encaixado" no não-TTY: rótulo + eco
      // REDIGIDO (já redigido na origem; vazio ⇒ só o rótulo).
      return `[encaixado]${block.text.trim() ? ` ${block.text.trim()}` : ''}`;
  }
}
