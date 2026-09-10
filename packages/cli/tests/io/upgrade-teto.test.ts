// O TETO do `npm install -g` existe para um npm PENDURADO não ficar de pé para sempre — não
// para apressar um install que está progredindo.
//
// Relato do dono (09/09, Windows): "a atualização para 1.0.0-rc.174 FALHOU: o npm demorou
// demais e foi interrompido". O teto era 60s — um número de Linux com cache quente (aqui um
// `npm pack` do pacote leva 1,4s). No Windows o mesmo install atravessa o antivírus lendo
// cada arquivo extraído e, com o perfil no OneDrive, a sincronização por cima.
//
// O que torna o prazo curto especialmente ruim: o install roda em SEGUNDO PLANO, então
// esperar não custa nada a ninguém — e a falha se REPETE a cada abertura, porque a versão
// nunca chega. Foi o que prendeu o dono na rc.173 com a 174 publicada.

import { describe, expect, it } from 'vitest';
import { tetoDeInstalacaoMs } from '../../src/io/auto-update.js';

describe('tetoDeInstalacaoMs', () => {
  it('o default é generoso — install em segundo plano não tem pressa', () => {
    expect(tetoDeInstalacaoMs({})).toBe(5 * 60 * 1000);
  });

  it('não é mais o minuto que cortou o install do dono', () => {
    expect(tetoDeInstalacaoMs({}), 'era 60_000 e falhava no Windows').toBeGreaterThan(60_000);
  });

  it('o env ajusta para quem tem máquina mais lenta (ou mais rápida)', () => {
    expect(tetoDeInstalacaoMs({ ALUY_UPGRADE_TIMEOUT_MS: '600000' })).toBe(600_000);
  });

  it('PISO — um valor minúsculo voltaria a matar install bom', () => {
    expect(tetoDeInstalacaoMs({ ALUY_UPGRADE_TIMEOUT_MS: '1' })).toBe(30_000);
    expect(tetoDeInstalacaoMs({ ALUY_UPGRADE_TIMEOUT_MS: '0' })).toBe(30_000);
  });

  it('TETO — um valor absurdo faria o processo pendurado sobreviver à sessão', () => {
    expect(tetoDeInstalacaoMs({ ALUY_UPGRADE_TIMEOUT_MS: '999999999' })).toBe(20 * 60 * 1000);
  });

  it('lixo no env cai no default, nunca em NaN', () => {
    for (const v of ['', 'abc', 'null']) {
      expect(tetoDeInstalacaoMs({ ALUY_UPGRADE_TIMEOUT_MS: v })).toBe(5 * 60 * 1000);
    }
  });
});
