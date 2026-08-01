// ADR-0158 §5 — testa `nextCronFire` (cálculo PURO do próximo disparo do `schedule`).
import { describe, it, expect } from 'vitest';
import { nextCronFire } from '@hiperplano/aluy-cli-core';

describe('nextCronFire', () => {
  it('rejeita expressão com contagem de campos errada', () => {
    expect(nextCronFire('* * * *', new Date('2026-08-01T10:00:00'))).toBeUndefined();
  });

  it('rejeita campo fora da faixa', () => {
    expect(nextCronFire('99 * * * *', new Date('2026-08-01T10:00:00'))).toBeUndefined();
  });

  it('"* * * * *" dispara no PRÓXIMO minuto (nunca o próprio `from`)', () => {
    const from = new Date('2026-08-01T10:00:30');
    const next = nextCronFire('* * * * *', from);
    expect(next).toEqual(new Date('2026-08-01T10:01:00'));
  });

  it('hora fixa hoje mais tarde', () => {
    const from = new Date('2026-08-01T08:00:00'); // sábado
    const next = nextCronFire('0 9 * * *', from);
    expect(next).toEqual(new Date('2026-08-01T09:00:00'));
  });

  it('hora fixa já passou hoje ⇒ amanhã', () => {
    const from = new Date('2026-08-01T10:00:00');
    const next = nextCronFire('0 9 * * *', from);
    expect(next).toEqual(new Date('2026-08-02T09:00:00'));
  });

  it('dias úteis (1-5) pula fim de semana — sexta tarde ⇒ segunda 9h', () => {
    // 2026-08-01 é sábado; então usamos sexta 2026-07-31 às 10h.
    const from = new Date('2026-07-31T10:00:00'); // sexta
    const next = nextCronFire('0 9 * * 1-5', from);
    expect(next).toEqual(new Date('2026-08-03T09:00:00')); // segunda
  });

  it('passo /15 dentro da hora', () => {
    const from = new Date('2026-08-01T10:02:00');
    const next = nextCronFire('*/15 * * * *', from);
    expect(next).toEqual(new Date('2026-08-01T10:15:00'));
  });

  it('passo /1 (limite mínimo válido) é aceito — equivale a "*"', () => {
    // A validação é `step < 1` (só rejeita `/0`, que travaria o loop de
    // varredura em incremento zero) — sem este teste, um mutante que troca
    // por `<=` (rejeitando também `/1`) passaria despercebido, já que o outro
    // teste de passo só cobre /15.
    const from = new Date('2026-08-01T10:02:00');
    const next = nextCronFire('*/1 * * * *', from);
    expect(next).toEqual(new Date('2026-08-01T10:03:00'));
  });

  it('lista de minutos', () => {
    const from = new Date('2026-08-01T10:02:00');
    const next = nextCronFire('0,30 * * * *', from);
    expect(next).toEqual(new Date('2026-08-01T10:30:00'));
  });

  it('nomes de mês/dia-da-semana', () => {
    const from = new Date('2026-08-01T10:00:00'); // sábado
    const next = nextCronFire('0 9 * * sun', from);
    expect(next).toEqual(new Date('2026-08-02T09:00:00')); // domingo
  });

  it('dom E dow ambos restritos ⇒ semântica OR (cron POSIX clássico)', () => {
    // "todo dia 1 do mês OU toda sexta" — a partir de sábado 2026-08-01, o próximo
    // é a sexta seguinte (2026-08-07), que vem antes do dia-1 do mês seguinte.
    const from = new Date('2026-08-01T10:00:00');
    const next = nextCronFire('0 9 1 * fri', from);
    expect(next).toEqual(new Date('2026-08-07T09:00:00'));
  });

  it('expressão que nunca casa (30 de fevereiro) ⇒ undefined (fail-safe, teto de 2 anos)', () => {
    const from = new Date('2026-08-01T10:00:00');
    expect(nextCronFire('0 0 30 2 *', from)).toBeUndefined();
  });
});
