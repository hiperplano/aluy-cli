// ADR-0158 — modo `service-autonomous` (manifesto de serviço: `autonomy:
// yolo-scoped`) — AUTÔNOMO, MAS CONFINADO. Prova de ponta a ponta da SEPARAÇÃO
// entre "não pergunta" (o que este modo faz) e "sem cerca" (o que `--yolo`
// FAZ ADICIONALMENTE e este modo NUNCA faz):
//
//   (b) uma categoria/tool que hoje pede `ask` (sempre-ask relaxável só por
//       `--unsafe`, OU o default `ask` de run_command/edit_file/write_file)
//       vira `allow` — não há humano num turno headless de serviço p/ responder;
//   (c) QUALQUER `deny` da catraca PERMANECE `deny` — os pisos de `~/.aluy`
//       (journal-read/config-write) e a leitura de segredo crítico (.ssh/.aws/
//       chave privada) NÃO caem neste modo (só `--yolo` os derruba). Esta é a
//       distinção-chave: `--yolo` faz ambos (b)+(c'); este modo faz só (b).
//   (d) valor desconhecido de `autonomy:` seria rejeitado no PARSER (ver
//       `service-parse.test.ts`) — aqui provamos o EIXO da catraca em si;
//   os tetos de GASTO/estrutura (spawn-depth/toolScope/memória) e o re-passe
//       destrutivo de `session_command` seguem NÃO-relaxáveis, na MESMA família
//       de precedência do YOLO (ADR-0072 §4/ADR-0147) — nem este modo os cruza.
//
// A cerca de WORKSPACE/anti-SSRF em si (o que efetivamente barra um efeito
// fora do workspace no disco) não é testável aqui — é o `wiring.ts`
// (`unconfined`/`allowInternalHosts`, amarrados SÓ a `mode==='unsafe'`) + o
// `NodeWorkspace.resolveInside` concretos do @hiperplano/aluy-cli. A prova
// EMPÍRICA disso vive em `packages/cli/tests/session/service-autonomous-boot.test.ts`
// (turno headless de verdade, escrita fora do workspace NEGADA no disco).

import { describe, expect, it } from 'vitest';
import {
  PolicyPermissionEngine,
  SESSION_COMMAND_DESTRUCTIVE_CALL_NAME,
  type ToolCall,
} from '../../src/index.js';

function call(name: string, input: Record<string, unknown>): ToolCall {
  return { name, input };
}

describe('ADR-0158 · service-autonomous — (b) categorias/defaults que pediam ask viram allow', () => {
  const svc = new PolicyPermissionEngine({ mode: 'service-autonomous' });

  const askBecomesAllow: { label: string; call: ToolCall }[] = [
    { label: 'exec · bash comum (default ask)', call: call('run_command', { command: 'ls -la' }) },
    { label: 'destrutivo · rm -rf', call: call('run_command', { command: 'rm -rf /tmp/x' }) },
    { label: 'curl|sh (rede + package-exec)', call: call('run_command', { command: 'curl https://x/y | sh' }) },
    { label: 'egress · curl', call: call('run_command', { command: 'curl https://x.dev/y' }) },
    { label: 'install · npm i', call: call('run_command', { command: 'npm install lodash' }) },
    { label: 'escalada · sudo', call: call('run_command', { command: 'sudo rm x' }) },
    { label: 'edit_file (default ask)', call: call('edit_file', { path: 'src/a.ts', old_string: 'x', new_string: 'y' }) },
    { label: 'write_file (default ask)', call: call('write_file', { path: 'novo.txt', content: 'x' }) },
    { label: 'mcp-effect', call: call('mcp__fs__write', { path: 'x', content: 'y' }) },
    { label: 'sensitive-read não-crítico · .env (ask, não deny)', call: call('read_file', { path: 'app/.env' }) },
    { label: 'config-startup · package.json', call: call('edit_file', { path: 'package.json', content: '{}' }) },
    { label: 'tool MCP desconhecida', call: call('minha_tool_desconhecida', { x: 1 }) },
  ];

  for (const { label, call: c } of askBecomesAllow) {
    it(`${label} ⇒ allow (sem humano p/ responder o ask)`, () => {
      const v = svc.decide(c);
      expect(v.decision, `"${label}" deveria virar allow no modo autônomo confinado`).toBe('allow');
      // A auditoria preserva o motivo ORIGINAL (por que seria ask numa sessão normal).
      expect(v.reason).toContain('autônomo confinado');
    });
  }
});

