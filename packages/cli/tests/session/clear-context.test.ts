// EST-0948 (composer/sessão) — `/clear` ZERA O CONTEXTO do modelo (o modelo
// ESQUECE), não só esvazia os blocos visuais. Antes, `clear()` fazia só
// `patch({ blocks: [] })`: a tela parecia limpa mas o modelo seguia lembrando de
// tudo, porque o histórico que o próximo turno reidrata mora no CONTROLLER
// (lastRunHistory/compactedSeed) e nas sementes pendentes (pendingSeed de sessão
// retomada, pendingInjected de INTERAGIR) — não nos blocos.
//
// Prova "o modelo esquece": semeamos um FATO no contexto (via seedHistory — o canal
// de uma sessão retomada, o portador de memória mais simples). Um submit ANTES do
// /clear leva o fato ao modelo (ele "lembra"). Após /clear, o próximo submit NÃO
// carrega o fato (ele "não sabe"). Espionamos as MENSAGENS que chegam ao caller.

import { describe, expect, it } from 'vitest';
import {
  PolicyPermissionEngine,
  type ModelCaller,
  type ModelCallResult,
  type ToolPorts,
  type FileSystemPort,
  type ShellPort,
  type SearchPort,
  type HistoryItem,
} from '@hiperplano/aluy-cli-core';
import { SessionController } from '../../src/session/controller.js';
import { TuiAskResolver } from '../../src/ask/ask-resolver.js';
import { buildActivityLog } from '../../src/session/activity-log.js';

function fakePorts(): ToolPorts {
  const fs: FileSystemPort = {
    async readFile() {
      return '';
    },
    async writeFile() {},
    async exists() {
      return false;
    },
  };
  const shell: ShellPort = {
    async exec() {
      return { stdout: '', stderr: '', exitCode: 0 };
    },
  };
  const search: SearchPort = {
    async search() {
      return { matches: [], truncated: {} };
    },
  };
  return { fs, shell, search };
}

/** Caller que CAPTURA o texto de todas as mensagens de cada chamada e responde curto. */
function capturingCaller(): { caller: ModelCaller; lastPromptText: () => string } {
  let last = '';
  const caller: ModelCaller = {
    async call(args): Promise<ModelCallResult> {
      last = args.messages.map((m) => m.content).join('\n');
      return { request_id: 'r', content: 'ok', finish_reason: 'stop' };
    },
  };
  return { caller, lastPromptText: () => last };
}

function buildController(model: ModelCaller): SessionController {
  return new SessionController({
    model,
    permission: new PolicyPermissionEngine(),
    ports: fakePorts(),
    askResolver: new TuiAskResolver(),
    meta: { cwd: '/proj', tier: 'aluy-flux', tokens: 0, windowPct: 0 },
    flush: { intervalMs: 0 },
  });
}

const FACT = 'meu-cachorro-se-chama-Rex';

describe('controller.clear() — o modelo ESQUECE (contexto zerado), não só a tela', () => {
  it('seedHistory (memória) ⇒ o fato chega ao modelo; após /clear ⇒ NÃO chega', async () => {
    const { caller, lastPromptText } = capturingCaller();
    const controller = buildController(caller);
    controller.dismissBoot();

    // semeia um FATO no contexto (como faria uma sessão retomada).
    const seed: HistoryItem[] = [{ role: 'observation', toolName: 'memoria', text: FACT }];
    controller.seedHistory(seed);

    // 1º turno: o modelo VÊ o fato (semente prependada ao objetivo).
    await controller.submit('qual o nome do meu cachorro?');
    expect(lastPromptText()).toContain(FACT);

    // re-semeia (simula que a memória da conversa ainda estaria viva) e LIMPA.
    controller.seedHistory(seed);
    controller.clear();

    // 2º turno após /clear: o fato NÃO entra mais no contexto — o modelo "não sabe".
    await controller.submit('qual o nome do meu cachorro?');
    expect(lastPromptText()).not.toContain(FACT);
  });

  it('/clear zera pendingInjected (INTERAGIR) — input injetado não vaza p/ o próximo turno', async () => {
    const { caller, lastPromptText } = capturingCaller();
    const controller = buildController(caller);
    controller.dismissBoot();

    // INTERAGIR injeta input no agente PRINCIPAL p/ o próximo turno. Para isso o
    // controller precisa de uma árvore de fluxos (criada num submit) com o nó raiz.
    await controller.submit('primeiro objetivo');
    const root = controller.flowOverview()[0];
    expect(root).toBeDefined();
    controller.injectInput(root!.id, FACT);

    // /clear antes do próximo submit ⇒ o injetado é descartado.
    controller.clear();
    await controller.submit('segundo objetivo');
    expect(lastPromptText()).not.toContain(FACT);
  });

  it('/clear esvazia os blocos E mantém a sessão (phase idle, sem erro)', async () => {
    const { caller } = capturingCaller();
    const controller = buildController(caller);
    controller.dismissBoot();
    await controller.submit('faça algo');
    expect(controller.blocks.length).toBeGreaterThan(0);
    controller.clear();
    expect(controller.blocks.length).toBe(0);
    expect(controller.current.phase).toBe('idle');
  });

  it('após /clear, canCompact volta a false (não há histórico ativo a compactar)', async () => {
    const { caller } = capturingCaller();
    const controller = buildController(caller);
    controller.dismissBoot();
    // um turno deixa lastRunHistory setado (base do /compact).
    await controller.submit('faça algo');
    controller.clear();
    expect(controller.canCompact).toBe(false);
  });
});

