// GUARDA — o script do sidecar do Mem0 e o PIN do pip não podem divergir em silêncio.
//
// O defeito que originou isto (31/08, máquina do dono e a minha): `MEM0_PIP_PACKAGES`
// pina `mem0ai==0.1.76`, cuja API de leitura é `search(query, user_id=, limit=)` e
// `get_all(user_id=)`. O `aluy-mem0-server.py` chamava a API da linha 2.x
// (`filters=`/`top_k=`), que NÃO existe na 0.1.x ⇒ `TypeError` ⇒ HTTP 500 em TODA
// leitura, por 12 dias, sem um único alarme.
//
// Por que passou despercebido tanto tempo: `add` usa a assinatura ANTIGA e sempre
// funcionou. A memória GRAVAVA e nunca LIA. O `recall` do boot morria no 500, o
// chamador engolia num `catch` e a sessão abria amnésica — o dono descreveu como
// "entrei e parece que ele nem sabe do que se trata". O único sinal era um `✗` de um
// caractere no rodapé.
//
// Esta guarda LÊ O FONTE porque a divergência é entre dois arquivos que ninguém edita
// junto: um `.py` de asset e uma constante `.ts`. Nenhum teste de comportamento pega
// isso sem um venv real, e o venv real é justamente o que não existe na CI.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MEM0_PIP_PACKAGES } from '../../../cli-core/src/agent/maestro/provisioner-contract.js';

const SCRIPT = join(__dirname, '..', '..', 'assets', 'mem0', 'aluy-mem0-server.py');
const fonte = readFileSync(SCRIPT, 'utf8');

/** A versão de `mem0ai` que o provisioner REALMENTE instala. */
function versaoPinadaDoMem0(): string {
  const pin = MEM0_PIP_PACKAGES.find((p) => p.startsWith('mem0ai=='));
  if (pin === undefined) throw new Error('mem0ai não está em MEM0_PIP_PACKAGES');
  return pin.slice('mem0ai=='.length);
}

describe('sidecar do Mem0 — script × pin do pip', () => {
  it('o pin de mem0ai continua na linha 0.1.x (se subir p/ 2.x, este arquivo tem de mudar junto)', () => {
    // Não é preciosismo: a assinatura de LEITURA muda entre as linhas. Subir o pin sem
    // revisar o script é exatamente como o defeito nasceu.
    expect(versaoPinadaDoMem0()).toMatch(/^0\.1\./);
  });

  it('a leitura NÃO usa `top_k=` — não existe na API pinada', () => {
    // A chamada crua com top_k= é o defeito literal. O fallback tolerante pode citá-la,
    // mas só DEPOIS de tentar a assinatura do pin (ver o teste do fallback abaixo).
    const cruas = fonte
      .split('\n')
      .filter((l) => /\.search\(/.test(l) && /top_k=/.test(l) && !/except TypeError/.test(l));
    // A única ocorrência legítima está dentro do `_search_compat`, no ramo de fallback.
    for (const linha of cruas) {
      expect(linha, `chamada com top_k= fora do compat: ${linha.trim()}`).toContain('filters=');
    }
    // E ela NUNCA pode ser a primeira tentativa.
    const compat = /def _search_compat[\s\S]*?\n\n/.exec(fonte)?.[0] ?? '';
    expect(compat, '_search_compat não encontrado').not.toBe('');
    const posPin = compat.indexOf('user_id=user_id, limit=limit');
    const posNova = compat.indexOf('top_k=');
    expect(posPin, 'a assinatura do PIN não aparece no compat').toBeGreaterThanOrEqual(0);
    expect(posNova, 'o fallback 2.x não aparece no compat').toBeGreaterThanOrEqual(0);
    expect(posPin, 'a API do PIN tem de ser tentada ANTES do fallback').toBeLessThan(posNova);
  });

  it('`get_all` também tenta a assinatura do pin primeiro', () => {
    const compat = /def _get_all_compat[\s\S]*?\n\n/.exec(fonte)?.[0] ?? '';
    expect(compat, '_get_all_compat não encontrado').not.toBe('');
    const posPin = compat.indexOf('get_all(user_id=user_id)');
    const posNova = compat.indexOf('filters=');
    expect(posPin).toBeGreaterThanOrEqual(0);
    expect(posNova).toBeGreaterThanOrEqual(0);
    expect(posPin).toBeLessThan(posNova);
  });

  it('nenhuma leitura chama a API 2.x DIRETO no handler (tem de passar pelo compat)', () => {
    // O ponto é que o conserto não vale só onde o sintoma apareceu: qualquer handler
    // futuro que leia precisa entrar pelos helpers, senão o defeito volta pela porta
    // do lado — foi assim que o fetch pinado ficou quebrado em 8 de 9 pontos.
    const foraDoCompat: string[] = [];
    const linhas = fonte.split('\n');
    let dentroDoCompat = false;
    for (const l of linhas) {
      if (/^def _(search|get_all)_compat/.test(l)) dentroDoCompat = true;
      else if (/^(def |class )/.test(l)) dentroDoCompat = false;
      if (dentroDoCompat) continue;
      if (/self\.memory\.(search|get_all)\(/.test(l)) foraDoCompat.push(l.trim());
    }
    expect(foraDoCompat).toEqual([]);
  });

  it('a varredura ACHA alguém quando o defeito volta (não passa por vacuidade)', () => {
    // Sem este caso, o teste acima passaria verde num arquivo vazio.
    const mutado = fonte.replace(
      'resp = _search_compat(self.memory, query, user_id, limit)',
      'resp = self.memory.search(query, filters={"user_id": user_id}, top_k=limit)',
    );
    expect(mutado, 'a âncora do handler mudou — atualize esta guarda').not.toBe(fonte);
    const achou = mutado
      .split('\n')
      .some((l) => /self\.memory\.search\(/.test(l) && /top_k=/.test(l));
    expect(achou).toBe(true);
  });
});
