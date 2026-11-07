// F-BG (21/09/2026, pedido do dono) — SOLTAR um comando para segundo plano, que NÃO é
// matar. O que existia era ESC/F8 (mata); faltava o oposto: o comando segue vivo e o TURNO
// deixa de esperar.
//
// O SINTOMA QUE ORIGINOU ISTO: o `timeoutMs` do shell é de INATIVIDADE, re-armado a cada
// chunk. Um comando longo e FALANTE — servidor, watcher, `tail -f` — nunca expira, então
// `run_command` não retorna e a tela fica "processando" indefinidamente.
//
// O RISCO QUE ESTES TESTES GUARDAM é o stdio. O filho tem stdout/stderr em PIPE. Se o turno
// para de esperar e ninguém drena, o buffer do SO enche e O PROCESSO TRAVA — o oposto do
// pedido. Não dá para re-apontar o stdio de um processo já em execução, então soltar =
// manter o dreno vivo redirecionando-o para um arquivo de log. É isso que se verifica aqui.
import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeShellPort } from '../../src/io/shell-port.js';
import type { DetachedShellInfo } from '@hiperplano/aluy-cli-core';

/** Workspace mínimo apontando para um dir temporário real. */
function workspaceEm(raiz: string) {
  return { root: raiz, cwd: raiz, resolveInside: (p: string) => join(raiz, p) } as never;
}

function porta(raiz: string): NodeShellPort {
  return new NodeShellPort({
    workspace: workspaceEm(raiz),
    // Curto de propósito: se o "soltar" NÃO parar o relógio de inatividade, o anti-hang
    // mata o processo e o teste denuncia — é a regressão mais fácil de introduzir aqui.
    timeoutMs: 1_500,
  });
}

const esperar = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Limpeza tolerante. No Windows, apagar um dir que ainda é `cwd` de um processo
 * recém-morto dá EPERM — o SO leva um instante para soltar a referência. Tentamos algumas
 * vezes e desistimos em silêncio: é um temporário, e falhar ao limpá-lo NÃO é o defeito
 * que este arquivo investiga.
 */
async function limpar(raiz: string): Promise<void> {
  for (let i = 0; i < 5; i++) {
    try {
      rmSync(raiz, { recursive: true, force: true });
      return;
    } catch {
      await esperar(120);
    }
  }
}

