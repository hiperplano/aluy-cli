// EST-0960a · ADR-0056 §5 / RESSALVA-7 (R7) — path-deny de LEITURA de `~/.aluy/`.
//
// O furo sério que o gate FORTE do `seguranca` (AG-0008) cravou: o ADR fechava a
// ESCRITA do agente sobre o journal, mas a LEITURA via `run_command cat` ficava
// aberta — um prompt-injection (CLI-SEC-4/CLI-T2) poderia mandar o agente
// `cat ~/.aluy/undo/<sess>/blobs/*` e EXFILTRAR o conteúdo-antes (possível
// segredo). Esta bateria prova que NENHUMA tool de leitura alcança o journal:
//   T8 — read_file/grep/edit_file sobre `~/.aluy/` ⇒ DENY (não ask).
//   T9 — run_command (cat/ls/grep/head/tail/… no shell) sobre `~/.aluy/` ⇒ DENY.
// O DENY é não-relaxável por allow-list/hook (categoria sempre-ask, deny).

import { describe, expect, it } from 'vitest';
import {
  PolicyPermissionEngine,
  classifyAlwaysAsk,
  type PermissionPolicy,
  type ToolCall,
} from '../../src/index.js';

function call(name: string, input: Record<string, unknown>): ToolCall {
  return { name, input };
}

const JOURNAL = '~/.aluy/undo/abc/blobs/b0';
const JOURNAL_ABS = '/home/tiago/.aluy/undo/abc/blobs/b0';
const JOURNAL_ROOT_ABS = '/root/.aluy/undo/abc/blobs/b0';
const JOURNAL_HOMEVAR = '$HOME/.aluy/undo/abc/blobs/b0';

describe('T8 · R7 — read_file/grep/edit_file sobre ~/.aluy/ ⇒ DENY', () => {
  const engine = new PolicyPermissionEngine();

  it('read_file no journal (~/.aluy/) ⇒ DENY', () => {
    const v = engine.decide(call('read_file', { path: JOURNAL }));
    expect(v.decision).toBe('deny');
    expect(v.category).toBe('always-ask:journal-read-deny');
  });

  it('read_file no journal por path ABSOLUTO da home / $HOME ⇒ DENY', () => {
    expect(engine.decide(call('read_file', { path: JOURNAL_ABS })).decision).toBe('deny');
    expect(engine.decide(call('read_file', { path: JOURNAL_ROOT_ABS })).decision).toBe('deny');
    expect(engine.decide(call('read_file', { path: JOURNAL_HOMEVAR })).decision).toBe('deny');
  });

  it('grep no journal ⇒ DENY (grep lê)', () => {
    expect(engine.decide(call('grep', { pattern: 'AKIA', path: JOURNAL })).decision).toBe('deny');
  });

  it('edit_file no journal ⇒ DENY (agente nem escreve no journal)', () => {
    expect(engine.decide(call('edit_file', { path: JOURNAL, content: 'x' })).decision).toBe('deny');
  });

  it('o DENY do journal é NÃO-relaxável por allow-list do usuário', () => {
    const policy: PermissionPolicy = {
      rules: [{ tool: 'read_file', decision: 'allow' }],
    };
    const eng = new PolicyPermissionEngine({ policy });
    // a categoria sempre-ask (deny) vence a regra de allow do usuário.
    expect(eng.decide(call('read_file', { path: JOURNAL })).decision).toBe('deny');
  });

  it('NÃO super-bloqueia: um `.aluy/` DENTRO do workspace não é o journal da home', () => {
    // o journal é `~/.aluy/` (FORA do workspace). Um `.aluy/notes` relativo ao
    // workspace NÃO casa o matcher de home — não vira deny de journal.
    const v = engine.decide(call('read_file', { path: '.aluy/notes.txt' }));
    expect(v.decision).not.toBe('deny');
  });
});

