import test from 'node:test';
import assert from 'node:assert/strict';
import { adicionar, baixar, disponivel, limpar } from '../src/estoque.js';

test('baixa de estoque', () => {
  limpar();
  adicionar('A', 3);
  baixar('A', 2);
  assert.equal(disponivel('A'), 1);
});
