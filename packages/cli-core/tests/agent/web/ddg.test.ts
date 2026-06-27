import { describe, it, expect } from 'vitest';
import {
  unwrapDdgRedirect,
  parseDdgResults,
  buildDdgSearchUrl,
  buildDdgSearchBody,
} from '../../../src/agent/web/ddg.js';

describe('buildDdgSearchUrl / buildDdgSearchBody (bônus)', () => {
  it('buildDdgSearchUrl monta URL com query', () => {
    const url = buildDdgSearchUrl('hello world');
    expect(url).toContain('html.duckduckgo.com/html/');
    expect(url).toContain('q=hello+world');
  });

  it('buildDdgSearchBody monta corpo POST', () => {
    const body = buildDdgSearchBody('test query');
    expect(body).toContain('q=test+query');
    expect(body).toContain('b=');
  });
});

describe('unwrapDdgRedirect', () => {
  it('(a) normaliza // para https://', () => {
    expect(unwrapDdgRedirect('//duckduckgo.com/algo')).toBe('https://duckduckgo.com/algo');
  });

  it('(b) desembrulha redirect DDG (/l/?uddg=...)', () => {
    const target = 'https://destino.com/pagina';
    const href = '/l/?uddg=' + encodeURIComponent(target);
    expect(unwrapDdgRedirect(href)).toBe(target);
  });

  it('(c) URL absoluta direta retorna normalizada', () => {
    const result = unwrapDdgRedirect('https://exemplo.com/x');
    expect(result).toContain('exemplo.com');
  });

  it('(d) protocolo não-http retorna vazio', () => {
    expect(unwrapDdgRedirect('ftp://x.com')).toBe('');
    expect(unwrapDdgRedirect('javascript:alert(1)')).toBe('');
  });

  it('(e) href inválido (new URL lança) retorna vazio', () => {
    expect(unwrapDdgRedirect('http://[')).toBe('');
  });
});

describe('parseDdgResults', () => {
  it('(a) HTML válido com 2 resultados', () => {
    const html = `
      <div class="result">
        <a class="result__a" href="https://site1.com/a">Titulo 1</a>
        <a class="result__snippet">Snippet 1</a>
      </div>
      <div class="result">
        <a class="result__a" href="https://site2.com/b">Titulo 2</a>
        <a class="result__snippet">Snippet 2</a>
      </div>
    `;
    const results = parseDdgResults(html);
    expect(results).toHaveLength(2);
    expect(results[0].title).toBe('Titulo 1');
    expect(results[0].url).toBe('https://site1.com/a');
    expect(results[0].snippet).toBe('Snippet 1');
    expect(results[1].title).toBe('Titulo 2');
    expect(results[1].url).toBe('https://site2.com/b');
    expect(results[1].snippet).toBe('Snippet 2');
  });

  it('(b) skip de título vazio ou href vazio', () => {
    const html = `
      <div class="result">
        <a class="result__a" href="https://x.com"></a>
        <a class="result__snippet">Skip me</a>
      </div>
      <div class="result">
        <a class="result__a" href="https://valido.com">Valido</a>
        <a class="result__snippet">Entra</a>
      </div>
    `;
    const results = parseDdgResults(html);
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('Valido');
    expect(results[0].url).toBe('https://valido.com/');
    expect(results[0].snippet).toBe('Entra');
  });

  it('(b2) skip de href que desembrulha para vazio (protocolo não-http)', () => {
    const html = `
      <div class="result">
        <a class="result__a" href="javascript:void(0)">JS Link</a>
        <a class="result__snippet">Invalido</a>
      </div>
      <div class="result">
        <a class="result__a" href="https://bom.com">Bom</a>
        <a class="result__snippet">OK</a>
      </div>
    `;
    const results = parseDdgResults(html);
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('Bom');
  });

  it('(c) teto max limita resultados', () => {
    const html = `
      <div class="result">
        <a class="result__a" href="https://a.com">A</a>
        <a class="result__snippet">a</a>
      </div>
      <div class="result">
        <a class="result__a" href="https://b.com">B</a>
        <a class="result__snippet">b</a>
      </div>
      <div class="result">
        <a class="result__a" href="https://c.com">C</a>
        <a class="result__snippet">c</a>
      </div>
    `;
    const results = parseDdgResults(html, 2);
    expect(results).toHaveLength(2);
    expect(results[0].title).toBe('A');
    expect(results[1].title).toBe('B');
  });

  it('(d) snippet faltando => fallback para string vazia', () => {
    const html = `
      <div class="result">
        <a class="result__a" href="https://sem-snippet.com">Sem Snippet</a>
      </div>
    `;
    const results = parseDdgResults(html);
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('Sem Snippet');
    expect(results[0].url).toBe('https://sem-snippet.com/');
    expect(results[0].snippet).toBe('');
  });
});