describe('T9 · R7 — run_command (shell) sobre ~/.aluy/ ⇒ DENY (fecha exfiltração via injeção)', () => {
  const engine = new PolicyPermissionEngine();

  const exfilCommands = [
    'cat ~/.aluy/undo/abc/blobs/b0',
    'ls ~/.aluy/undo',
    'grep -r AKIA ~/.aluy/',
    'head -c 100 ~/.aluy/undo/abc/blobs/b0',
    'tail ~/.aluy/undo/abc/stack.jsonl',
    'cat /home/tiago/.aluy/undo/abc/blobs/b0',
    'cat /root/.aluy/undo/abc/blobs/b0',
    'cat $HOME/.aluy/undo/abc/blobs/b0',
    'cat ${HOME}/.aluy/undo/abc/blobs/b0',
    'cp ~/.aluy/undo/abc/blobs/b0 /tmp/leak && cat /tmp/leak',
    'while read l; do echo $l; done < ~/.aluy/undo/abc/stack.jsonl',
    // EST-0945 (3ª iter — SEGURANÇA): o redirect-ENTRADA `<` COLADO ao path (sem espaço)
    // escapava AMBOS os detectores — o boundary da extração (`[\s=>]`) E o do raw-scanner
    // (`[\s=>:'"(]`) esqueceram o `<` ⇒ o journal-read-deny não casava e o veredito CAÍA de
    // DENY p/ ask (`cat <~/.aluy/blobs/b0` virava ask-aprovável). Os dois boundaries ganharam
    // `<`. (Aspas já eram pegas pelo raw-scanner — só o `<` bare era o furo.)
    'cat <~/.aluy/undo/abc/blobs/b0', // redirect-ENTRADA `<` colado (≠ o `< ` com espaço acima)
  ];

  for (const command of exfilCommands) {
    it(`bash: \`${command}\` ⇒ DENY`, () => {
      const v = engine.decide(call('run_command', { command }));
      expect(v.decision).toBe('deny');
      // a categoria que dispara é a do journal (não só destrutivo/rede).
      const cats = classifyAlwaysAsk('run_command', { command });
      expect(cats.some((c) => c.category === 'always-ask:journal-read-deny' && c.deny)).toBe(true);
    });
  }

  it('comando que NÃO toca o journal segue a catraca normal (não vira deny por isso)', () => {
    const cats = classifyAlwaysAsk('run_command', { command: 'cat ./src/a.ts' });
    expect(cats.some((c) => c.category === 'always-ask:journal-read-deny')).toBe(false);
  });

  it('o DENY do journal via shell é NÃO-relaxável por allow-list', () => {
    const policy: PermissionPolicy = { rules: [{ tool: 'run_command', decision: 'allow' }] };
    const eng = new PolicyPermissionEngine({ policy });
    expect(
      eng.decide(call('run_command', { command: 'cat ~/.aluy/undo/abc/blobs/b0' })).decision,
    ).toBe('deny');
  });
});

