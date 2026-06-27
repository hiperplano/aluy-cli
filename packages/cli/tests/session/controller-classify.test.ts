// EST-0942 (auth/login · classificação de erro de broker) — o bug que enganou o
// Tiago: TODA falha virava "broker indisponível", juntando causas que pedem AÇÕES
// DIFERENTES (re-login vs. checar a URL do broker vs. trocar de tier vs. saldo).
//
// Aqui provamos a CLASSIFICAÇÃO em dois níveis:
//   (1) a função pura `classifyBrokerError` — causa → headline + message ACIONÁVEL,
//       NEUTRA (HG-2) e SEM TOKEN (CLI-SEC-6);
//   (2) o `onError` do controller (via `submit` com um caller roteirizado que LANÇA
//       cada causa) — o bloco `broker-error` carrega a mensagem certa, e os erros de
//       AUTH (sem credencial / 401) NÃO auto-retentam (não adianta repetir).
//
// Broker MOCKADO (sem rede, sem modelo real — FRUGAL). O token jamais aparece: os
// erros sintéticos nunca o carregam, e a função só compõe literais + status numérico.

import { describe, expect, it } from 'vitest';
import {
  PolicyPermissionEngine,
  BrokerError,
  BrokerTransportError,
  SessionExpiredError,
  RefreshUnavailableError,
  type ModelCaller,
  type ModelCallResult,
  type ToolPorts,
  type FileSystemPort,
  type ShellPort,
  type SearchPort,
} from '@aluy/cli-core';
import {
  SessionController,
  classifyBrokerError,
  type RetryOptions,
} from '../../src/session/controller.js';
import { TuiAskResolver } from '../../src/ask/ask-resolver.js';
import type { SessionState, BrokerErrorBlock } from '../../src/session/model.js';

// Um PAT plausível (NUNCA deve vazar p/ a mensagem do usuário). Usamos como sentinela.
const SECRET = 'pat_abc123_supersecretvalue';

