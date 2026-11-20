// Testes unitários dos indicadores do Curador (Fase 4), sobre o código compilado.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { situacaoDoCorredor } from '../dist/indicadores.js';

const HOJE = '2026-11-20';
const ocm = (id, extra = {}) => ({ id: `ocm-${id}`, origem: 'open_charge_map', nome: `Posto ${id}`, verificado: false, ...extra });

describe('Situação do corredor (UC07 da obtenção)', () => {
  test('RN18: lugar do Google no trecho não aparece nem conta nos indicadores', () => {
    const s = situacaoDoCorredor([ocm(1), { id: 'google-abc', origem: 'google', verificado: false }], HOJE);
    assert.deepEqual(s.postos.map((p) => p.id), ['ocm-1']);
    assert.equal(s.indicadores.postos, 1);
  });

  test('RN13: só a verificação própria torna o posto verificado e conta preço e regras', () => {
    // Preço vindo do OCM, sem verificação própria: não verificado e sem preço para o corredor.
    const s = situacaoDoCorredor([ocm(1, { preco_observado: null, preco: 'R$ 2/kWh' })], HOJE);
    assert.deepEqual(s.postos[0], {
      id: 'ocm-1', origem: 'open_charge_map', nome: 'Posto 1', verificado: false, ultima_verificacao: null, tem_preco: false, tem_regras_cobranca: false,
    });
    assert.equal(s.indicadores.parcela_verificados, 0);
  });

  test('corredor sem verificações: todos não verificados, sem idade mediana', () => {
    const s = situacaoDoCorredor([ocm(1), ocm(2)], HOJE);
    assert.deepEqual(s.indicadores, {
      postos: 2, verificados: 0, parcela_verificados: 0, idade_mediana_ultima_verificacao_dias: null, com_preco_e_regras: 0, parcela_com_preco_e_regras: 0,
    });
  });

  test('os indicadores batem com a contagem manual de um trecho fixo', () => {
    const linhas = [
      ocm(1, { verificado: true, data_observacao: '2026-11-18', preco_observado: 'R$ 2,10/kWh', regras_cobranca: 'Por kWh' }), // 2 dias
      ocm(2, { verificado: true, data_observacao: '2026-11-10', preco_observado: 'R$ 1,90/kWh' }), // 10 dias, sem regras
      { id: 'propria-7', origem: 'verificacao_propria', nome: null, verificado: true, data_observacao: '2026-10-21' }, // 30 dias, sem preço
      ocm(3),
      ocm(4),
      { id: 'google-x', origem: 'google', verificado: false },
    ];
    const s = situacaoDoCorredor(linhas, HOJE);
    // Contagem manual: 5 postos (o Google fica de fora), 3 verificados, idades 2, 10 e 30 (mediana 10), 1 com preço e regras.
    assert.deepEqual(s.indicadores, {
      postos: 5, verificados: 3, parcela_verificados: 3 / 5, idade_mediana_ultima_verificacao_dias: 10, com_preco_e_regras: 1, parcela_com_preco_e_regras: 1 / 5,
    });
    assert.deepEqual(s.postos.map((p) => [p.id, p.verificado, p.ultima_verificacao, p.tem_preco, p.tem_regras_cobranca]), [
      ['ocm-1', true, '2026-11-18', true, true],
      ['ocm-2', true, '2026-11-10', true, false],
      ['propria-7', true, '2026-10-21', false, false],
      ['ocm-3', false, null, false, false],
      ['ocm-4', false, null, false, false],
    ]);
  });

  test('número par de verificados: a idade mediana é a média das duas do meio', () => {
    const s = situacaoDoCorredor([ocm(1, { verificado: true, data_observacao: '2026-11-18' }), ocm(2, { verificado: true, data_observacao: '2026-11-10' })], HOJE);
    assert.equal(s.indicadores.idade_mediana_ultima_verificacao_dias, 6);
  });
});
