// CHAVE-REVOGADA (dogfooding real) — o serviço do dono, na rc.130, fez isto:
//
//   [05:06:08] atividade 1/6 "scan": ok.
//   [05:06:08] atividade 2/6 "traduzir": iniciando turno…
//   [05:06:10] atividade 2/6 "traduzir": turno terminou com erro. — … o keychain do SO
//              NÃO respondeu (Couldn't access platform storage: KeyRevoked)
//
// DOIS SEGUNDOS entre ler a chave com sucesso e receber `KeyRevoked`. Na máquina dele o
// backend do keychain é o keyring do KERNEL (não há Secret Service): ele é VOLÁTIL e
// REVOGADO junto com a sessão que o criou. Como cada atividade é um processo NOVO que
// relê a credencial do zero, o serviço vivia à mercê de qual sessão ainda estava viva.
//
// Um cache em memória (rc.130) não alcança este caso — ele morre com o processo. O
// RUNNER é o único que dura o expediente inteiro: ele resolve UMA vez e sustenta os
// filhos pelo catch-all `ALUY_LOCAL_API_KEY` que o resolvedor já consultava.
//
// O que estes testes travam: a credencial CHEGA nos filhos; NÃO atropela a do dono; NÃO
// aparece quando não foi resolvida; e o serviço sem ela continua idêntico ao de antes.

import { describe, expect, it } from 'vitest';
import { buildActivityEnv } from '../../src/service/runner.js';

const DIR = '/tmp/servico-x';

describe('buildActivityEnv — credencial do runner chega ao filho', () => {
  it('resolvida pelo runner ⇒ vai como ALUY_LOCAL_API_KEY (o catch-all do resolvedor)', () => {
    const env = buildActivityEnv(DIR, undefined, {}, undefined, undefined, 'sk-do-runner');
    expect(env.ALUY_LOCAL_API_KEY).toBe('sk-do-runner');
  });

  it('a chave do DONO no ambiente VENCE — nunca sobrescrevemos o que ele exportou', () => {
    const env = buildActivityEnv(
      DIR,
      undefined,
      { ALUY_LOCAL_API_KEY: 'sk-do-dono' },
      undefined,
      undefined,
      'sk-do-runner',
    );
    expect(env.ALUY_LOCAL_API_KEY).toBe('sk-do-dono');
  });

  it('runner NÃO resolveu ⇒ a chave nem existe no env (comportamento de antes, byte a byte)', () => {
    const env = buildActivityEnv(DIR, undefined, {}, undefined, undefined, undefined);
    expect('ALUY_LOCAL_API_KEY' in env).toBe(false);
  });

  it('não vaza para outras chaves nem mexe no resto do env do serviço', () => {
    const env = buildActivityEnv(
      DIR,
      'macro',
      { PATH: '/bin' },
      'yolo-scoped',
      ['/home/aluy/projects/fluider'],
      'sk-do-runner',
    );
    expect(env.ALUY_SERVICE_HOME).toBe(DIR);
    expect(env.ALUY_SERVICE_PERSONA).toBe('macro');
    expect(env.ALUY_SERVICE_AUTONOMY).toBe('yolo-scoped');
    expect(env.ALUY_SERVICE_WORKSPACE_ROOTS).toBe('["/home/aluy/projects/fluider"]');
    expect(env.PATH).toBe('/bin');
    // A credencial mora numa chave SÓ — nada de eco em OPENROUTER_API_KEY & cia.
    const comSegredo = Object.entries(env).filter(([, v]) => v === 'sk-do-runner');
    expect(comSegredo.map(([k]) => k)).toEqual(['ALUY_LOCAL_API_KEY']);
  });

  it('string vazia NÃO vira credencial — a chave nem aparece', () => {
    // Injetar `''` faria o resolvedor do filho ACHAR que tem chave (o catch-all é
    // consultado antes do erro) e falhar depois, com a mensagem do provider recusando
    // em vez da que aponta o keychain — trocaria um diagnóstico bom por um ruim.
    const env = buildActivityEnv(DIR, undefined, {}, undefined, undefined, '');
    expect('ALUY_LOCAL_API_KEY' in env).toBe(false);
  });
});