function fakePorts(): ToolPorts {
  const fs: FileSystemPort = {
    async readFile() {
      throw new Error('n/a');
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

function fakeSleep(): RetryOptions['sleep'] {
  return (_ms: number, signal: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
      if (signal.aborted) return reject(new Error('aborted'));
      queueMicrotask(() => (signal.aborted ? reject(new Error('aborted')) : resolve()));
    });
}

/** Caller que SEMPRE lança `error` (captura o nº de chamadas p/ provar (não-)retry). */
function alwaysFailing(error: unknown): { model: ModelCaller; calls: () => number } {
  let calls = 0;
  const model: ModelCaller = {
    async call(): Promise<ModelCallResult> {
      calls += 1;
      throw error;
    },
  };
  return { model, calls: () => calls };
}

function buildController(model: ModelCaller): {
  controller: SessionController;
  snapshots: SessionState[];
} {
  let t = 0;
  const controller = new SessionController({
    model,
    permission: new PolicyPermissionEngine(),
    ports: fakePorts(),
    askResolver: new TuiAskResolver(),
    meta: { cwd: '/proj', tier: 'aluy-flux', tokens: 0, windowPct: 0 },
    retry: {
      sleep: fakeSleep(),
      rand: () => 0.5,
      now: () => (t += 1000),
      backoff: { baseMs: 1000, maxMs: 8000, jitter: 0 },
    },
  });
  const snapshots: SessionState[] = [];
  controller.subscribe((s) => snapshots.push(s));
  return { controller, snapshots };
}

const terminalBrokerError = (
  blocks: readonly SessionState['blocks'][number][],
): BrokerErrorBlock => {
  const b = blocks.find((x) => x.kind === 'broker-error');
  if (b?.kind !== 'broker-error') throw new Error('sem bloco broker-error');
  return b;
};

// ── (1) função pura: causa → headline + message ───────────────────────────────
describe('classifyBrokerError — causa → mensagem ACIONÁVEL (EST-0942)', () => {
  it('SEM credencial / sessão expirada ⇒ "rode aluy login" (NÃO "indisponível")', () => {
    const c = classifyBrokerError(new SessionExpiredError());
    expect(c.message.toLowerCase()).toContain('sem credencial');
    expect(c.message).toContain('aluy login');
    expect(c.headline.toLowerCase()).not.toContain('indisponível');
    expect(c.status).toBeUndefined();
  });

  // HUNT-AUTH-HONESTY — refresh TRANSITÓRIO (blip) ≠ falta de login: a credencial foi
  // PRESERVADA, então NÃO mandamos "rode aluy login" (seria enganoso). Distinto do
  // `AuthError` genérico mesmo o estendendo (vem antes na classificação).
  it('refresh transitório (RefreshUnavailableError) ⇒ "tente de novo", NÃO "aluy login"', () => {
    const c = classifyBrokerError(new RefreshUnavailableError());
    expect(c.message.toLowerCase()).toContain('tente de novo');
    expect(c.message.toLowerCase()).toContain('preservada');
    expect(c.message).not.toContain('aluy login');
  });

  it('401 ⇒ "credencial inválida ou expirada — aluy login" (NÃO "indisponível")', () => {
    const c = classifyBrokerError(
      new BrokerError({ status: 401, code: 'UNAUTHENTICATED', title: 'no auth' }),
    );
    expect(c.message.toLowerCase()).toContain('inválida ou expirada');
    expect(c.message).toContain('aluy login');
    expect(c.headline.toLowerCase()).not.toContain('indisponível');
    expect(c.status).toBe(401);
  });

  it('403 (permissão) também cai em re-login (isAuth)', () => {
    const c = classifyBrokerError(
      new BrokerError({ status: 403, code: 'PERMISSION_DENIED', title: 'denied' }),
    );
    expect(c.message).toContain('aluy login');
  });

  it('conexão recusada / rede (transporte) ⇒ "não conectei ao broker" + ALUY_BROKER_URL', () => {
    const c = classifyBrokerError(
      new BrokerTransportError('falha de transporte ao chamar o broker.'),
    );
    expect(c.message.toLowerCase()).toContain('não conectei ao broker');
    expect(c.message).toContain('ALUY_BROKER_URL');
    expect(c.headline).toBe('broker indisponível'); // ESTE é o "indisponível" de verdade
    expect(c.status).toBeUndefined();
  });

  it('402 ⇒ "sem crédito/quota"', () => {
    const c = classifyBrokerError(
      new BrokerError({ status: 402, code: 'INSUFFICIENT_CREDIT', title: 'saldo' }),
    );
    expect(c.message.toLowerCase()).toContain('crédito');
    expect(c.headline.toLowerCase()).toContain('crédito');
    expect(c.status).toBe(402);
  });

  it('502 PROVIDER_ERROR ⇒ "provedor do tier falhou — tente outro tier" (≠ broker-down)', () => {
    const c = classifyBrokerError(
      new BrokerError({ status: 502, code: 'PROVIDER_ERROR', title: 'vendor fora' }),
    );
    expect(c.message.toLowerCase()).toContain('provedor');
    expect(c.message.toLowerCase()).toContain('outro tier');
    expect(c.headline.toLowerCase()).not.toContain('indisponível'); // distinto de broker-down
    expect(c.status).toBe(502);
  });

  it('VAULT_UNAVAILABLE / PROVIDER_NOT_CONFIGURED também ⇒ "provedor do tier"', () => {
    for (const code of ['VAULT_UNAVAILABLE', 'PROVIDER_NOT_CONFIGURED'] as const) {
      const c = classifyBrokerError(new BrokerError({ status: 502, code, title: 't' }));
      expect(c.message.toLowerCase()).toContain('provedor');
    }
  });

  // EST-1015 (fix repro do dono `--provider deepseek`) — os 3 códigos 502 são CAUSAS
  // distintas: a mensagem ÚNICA "tente outro tier ou mais tarde" enganava (p/ config,
  // esperar nunca resolve). Cada código vira uma frase ACIONÁVEL e DISTINTA, mantendo HG-2
  // (nunca cita o NOME do provider).
  it('502: os 3 códigos dão mensagens DISTINTAS e ACIONÁVEIS (HG-2 preservado)', () => {
    const notCfg = classifyBrokerError(
      new BrokerError({ status: 502, code: 'PROVIDER_NOT_CONFIGURED', title: 't' }),
    );
    const vault = classifyBrokerError(
      new BrokerError({ status: 502, code: 'VAULT_UNAVAILABLE', title: 't' }),
    );
    const provErr = classifyBrokerError(
      new BrokerError({ status: 502, code: 'PROVIDER_ERROR', title: 't' }),
    );
    // NOT_CONFIGURED ⇒ acionável de CONFIG (≠ "tente mais tarde" — esperar não resolve).
    expect(notCfg.message.toLowerCase()).toMatch(/configur/);
    expect(notCfg.message.toLowerCase()).not.toBe(provErr.message.toLowerCase());
    // VAULT ⇒ fala de credencial/cofre, distinto.
    expect(vault.message.toLowerCase()).toMatch(/credencial|cofre/);
    expect(vault.message.toLowerCase()).not.toBe(provErr.message.toLowerCase());
    // PROVIDER_ERROR ⇒ transitório (saldo/fora ⇒ mais tarde).
    expect(provErr.message.toLowerCase()).toMatch(/mais tarde|saldo|crédito/);
    // HG-2: NENHUMA cita o NOME de um provider.
    for (const c of [notCfg, vault, provErr]) {
      expect(c.message.toLowerCase()).not.toMatch(/openai|anthropic|deepseek|gpt|claude/);
    }
  });

  it('5xx genérico do broker ⇒ "o broker respondeu com erro (Nxx)"', () => {
    const c = classifyBrokerError(new BrokerError({ status: 503, code: 'HTTP_503', title: 't' }));
    expect(c.message).toContain('503');
    expect(c.message.toLowerCase()).toContain('broker respondeu com erro');
  });

  it('mensagem NEUTRA (HG-2): nunca cita provider, mesmo se o detail tentar', () => {
    const c = classifyBrokerError(
      new BrokerError({
        status: 502,
        code: 'PROVIDER_ERROR',
        title: 'x',
        detail: 'OpenAI gpt-4o respondeu 503', // o detail server-side NÃO deve vazar
      }),
    );
    expect(c.message.toLowerCase()).not.toMatch(/openai|anthropic|gpt/);
  });

  it('NUNCA vaza o token: nem o status, nem a mensagem, contêm o segredo', () => {
    // Erro de auth carregando o segredo no .message (não deveria, mas é o pior caso).
    const leaky = new BrokerError({
      status: 401,
      code: 'UNAUTHENTICATED',
      title: 'auth',
      detail: `token ${SECRET} rejeitado`,
    });
    const c = classifyBrokerError(leaky);
    expect(c.message).not.toContain(SECRET);
    expect(JSON.stringify(c)).not.toContain(SECRET);
  });

  // ── EST-0942 (este PR): 422 do modo Custom carrega o `detail` ACIONÁVEL ──────────
  // O bug do Tiago: 422 caía no fallback genérico ("o broker recusou a requisição
  // (422)." vazio), perdendo o `detail` ÚTIL que o broker mandou. Agora REPASSAMOS.
  const UNKNOWN_MODEL_DETAIL =
    "modelo 'Llama 3 1 8b' não existe no catálogo da OpenRouter. Escolha um modelo válido (o id exato que a OpenRouter expõe).";

  it('422 UNKNOWN_MODEL ⇒ headline "modelo inválido" + message COM o detail (id exato)', () => {
    const c = classifyBrokerError(
      new BrokerError({
        status: 422,
        code: 'UNKNOWN_MODEL',
        title: 'Unprocessable Content',
        detail: UNKNOWN_MODEL_DETAIL,
      }),
    );
    expect(c.headline).toBe('modelo inválido');
    expect(c.message).toBe(UNKNOWN_MODEL_DETAIL);
    expect(c.message).toContain('id exato'); // o acionável chega ao usuário
    expect(c.status).toBe(422);
  });

  it('422 VALIDATION_FAILED (Custom sem model) ⇒ "requisição inválida" + o detail', () => {
    const detail = "o modo Custom (tier:'custom') exige o campo 'model'.";
    const c = classifyBrokerError(
      new BrokerError({ status: 422, code: 'VALIDATION_FAILED', detail }),
    );
    expect(c.headline).toBe('requisição inválida');
    expect(c.message).toBe(detail);
    expect(c.status).toBe(422);
  });

  it('422 sem detail de topo ⇒ usa o detail do 1º errors[]', () => {
    const c = classifyBrokerError(
      new BrokerError({
        status: 422,
        code: 'VALIDATION_FAILED',
        errors: [{ field: 'model', code: 'invalid', detail: "exige o campo 'model'." }],
      }),
    );
    expect(c.message).toBe("exige o campo 'model'.");
  });

  it('422 SEM detail ⇒ fallback "o broker recusou a requisição (422)."', () => {
    const c = classifyBrokerError(new BrokerError({ status: 422, code: 'VALIDATION_FAILED' }));
    expect(c.message).toBe('o broker recusou a requisição (422).');
    expect(c.status).toBe(422);
  });

  it('422 com detail só de espaços em branco ⇒ cai no fallback (não mostra vazio)', () => {
    const c = classifyBrokerError(
      new BrokerError({ status: 422, code: 'UNKNOWN_MODEL', detail: '   ' }),
    );
    expect(c.message).toContain('id exato'); // fallback do UNKNOWN_MODEL, não string vazia
    expect(c.message.trim()).not.toBe('');
  });

  it('422 de code DESCONHECIDO ⇒ headline "requisição recusada" + repassa o detail', () => {
    const c = classifyBrokerError(
      new BrokerError({ status: 422, code: 'UNKNOWN_TIER', detail: "tier 'xpto' não existe." }),
    );
    expect(c.headline).toBe('requisição recusada');
    expect(c.message).toBe("tier 'xpto' não existe.");
  });

  it('422 só repassa o `detail`/`errors[].detail` — NUNCA title/type/instance crus (CLI-SEC-6)', () => {
    // O 422 surface o `detail` (redigido server-side). Mas NÃO ecoa OUTROS campos do
    // corpo: se um segredo de sentinela vier em `title`/`type`/`instance` (campos que
    // o cliente não deve mostrar), ele JAMAIS aparece na mensagem classificada.
    const c = classifyBrokerError(
      new BrokerError({
        status: 422,
        code: 'UNKNOWN_MODEL',
        detail: UNKNOWN_MODEL_DETAIL, // o único campo seguro p/ humano
        title: `título com ${SECRET}`,
        type: `https://errors/${SECRET}`,
        instance: `/v1/chat/${SECRET}`,
      }),
    );
    expect(c.message).toBe(UNKNOWN_MODEL_DETAIL);
    expect(JSON.stringify(c)).not.toContain(SECRET);
  });
});

// ── F52 — backend 'local': classificação cita "provider local", não "broker" ──

it('F52: backend "local" — headline default troca "broker indisponível" p/ "provider local indisponível"', () => {
  const c = classifyBrokerError(
    new BrokerTransportError('falha de transporte ao chamar o provider (backend local).'),
    'local',
  );
  expect(c.headline).toBe('provider local indisponível');
  expect(c.message).not.toContain('broker');
  expect(c.message).toContain('provider local');
});

it('F52: backend "local" — mensagem de transporte não cita "broker"', () => {
  const c = classifyBrokerError(new BrokerTransportError('connection refused'), 'local');
  expect(c.message).not.toContain('broker');
  expect(c.message).not.toContain('ALUY_BROKER_URL');
  expect(c.message).toContain('provider local');
  expect(c.headline).toBe('provider local indisponível');
});

it('F52: backend "local" — fallback genérico cita "provider local", não "broker"', () => {
  const c = classifyBrokerError(new Error('algo inesperado'), 'local');
  expect(c.headline).toBe('provider local indisponível');
  expect(c.message).toContain('provider local');
  expect(c.message).not.toContain('broker');
});

it('F52: backend "local" — 5xx classifica "erro do provider local", não "erro do broker"', () => {
  const c = classifyBrokerError(
    new BrokerError({ status: 503, code: 'HTTP_503', title: 't' }),
    'local',
  );
  expect(c.headline).toBe('erro do provider local');
  expect(c.message).toContain('503');
  expect(c.message).toContain('provider local');
  expect(c.message).not.toContain('broker');
});

it('F52: backend "local" — 422 fallback cita "provider local", não "broker"', () => {
  const c = classifyBrokerError(
    new BrokerError({ status: 422, code: 'VALIDATION_FAILED' }),
    'local',
  );
  expect(c.message).toContain('provider local');
  expect(c.message).not.toContain('broker');
});

it('F52: backend "broker" (default) — preserva comportamento original, NÃO regride', () => {
  // Transporte
  const t = classifyBrokerError(new BrokerTransportError('x'));
  expect(t.headline).toBe('broker indisponível');
  expect(t.message).toContain('broker');
  expect(t.message).toContain('ALUY_BROKER_URL');

  // Fallback
  const f = classifyBrokerError(new Error('x'));
  expect(f.headline).toBe('broker indisponível');
  expect(f.message).toContain('broker');
  expect(f.message).toContain('Aluy');

  // 5xx
  const g = classifyBrokerError(new BrokerError({ status: 503, code: 'HTTP_503', title: 't' }));
  expect(g.headline).toBe('erro do broker');
  expect(g.message).toContain('broker');
  expect(g.message).not.toContain('provider local');
});

// ── (2) integração via controller.onError (submit) ─────────────────────────────
describe('SessionController.onError — bloco classificado + (não-)retry (EST-0942)', () => {
  it('sem credencial (SessionExpiredError) ⇒ "rode aluy login", SEM auto-retry', async () => {
    const f = alwaysFailing(new SessionExpiredError());
    const { controller, snapshots } = buildController(f.model);

    await controller.submit('faça algo');

    expect(f.calls()).toBe(1); // auth não auto-retenta (não adianta repetir)
    expect(snapshots.some((s) => s.phase === 'retrying')).toBe(false);
    expect(controller.current.phase).toBe('error');
    const term = terminalBrokerError(controller.current.blocks);
    expect(term.message).toContain('aluy login');
    expect(term.headline?.toLowerCase()).not.toContain('indisponível');
  });

  it('401 ⇒ "credencial inválida/expirada, aluy login", SEM auto-retry', async () => {
    const err = new BrokerError({ status: 401, code: 'UNAUTHENTICATED', title: 'no auth' });
    const f = alwaysFailing(err);
    const { controller, snapshots } = buildController(f.model);

    await controller.submit('faça algo');

    expect(f.calls()).toBe(1); // 401 não auto-retenta
    expect(snapshots.some((s) => s.phase === 'retrying')).toBe(false);
    const term = terminalBrokerError(controller.current.blocks);
    expect(term.message.toLowerCase()).toContain('inválida ou expirada');
    expect(term.message).toContain('aluy login');
    expect(term.status).toBe(401);
  });

  it('conexão recusada (transporte) ⇒ "não conectei ao broker" (após esgotar o retry)', async () => {
    const f = alwaysFailing(new BrokerTransportError('connection refused'));
    const { controller } = buildController(f.model);

    await controller.submit('faça algo');

    // transporte É retryable (#74): tenta o ciclo BOUNDED, depois mostra o erro classificado.
    expect(f.calls()).toBeGreaterThan(1);
    const term = terminalBrokerError(controller.current.blocks);
    expect(term.message.toLowerCase()).toContain('não conectei ao broker');
    expect(term.headline).toBe('broker indisponível');
  });

  it('502 provider ⇒ "provedor do tier falhou, tente outro tier" (após esgotar o retry)', async () => {
    const err = new BrokerError({
      status: 502,
      code: 'PROVIDER_ERROR',
      title: 'x',
      retryable: true,
    });
    const f = alwaysFailing(err);
    const { controller } = buildController(f.model);

    await controller.submit('faça algo');

    const term = terminalBrokerError(controller.current.blocks);
    expect(term.message.toLowerCase()).toContain('provedor');
    expect(term.message.toLowerCase()).toContain('outro tier');
    expect(term.status).toBe(502);
  });

  it('402 ⇒ "sem crédito", SEM auto-retry', async () => {
    const err = new BrokerError({
      status: 402,
      code: 'INSUFFICIENT_CREDIT',
      title: 'saldo',
      retryable: false,
    });
    const f = alwaysFailing(err);
    const { controller, snapshots } = buildController(f.model);

    await controller.submit('faça algo');

    expect(f.calls()).toBe(1);
    expect(snapshots.some((s) => s.phase === 'retrying')).toBe(false);
    const term = terminalBrokerError(controller.current.blocks);
    expect(term.message.toLowerCase()).toContain('crédito');
    expect(term.status).toBe(402);
  });

  it('o token NUNCA aparece no bloco mostrado ao usuário', async () => {
    const err = new BrokerError({
      status: 401,
      code: 'UNAUTHENTICATED',
      title: 'auth',
      detail: `token ${SECRET} rejeitado`,
    });
    const f = alwaysFailing(err);
    const { controller } = buildController(f.model);

    await controller.submit('faça algo');

    const term = terminalBrokerError(controller.current.blocks);
    expect(JSON.stringify(term)).not.toContain(SECRET);
  });

  it('422 UNKNOWN_MODEL (Custom) ⇒ bloco COM o detail acionável, SEM auto-retry', async () => {
    const err = new BrokerError({
      status: 422,
      code: 'UNKNOWN_MODEL',
      title: 'Unprocessable Content',
      detail:
        "modelo 'Llama 3 1 8b' não existe no catálogo da OpenRouter. Escolha um modelo válido (o id exato que a OpenRouter expõe).",
    });
    const f = alwaysFailing(err);
    const { controller, snapshots } = buildController(f.model);

    await controller.submit('use o modelo Llama 3 1 8b');

    expect(f.calls()).toBe(1); // 422 = input inválido ⇒ NÃO adianta re-tentar
    expect(snapshots.some((s) => s.phase === 'retrying')).toBe(false);
    const term = terminalBrokerError(controller.current.blocks);
    expect(term.headline).toBe('modelo inválido');
    expect(term.message).toContain('id exato'); // o detail útil CHEGA ao Tiago
    expect(term.message).not.toBe('o broker recusou a requisição (422).'); // não é o vazio de antes
    expect(term.status).toBe(422);
  });
});
