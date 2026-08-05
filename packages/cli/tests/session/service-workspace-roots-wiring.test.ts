// ADR-0158 — INTEGRAÇÃO do `workspace:` do service.md no wiring da sessão
// (`buildSession`, `session/wiring.ts`). O runner já resolveu/validou as raízes
// (`resolveServiceWorkspaceRoots`, `io/services-store.ts` — testado à parte em
// `workspace-roots.test.ts`/`services-store.test.ts`) e as propaga via a env
// interna `ALUY_SERVICE_WORKSPACE_ROOTS`; este arquivo prova que o WIRING as
// AUTORIZA de verdade (`workspace.addRoot`), com a MECÂNICA REAL do
// `NodeWorkspace` (sem mockar `resolveInside`) — a prova empírica pedida:
//
//   (c) COM a raiz declarada, um acesso DENTRO dela é PERMITIDO;
//   (d) um acesso a um diretório VIZINHO não declarado continua NEGADO — a prova
//       que distingue isto de `unconfined` (YOLO): a cerca continua de pé, só
//       que com MAIS DE UMA raiz autorizada;
//   (e) o PISO NÃO CAI: mesmo com `ALUY_SERVICE_WORKSPACE_ROOTS` contendo um path
//       dentro do "~/.aluy/" (aqui, via `HOME` injetado — NUNCA o real da
//       máquina), aquela raiz especificamente NUNCA é autorizada;
//   (f) sem a env (serviço sem `workspace:`, ou sessão interativa normal do
//       dono) ⇒ zero mudança — só a raiz primária, mesmo comportamento de hoje.
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSession } from '../../src/session/wiring.js';
import { WorkspaceEscapeError } from '../../src/io/workspace.js';

describe('buildSession — ALUY_SERVICE_WORKSPACE_ROOTS (workspace: do service.md)', () => {
  let base: string;
  let serviceDir: string;
  let fakeHome: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'aluy-svc-ws-wiring-'));
    serviceDir = join(base, 'services', 'trader');
    mkdirSync(serviceDir, { recursive: true });
    fakeHome = join(base, 'home');
    mkdirSync(fakeHome, { recursive: true });
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  it('(c)+(d) raiz declarada ⇒ leitura DENTRO dela permitida; num VIZINHO não declarado, negada', () => {
    const extraDir = join(base, 'external', 'fluider');
    const neighborDir = join(base, 'external', 'outro-projeto');
    mkdirSync(extraDir, { recursive: true });
    mkdirSync(neighborDir, { recursive: true });
    writeFileSync(join(extraDir, 'dados.txt'), 'ok');
    writeFileSync(join(neighborDir, 'segredo.txt'), 'nao deveria ler');

    const s = buildSession({
      workspaceRoot: serviceDir,
      mode: 'normal',
      env: {
        HOME: fakeHome,
        ALUY_SERVICE_HOME: serviceDir,
        ALUY_SERVICE_WORKSPACE_ROOTS: JSON.stringify([extraDir]),
      },
    });

    // (c) — dentro da raiz declarada, resolve sem lançar.
    expect(() => s.workspace.resolveInside(join(extraDir, 'dados.txt'))).not.toThrow();
    expect(s.workspace.contains(extraDir)).toBe(true);

    // (d) — o VIZINHO não foi declarado: continua FORA das raízes autorizadas.
    // Esta é a prova que distingue de `unconfined`: só a raiz declarada abre,
    // tudo o mais junto dela segue negado.
    expect(() => s.workspace.resolveInside(join(neighborDir, 'segredo.txt'))).toThrow(
      WorkspaceEscapeError,
    );
    expect(s.workspace.contains(neighborDir)).toBe(false);
  });

  it('(e) PISO QUE NÃO CAI — raiz declarada dentro do "~/.aluy/" (HOME injetado) NUNCA é autorizada', () => {
    const aluyHomeDirPath = join(fakeHome, '.aluy');
    mkdirSync(aluyHomeDirPath, { recursive: true });

    const s = buildSession({
      workspaceRoot: serviceDir,
      mode: 'normal',
      env: {
        HOME: fakeHome,
        ALUY_SERVICE_HOME: serviceDir,
        ALUY_SERVICE_WORKSPACE_ROOTS: JSON.stringify([aluyHomeDirPath]),
      },
    });

    // NÃO virou raiz: um acesso a ela segue FORA das raízes autorizadas (só a
    // raiz primária — `serviceDir` — segue de pé).
    expect(s.workspace.contains(aluyHomeDirPath)).toBe(false);
    expect(s.workspace.roots).toEqual([s.workspace.root]);
  });

  it('(f) sem ALUY_SERVICE_WORKSPACE_ROOTS ⇒ zero mudança — só a raiz primária (comportamento de hoje)', () => {
    const s = buildSession({
      workspaceRoot: serviceDir,
      mode: 'normal',
      env: { HOME: fakeHome },
    });
    expect(s.workspace.roots).toEqual([s.workspace.root]);
  });
});
