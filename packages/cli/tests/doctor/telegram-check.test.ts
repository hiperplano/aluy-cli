// #TG — o `/doctor` passa a olhar o conector Telegram.
//
// "o doctor tmbm nao valida nada do telegram" — o dono, depois de dias achando que o
// conector não existia. O `/doctor` é o lugar onde se vai perguntar "o que está errado?",
// e era o terceiro lugar que não contava: o motivo da recusa ia para um stderr apagado pela
// TUI, o `/telegram status` negava o recurso com uma frase cravada, e aqui não havia nada.
//
// Cada estado tem um CONSERTO nomeado. Um diagnóstico que diz "há algo errado" sem dizer o
// próximo passo é o mesmo silêncio com outra roupa.

import { describe, expect, it } from 'vitest';
import { checkTelegram } from '../../src/doctor/checks.js';

describe('/doctor — conector Telegram', () => {
  it('sem token ⇒ AVISO, e manda fazer login', () => {
    const c = checkTelegram({ tokenPresent: false, allowlistSize: 0 });
    expect(c.status).toBe('warn');
    expect(c.detail).toContain('sem token');
    expect(c.fix).toContain('aluy telegram login');
  });

  // O caso mais traiçoeiro: tudo parece certo, a ponte SOBE, e nada entra.
  it('token presente + allowlist VAZIA ⇒ AVISO explicando que a ponte sobe FECHADA', () => {
    const c = checkTelegram({ tokenPresent: true, allowlistSize: 0 });
    expect(c.status).toBe('warn');
    expect(c.detail).toContain('VAZIA');
    expect(c.fix).toContain('allow');
  });

  // O estado em que o dono ficou preso, sem ninguém dizer: configurado e sem a flag.
  it('configurado mas sem a flag ⇒ AVISO dizendo que falta `--telegram`', () => {
    const c = checkTelegram({ tokenPresent: true, allowlistSize: 1, bridgeActive: false });
    expect(c.status).toBe('warn');
    expect(c.fix).toContain('--telegram');
  });

  it('ponte no ar ⇒ OK, com a contagem de chats', () => {
    const c = checkTelegram({ tokenPresent: true, allowlistSize: 2, bridgeActive: true });
    expect(c.status).toBe('ok');
    expect(c.detail).toContain('2');
    expect(c.fix).toBeUndefined(); // nada a consertar
  });

  it('fora de sessão (não dá para saber da ponte) ⇒ trata como não-ligada, sem inventar', () => {
    const c = checkTelegram({ tokenPresent: true, allowlistSize: 1 });
    expect(c.status).toBe('warn');
    expect(c.fix).toContain('--telegram');
  });

  it('NUNCA carrega o token — só presença e contagens', () => {
    const c = checkTelegram({ tokenPresent: true, allowlistSize: 1, bridgeActive: true });
    const texto = `${c.detail} ${c.fix ?? ''}`;
    expect(texto).not.toMatch(/[0-9]{6,}:[A-Za-z0-9_-]{20,}/); // forma de token do BotFather
  });
});
