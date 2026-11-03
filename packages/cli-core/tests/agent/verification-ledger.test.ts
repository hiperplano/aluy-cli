// Regra "pula a sonda se o agente já verificou" — predicado puro + costura no loop.

import { describe, expect, it } from 'vitest';
import { VerificationLedger } from '../../src/agent/verification-ledger.js';
import { resolveSelfCheck, SELF_CHECK_MARKER } from '../../src/agent/self-check.js';
import { AgentLoop } from '../../src/agent/loop.js';
import { ToolRegistry } from '../../src/agent/tools/registry.js';
import { NATIVE_TOOLS } from '../../src/agent/tools/native.js';
import {
  MemoryFs,
  ScriptedModelCaller,
  allowAllEngine,
  makePorts,
  toolCallBlock,
} from './helpers.js';

type Step = readonly [name: string, input: Record<string, unknown>, ok?: boolean];
const w = (path: string): Step => ['write_file', { path, content: 'x' }];
const e = (path: string): Step => ['edit_file', { path, old_string: 'a', new_string: 'b' }];
const r = (path: string, ok = true): Step => ['read_file', { path }, ok];
const sh = (command: string, ok = true): Step => ['run_command', { command }, ok];
const t = (command: string, ok = true): Step => ['run_tests', { command }, ok];

const CASES: ReadonlyArray<readonly [string, readonly Step[], boolean]> = [
  ['sem nenhum efeito (só leitura) ⇒ sonda', [r('a.txt')], false],
  ['escreveu e NÃO conferiu ⇒ sonda', [r('a.txt'), w('b.txt')], false],
  ['releu o MESMO arquivo ⇒ pula', [r('a.txt'), w('b.txt'), r('b.txt')], true],
  ['releu com caminho equivalente (./) ⇒ pula', [w('d/b.txt'), r('./d/../d/b.txt')], true],
  ['releu OUTRO arquivo ⇒ sonda', [w('b.txt'), r('a.txt')], false],
  ['releu ANTES de editar ⇒ sonda', [r('b.txt'), e('b.txt')], false],
  ['releitura falhou ⇒ sonda', [w('b.txt'), r('b.txt', false)], false],
  ['2 arquivos, só 1 relido ⇒ sonda', [w('a.txt'), w('b.txt'), r('b.txt')], false],
  ['2 arquivos, ambos relidos ⇒ pula', [w('a.txt'), w('b.txt'), r('b.txt'), r('a.txt')], true],
  ['edição que falhou não suja ⇒ sem efeito ⇒ sonda', [['edit_file', { path: 'a' }, false]], false],
  ['teste passou ⇒ pula', [e('src.ts'), t('npx vitest run')], true],
  ['teste FALHOU ⇒ sonda', [e('src.ts'), t('npx vitest run', false)], false],
  [
    'teste falhou e depois passou ⇒ pula',
    [e('src.ts'), t('npm test', false), e('src.ts'), t('npm test')],
    true,
  ],
  [
    'teste passou e depois editou de novo ⇒ sonda',
    [e('src.ts'), t('npm test'), e('src.ts')],
    false,
  ],
  ['run_command de teste passou ⇒ pula', [w('x.py'), sh('python -m pytest -q')], true],
  ['run_command de build passou ⇒ pula', [e('x.ts'), sh('cd pkg && npm run build')], true],
  ['teste falhou mesmo relendo o arquivo ⇒ sonda', [e('a'), t('npm test', false), r('a')], false],
  ['cat do arquivo via shell ⇒ pula', [w('b.txt'), sh('cat b.txt')], true],
  ['bash com efeito DEPOIS da leitura ⇒ sonda', [w('b.txt'), r('b.txt'), sh('rm b.txt')], false],
  ['bash com efeito ANTES da leitura, só leu ⇒ sonda', [sh('mv a b'), r('b')], false],
  ['bash com redirecionamento ⇒ efeito', [sh('echo oi > b.txt'), r('b.txt')], false],
  [
    'bash com efeito coberto por teste passante posterior ⇒ pula',
    [sh('sed -i s/a/b/ f'), t('npm test')],
    true,
  ],
  [
    'tool MCP desconhecida ⇒ efeito não atribuível ⇒ sonda',
    [w('b'), r('b'), ['mcp__x__y', {}]],
    false,
  ],
  ['comando só de leitura não é efeito ⇒ sonda', [sh('ls -la')], false],
];

