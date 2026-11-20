// Testes unitários dos indicadores do Curador (Fase 4), sobre o código compilado.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { MINIMO_MOTORISTAS, indicadoresDoApp, situacaoDoCorredor } from '../dist/indicadores.js';

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

describe('Indicadores do app para o Curador (RF15 e RN21 do app)', () => {
  const chegadas = (motoristas, chegadas, como_informado) => ({ motoristas, chegadas, como_informado, dados_ate: '2026-11-19' });
  const semana = (semana, motoristas, checkins) => ({ semana, motoristas, checkins, dados_ate: semana });

  test('RN21: grupo com menos de 5 motoristas sai sem números, e nenhum indicador traz motorista ou contagem de motoristas', () => {
    assert.equal(MINIMO_MOTORISTAS, 5);
    const r = indicadoresDoApp(chegadas(4, 9, 6), [semana('2026-11-09', 4, 4), semana('2026-11-16', 5, 7)]);
    assert.deepEqual(r.como_informado, { chegadas: null, como_informado: null, parcela: null, suprimido: true, dados_ate: '2026-11-19' });
    assert.deepEqual(r.checkins_por_semana_no_corredor.semanas, [
      { semana: '2026-11-09', checkins: null, suprimido: true },
      { semana: '2026-11-16', checkins: 7, suprimido: false },
    ]);
    // Nada que permita chegar a uma pessoa: nem autor, nem conta, nem quantos motoristas havia em cada grupo.
    assert.doesNotMatch(JSON.stringify(r), /motoristas"|autor|conta|sub"|pseudonimo/);
  });

  test('os números batem com a contagem manual de um período fixo', () => {
    // Contagem manual: 6 motoristas, 9 chegadas, 6 como o app informou; no corredor, semana de 09/11 com 5 check-ins de 5
    // motoristas e semana de 16/11 com 2 check-ins de 2 motoristas.
    const r = indicadoresDoApp(chegadas(6, 9, 6), [semana('2026-11-09', 5, 5), semana('2026-11-16', 2, 2)]);
    assert.deepEqual(r, {
      minimo_motoristas_por_grupo: 5,
      como_informado: { chegadas: 9, como_informado: 6, parcela: 6 / 9, suprimido: false, dados_ate: '2026-11-19' },
      checkins_por_semana_no_corredor: {
        semanas: [{ semana: '2026-11-09', checkins: 5, suprimido: false }, { semana: '2026-11-16', checkins: null, suprimido: true }],
        dados_ate: '2026-11-16',
      },
    });
  });

  test('sem chegadas no período: parcela null', () => {
    const r = indicadoresDoApp({ motoristas: 0, chegadas: 0, como_informado: 0, dados_ate: null }, []);
    assert.deepEqual(r.como_informado, { chegadas: null, como_informado: null, parcela: null, suprimido: true, dados_ate: null });
    assert.deepEqual(r.checkins_por_semana_no_corredor, { semanas: [], dados_ate: null });
  });
});
