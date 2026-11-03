// Auditoria — persistência da pausa por cota (`~/.aluy/pausas/<sessão>.json`): varredura de
// pausas velhas, imagens fora do disco, id inseguro, sanitização na leitura e ausência de
// temporários. Tudo em dir temporário (nunca o ~/.aluy real).

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PausaStore } from '../../src/io/pausa-store.js';

const DIA_MS = 24 * 3_600_000;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aluy-pausa-lim-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const snap = (label = 'principal', over: Record<string, unknown> = {}) => ({
  label,
  kind: 'principal' as const,
  history: [{ role: 'goal' as const, text: 'objetivo' }],
  pausedAt: 5,
  ...over,
});
const base = { scope: 'janela', reason: 'r' };

describe('PausaStore · limites', () => {
  it('a próxima gravação varre pausas mais velhas que 14 dias, e só elas', () => {
    const store = new PausaStore({ baseDir: dir });
    store.save({ ...base, sessionId: 'velha', agents: [snap()] });
    store.save({ ...base, sessionId: 'recente', agents: [snap()] });
    store.save({ ...base, sessionId: 'quase', agents: [snap()] });
    const velha = store.pathFor('velha');
    const antigo = (Date.now() - 14 * DIA_MS - 3_600_000) / 1000;
    utimesSync(velha, antigo, antigo);
    const quase = (Date.now() - 13 * DIA_MS) / 1000;
    utimesSync(store.pathFor('quase'), quase, quase);
    store.save({ ...base, sessionId: 'nova', agents: [snap()] });
    expect(existsSync(velha)).toBe(false);
    expect(store.load('recente')).not.toBeNull();
    expect(store.load('quase')).not.toBeNull(); // 13 dias ainda vale
    expect(store.load('nova')).not.toBeNull();
  });

  it('imagens anexadas não vão para o disco; o resto do histórico fica', () => {
    const store = new PausaStore({ baseDir: dir });
    store.save({
      ...base,
      sessionId: 's',
      agents: [
        snap('principal', {
          history: [
            { role: 'goal', text: 'olha isto' },
            { role: 'attachment_image', text: 'AAAA', mediaType: 'image/png', name: 'x.png' },
          ],
        }),
      ],
    });
    const back = store.load('s');
    expect(back?.agents[0]?.history).toHaveLength(1);
    expect(back?.agents[0]?.history[0]).toMatchObject({ role: 'goal' });
  });

  it('id com caminho/barra/ponto não grava nem lê fora do diretório de pausas', () => {
    const store = new PausaStore({ baseDir: dir });
    for (const id of ['../fora', 'a/b', '', 'x'.repeat(129), 'com espaço']) {
      expect(store.save({ ...base, sessionId: id, agents: [snap()] })).toBe(false);
      expect(store.load(id)).toBeNull();
    }
    expect(existsSync(join(dir, 'fora.json'))).toBe(false);
  });

  it('não deixa arquivo temporário para trás', () => {
    const store = new PausaStore({ baseDir: dir });
    store.save({ ...base, sessionId: 's', agents: [snap()] });
    store.save({ ...base, sessionId: 's', agents: [snap('principal', { pausedAt: 9 })] });
    const nomes = readdirSync(join(dir, 'pausas'));
    expect(nomes).toEqual(['s.json']);
  });

  it('leitura sanitiza: sessionId trocado, sub-agente sem perfil e registro sem agentes são descartados', () => {
    const store = new PausaStore({ baseDir: dir });
    mkdirSync(join(dir, 'pausas'), { recursive: true });
    const escreve = (id: string, corpo: unknown): void =>
      writeFileSync(join(dir, 'pausas', `${id}.json`), JSON.stringify(corpo));
    // sessionId do conteúdo diverge do nome do arquivo ⇒ rejeita
    escreve('a', { sessionId: 'outra', agents: [snap()] });
    expect(store.load('a')).toBeNull();
    // sub-agente sem perfil não é retomável ⇒ some; sem restar agente ⇒ null
    escreve('b', { sessionId: 'b', agents: [snap('f', { kind: 'subagente' })] });
    expect(store.load('b')).toBeNull();
    // principal + sub-agente sem perfil: fica só o principal
    escreve('c', {
      sessionId: 'c',
      scope: 'semanal',
      agents: [snap(), snap('f', { kind: 'subagente' })],
    });
    const c = store.load('c');
    expect(c?.agents.map((x) => x.label)).toEqual(['principal']);
    expect(c?.scope).toBe('semanal');
    // JSON quebrado ⇒ null (fail-safe)
    writeFileSync(join(dir, 'pausas', 'd.json'), '{nao é json');
    expect(store.load('d')).toBeNull();
  });
});