// EST-0973 (pedido do Tiago: "o /clear tem que limpar o LOG também") — o `/clear` zera
// o LOG DE ATIVIDADE (a FlowTree, fonte do split #135 e do cockpit #144 via
// `flowOverview()`/`buildActivityLog`). Projetamos o log EXATAMENTE como o split/cockpit
// (`buildActivityLog(flowOverview(), drillInFlow)`) e provamos: ATIVIDADE após um turno
// ⇒ /clear ⇒ log VAZIO (estado "sem atividade ainda"); a guarda de turno VIVO não zera
// no meio do fluxo; e o caminho de SESSÃO do `/clear full` (#138) também zera o log.

/** Projeta o log do jeito do split/cockpit — uma fonte, a MESMA chamada da App.tsx. */
function projectLog(controller: SessionController): ReturnType<typeof buildActivityLog> {
  return buildActivityLog(controller.flowOverview(), (id) => controller.drillInFlow(id));
}

describe('controller.clear() — ZERA o LOG DE ATIVIDADE (split #135 / cockpit #144)', () => {
  it('atividade após um turno ⇒ /clear ⇒ flowOverview vazio E buildActivityLog sem seções', async () => {
    const { caller } = capturingCaller();
    const controller = buildController(caller);
    controller.dismissBoot();

    // um turno cria a FlowTree (nó raiz) — o log passa a ter a seção do agente.
    await controller.submit('faça algo');
    expect(controller.flowOverview().length).toBeGreaterThan(0);
    expect(projectLog(controller).sections.length).toBeGreaterThan(0);

    controller.clear();

    // após /clear: a árvore foi descartada ⇒ overview vazio ⇒ log SEM seções (o split/
    // cockpit renderizam o estado vazio "sem atividade ainda").
    expect(controller.flowOverview()).toEqual([]);
    expect(projectLog(controller).sections).toEqual([]);
    expect(projectLog(controller).totalEvents).toBe(0);
    // e o drill-in de um nó que não existe mais não estoura.
    expect(controller.drillInFlow('root')).toBeUndefined();
  });

  it('o log zerado SOBREVIVE entre /clear e o próximo turno (recomeço limpo, depois cresce de novo)', async () => {
    const { caller } = capturingCaller();
    const controller = buildController(caller);
    controller.dismissBoot();

    await controller.submit('turno A');
    controller.clear();
    expect(projectLog(controller).sections).toEqual([]);

    // o próximo turno reconstrói a árvore (não fica vazio p/ sempre) — só o ACUMULADO
    // velho some; a atividade NOVA aparece normalmente.
    await controller.submit('turno B');
    expect(projectLog(controller).sections.length).toBeGreaterThan(0);
  });

  it('/clear no MEIO de um turno VIVO não corrompe o fluxo ativo (a árvore viva é preservada)', async () => {
    // caller que SUSPENDE no meio do turno: assim podemos chamar /clear com o turno VIVO.
    let release!: () => void;
    const gate = new Promise<void>((res) => {
      release = res;
    });
    const caller: ModelCaller = {
      async call(): Promise<ModelCallResult> {
        await gate; // segura o turno aberto (rootFlow não-terminal)
        return { request_id: 'r', content: 'ok', finish_reason: 'stop' };
      },
    };
    const controller = buildController(caller);
    controller.dismissBoot();

    const turn = controller.submit('objetivo longo'); // não await — fica VIVO
    await Promise.resolve(); // deixa o submit chegar ao caller suspenso

    // turno VIVO ⇒ a guarda NÃO descarta a árvore (zerá-la perderia o accounting do
    // fluxo em andamento). O overview do turno corrente segue íntegro.
    expect(controller.flowOverview().length).toBeGreaterThan(0);
    controller.clear();
    expect(controller.flowOverview().length).toBeGreaterThan(0); // preservado: turno ativo

    // libera o turno e deixa fechar — sem corromper (resolve limpo).
    release();
    await turn;

    // agora EM REPOUSO, um /clear de fato zera o log.
    controller.clear();
    expect(projectLog(controller).sections).toEqual([]);
  });

  it('o caminho de SESSÃO do `/clear full` (#138) — clearSession ⇒ controller.clear() — também zera o log', async () => {
    // `/clear full` roteia a parte de SESSÃO por ESTE controller.clear() (a memória é
    // apagada à parte, no wiring). Provamos que a via de sessão do full zera o log.
    const { caller } = capturingCaller();
    const controller = buildController(caller);
    controller.dismissBoot();
    await controller.submit('faça algo');
    expect(projectLog(controller).sections.length).toBeGreaterThan(0);

    // simula o `clearSession` que o runClearCommand chama no `full` (= controller.clear()).
    const clearSession = (): void => controller.clear();
    clearSession();

    expect(projectLog(controller).sections).toEqual([]);
    expect(controller.blocks.length).toBe(0);
  });
});