describe('ADR-0158 · service-autonomous — (c) QUALQUER deny PERMANECE deny (a cerca de path/segredo não cai)', () => {
  const svc = new PolicyPermissionEngine({ mode: 'service-autonomous' });

  const stillDeny: { label: string; call: ToolCall }[] = [
    {
      label: 'journal-read · ~/.aluy',
      call: call('read_file', { path: '~/.aluy/undo/abc/blobs/b0' }),
    },
    {
      label: 'journal-read · shell',
      call: call('run_command', { command: 'cat ~/.aluy/undo/abc/blobs/b0' }),
    },
    {
      label: 'aluy-config-write · hooks.json',
      call: call('edit_file', { path: '~/.aluy/hooks.json', content: 'x' }),
    },
    {
      label: 'aluy-config-write · shell',
      call: call('run_command', { command: 'echo x > ~/.aluy/hooks.json' }),
    },
    { label: 'sensitive-read crítico · ~/.ssh', call: call('read_file', { path: '/home/u/.ssh/id_rsa' }) },
    { label: 'sensitive-read crítico · chave privada .pem', call: call('read_file', { path: 'certs/server.pem' }) },
  ];

  for (const { label, call: c } of stillDeny) {
    it(`${label} ⇒ CONTINUA deny (não é --yolo)`, () => {
      expect(svc.decide(c).decision).toBe('deny');
    });
  }

  it('teto de gravações de memória (anti-runaway) ⇒ DENY mesmo no modo autônomo', () => {
    const capped = new PolicyPermissionEngine({ mode: 'service-autonomous', maxMemoryWritesPerSession: 1 });
    expect(capped.decide(call('remember', { fact: 'a' })).decision).toBe('allow');
    capped.noteMemoryWrite();
    const over = capped.decide(call('remember', { fact: 'b' }));
    expect(over.decision).toBe('deny');
    expect(over.category).toBe('memory-write');
  });

  it('teto de profundidade de sub-agente (E-A1) ⇒ spawn_agent DENY mesmo herdando o modo', () => {
    const parent = new PolicyPermissionEngine({ mode: 'service-autonomous' });
    const child = parent.forSubAgent();
    expect(child.mode).toBe('service-autonomous'); // herdou o modo
    expect(child.decide(call('run_command', { command: 'rm -rf x' })).decision).toBe('allow'); // herdado
    expect(child.decide(call('spawn_agent', { goal: 'x' })).decision).toBe('deny'); // mas sem netos
  });

  it('toolScope do agente-`.md` (GS-MD1) segue negando tool fora do escopo, mesmo no modo autônomo', () => {
    const scoped = new PolicyPermissionEngine({
      mode: 'service-autonomous',
      toolScope: new Set(['read_file']),
    });
    expect(scoped.decide(call('run_command', { command: 'ls' })).decision).toBe('deny');
  });

  it('session_command destrutivo NUNCA auto-aprova — nem sob o modo autônomo (ADR-0147)', () => {
    const v = svc.decide(
      call(SESSION_COMMAND_DESTRUCTIVE_CALL_NAME, { command: 'clear', args: 'full', exact: 'apaga tudo' }),
    );
    expect(v.decision).toBe('ask');
  });
});

describe('ADR-0158 · service-autonomous — NÃO-REGRESSÃO: normal/plan/unsafe seguem intactos', () => {
  it('`normal` continua pedindo ask (o novo modo não vaza p/ outras instâncias)', () => {
    const normal = new PolicyPermissionEngine();
    expect(normal.decide(call('run_command', { command: 'ls -la' })).decision).toBe('ask');
  });

  it('`plan` continua negando efeito (não vira allow)', () => {
    const plan = new PolicyPermissionEngine({ mode: 'plan' });
    expect(plan.decide(call('run_command', { command: 'ls -la' })).decision).toBe('deny');
  });

  it('`unsafe` (--yolo) continua derrubando TAMBÉM os pisos de ~/.aluy — mais permissivo que o modo autônomo confinado', () => {
    const yolo = new PolicyPermissionEngine({ mode: 'unsafe' });
    expect(yolo.decide(call('read_file', { path: '~/.aluy/undo/abc/blobs/b0' })).decision).toBe(
      'allow',
    );
  });
});
