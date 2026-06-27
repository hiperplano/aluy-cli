// EST-0957 — useFilePicker: máquina de estado do `@` (abrir/filtrar/navegar/anexar)
// + chips. Drivado por um Probe que expõe a API do hook via um ref e os getters de
// estado via texto. Não depende de `useInput`/TTY (testável no harness).

import React, { useEffect, useState } from 'react';
import { Text } from 'ink';
import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { useFilePicker, type FilePickerController } from '../../src/ui/hooks/useFilePicker.js';
import type { FileIndexPort } from '../../src/io/file-index.js';
import { AttachReader } from '../../src/attach/reader.js';
import type { WorkspacePort } from '../../src/io/workspace.js';
import type { FileSystemPort } from '@aluy/cli-core';

const PATHS = ['src/auth/session.ts', 'src/auth/config.ts', 'README.md'];

/** Index fake (sem fs). */
const fakeIndex: FileIndexPort = { list: async () => PATHS };

/** Workspace fake que confina trivialmente (tudo relativo é "dentro"). */
const fakeWorkspace: WorkspacePort = {
  root: '/proj',
  resolveInside(p) {
    if (p.includes('..')) throw new Error('escape');
    return `/proj/${p}`;
  },
  contains: (p) => !p.includes('..'),
};

/** FS fake: devolve um conteúdo p/ qualquer caminho dentro. */
const fakeFs: FileSystemPort = {
  async readFile(p) {
    return `// conteúdo de ${p}\n`;
  },
  async writeFile() {},
  async exists() {
    return true;
  },
};

function makeReader(): AttachReader {
  return new AttachReader({ workspace: fakeWorkspace, fs: fakeFs });
}

/**
 * Probe: roda uma sequência de AÇÕES no hook (via useEffect, uma por render) e
 * expõe o estado corrente como texto. `onReady` entrega o controller p/ o teste
 * inspecionar entre passos.
 */
function Probe(props: {
  steps: readonly ((c: FilePickerController) => void | Promise<void>)[];
  onState: (c: FilePickerController) => void;
  onDone?: () => void;
}): React.ReactElement {
  const picker = useFilePicker({ fileIndex: fakeIndex, attachReader: makeReader() });
  // Um passo POR RENDER: cada `step` roda com closures FRESCAS (como o App faz, um
  // `useInput` por tecla). Avança o índice após cada passo, forçando re-render.
  const [stepIdx, setStepIdx] = useState(0);
  useEffect(() => {
    props.onState(picker);
    // Sinaliza conclusão DETERMINÍSTICA: quando o último passo já rodou e o render
    // com o estado final já comitou, avisa `drive` (sem depender de sleep fixo).
    if (stepIdx >= props.steps.length) props.onDone?.();
  });
  useEffect(() => {
    if (stepIdx >= props.steps.length) return;
    let cancelled = false;
    void (async () => {
      await props.steps[stepIdx]!(picker);
      if (!cancelled) setStepIdx((i) => i + 1);
    })();
    return () => {
      cancelled = true;
    };
  }, [stepIdx]);
  return (
    <Text>
      {`open=${picker.open} q=${picker.query} sel=${picker.selected} hits=${picker.hits.length} chips=${picker.attachments
        .map((a) => a.path)
        .join(',')}`}
    </Text>
  );
}

/** Como `Probe`, mas com um índice INJETÁVEL (p/ testar o filtro `isPickable`). */
function Probe2(props: {
  index: FileIndexPort;
  steps: readonly ((c: FilePickerController) => void | Promise<void>)[];
  onState: (c: FilePickerController) => void;
}): React.ReactElement {
  const picker = useFilePicker({ fileIndex: props.index, attachReader: makeReader() });
  const [stepIdx, setStepIdx] = useState(0);
  useEffect(() => {
    props.onState(picker);
  });
  useEffect(() => {
    if (stepIdx >= props.steps.length) return;
    let cancelled = false;
    void (async () => {
      await props.steps[stepIdx]!(picker);
      if (!cancelled) setStepIdx((i) => i + 1);
    })();
    return () => {
      cancelled = true;
    };
  }, [stepIdx]);
  return <Text>{`open=${picker.open} hits=${picker.hits.length}`}</Text>;
}

async function drive(
  steps: readonly ((c: FilePickerController) => void | Promise<void>)[],
): Promise<FilePickerController> {
  let last!: FilePickerController;
  let done = false;
  render(<Probe steps={steps} onState={(c) => (last = c)} onDone={() => (done = true)} />);
  // Espera DETERMINÍSTICA: faz polling até o Probe sinalizar que todos os passos
  // rodaram E o render final comitou (evita o flake do sleep fixo sob carga de CI).
  // Mantém um teto de segurança generoso; resolve assim que `done` vira true.
  const deadline = Date.now() + 4000;
  while (!done && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10));
  }
  // Uma volta extra do event-loop p/ garantir que o último `onState` do render
  // concluído já capturou o estado settled.
  await new Promise((r) => setTimeout(r, 5));
  return last;
}

