import test from 'node:test';
import assert from 'node:assert/strict';
import { Carrinho } from '../src/carrinho.js';

test('subtotal soma preço x quantidade', () => {
  const c = new Carrinho();
  c.adicionar('A', 10, 2);
  c.adicionar('B', 5);
  assert.equal(c.subtotal(), 25);
});

test('desconto de 10% sobre 100 resulta em 90', () => {
  const c = new Carrinho();
  c.adicionar('A', 100);
  assert.equal(c.total(0.1), 90);
});
