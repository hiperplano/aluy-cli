// F-WIN (emenda, pedido do dono) — `/window [<tokens>]`.
//
// O caso real (01/09): `z-ai/glm-5.3-flash` no tokenrouter. A descoberta por `GET /models`
// roda certo e não acha nada — verificado na conta dele: 131 modelos, e o catálogo inteiro
// só traz `id`/`object`/`created`/`owned_by`/`supported_endpoint_types`/`tags`. Não existe
// campo de janela ali, e GLM não está nas 52 entradas da tabela embutida. Sem janela, a
// auto-compactação fica INERTE e o `⛁ %` trava em 0 — e a única saída era editar
// `~/.aluy/config.json` na mão. O pedido dele: "dar a opção de digitar".

import { describe, expect, it, vi } from 'vitest';
import { runWindowSlash } from '../../src/slash/handlers.js';

function deps(over: Partial<Parameters<typeof runWindowSlash>[1]> = {}) {
  return {
    slug: 'z-ai/glm-5.3-flash',
    providerId: 'tokenrouter',
    janelaAtual: 0,
    aplicar: vi.fn(),
    persistir: vi.fn(() => true),
    ...over,
  } as Parameters<typeof runWindowSlash>[1];
}

describe('/janela sem argumento — só LÊ', () => {
  it('janela desconhecida: diz o sintoma E como resolver', async () => {
    const n = await runWindowSlash('', deps());
    const txt = n.lines.join(' ');
    expect(txt).toContain('DESCONHECIDA');
    expect(txt).toContain('/window 128k');
    expect(txt).toContain('glm-5.3-flash');
  });

  it('janela conhecida: mostra o número em vigor', async () => {
    const n = await runWindowSlash('', deps({ janelaAtual: 131072 }));
    expect(n.lines.join(' ')).toContain('131.072');
  });

  it('sem argumento NÃO grava nada', async () => {
    const d = deps();
    await runWindowSlash('', d);
    expect(d.aplicar).not.toHaveBeenCalled();
    expect(d.persistir).not.toHaveBeenCalled();
  });
});

describe('/janela <tokens> — aplica e persiste', () => {
  it('aceita `128k` e converte', async () => {
    const d = deps();
    const n = await runWindowSlash('128k', d);
    expect(d.aplicar).toHaveBeenCalledWith('z-ai/glm-5.3-flash', 131072);
    expect(d.persistir).toHaveBeenCalledWith('tokenrouter', 'z-ai/glm-5.3-flash', 131072);
    expect(n.lines.join(' ')).toContain('gravado');
  });

  it('aceita o número cru', async () => {
    const d = deps();
    await runWindowSlash('200000', d);
    expect(d.aplicar).toHaveBeenCalledWith('z-ai/glm-5.3-flash', 200000);
  });

  it('RECUSA separador ambíguo sem gravar nada', async () => {
    const d = deps();
    const n = await runWindowSlash('128.000', d);
    expect(d.aplicar).not.toHaveBeenCalled();
    expect(d.persistir).not.toHaveBeenCalled();
    expect(n.lines.join(' ')).toContain('128.000');
  });

  it('RECUSA número fora da faixa plausível — o número vai p/ o DISCO', async () => {
    const d = deps();
    const n = await runWindowSlash('7', d);
    expect(d.aplicar).not.toHaveBeenCalled();
    expect(d.persistir).not.toHaveBeenCalled();
    expect(n.lines.join(' ')).toContain('fora da faixa');
  });

  it('RECUSA texto que não é número', async () => {
    const d = deps();
    await runWindowSlash('grande', d);
    expect(d.aplicar).not.toHaveBeenCalled();
  });

  it('sem modelo ativo: não inventa chave no config', async () => {
    const d = deps({ slug: undefined });
    const n = await runWindowSlash('128k', d);
    expect(d.persistir).not.toHaveBeenCalled();
    expect(n.lines.join(' ')).toContain('/model');
  });

  it('provider sem entrada própria: vale NA SESSÃO e diz que não gravou', async () => {
    const d = deps({ persistir: vi.fn(() => false) });
    const n = await runWindowSlash('128k', d);
    expect(d.aplicar).toHaveBeenCalled(); // a sessão ganha a janela mesmo assim
    expect(n.lines.join(' ')).toContain('NESTA sessão');
  });

  it('sem providerId não tenta persistir, mas aplica', async () => {
    const d = deps({ providerId: undefined });
    await runWindowSlash('128k', d);
    expect(d.aplicar).toHaveBeenCalled();
    expect(d.persistir).not.toHaveBeenCalled();
  });
});
