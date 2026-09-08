// A troca de provider tratava TODA reprovação da prova de conectividade como "provider
// ruim" e recusava a troca inteira — inclusive quando o que reprovou foi o MODELO.
//
// O modelo provado ali é o `defaultModel` do NOSSO catálogo, não uma escolha do dono. Em
// 08/09/2026 eu medi: o default do OpenRouter (`anthropic/claude-3.5-sonnet`) tinha sumido
// dos 431 modelos que ele anuncia. Resultado — a recusa acontecia ANTES do passo que
// pediria o modelo, e não havia como sair do buraco por dentro do fluxo: o dono ficava
// preso no provider antigo, sem alteração na barra de status e sem nada persistido.
//
// A leitura que este classificador trava: um status HTTP que NÃO é 401/403 prova que
// alcançamos o provider e ele RESPONDEU — a credencial passou pela porta.

import { describe, expect, it } from 'vitest';
import { classificarFalhaDeProva } from '../../../src/model/local/connectivity-check.js';

describe('classificarFalhaDeProva', () => {
  it('401 e 403 são CREDENCIAL — o único motivo de credencial para recusar', () => {
    expect(classificarFalhaDeProva('HTTP 401 — chave inválida? {"error":...}')).toBe('credencial');
    expect(classificarFalhaDeProva('HTTP 403')).toBe('credencial');
  });

  it('404 é MODELO — o caso literal do slug aposentado', () => {
    expect(classificarFalhaDeProva('HTTP 404 — modelo ou baseURL errado? {}')).toBe('modelo');
  });

  it('400 também é MODELO — gateways openai-compat recusam slug inexistente com 400', () => {
    expect(classificarFalhaDeProva('HTTP 400 model not found')).toBe('modelo');
  });

  it('outros status do provider NÃO são credencial — ele respondeu, a chave passou', () => {
    for (const d of ['HTTP 429 rate limited', 'HTTP 500', 'HTTP 503 upstream']) {
      expect(classificarFalhaDeProva(d)).toBe('modelo');
    }
  });

  it('sem status HTTP é CONEXÃO — rede/timeout/redirect bloqueado pelo anti-SSRF', () => {
    expect(classificarFalhaDeProva('não conectou (baseURL/rede?): fetch failed')).toBe('conexao');
    expect(classificarFalhaDeProva('')).toBe('conexao');
    expect(classificarFalhaDeProva('The operation was aborted')).toBe('conexao');
  });

  it('o status é o do INÍCIO — um "HTTP 401" citado no meio do texto não decide', () => {
    // O ramo de rede compõe `não conectou (baseURL/rede?): <e.message>`, e essa mensagem
    // pode CITAR um status (proxy corporativo, túnel, camada intermediária). Sem a âncora
    // `^`, esse texto viraria veredito de "credencial" e recusaria a troca alegando chave
    // inválida — mandando o dono caçar um problema que não existe. Este caso é o que
    // separa as duas leituras: sem a âncora ele passa a devolver 'credencial'.
    expect(
      classificarFalhaDeProva('não conectou (baseURL/rede?): proxy returned HTTP 401 to CONNECT'),
    ).toBe('conexao');
    expect(classificarFalhaDeProva('não conectou: socket hang up after 401 ms')).toBe('conexao');
  });

  it('tolera espaço em volta (o `detail` é montado com `.trim()` só no fim)', () => {
    expect(classificarFalhaDeProva('  HTTP 401 ')).toBe('credencial');
  });
});
