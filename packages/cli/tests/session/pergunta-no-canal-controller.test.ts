// INTEGRAÇÃO no SessionController do conserto pedido pelo dono em 02/09: "quando ele quer
// tirar uma dúvida, se a pergunta é do telegram ele não pode enviar no console pois o
// usuário não vai ver".
//
// O que este arquivo prova é o CIRCUITO FECHADO, não a formatação (essa é do
// `pergunta-no-canal.test.ts`): a tool `perguntar` abre a caixa, a pergunta SAI pelo canal,
// a resposta que volta por lá RESOLVE a pendência, e a escolha chega ao MODELO. Sem a
// última asserção o teste passaria com a pergunta resolvida no vazio — que é exatamente o
// defeito de antes (a resposta virava texto solto e a promessa ficava pendurada).
//
// Sem Ink e sem modelo real: controller + resolver de pergunta + modelo roteirizado.

import { describe, expect, it } from 'vitest';
import {
  PolicyPermissionEngine,
  type FileSystemPort,
  type ModelCallResult,
  type ModelCaller,
  type SearchPort,
  type ShellPort,
  type ToolPorts,
} from '@hiperplano/aluy-cli-core';
import { SessionController } from '../../src/session/controller.js';
import { TuiQuestionResolver } from '../../src/ask/question-resolver.js';
import { TuiAskResolver } from '../../src/ask/ask-resolver.js';

const TOOL_OPEN = '<<<ALUY_TOOL_CALL';
const TOOL_CLOSE = 'ALUY_TOOL_CALL>>>';
function toolCall(name: string, input: Record<string, unknown>): string {
  return `${TOOL_OPEN}\n${JSON.stringify({ name, input })}\n${TOOL_CLOSE}`;
}

function fakePorts(question: TuiQuestionResolver): ToolPorts {
  const fs: FileSystemPort = {
    async readFile() {
      return 'x';
    },
    async writeFile() {},
    async exists() {
      return true;
    },
  };
  const shell: ShellPort = {
    async exec() {
      return { stdout: 'ok', stderr: '', exitCode: 0 };
    },
  };
  const search: SearchPort = {
    async search() {
      return { matches: [], truncated: {} };
    },
  };
  return { fs, shell, search, question };
}

/** Modelo roteirizado que GUARDA o que recebeu — é onde a resposta tem de aparecer. */
function modeloQueGrava(turns: readonly string[], visto: string[]): ModelCaller {
  let i = 0;
  return {
    async call(args): Promise<ModelCallResult> {
      visto.push(JSON.stringify(args.messages));
      const content = turns[i] ?? 'pronto.';
      i += 1;
      return {
        request_id: 'r',
        content,
        finish_reason: 'stop',
        usage: { request_id: 'r', tier: 'aluy-flux', tokens_in: 10, tokens_out: 10 },
      };
    },
  };
}

const approveAll = {
  async resolve() {
    return { kind: 'approve-once' as const };
  },
};
const meta = { cwd: '/proj', tier: 'aluy-strata', tokens: 0, windowPct: 0 };

const PERGUNTA = toolCall('perguntar', {
  kind: 'single',
  question: 'Qual banco usar?',
  options: [{ label: 'Postgres' }, { label: 'SQLite' }],
});

interface Cenario {
  readonly controller: SessionController;
  readonly enviados: string[];
  readonly visto: string[];
}

function cenario(turns: readonly string[], ligarCanal = true): Cenario {
  const resolver = new TuiQuestionResolver();
  const visto: string[] = [];
  const controller = new SessionController({
    model: modeloQueGrava(turns, visto),
    permission: new PolicyPermissionEngine({ mode: 'unsafe' }),
    ports: fakePorts(resolver),
    askResolver: approveAll,
    questionResolver: resolver,
    meta,
  });
  const enviados: string[] = [];
  if (ligarCanal) {
    controller.ligarPerguntaNoCanal((t) => {
      enviados.push(t);
    });
  }
  return { controller, enviados, visto };
}

