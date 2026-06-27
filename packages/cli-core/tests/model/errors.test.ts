import { describe, expect, it } from 'vitest';
import {
  BrokerError,
  BrokerTransportError,
  ModelCallAbortedError,
  toProblemDetails,
} from '../../src/model/errors.js';

describe('toProblemDetails', () => {
  it('extrai code/detail/retryable de um problem+json do broker', () => {
    const p = toProblemDetails(402, {
      status: 402,
      code: 'INSUFFICIENT_CREDIT',
      detail: 'saldo insuficiente.',
      retryable: false,
    });
    expect(p).toMatchObject({ status: 402, code: 'INSUFFICIENT_CREDIT', retryable: false });
  });

  it('sintetiza um problem honesto quando o corpo não é reconhecível (sem inventar)', () => {
    const p = toProblemDetails(403, 'corpo cru não-json');
    expect(p).toEqual({ status: 403, code: 'PERMISSION_DENIED' });
  });

  it('mapeia status conhecidos para code default', () => {
    expect(toProblemDetails(401, {}).code).toBe('UNAUTHENTICATED');
    expect(toProblemDetails(429, {}).code).toBe('RATE_LIMITED');
    expect(toProblemDetails(502, {}).code).toBe('PROVIDER_ERROR');
    expect(toProblemDetails(418, {}).code).toBe('HTTP_418');
  });

  // EST-0942 — 422 do modo Custom (UNKNOWN_MODEL / VALIDATION_FAILED). O `detail`
  // ACIONÁVEL do broker DEVE ser capturado (o bug: o cliente o engolia).
  it('captura code + detail de um 422 UNKNOWN_MODEL (o detail acionável do Custom)', () => {
    const p = toProblemDetails(422, {
      status: 422,
      code: 'UNKNOWN_MODEL',
      title: 'Unprocessable Content',
      detail:
        "modelo 'Llama 3 1 8b' não existe no catálogo da OpenRouter. Escolha um modelo válido (o id exato que a OpenRouter expõe).",
    });
    expect(p.code).toBe('UNKNOWN_MODEL');
    expect(p.detail).toContain('id exato');
  });

  // EST-0942 — o `errors[]` ({field,code,detail}) é preservado p/ inspeção do campo.
  it('preserva o array errors[] ({field,code,detail}) do envelope', () => {
    const p = toProblemDetails(422, {
      status: 422,
      code: 'VALIDATION_FAILED',
      detail: "o modo Custom (tier:'custom') exige o campo 'model'.",
      errors: [{ field: 'model', code: 'invalid', detail: "exige o campo 'model'." }],
    });
    expect(p.errors).toEqual([
      { field: 'model', code: 'invalid', detail: "exige o campo 'model'." },
    ]);
  });

  it('descarta lixo no errors[] sem inventar campos; ausente quando nada aproveitável', () => {
    const p = toProblemDetails(422, {
      status: 422,
      code: 'VALIDATION_FAILED',
      errors: ['lixo', 42, null, {}, { field: 'model' }],
    });
    expect(p.errors).toEqual([{ field: 'model' }]);
    const empty = toProblemDetails(422, { status: 422, code: 'VALIDATION_FAILED', errors: [] });
    expect(empty.errors).toBeUndefined();
    const notArray = toProblemDetails(422, {
      status: 422,
      code: 'VALIDATION_FAILED',
      errors: 'x',
    });
    expect(notArray.errors).toBeUndefined();
  });
});

describe('BrokerError', () => {
  it('default de retryable: 5xx/429 retryable; 4xx (≠429) não', () => {
    expect(new BrokerError({ status: 502, code: 'PROVIDER_ERROR' }).retryable).toBe(true);
    expect(new BrokerError({ status: 429, code: 'RATE_LIMITED' }).retryable).toBe(true);
    expect(new BrokerError({ status: 401, code: 'UNAUTHENTICATED' }).retryable).toBe(false);
    expect(new BrokerError({ status: 422, code: 'UNKNOWN_TIER' }).retryable).toBe(false);
  });

  it('isAuth/isQuota classificam corretamente', () => {
    expect(new BrokerError({ status: 401, code: 'UNAUTHENTICATED' }).isAuth).toBe(true);
    expect(new BrokerError({ status: 429, code: 'BUDGET_EXHAUSTED' }).isQuota).toBe(true);
    expect(new BrokerError({ status: 402, code: 'INSUFFICIENT_CREDIT' }).isQuota).toBe(true);
    expect(new BrokerError({ status: 502, code: 'PROVIDER_ERROR' }).isQuota).toBe(false);
  });

  it('a mensagem usa detail (seguro), nunca um corpo cru com segredo', () => {
    const e = new BrokerError({ status: 502, code: 'PROVIDER_ERROR', detail: 'falhou.' });
    expect(e.message).toBe('falhou.');
  });

  // EST-0996 — degradação gracioso: 422 TOOLS_UNSUPPORTED ⇒ retry sem tools.
  it('isToolsUnsupported: só true em 422 + code TOOLS_UNSUPPORTED', () => {
    const yes = new BrokerError({ status: 422, code: 'TOOLS_UNSUPPORTED' });
    expect(yes.isToolsUnsupported).toBe(true);

    // outro 422 não é TOOLS_UNSUPPORTED
    expect(new BrokerError({ status: 422, code: 'VALIDATION_FAILED' }).isToolsUnsupported).toBe(
      false,
    );
    // outro status com o mesmo code também não
    expect(new BrokerError({ status: 400, code: 'TOOLS_UNSUPPORTED' }).isToolsUnsupported).toBe(
      false,
    );
  });
});

describe('BrokerTransportError', () => {
  it('tem name correto e preserva a mensagem', () => {
    const e = new BrokerTransportError('timeout de rede');
    expect(e.name).toBe('BrokerTransportError');
    expect(e.message).toBe('timeout de rede');
    expect(e).toBeInstanceOf(Error);
  });

  it('preserva o cause quando fornecido', () => {
    const causa = new Error('socket hung up');
    const e = new BrokerTransportError('falha de transporte', causa);
    expect(e.cause).toBe(causa);
  });

  it('funciona sem cause (não lança)', () => {
    expect(() => new BrokerTransportError('sem causa')).not.toThrow();
    const e = new BrokerTransportError('sem causa');
    expect(e.cause).toBeUndefined();
  });
});

describe('ModelCallAbortedError', () => {
  it('tem name correto e mensagem em PT-BR', () => {
    const e = new ModelCallAbortedError();
    expect(e.name).toBe('ModelCallAbortedError');
    expect(e.message).toBe('chamada de modelo cancelada.');
    expect(e).toBeInstanceOf(Error);
  });
});
