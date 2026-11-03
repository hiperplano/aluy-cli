import { listarPedidos } from './pedidos.js';
import { formatarMoeda } from './precos.js';

export function resumoVendas() {
  const lista = listarPedidos();
  const total = lista.reduce((s, p) => s + p.total, 0);
  return { quantidade: lista.length, total: formatarMoeda(total) };
}