describe('pergunta do agente num turno que veio do canal', () => {
  it('a pergunta SAI pelo canal — a caixa no terminal não basta, ele está no celular', async () => {
    const { controller, enviados } = cenario([PERGUNTA, 'pronto.']);
    let respondeu = false;
    const unsub = controller.subscribe((s) => {
      if (s.phase === 'questioning' && !respondeu) {
        respondeu = true;
        controller.responderPeloCanal('2');
      }
    });
    await controller.submit('qual banco?', [], { origem: 'telegram' });
    unsub();
    expect(respondeu).toBe(true);
    expect(enviados).toHaveLength(1);
    expect(enviados[0]).toContain('Qual banco usar?');
    expect(enviados[0]).toContain('2. SQLite');
  });

  it('a resposta que volta pelo canal chega ao MODELO como a escolha feita', async () => {
    const { controller, visto } = cenario([PERGUNTA, 'pronto.']);
    let respondeu = false;
    const unsub = controller.subscribe((s) => {
      if (s.phase === 'questioning' && !respondeu) {
        respondeu = true;
        controller.responderPeloCanal('2');
      }
    });
    await controller.submit('qual banco?', [], { origem: 'telegram' });
    unsub();
    // A observação do `perguntar` só existe se a promessa foi RESOLVIDA com a escolha.
    expect(visto.join('\n')).toContain('SQLite');
  });

  it('a pendência é CONSUMIDA: a resposta não vira instrução (devolve `true`)', async () => {
    const { controller } = cenario([PERGUNTA, 'pronto.']);
    let consumiu: boolean | undefined;
    let respondeu = false;
    const unsub = controller.subscribe((s) => {
      if (s.phase === 'questioning' && !respondeu) {
        respondeu = true;
        consumiu = controller.responderPeloCanal('1');
      }
    });
    await controller.submit('qual banco?', [], { origem: 'telegram' });
    unsub();
    expect(consumiu).toBe(true);
  });

  it('resposta ILEGÍVEL reapresenta a pergunta e a mantém pendente', async () => {
    const { controller, enviados } = cenario([PERGUNTA, 'pronto.']);
    let passo = 0;
    const unsub = controller.subscribe((s) => {
      if (s.phase !== 'questioning') return;
      if (passo === 0) {
        passo = 1;
        // "9" não existe na lista de 2 — não é resposta livre, é engano de número.
        expect(controller.responderPeloCanal('9')).toBe(true);
        // Continua pendente: o segundo envio é a pergunta de novo.
        expect(enviados).toHaveLength(2);
        expect(enviados[1]).toContain('Não consegui ler');
        controller.responderPeloCanal('1');
      }
    });
    await controller.submit('qual banco?', [], { origem: 'telegram' });
    unsub();
    expect(passo).toBe(1);
  });

  it('turno DIGITADO no terminal não manda nada para o celular (zero ruído)', async () => {
    const { controller, enviados } = cenario([PERGUNTA, 'pronto.']);
    let respondeu = false;
    const unsub = controller.subscribe((s) => {
      if (s.phase === 'questioning' && !respondeu) {
        respondeu = true;
        // Sem espelho no canal, `responderPeloCanal` NÃO consome nada.
        expect(controller.responderPeloCanal('1')).toBe(false);
        controller.resolveQuestion({ kind: 'choice', index: 0, label: 'Postgres' });
      }
    });
    await controller.submit('qual banco?');
    unsub();
    expect(respondeu).toBe(true);
    expect(enviados).toHaveLength(0);
  });

  it('sem canal ligado (ponte fora do ar) o comportamento é o de sempre', async () => {
    const { controller } = cenario([PERGUNTA, 'pronto.'], false);
    let respondeu = false;
    const unsub = controller.subscribe((s) => {
      if (s.phase === 'questioning' && !respondeu) {
        respondeu = true;
        expect(controller.responderPeloCanal('1')).toBe(false);
        controller.resolveQuestion({ kind: 'choice', index: 0, label: 'Postgres' });
      }
    });
    await controller.submit('qual banco?', [], { origem: 'telegram' });
    unsub();
    expect(respondeu).toBe(true);
  });

  it('sem pergunta pendente, a mensagem do canal segue instrução normal', () => {
    const { controller } = cenario(['pronto.']);
    expect(controller.responderPeloCanal('ola')).toBe(false);
  });
});