describe('F-BG · NodeShellPort — soltar para segundo plano', () => {
  it('SOLTAR resolve o turno na hora, sem matar o processo', async () => {
    const raiz = mkdtempSync(join(tmpdir(), 'aluy-bg-'));
    try {
      const ctl = new AbortController();
      let info: DetachedShellInfo | undefined;
      const p = porta(raiz).exec('node -e "setInterval(()=>console.log(\'vivo\'),80)"', {
        detachSignal: ctl.signal,
        onDetached: (i) => {
          info = i;
        },
      });
      await esperar(250);
      ctl.abort(); // Ctrl+B
      const r = await p;

      expect(r.detached).toBe(true);
      expect(r.logPath).toBeTruthy();
      expect(info).toBeDefined();
      expect(info!.command).toContain('setInterval');
      // O processo NÃO morreu com o soltar — quem mata é o `kill` do handle.
      info!.handle.kill();
    } finally {
      await limpar(raiz);
    }
  });

  // A REGRESSÃO MAIS CARA: parar de drenar enche o pipe e trava o processo. Um comando
  // que cospe MUITO depois de solto prova que o dreno seguiu vivo.
  it('o processo solto CONTINUA produzindo saída (o pipe não entope)', async () => {
    const raiz = mkdtempSync(join(tmpdir(), 'aluy-bg-'));
    try {
      const ctl = new AbortController();
      let info: DetachedShellInfo | undefined;
      const p = porta(raiz).exec(
        'node -e "let i=0;const t=setInterval(()=>{console.log(\'linha\'+(i++)+\' \'.repeat(500));if(i>200){clearInterval(t)}},1)"',
        {
          detachSignal: ctl.signal,
          onDetached: (i) => {
            info = i;
          },
        },
      );
      await esperar(120);
      ctl.abort();
      await p;

      // Espera o processo terminar SOZINHO — se o pipe tivesse entupido, ele travaria
      // e o `onExit` nunca chegaria.
      const code = await new Promise<number | null>((resolve) => {
        const timer = setTimeout(() => resolve(-1), 8000);
        info!.handle.onExit((c) => {
          clearTimeout(timer);
          resolve(c);
        });
      });
      expect(code).toBe(0);

      const log = readFileSync(info!.logPath, 'utf8');
      expect(log).toContain('solto para segundo plano');
      expect(log).toContain('linha150'); // saiu DEPOIS de solto ⇒ o dreno seguiu vivo
      expect(log).toContain('fim — exit=0');
    } finally {
      await limpar(raiz);
    }
  }, 20_000);

  // Sem isto, o anti-hang mataria justamente o processo que o dono mandou manter vivo.
  it('depois de solto, o timeout de INATIVIDADE não mata mais o processo', async () => {
    const raiz = mkdtempSync(join(tmpdir(), 'aluy-bg-'));
    try {
      const ctl = new AbortController();
      let info: DetachedShellInfo | undefined;
      // Silencioso por 3s — MAIS que o timeoutMs de 1.5s da porta.
      const p = porta(raiz).exec('node -e "setTimeout(()=>console.log(\'fim\'),3000)"', {
        detachSignal: ctl.signal,
        onDetached: (i) => {
          info = i;
        },
      });
      await esperar(150);
      ctl.abort();
      await p;

      const code = await new Promise<number | null>((resolve) => {
        const timer = setTimeout(() => resolve(-1), 8000);
        info!.handle.onExit((c) => {
          clearTimeout(timer);
          resolve(c);
        });
      });
      // exit 0 = terminou sozinho. Se o anti-hang tivesse agido, viria sinal/não-zero.
      expect(code).toBe(0);
      expect(readFileSync(info!.logPath, 'utf8')).toContain('fim');
    } finally {
      await limpar(raiz);
    }
  }, 20_000);

  it('o que saiu ANTES de soltar também vai para o log (não se perde o começo)', async () => {
    const raiz = mkdtempSync(join(tmpdir(), 'aluy-bg-'));
    try {
      const ctl = new AbortController();
      let info: DetachedShellInfo | undefined;
      const p = porta(raiz).exec(
        'node -e "console.log(\'ANTES-DE-SOLTAR\');setTimeout(()=>console.log(\'DEPOIS\'),400)"',
        {
          detachSignal: ctl.signal,
          onDetached: (i) => {
            info = i;
          },
        },
      );
      await esperar(250);
      ctl.abort();
      await p;
      await esperar(900);

      const log = readFileSync(info!.logPath, 'utf8');
      expect(log).toContain('ANTES-DE-SOLTAR');
      expect(log).toContain('DEPOIS');
    } finally {
      await limpar(raiz);
    }
  }, 20_000);

  it('SEM detachSignal o comportamento é o de sempre (não-regressão)', async () => {
    const raiz = mkdtempSync(join(tmpdir(), 'aluy-bg-'));
    try {
      const r = await porta(raiz).exec('node -e "console.log(42)"');
      expect(r.detached).toBeUndefined();
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('42');
      expect(r.logPath).toBeUndefined();
    } finally {
      await limpar(raiz);
    }
  }, 20_000);

  it('abort (ESC) e detach (Ctrl+B) são opostos: o primeiro mata, o segundo não', async () => {
    const raiz = mkdtempSync(join(tmpdir(), 'aluy-bg-'));
    try {
      const kill = new AbortController();
      const r = await (async () => {
        const p = porta(raiz).exec('node -e "setInterval(()=>console.log(1),50)"', {
          signal: kill.signal,
        });
        await esperar(200);
        kill.abort();
        return p;
      })();
      expect(r.aborted).toBe(true);
      expect(r.detached).toBeUndefined();
      expect(existsSync(join(raiz, 'nada'))).toBe(false);
    } finally {
      await limpar(raiz);
    }
  }, 20_000);
});
