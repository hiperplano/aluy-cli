// EST-1013 — server MCP de TESTE que devolve um bloco de tipo NÃO-texto ('image').
// Usado p/ exercitar o placeholder "[conteúdo MCP "image" omitido]" em
// extractTextContent (linhas 192-193 do stdio-transport.ts).

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const server = new McpServer({ name: 'image-block', version: '0.0.0' });

server.tool('give_image', async () => ({
  content: [
    { type: 'text', text: 'texto antes' },
    {
      type: 'image',
      data: 'iVBORw0KGgoAAAARSUhEUgAAAAEAAAABCAIAAACQd1PeAAAAEElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAABElFTkSuQmCC',
      mimeType: 'image/png',
    },
    { type: 'text', text: 'texto depois' },
  ],
}));

const transport = new StdioServerTransport();
await server.connect(transport);