describe('VerificationLedger.canSkip', () => {
  it.each(CASES)('%s', (_n, steps, expected) => {
    const l = new VerificationLedger();
    for (const [name, input, ok] of steps) l.record(name, input, ok ?? true);
    expect(l.canSkip()).toBe(expected);
  });
});

describe('resolveSelfCheck · skipWhenVerified', () => {
  it('default OFF; env liga; config liga; env vence config', () => {
    const base = { tier: 'custom' } as const;
    expect(resolveSelfCheck(base).skipWhenVerified).toBe(false);
    expect(resolveSelfCheck({ ...base, skipWhenVerifiedEnv: '1' }).skipWhenVerified).toBe(true);
    expect(resolveSelfCheck({ ...base, skipWhenVerifiedConfig: true }).skipWhenVerified).toBe(true);
    expect(
      resolveSelfCheck({ ...base, skipWhenVerifiedEnv: '0', skipWhenVerifiedConfig: true })
        .skipWhenVerified,
    ).toBe(false);
  });
  it('maxVerifications=1 via env', () => {
    expect(resolveSelfCheck({ tier: 'custom', maxVerificationsEnv: '1' }).maxVerifications).toBe(1);
  });
});

describe('loop · 1 vs 2 passadas e skip', () => {
  function build(maxVerifications: number, skipWhenVerified: boolean, script: string[]) {
    const fs = new MemoryFs(new Map([['a.txt', 'x']]));
    const { ports } = makePorts({ fs });
    const model = new ScriptedModelCaller(script.map((text) => ({ text })));
    const loop = new AgentLoop({
      model,
      permission: allowAllEngine,
      tools: new ToolRegistry(NATIVE_TOOLS),
      ports,
      sessionId: 's',
      selfCheck: { enabled: true, reanchorEveryK: 1000, maxVerifications, skipWhenVerified },
    });
    return { model, loop };
  }
  const probes = (m: ScriptedModelCaller): number => {
    const last = m.calls[m.calls.length - 1];
    return last
      ? last.messages.filter((x) => x.role === 'assistant' && x.content.includes(SELF_CHECK_MARKER))
          .length
      : 0;
  };
  const w1 = toolCallBlock('write_file', { path: 'b.txt', content: 'X' });
  const r1 = toolCallBlock('read_file', { path: 'b.txt' });

  it('2 passadas (hoje): sempre-pronto ⇒ 2 sondas', async () => {
    const { model, loop } = build(2, false, [w1, r1, 'pronto', 'pronto', 'pronto']);
    await loop.run('crie b.txt');
    expect(probes(model)).toBe(2);
    expect(model.calls.length).toBe(5);
  });
  it('1 passada ⇒ 1 sonda', async () => {
    const { model, loop } = build(1, false, [w1, r1, 'pronto', 'pronto', 'pronto']);
    await loop.run('crie b.txt');
    expect(probes(model)).toBe(1);
    expect(model.calls.length).toBe(4);
  });
  it('skip: escreveu e releu ⇒ NENHUMA sonda', async () => {
    const { model, loop } = build(2, true, [w1, r1, 'pronto', 'pronto']);
    const res = await loop.run('crie b.txt');
    expect(res.stop.kind).toBe('final');
    expect(probes(model)).toBe(0);
    expect(model.calls.length).toBe(3);
  });
  it('skip ligado mas NÃO releu ⇒ sonda normalmente', async () => {
    const { model, loop } = build(1, true, [w1, 'pronto', 'pronto']);
    await loop.run('crie b.txt');
    expect(probes(model)).toBe(1);
  });
});