// ── A APROVAÇÃO (catraca de permissão), mesma família e a mais cara ────────────────────
//
// A catraca abre o diálogo no terminal e o loop fica parado SEM PRAZO. Num turno vindo do
// celular, o dono não via nada: nem a pergunta, nem que havia algo parado esperando por ele.
//
// O que estes testes travam, além do aviso, é a ASSIMETRIA deliberada: NEGAR pelo celular
// vale (é o default fail-safe da catraca, só diminui o que acontece); APROVAR, não — o dono
// aprova o efeito EXATO que vê (CLI-SEC-9), e o efeito inteiro está no terminal.

const COMANDO = toolCall('run_command', { command: 'rm -rf /tmp/alvo' });

interface CenarioAprovacao {
  readonly controller: SessionController;
  readonly enviados: string[];
  readonly rodou: string[];
}

function cenarioAprovacao(turns: readonly string[]): CenarioAprovacao {
  const resolver = new TuiQuestionResolver();
  const rodou: string[] = [];
  const shell: ShellPort = {
    async exec(cmd: string) {
      rodou.push(cmd);
      return { stdout: 'ok', stderr: '', exitCode: 0 };
    },
  };
  const controller = new SessionController({
    model: modeloQueGrava(turns, []),
    permission: new PolicyPermissionEngine(),
    ports: { ...fakePorts(resolver), shell },
    askResolver: new TuiAskResolver(),
    questionResolver: resolver,
    meta,
  });
  const enviados: string[] = [];
  controller.ligarPerguntaNoCanal((t) => {
    enviados.push(t);
  });
  return { controller, enviados, rodou };
}

describe('aprovação pendente num turno que veio do canal', () => {
  it('AVISA no canal que o turno parou — antes disso o dono só via silêncio', async () => {
    const { controller, enviados } = cenarioAprovacao([COMANDO, 'pronto.']);
    let viu = false;
    const unsub = controller.subscribe((s) => {
      if (s.phase === 'asking' && !viu) {
        viu = true;
        controller.responderPeloCanal('cancelar');
      }
    });
    await controller.submit('limpe o alvo', [], { origem: 'telegram' });
    unsub();
    expect(viu).toBe(true);
    expect(enviados).toHaveLength(1);
    expect(enviados[0]).toContain('APROVAÇÃO');
    expect(enviados[0], 'o efeito EXATO tem de ir junto').toContain('rm -rf /tmp/alvo');
  });

  it('"cancelar" pelo celular NEGA — e o comando NÃO roda', async () => {
    const { controller, rodou } = cenarioAprovacao([COMANDO, 'pronto.']);
    let negou = false;
    const unsub = controller.subscribe((s) => {
      if (s.phase === 'asking' && !negou) {
        negou = true;
        expect(controller.responderPeloCanal('cancelar')).toBe(true);
      }
    });
    await controller.submit('limpe o alvo', [], { origem: 'telegram' });
    unsub();
    expect(negou).toBe(true);
    expect(rodou, 'negado ⇒ o shell nunca é tocado').toHaveLength(0);
  });

  it('qualquer outra resposta NÃO aprova — o efeito exato se aprova no terminal', async () => {
    const { controller, enviados, rodou } = cenarioAprovacao([COMANDO, 'pronto.']);
    let passo = 0;
    const unsub = controller.subscribe((s) => {
      if (s.phase !== 'asking') return;
      if (passo === 0) {
        passo = 1;
        expect(controller.responderPeloCanal('pode mandar, aprovo')).toBe(true);
        expect(enviados, 'o lembrete volta pelo canal').toHaveLength(2);
        expect(enviados[1]).toContain('terminal');
        // Continua PENDENTE: quem encerra é o terminal (ou a desistência).
        controller.resolveAsk({ kind: 'deny', reason: 'fim do teste' });
      }
    });
    await controller.submit('limpe o alvo', [], { origem: 'telegram' });
    unsub();
    expect(passo).toBe(1);
    expect(rodou, '"aprovo" por chat NUNCA pode executar').toHaveLength(0);
  });

  it('CONTROLE: aprovado no terminal, o comando RODA — sem isto os "não roda" acima seriam vazios', async () => {
    // Uma asserção de que algo NÃO aconteceu só vale se o caminho que o faz acontecer for
    // exercitado. Sem este caso, `rodou` poderia estar vazio por a tool nem chegar ao shell.
    const { controller, rodou } = cenarioAprovacao([COMANDO, 'pronto.']);
    let viu = false;
    const unsub = controller.subscribe((s) => {
      if (s.phase === 'asking' && !viu) {
        viu = true;
        controller.resolveAsk({ kind: 'approve-once' });
      }
    });
    await controller.submit('limpe o alvo', [], { origem: 'telegram' });
    unsub();
    expect(rodou).toContain('rm -rf /tmp/alvo');
  });

  it('turno digitado no terminal não manda aviso nenhum para o celular', async () => {
    const { controller, enviados } = cenarioAprovacao([COMANDO, 'pronto.']);
    let viu = false;
    const unsub = controller.subscribe((s) => {
      if (s.phase === 'asking' && !viu) {
        viu = true;
        controller.resolveAsk({ kind: 'deny', reason: 'não' });
      }
    });
    await controller.submit('limpe o alvo');
    unsub();
    expect(viu).toBe(true);
    expect(enviados).toHaveLength(0);
  });
});