describe('EST-0991 · ADR-0072 — YOLO DERRUBA o journal-read-deny (Alternativa C, do dono)', () => {
  // MUDANÇA DE CONTRATO (ADR-0072, decisão do dono — Tiago, supera a recomendação do
  // arquiteto): o `--yolo` é PERMISSÃO COMPLETA na máquina (paridade com Claude Code).
  // O antigo piso `journal-read-deny` (que sobrevivia ao `--unsafe`) AGORA CAI no YOLO.
  // O classifier (`classifyAlwaysAsk`) é o MESMO — a categoria ainda existe; só a
  // PRECEDÊNCIA mudou: o YOLO (prec. 0) passou p/ ACIMA do piso de `~/.aluy` (0.b).
  // ⚠ NÃO-REGRESSÃO: em `normal` o piso PERMANECE DENY (provado em T8/T9/B2 acima).
  const yolo = new PolicyPermissionEngine({ mode: 'unsafe' });
  const yoloLegacy = new PolicyPermissionEngine({ unsafe: true });

  it('read_file de ~/.aluy/ sob YOLO ⇒ ALLOW (piso derrubado)', () => {
    const v = yolo.decide(call('read_file', { path: JOURNAL }));
    expect(v.decision).toBe('allow');
    expect(v.reason).toContain('--yolo');
  });

  it('read_file de path ABSOLUTO/$HOME do journal sob YOLO ⇒ ALLOW', () => {
    expect(yolo.decide(call('read_file', { path: JOURNAL_ABS })).decision).toBe('allow');
    expect(yolo.decide(call('read_file', { path: JOURNAL_ROOT_ABS })).decision).toBe('allow');
    expect(yolo.decide(call('read_file', { path: JOURNAL_HOMEVAR })).decision).toBe('allow');
  });

  it('grep/edit_file de ~/.aluy/ sob YOLO ⇒ ALLOW', () => {
    expect(yolo.decide(call('grep', { pattern: 'AKIA', path: JOURNAL })).decision).toBe('allow');
    expect(yolo.decide(call('edit_file', { path: JOURNAL, content: 'x' })).decision).toBe('allow');
  });

  it('o flag LEGADO `unsafe:true` (sem `mode`) também derruba o piso no YOLO', () => {
    expect(yoloLegacy.decide(call('read_file', { path: JOURNAL })).decision).toBe('allow');
  });

  const exfilUnderYolo = [
    'cat ~/.aluy/undo/abc/blobs/b0',
    'ls ~/.aluy/undo',
    'cat /home/tiago/.aluy/undo/abc/blobs/b0',
    'cat $HOME/.aluy/undo/abc/blobs/b0',
  ];
  for (const command of exfilUnderYolo) {
    it(`bash sob YOLO: \`${command}\` ⇒ ALLOW`, () => {
      expect(yolo.decide(call('run_command', { command })).decision).toBe('allow');
    });
  }

  it('o RESTO do YOLO segue allow (destrutivo/rede): tudo é allow no YOLO', () => {
    expect(yolo.decide(call('run_command', { command: 'rm -rf build' })).decision).toBe('allow');
    expect(yolo.decide(call('run_command', { command: 'curl https://x.dev' })).decision).toBe(
      'allow',
    );
    expect(yolo.decide(call('run_command', { command: 'cat ./src/a.ts' })).decision).toBe('allow');
  });

  it('NÃO-REGRESSÃO — em `normal` o journal-read-deny PERMANECE DENY', () => {
    const normal = new PolicyPermissionEngine();
    expect(normal.decide(call('read_file', { path: JOURNAL })).decision).toBe('deny');
    expect(
      normal.decide(call('run_command', { command: 'cat ~/.aluy/undo/abc/blobs/b0' })).decision,
    ).toBe('deny');
  });
});

