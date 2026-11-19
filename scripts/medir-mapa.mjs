// Mede o GET /v1/mapa (RNF-04: até 150 KB comprimida e até 1 s no p95, no servidor) em janelas sorteadas em volta de
// postos reais. Uso: node scripts/medir-mapa.mjs http://localhost:3355 [pedidos por caso]
// Só lê; nenhuma fonte externa é consultada pela API ao responder o mapa.
import http from 'node:http';
import pg from 'pg';

const base = process.argv[2] ?? 'http://localhost:3333';
const N = Number(process.argv[3] ?? 40);
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const { rows: pontos } = await db.query('SELECT lat, lng FROM eletroposto ORDER BY random() LIMIT 2000');
await db.end();

function pedir(url) {
  return new Promise((ok, falha) => {
    const t0 = performance.now();
    http.get(url, { headers: { 'Accept-Encoding': 'gzip' } }, (res) => {
      let bytes = 0;
      res.on('data', (p) => (bytes += p.length));
      res.on('end', () => ok({ status: res.statusCode, bytes, ms: performance.now() - t0, gzip: res.headers['content-encoding'] === 'gzip' }));
    }).on('error', falha);
  });
}

const p = (lista, q) => lista.sort((a, b) => a - b)[Math.min(lista.length - 1, Math.floor(q * lista.length))];
// Celular: ~400 x 850 pontos = 1,6 x 3,3 blocos de 256. Máxima: 8 x 8 blocos (o limite da API).
const telas = { celular: [1.6, 3.3], maxima: [8, 8] };
console.log('zoom | tela    | p50 ms | p95 ms | máx ms | p95 KB gzip | máx KB gzip | máx pinos+grupos');
for (const zoom of [4, 6, 8, 10, 12, 13, 14, 16]) {
  for (const [nome, [bx, by]] of Object.entries(telas)) {
    const ms = [], kb = [];
    let maxItens = 0;
    for (let i = 0; i < N; i++) {
      const c = pontos[Math.floor(Math.random() * pontos.length)];
      const bloco = 360 / 2 ** zoom;
      const [w, h] = [bx * bloco * 0.99, by * bloco * 0.99];
      const bbox = [c.lng - w / 2, c.lat - h / 2, c.lng + w / 2, c.lat + h / 2].map((v) => v.toFixed(5));
      const r = await pedir(`${base}/v1/mapa?bbox=${bbox.join(',')}&zoom=${zoom}`);
      if (r.status !== 200) throw new Error(`status ${r.status} em ${bbox} z${zoom}`);
      ms.push(r.ms);
      kb.push(r.bytes / 1024);
      if (i === 0 && !r.gzip && r.bytes > 1024) console.log('  (resposta sem gzip)');
    }
    // Um pedido extra, sem gzip, para contar os itens do pior caso desta rodada não vale o custo: conta só o tamanho.
    console.log(`${String(zoom).padStart(4)} | ${nome.padEnd(7)} | ${p(ms, 0.5).toFixed(0).padStart(6)} | ${p(ms, 0.95).toFixed(0).padStart(6)} | ${Math.max(...ms).toFixed(0).padStart(6)} | ${p(kb, 0.95).toFixed(1).padStart(11)} | ${Math.max(...kb).toFixed(1).padStart(11)} |`);
  }
}