// ── AS PAUSAS: watchdog de travamento e gate de orçamento ─────────────────────────────
//
// As duas últimas fases que paravam o loop esperando o teclado. O `stuck` é o pior dos
// quatro casos: a promise do loop fica pendurada SEM PRAZO e, como o turno segue vivo, a
// tentativa de destravar pelo celular caía no `injectInput` como texto solto.
//
// Aqui o canal aceita MAIS que na catraca de permissão, e de propósito: nenhuma das saídas
// da pausa relaxa a catraca — todas são input do dono, o mesmo que ele daria no teclado.

const REPETE = toolCall('run_command', { command: 'ls' });

function cenarioTravado(turns: readonly string[]) {
  const resolver = new TuiQuestionResolver();
  const visto: string[] = [];
  const controller = new SessionController({
    model: modeloQueGrava(turns, visto),
    permission: new PolicyPermissionEngine({ mode: 'unsafe' }),
    ports: fakePorts(resolver),
    askResolver: approveAll,
    questionResolver: resolver,
    meta,
  });
  const enviados: string[] = [];
  controller.ligarPerguntaNoCanal((t) => {
    enviados.push(t);
  });
  return { controller, enviados, visto };
}

describe('pausa do watchdog num turno que veio do canal', () => {
  it('AVISA no canal o que travou — antes disso o loop parava calado, sem prazo', async () => {
    const { controller, enviados } = cenarioTravado([REPETE, REPETE, REPETE, REPETE, 'pronto.']);
    let viu = false;
    const unsub = controller.subscribe((s) => {
      if (s.phase === 'stuck' && !viu) {
        viu = true;
        controller.responderPeloCanal('cancelar');
      }
    });
    await controller.submit('faça', [], { origem: 'telegram' });
    unsub();
    expect(viu).toBe(true);
    expect(enviados).toHaveLength(1);
    expect(enviados[0]).toContain('Parei');
    expect(enviados[0], 'o que se repetiu tem de aparecer').toContain('run_command');
  });

  it('"cancelar" ENCERRA o turno travado — a saída [n], pelo celular', async () => {
    const { controller } = cenarioTravado([REPETE, REPETE, REPETE, REPETE, REPETE, REPETE]);
    let viu = false;
    const unsub = controller.subscribe((s) => {
      if (s.phase === 'stuck' && !viu) {
        viu = true;
        expect(controller.responderPeloCanal('cancelar')).toBe(true);
      }
    });
    await controller.submit('faça', [], { origem: 'telegram' });
    unsub();
    expect(viu).toBe(true);
    expect(controller.current.phase, 'não pode ficar preso em stuck').not.toBe('stuck');
  });

  it('"continuar" insiste — a saída [c]', async () => {
    const { controller } = cenarioTravado([REPETE, REPETE, REPETE, REPETE, 'pronto.']);
    const fases: string[] = [];
    let viu = false;
    const unsub = controller.subscribe((s) => {
      fases.push(s.phase);
      if (s.phase === 'stuck' && !viu) {
        viu = true;
        expect(controller.responderPeloCanal('continuar')).toBe(true);
      }
    });
    await controller.submit('faça', [], { origem: 'telegram' });
    unsub();
    expect(viu).toBe(true);
    expect(fases.slice(fases.indexOf('stuck') + 1), 'o turno retomou').toContain('thinking');
    // DISTINGUE do redirect: os dois voltam a `thinking`, então "voltou a pensar" não prova
    // qual saída foi tomada. O redirect deixa a nota; o continuar, não.
    const notas = controller.current.blocks.filter((b) => b.kind === 'note');
    expect(notas.some((n) => n.kind === 'note' && n.title === 'redirecionado')).toBe(false);
  });

  it('texto livre vira a NOVA DIREÇÃO — a saída [r], que é a útil pelo celular', async () => {
    const { controller, visto } = cenarioTravado([REPETE, REPETE, REPETE, REPETE, 'pronto.']);
    let viu = false;
    const unsub = controller.subscribe((s) => {
      if (s.phase === 'stuck' && !viu) {
        viu = true;
        expect(controller.responderPeloCanal('pare e leia o README')).toBe(true);
      }
    });
    await controller.submit('faça', [], { origem: 'telegram' });
    unsub();
    expect(viu).toBe(true);
    // A direção tem de CHEGAR ao modelo — senão o "redirect" seria decorativo.
    expect(visto.join('\n')).toContain('pare e leia o README');
    const notas = controller.current.blocks.filter((b) => b.kind === 'note');
    expect(notas.some((n) => n.kind === 'note' && n.title === 'redirecionado')).toBe(true);
  });

  it('turno digitado no terminal não manda nada para o celular', async () => {
    const { controller, enviados } = cenarioTravado([REPETE, REPETE, REPETE, REPETE, 'pronto.']);
    let viu = false;
    const unsub = controller.subscribe((s) => {
      if (s.phase === 'stuck' && !viu) {
        viu = true;
        controller.endAfterStuck();
      }
    });
    await controller.submit('faça');
    unsub();
    expect(viu).toBe(true);
    expect(enviados).toHaveLength(0);
  });
});