describe('B2 · R7 — matcher endurecido contra normalização de path + home-cd', () => {
  const engine = new PolicyPermissionEngine();

  // Os 5 vetores que FURAVAM o matcher (normalização `/./`, `//`, `/x/../` e
  // home-cd + path relativo `.aluy`). CADA UM ⇒ DENY.
  const normVectors = [
    'cat ~/./.aluy/undo/abc/blobs/b0', // `/./`
    'cat ~//.aluy/undo/abc/blobs/b0', // `//`
    'cat ~/foo/../.aluy/undo/abc/blobs/b0', // `/foo/../`
    'cd ~ && cat .aluy/undo/abc/blobs/b0', // home-cd `~` + relativo
    'cd $HOME; cat .aluy/undo/abc/blobs/b0', // home-cd `$HOME` + relativo
  ];
  for (const command of normVectors) {
    it(`bash: \`${command}\` ⇒ DENY (vetor de normalização B2)`, () => {
      const v = engine.decide(call('run_command', { command }));
      expect(v.decision).toBe('deny');
      const cats = classifyAlwaysAsk('run_command', { command });
      expect(cats.some((c) => c.category === 'always-ask:journal-read-deny' && c.deny)).toBe(true);
    });
  }

  // variantes extras de home-cd (mesma classe).
  for (const command of [
    'cd ${HOME} && cat .aluy/undo/x',
    'HOME=/tmp; cat .aluy/undo/x',
    'export HOME=/x && cat .aluy/undo/x',
  ]) {
    it(`bash: \`${command}\` ⇒ DENY (home-cd variante)`, () => {
      expect(engine.decide(call('run_command', { command })).decision).toBe('deny');
    });
  }

  // ── FAMÍLIA "BARRA FINAL" (gate FORTE do `seguranca`) — os 6 vetores que o
  // âncora `homeAnchor` FURAVA: uma `/` (ou `.`, ou aspas) colada ao token de
  // home (`~`/`$HOME`/`${HOME}`) impedia o casamento. Endurecido p/ tolerar
  // barra final + aspas + separador colado/espaçado. CADA UM ⇒ DENY. Esta é a
  // defesa-em-profundidade; a TRAVA é a cifra (#1) — a leitura do blob é
  // inofensiva (ciphertext) mesmo se um vetor novo furar.
  const barraFinalVectors = [
    'cd ~/ && cat .aluy/undo/abc/blobs/b0', // `cd ~/` (barra final)
    'cd ${HOME}/ && cat .aluy/undo/abc/blobs/b0', // `cd ${HOME}/`
    'cd "$HOME"/ && cat .aluy/undo/abc/blobs/b0', // `cd "$HOME"/` (aspas + barra)
    'cd ~/&&cat .aluy/undo/abc/blobs/b0', // `cd ~/&&` (separador COLADO, sem espaço)
    'cd ~/. && cat .aluy/undo/abc/blobs/b0', // `cd ~/.` (barra + ponto)
    'cd ~/ | cat .aluy/undo/abc/blobs/b0', // `cd ~/ |` (barra + espaço + pipe)
  ];
  for (const command of barraFinalVectors) {
    it(`bash: \`${command}\` ⇒ DENY (família "barra final" B2)`, () => {
      const v = engine.decide(call('run_command', { command }));
      expect(v.decision).toBe('deny');
      const cats = classifyAlwaysAsk('run_command', { command });
      expect(cats.some((c) => c.category === 'always-ask:journal-read-deny' && c.deny)).toBe(true);
    });
  }

  // BENIGNO complementar à família "barra final": `cd ~/` SEM `.aluy` (entrar na
  // home p/ ler um arquivo comum) NÃO vira deny de journal — o 2º clause exige
  // o `.aluy` relativo. Garante que o âncora endurecido não super-bloqueia.
  it('benigno: `cd ~/ && cat README.md` (barra final, SEM .aluy) NÃO vira deny por journal', () => {
    const cats = classifyAlwaysAsk('run_command', { command: 'cd ~/ && cat README.md' });
    expect(cats.some((c) => c.category === 'always-ask:journal-read-deny')).toBe(false);
  });

  // path direto (read_file) com normalização ⇒ DENY.
  for (const path of [
    '~/./.aluy/undo/abc/blobs/b0',
    '~//.aluy/undo/abc/blobs/b0',
    '~/foo/../.aluy/undo/abc/blobs/b0',
  ]) {
    it(`read_file path \`${path}\` ⇒ DENY (normalização B2)`, () => {
      expect(engine.decide(call('read_file', { path })).decision).toBe('deny');
    });
  }

  // BENIGNOS — NÃO super-bloquear: `.aluy/` relativo do workspace SEM home-âncora
  // nem `cd ~` não é o journal da home.
  it('benigno: `cat .aluy/notes.txt` (relativo ao workspace, sem cd ~) NÃO vira deny', () => {
    expect(
      engine.decide(call('run_command', { command: 'cat .aluy/notes.txt' })).decision,
    ).not.toBe('deny');
  });

  it('benigno: `cd ~ && cat README.md` (cd ~ mas SEM .aluy) NÃO vira deny por journal', () => {
    const cats = classifyAlwaysAsk('run_command', { command: 'cd ~ && cat README.md' });
    expect(cats.some((c) => c.category === 'always-ask:journal-read-deny')).toBe(false);
  });

  it('benigno: `cat my.aluy.txt` (não é `.aluy/` relativo) NÃO vira deny', () => {
    const cats = classifyAlwaysAsk('run_command', { command: 'cat my.aluy.txt' });
    expect(cats.some((c) => c.category === 'always-ask:journal-read-deny')).toBe(false);
  });

  it('benigno: read_file `.aluy/notes.txt` relativo ao workspace NÃO vira deny', () => {
    expect(engine.decide(call('read_file', { path: '.aluy/notes.txt' })).decision).not.toBe('deny');
  });
});
