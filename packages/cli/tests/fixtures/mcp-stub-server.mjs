// EST-1007 (HANG) — SERVER MCP stdio MÍNIMO de teste (fixture). Fala o protocolo MCP
// real (`@modelcontextprotocol/sdk`) — handshake `initialize` + `tools/list` — e fica
// VIVO escutando stdin, exatamente como os servers reais (`server-everything`/
// `playwright`) do `~/.aluy/mcp.json`. É esse processo-filho VIVO que pinava o
// event-loop do binário e travava o `aluy -p`/posicional no não-TTY antes do fix
// (que agora chama `mcpSetup.close()` em toda saída). Sem este filho real, o teste
// (com `mcpTools:[]`) NÃO exercita o spawn e NÃO pega o hang.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const server = new Server(
  { name: 'aluy-test-mcp', version: '0.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'noop',
      description: 'no-op de teste',
      inputSchema: { type: 'object', properties: {} },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async () => ({
  content: [{ type: 'text', text: 'ok' }],
}));

const transport = new StdioServerTransport();
await server.connect(transport);
// Fica vivo (stdin aberto) até o cliente fechar o transporte — o handle que pinava o loop.