function cenarioOrcamento() {
  const resolver = new TuiQuestionResolver();
  const controller = new SessionController({
    model: modeloQueGrava(['pronto.'], []),
    permission: new PolicyPermissionEngine({ mode: 'unsafe' }),
    ports: fakePorts(resolver),
    askResolver: approveAll,
    questionResolver: resolver,
    meta,
    // Estoura por ITERAÇÕES na hora, com folga de tokens p/ o `continuar` conseguir retomar.
    limits: { maxIterations: 0, maxToolCalls: 50, maxTokens: 1_000_000 },
  });
  const enviados: string[] = [];
  controller.ligarPerguntaNoCanal((t) => {
    enviados.push(t);
  });
  return { controller, enviados };
}

describe('gate de orçamento num turno que veio do canal', () => {
  it('AVISA no canal que parou no teto, com o número e o risco', async () => {
    const { controller, enviados } = cenarioOrcamento();
    await controller.submit('faça', [], { origem: 'telegram' });
    expect(controller.current.phase).toBe('budget');
    expect(enviados).toHaveLength(1);
    expect(enviados[0]).toContain('orçamento');
    expect(enviados[0], 'o dono precisa saber que perde o trabalho').toContain('se perde');
  });

  it('"continuar" estende o teto e RETOMA de onde parou', async () => {
    const { controller } = cenarioOrcamento();
    await controller.submit('faça', [], { origem: 'telegram' });
    expect(controller.responderPeloCanal('continuar')).toBe(true);
    // `continueAfterBudget` é async e disparado com `void` — espera assentar.
    for (let i = 0; i < 200 && controller.current.phase === 'budget'; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(controller.current.phase).not.toBe('budget');
    expect(controller.current.pendingBudget).toBeUndefined();
  });

  it('qualquer outra mensagem NÃO é consumida — vira instrução, que é o dono seguindo', async () => {
    // Diferente do `stuck`: aqui o turno já voltou, nada está pendurado. Engolir a mensagem
    // deixaria o dono sem conseguir mudar de assunto.
    const { controller } = cenarioOrcamento();
    await controller.submit('faça', [], { origem: 'telegram' });
    expect(controller.responderPeloCanal('deixa pra lá, faz outra coisa')).toBe(false);
  });

  it('turno digitado no terminal não manda nada para o celular', async () => {
    const { controller, enviados } = cenarioOrcamento();
    await controller.submit('faça');
    expect(controller.current.phase).toBe('budget');
    expect(enviados).toHaveLength(0);
  });
});