describe('useFilePicker — abrir/filtrar/navegar', () => {
  it('abre o picker e carrega o índice', async () => {
    const c = await drive([(p) => p.openPicker()]);
    expect(c.open).toBe(true);
    expect(c.hits.length).toBe(PATHS.length);
  });

  it('filtra por query fuzzy (CA-1)', async () => {
    const c = await drive([(p) => p.openPicker(), (p) => p.setQuery('session')]);
    expect(c.hits[0]?.path).toBe('src/auth/session.ts');
    expect(c.hits.some((h) => h.path === 'README.md')).toBe(false);
  });

  it('navega ↑↓ (move clampeado)', async () => {
    const c = await drive([(p) => p.openPicker(), (p) => p.move(1), (p) => p.move(1)]);
    expect(c.selected).toBe(2);
    const c2 = await drive([(p) => p.openPicker(), (p) => p.move(-5)]);
    expect(c2.selected).toBe(0);
  });

  it('confirm anexa o selecionado e fecha o picker (CA-3)', async () => {
    const c = await drive([
      (p) => p.openPicker(),
      (p) => p.setQuery('config'),
      async (p) => {
        await p.confirm();
      },
    ]);
    expect(c.open).toBe(false);
    expect(c.attachments.map((a) => a.path)).toEqual(['src/auth/config.ts']);
  });

  it('multi-anexo + removeLast (CA-5/§4.2)', async () => {
    const c = await drive([
      async (p) => {
        await p.attachPath('src/auth/session.ts');
      },
      async (p) => {
        await p.attachPath('README.md');
      },
      (p) => p.removeLast(),
    ]);
    expect(c.attachments.map((a) => a.path)).toEqual(['src/auth/session.ts']);
  });

  it('escape de caminho é rejeitado no attach (não vira chip)', async () => {
    const c = await drive([
      async (p) => {
        await p.attachPath('../../etc/passwd');
      },
    ]);
    expect(c.attachments).toEqual([]);
  });
});

// R1 (seguranca) + revisor #2 — o picker NÃO oferece caminhos sensíveis: o índice
// é filtrado por `isPickable` no `loadIndex`. `.env`/`.key`/`*token*`/`*secret*`
// somem da lista do picker; só entram por caminho LITERAL + confirmação.
describe('useFilePicker — índice do picker esconde sensíveis (isPickable)', () => {
  it('.env/.key/*token* NÃO aparecem nos hits do picker', async () => {
    const sensitiveIndex: FileIndexPort = {
      list: async () => [
        'src/app.ts',
        'README.md',
        '.env',
        'config/.env.production',
        'cert.key',
        'app-token.txt',
        'my_secret.json',
        '.ssh/id_rsa',
      ],
    };
    let last!: FilePickerController;
    render(
      <Probe2 index={sensitiveIndex} steps={[(p) => p.openPicker()]} onState={(c) => (last = c)} />,
    );
    await new Promise((r) => setTimeout(r, 90));
    const paths = last.hits.map((h) => h.path);
    expect(paths).toContain('src/app.ts');
    expect(paths).toContain('README.md');
    // sensíveis somem do picker (deny + ask):
    expect(paths).not.toContain('.env');
    expect(paths).not.toContain('config/.env.production');
    expect(paths).not.toContain('cert.key');
    expect(paths).not.toContain('app-token.txt');
    expect(paths).not.toContain('my_secret.json');
    expect(paths).not.toContain('.ssh/id_rsa');
    expect(last.hits.length).toBe(2);
  });
});

// Revisor #3 — a recusa de anexo NÃO falha muda: o hook expõe o motivo em
// `notice` e `dismissNotice()` o limpa.
describe('useFilePicker — feedback de recusa (notice)', () => {
  it('attach rejeitado (escape) seta `notice` com o motivo; dismiss limpa', async () => {
    const c = await drive([
      async (p) => {
        await p.attachPath('../../etc/passwd');
      },
    ]);
    expect(c.attachments).toEqual([]);
    expect(c.notice).not.toBeNull();
    expect(c.notice).toMatch(/fora do workspace/);

    const c2 = await drive([
      async (p) => {
        await p.attachPath('../../etc/passwd');
      },
      (p) => p.dismissNotice(),
    ]);
    expect(c2.notice).toBeNull();
  });

  it('attach OK limpa qualquer notice anterior', async () => {
    const c = await drive([
      async (p) => {
        await p.attachPath('../../etc/passwd');
      },
      async (p) => {
        await p.attachPath('README.md');
      },
    ]);
    expect(c.notice).toBeNull();
    expect(c.attachments.map((a) => a.path)).toEqual(['README.md']);
  });
});
