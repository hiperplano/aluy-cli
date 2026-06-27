// EST-1011 · ADR-0065 §11.2 (E-B3 / FU-VAU-11-bis) — server MCP de TESTE que SONDA o
// sandbox de SO. SEM DEPENDÊNCIAS (não usa o SDK nem zod): um JSON-RPC 2.0 cru sobre
// stdio que implementa o MÍNIMO do protocolo MCP (`initialize`, `tools/list`,
// `tools/call`). Assim, confinado, ele precisa SÓ do binário `node` + deste arquivo —
// NÃO de um `node_modules` (que, num workspace de teste sintético, ficaria fora do
// bind). Em produção o `node_modules` do server vive DENTRO do workspace (montado RW),
// então isto é fidelidade de teste, não um caso especial do sandbox.
//
// Um server malicioso/comprometido tentaria justamente o que estas tools sondam: ler
// segredos do $HOME, abrir socket p/ exfiltrar. Confinado, o kernel barra:
//   - read_path {path}: tenta ler um arquivo — READ_OK:<conteúdo> ou READ_ERR:<code>.
//     Confinado ⇒ ~/.ssh/~/.aws/~/.aluy/$HOME ⇒ ENOENT (a); workspace ⇒ READ_OK (a).
//   - try_connect {host,port}: tenta TCP connect — CONNECTED ou CONN_ERR:<code>.
//     Confinado SEM rede ⇒ NUNCA CONNECTED (d).
//   - whoami_env {key}: devolve uma env var — prova CLI-SEC-7 também sob sandbox.
//
// O handshake `initialize` e cada `tools/call` fluem ATRAVÉS do bwrap (fds 0/1/2): se
// o protocolo quebrasse confinado, o `connect`/`callTool` do transport falhariam.

import { readFileSync } from 'node:fs';
import { connect } from 'node:net';

const TOOLS = [
  {
    name: 'read_path',
    description: 'lê um arquivo (sonda de FS do sandbox)',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
  {
    name: 'try_connect',
    description: 'tenta um TCP connect (sonda de rede do sandbox)',
    inputSchema: {
      type: 'object',
      properties: { host: { type: 'string' }, port: { type: 'number' } },
      required: ['host', 'port'],
    },
  },
  {
    name: 'whoami_env',
    description: 'devolve uma env var (sonda CLI-SEC-7)',
    inputSchema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] },
  },
];

function text(t) {
  return { content: [{ type: 'text', text: t }] };
}

async function callTool(name, args) {
  if (name === 'read_path') {
    try {
      return text(`READ_OK:${readFileSync(args.path, 'utf8').trim()}`);
    } catch (e) {
      return text(`READ_ERR:${e.code ?? e.message}`);
    }
  }
  if (name === 'try_connect') {
    const msg = await new Promise((resolve) => {
      let done = false;
      const sock = connect({ host: args.host, port: args.port });
      const finish = (m) => {
        if (done) return;
        done = true;
        try {
          sock.destroy();
        } catch {
          /* ignore */
        }
        resolve(m);
      };
      sock.setTimeout(3000);
      sock.on('connect', () => finish('CONNECTED'));
      sock.on('timeout', () => finish('CONN_ERR:ETIMEDOUT'));
      sock.on('error', (e) => finish(`CONN_ERR:${e.code ?? e.message}`));
    });
    return text(msg);
  }
  if (name === 'whoami_env') {
    return text(process.env[args.key] ?? '(vazio)');
  }
  throw new Error(`tool desconhecida: ${name}`);
}

function send(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

async function handle(req) {
  const { id, method, params } = req;
  if (method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: params?.protocolVersion ?? '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'sandbox-probe', version: '0.0.0' },
      },
    };
  }
  if (method === 'tools/list') {
    return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
  }
  if (method === 'tools/call') {
    const result = await callTool(params.name, params.arguments ?? {});
    return { jsonrpc: '2.0', id, result };
  }
  // notificações (sem id) e métodos não suportados: ignora/no-op.
  return undefined;
}

// Leitor de linhas JSON-RPC (uma mensagem por linha, como o transport do SDK emite).
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let req;
    try {
      req = JSON.parse(line);
    } catch {
      continue;
    }
    Promise.resolve(handle(req))
      .then((res) => {
        if (res !== undefined) send(res);
      })
      .catch((e) => {
        if (req?.id !== undefined) {
          send({ jsonrpc: '2.0', id: req.id, error: { code: -32000, message: String(e) } });
        }
      });
  }
});
