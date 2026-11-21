// Testes unitários das regras do Google na obtenção, com banco e Google falsos: nenhuma chamada sai da máquina.
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { GoogleService } from '../dist/google.js';

// Banco falso: devolve o teto e as consultas do mês e anota toda escrita.
function bancoFalso({ teto, consultas = {}, ligada = true }) {
  const escritas = [];
  return {
    escritas,
    fonteLigada: async () => ligada,
    query: async (sql) => {
      if (sql.includes('FROM teto_google')) return [{ valor_usd: teto, alterado_em: null, alterado_por: null }];
      if (sql.includes('FROM consulta_google')) return Object.entries(consultas).map(([tipo, n]) => ({ tipo, consultas: n }));
      escritas.push(sql);
      return [];
    },
  };
}

let chamadasAoGoogle;
const fetchOriginal = globalThis.fetch;
const chaveOriginal = process.env.GOOGLE_PLACES_API_KEY;
beforeEach(() => {
  chamadasAoGoogle = 0;
  globalThis.fetch = async () => {
    chamadasAoGoogle++;
    return new Response('{}', { status: 200 });
  };
  process.env.GOOGLE_PLACES_API_KEY = 'chave-falsa-do-teste';
});
afterEach(() => {
  globalThis.fetch = fetchOriginal;
  if (chaveOriginal === undefined) delete process.env.GOOGLE_PLACES_API_KEY;
  else process.env.GOOGLE_PLACES_API_KEY = chaveOriginal;
});

const chamar = (db, tipo = 'ficha') => new GoogleService(db).chamar(tipo, 'http://google.invalid/teste', {});

describe('RN15 da obtenção: teto mensal de gasto com o Google', () => {
  test('abaixo do teto, a consulta sai e fica contada no gasto do mês', async () => {
    const db = bancoFalso({ teto: 50, consultas: { ficha: 1040 } });
    const r = await chamar(db);
    assert.ok(r.resposta);
    assert.equal(chamadasAoGoogle, 1);
    assert.equal(db.escritas.filter((s) => s.includes('INSERT INTO consulta_google')).length, 1);
  });

  test('com o teto atingido, nenhuma consulta sai e nada é contado', async () => {
    // 1.040 fichas: 40 acima das 1.000 grátis, a US$ 25 por mil = US$ 1,00, igual ao teto.
    const db = bancoFalso({ teto: 1, consultas: { ficha: 1040 } });
    assert.deepEqual(await chamar(db), { motivo: 'teto_atingido' });
    assert.equal(chamadasAoGoogle, 0);
    assert.deepEqual(db.escritas, []);
  });

  test('a consulta que passaria do teto também não sai', async () => {
    // US$ 1,00 gastos + US$ 0,025 da próxima ficha passam do teto de US$ 1,02.
    assert.deepEqual(await chamar(bancoFalso({ teto: 1.02, consultas: { ficha: 1040 } })), { motivo: 'teto_atingido' });
    assert.equal(chamadasAoGoogle, 0);
  });

  test('teto zero barra até a consulta da faixa grátis, em todos os tipos', async () => {
    for (const tipo of ['busca_area', 'ficha', 'rota', 'busca_rota'])
      assert.deepEqual(await chamar(bancoFalso({ teto: 0 }), tipo), { motivo: 'teto_atingido' }, tipo);
    assert.equal(chamadasAoGoogle, 0);
  });

  test('o gasto soma todos os tipos, e o teto atingido vem com o aviso', async () => {
    // Busca na área: 100 acima das 5.000 grátis, a US$ 32 por mil = US$ 3,20. Ficha: US$ 1,00.
    const g = await new GoogleService(bancoFalso({ teto: 4.2, consultas: { busca_area: 5100, ficha: 1040 } })).gasto();
    assert.equal(g.gasto_usd.toFixed(2), '4.20');
    assert.equal(g.teto_atingido, true);
    assert.match(g.aviso, /Teto de gasto com o Google atingido/);
    assert.deepEqual(g.por_tipo.map((t) => t.tipo), ['busca_area', 'ficha', 'rota', 'busca_rota']);
  });

  test('com a camada do Google desligada, nenhuma consulta sai, mesmo abaixo do teto', async () => {
    assert.deepEqual(await chamar(bancoFalso({ teto: 50, ligada: false })), { motivo: 'desligada' });
    assert.equal(chamadasAoGoogle, 0);
  });
});

describe('RN21 da obtenção: a varredura só começa depois do disparo do Curador', () => {
  // Banco falso só com a contagem de células: zero enquanto o Curador não disparou a primeira varredura.
  const comCelulas = (n) => ({ query: async (sql) => (sql.includes('FROM google_celula') ? [{ n }] : []) });

  test('sem o disparo, a tarefa diária não varre nem chama o Google', async () => {
    const servico = new GoogleService(comCelulas(0));
    let varreu = false;
    servico.varrer = async () => (varreu = true);
    assert.equal(await servico.varrerDiario(), undefined);
    assert.equal(varreu, false);
    assert.equal(chamadasAoGoogle, 0);
  });

  test('depois do disparo, a tarefa diária renova as células vencidas, até o limite do dia', async () => {
    const servico = new GoogleService(comCelulas(42));
    let limite = null;
    servico.varrer = async (n) => (limite = n);
    await servico.varrerDiario();
    assert.equal(limite, 500);
  });
});
