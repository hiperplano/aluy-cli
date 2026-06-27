// EST-1007 · AG-0008 — PRELOAD de teste: faz `process.geteuid()` devolver 0 (uid 0 =
// ROOT) ANTES do binário rodar, SEM precisar de privilégio real nem de um hook de
// produção. Carregado via `node --require .../force-root.cjs dist/bin/aluy.js`. O binário
// deriva `root` de `process.geteuid?.() === 0`, então isto simula com fidelidade o caso
// catastrófico que o YOLO RECUSA (espelha o Claude Code, que bloqueia root). Fixture de
// teste — zero linha de produto: a guarda continua lendo o `geteuid` REAL em produção.
process.geteuid = () => 0;
