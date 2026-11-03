import { describe, expect, it } from 'vitest';
import {
  capRecallLines,
  RECALL_MAX_CHARS_PER_ITEM,
  RECALL_MAX_CHARS_TOTAL,
} from '../../src/agent/loop.js';

describe('capRecallLines — teto do recall de memória', () => {
  it('mantém itens curtos intactos', () => {
    expect(capRecallLines(['- a', '- b'])).toEqual(['- a', '- b']);
  });
  it('corta item gigante no teto por item, com reticências', () => {
    const [l] = capRecallLines(['- ' + 'x'.repeat(5000)]);
    expect(l!.length).toBe(RECALL_MAX_CHARS_PER_ITEM);
    expect(l!.endsWith('…')).toBe(true);
  });
  it('respeita o teto total e descarta os menos relevantes (fim da lista)', () => {
    const lines = Array.from({ length: 5 }, (_, i) => `- ${i}` + 'y'.repeat(1000));
    const out = capRecallLines(lines);
    expect(out.join('\n').length).toBeLessThanOrEqual(RECALL_MAX_CHARS_TOTAL);
    expect(out.length).toBeLessThan(5);
    expect(out[0]!.startsWith('- 0')).toBe(true);
  });
});
