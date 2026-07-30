// F21-bis — prova em TTY REAL do one-shot do reforço `FRONTEIRA DE DADOS` ENTRE TURNOS.
//
// Renderiza o App REAL (Ink) com o SessionController REAL num PTY, no combo EXATO que
// arma o guardrail: `--yolo` (PolicyPermissionEngine mode:'unsafe') + tier FRACO
// (`custom`) + conteúdo NÃO-CONFIÁVEL no contexto (uma tool roda ⇒ observação envelopada).
//
// O OBSERVÁVEL é determinístico e vem do PROMPT, não da tela: o reanchor entra como
// mensagem `role:'assistant'` e NÃO é renderizado pela TUI (o usuário só o vê quando o
// modelo o papagaia). Então o caller mock CONTA, a cada chamada, quantas cópias do
// marcador chegaram nas `messages` — e emite `__REANCHOR__ <n>`. É a mesma via dos
// harnesses `pty-*.mjs`: marcador no stdout que o driver casa por regex.
//
// Sem modelo real, sem rede, sem custo: o caller é roteirizado. Mas o CAMINHO é o real
// (controller + Ink + PTY + a cadência run→resume de UM turno por submit).
//
// Rodar via: `python3 scripts/ptydrive-weak-yolo-reanchor.py`

import React from 'react';
import { render } from 'ink';
import { ThemeProvider } from '../packages/cli/dist/ui/theme/context.js';
import { resolveTheme } from '../packages/cli/dist/ui/theme/theme.js';
import { App } from '../packages/cli/dist/session/App.js';
import { SessionController } from '../packages/cli/dist/session/controller.js';
import { TuiAskResolver } from '../packages/cli/dist/ask/ask-resolver.js';
import { PolicyPermissionEngine } from '@hiperplano/aluy-cli-core';

const MARKER = 'FRONTEIRA DE DADOS';

const ports = {
  fs: {
    async readFile() {
      return 'conteudo qualquer do arquivo lido';
    },
    async writeFile() {},
    async exists() {
      return true;
    },
  },
  shell: {
    async exec() {
      return { stdout: '', stderr: '', exitCode: 0 };
    },
  },
  search: {
    async search() {
      return { matches: [], truncated: {} };
    },
  },
};

const toolCall = (name, input) =>
  `<<<ALUY_TOOL_CALL\n${JSON.stringify({ name, input })}\nALUY_TOOL_CALL>>>`;

let controllerRef = null;
let call = 0;

// Cada TURNO do usuário = 2 chamadas: (1) uma tool-call (gera a observação NÃO-CONFIÁVEL
// que arma a 3ª perna do combo) e (2) a resposta final. O guardrail é avaliado no TOPO
// de cada iteração, então na 2ª chamada do turno 1 o reforço já deve estar no prompt.
const model = {
  async call(args) {
    call += 1;
    // O caller do controller recebe `{messages, idempotencyKey, signal}` — as mensagens
    // vêm no TOPO (o `request` aninhado é a forma do LocalModelClient, não desta porta).
    const msgs = args?.messages ?? args?.request?.messages ?? [];
    const n = msgs.filter(
      (m) => m.role === 'assistant' && String(m.content ?? '').includes(MARKER),
    ).length;
    // CONTAGEM do prompt desta chamada — o observável da prova.
    process.stdout.write(`\r\n__REANCHOR__ call=${call} n=${n}\r\n`);
    if (process.env.PTY_DEBUG === '1') {
      const roles = msgs.map((m) => m.role).join(',');
      const argKeys = args && typeof args === 'object' ? Object.keys(args).join('|') : String(args);
      const reqKeys =
        args?.request && typeof args.request === 'object'
          ? Object.keys(args.request).join('|')
          : '(sem request)';
      process.stdout.write(
        `\r\n__ROLES__ call=${call} [${roles}] args={${argKeys}} request={${reqKeys}}\r\n`,
      );
    }

    const sink = controllerRef.sink;
    sink.onStart?.();
    const isToolTurn = call % 2 === 1; // ímpar: tool-call; par: final
    const text = isToolTurn ? toolCall('read_file', { path: 'dados.txt' }) : 'pronto.';
    sink.onDelta(text);
    sink.onUsage?.({ request_id: 'r', tier: 'custom', tokens_in: 1200, tokens_out: 40 });
    sink.onDone?.();
    return { request_id: 'r', content: text, finish_reason: 'stop' };
  },
};

const controller = new SessionController({
  model,
  // YOLO: bypass total — a 1ª perna do combo.
  permission: new PolicyPermissionEngine({ mode: 'unsafe' }),
  ports,
  askResolver: new TuiAskResolver(),
  // tier `custom` = tier FRACO — a 2ª perna do combo.
  meta: { cwd: '/proj/aluy', tier: 'custom', tokens: 0, windowPct: 0 },
  flush: { intervalMs: 0 },
});
controllerRef = controller;
controller.dismissBoot();

let lastPhase = '';
controller.subscribe((s) => {
  if (s.phase !== lastPhase) {
    lastPhase = s.phase;
    process.stdout.write(`\r\n__PHASE__ ${s.phase}\r\n`);
  }
});

const theme = resolveTheme({ env: { LANG: 'en_US.UTF-8', TERM: 'xterm-256color' } });
const { unmount } = render(
  React.createElement(
    ThemeProvider,
    { theme },
    React.createElement(App, { controller, animate: false, bootMs: 0 }),
  ),
  { exitOnCtrlC: false },
);

process.stdout.write('\r\n__READY__\r\n');

// TTL: o driver automatizado quer um fim determinístico; o USO INTERATIVO (você abre e
// digita) quer ficar vivo. `PTY_TTL_MS=0` (ou `off`) desliga o auto-exit — aí sai com
// ctrl-c duas vezes, como na TUI real.
const ttlRaw = process.env.PTY_TTL_MS ?? '30000';
const ttl = ttlRaw === 'off' ? 0 : Number.parseInt(ttlRaw, 10);
if (Number.isFinite(ttl) && ttl > 0) {
  setTimeout(() => {
    unmount();
    process.exit(0);
  }, ttl);
}
