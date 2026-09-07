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
