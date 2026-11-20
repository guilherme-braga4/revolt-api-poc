// Testes unitários das regras da obtenção (PRD de obtenção, §7.2), sobre o código compilado.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { triagemOcm } from '../dist/ocm.js';
import { pinoDaBase, pinoDoGoogle } from '../dist/v1/mapa.js';
import { condicoesDeUso } from '../dist/vocabulario.js';

// Registro do OCM no formato da API dele, aberto (CC BY 4.0) e com coordenada.
const poi = (extra = {}) => ({
  ID: 1,
  DataProviderID: 1,
  DataProvider: { Title: 'Open Charge Map Contributors', IsOpenDataLicensed: true, License: 'Licensed under Creative Commons Attribution 4.0 International (CC BY 4.0)' },
  AddressInfo: { Title: 'Posto 1', AddressLine1: 'Rua A', Town: 'Taubaté', StateOrProvince: 'SP', Latitude: -23.0, Longitude: -45.5 },
  StatusType: { IsOperational: true, Title: 'Operational' },
  ...extra,
});
const provedor = (License, IsOpenDataLicensed = true) => ({ DataProvider: { Title: 'Provedor X', IsOpenDataLicensed, License } });

describe('Cópia do Open Charge Map (Alteração 1 da obtenção)', () => {
  test('RN01: o registro que entra na cópia traz provedor e licença', () => {
    const { registro } = triagemOcm(poi(), []);
    assert.equal(registro.provedor, 'Open Charge Map Contributors');
    assert.equal(registro.licenca, 'CC BY 4.0');
    assert.equal(registro.ocm_id, 1);
  });

  test('RN01 e RN03: registro sem licença aberta não é guardado', () => {
    assert.deepEqual(triagemOcm(poi({ DataProvider: undefined }), []), { motivo: 'licenca_nao_aberta' });
    assert.deepEqual(triagemOcm(poi(provedor('CC BY 4.0', false)), []), { motivo: 'licenca_nao_aberta' });
  });

  test('RN03: só CC0 e CC BY 4.0 entram, nas grafias que o OCM usa', () => {
    assert.equal(triagemOcm(poi(provedor('CC0')), []).registro.licenca, 'CC0');
    assert.equal(triagemOcm(poi(provedor('CC-0 Public Domain')), []).registro.licenca, 'CC0');
    assert.equal(triagemOcm(poi(provedor('CC BY 4.0')), []).registro.licenca, 'CC BY 4.0');
    for (const outra of ['CC BY-SA 4.0', 'CC BY-NC 4.0', 'CC BY 3.0', 'Proprietary', ''])
      assert.deepEqual(triagemOcm(poi(provedor(outra)), []), { motivo: 'licenca_nao_aberta' }, outra);
  });

  test('RN04: registro aberto que cita o PlugShare em qualquer campo fica de fora', () => {
    assert.deepEqual(triagemOcm(poi({ GeneralComments: 'Fonte: PlugShare' }), []), { motivo: 'cita_plugshare' });
    assert.deepEqual(triagemOcm(poi({ MediaItems: [{ ItemURL: 'https://www.plugshare.com/location/1' }] }), []), { motivo: 'cita_plugshare' });
  });

  test('provedor desligado pelo Curador e registro sem coordenada ficam de fora', () => {
    assert.deepEqual(triagemOcm(poi(), [1]), { motivo: 'provedor_desligado' });
    assert.deepEqual(triagemOcm(poi({ AddressInfo: { Title: 'Sem lugar' } }), []), { motivo: 'sem_coordenada' });
  });
});

describe('Condições de uso e verificação no item entregue (RN05 e RN13 da obtenção)', () => {
  const base = { id: 'ocm-1', lat: -23, lng: -45.5, nome: 'Posto 1', situacao: 'operacional', tipos: ['CCS2'], potencia_max_kw: 60, data_fonte: '2026-11-19T12:00:00Z' };

  test('RN05: o posto do OCM leva a atribuição por provedor exigida pela licença', () => {
    const c = pinoDaBase({ ...base, origem: 'open_charge_map', provedor: 'EZVolt', licenca: 'CC BY 4.0' }).condicoes_de_uso;
    assert.equal(c.licenca, 'CC BY 4.0');
    assert.equal(c.atribuicao, 'EZVolt via Open Charge Map');
    assert.match(c.texto, /Atribuição obrigatória/);
    assert.match(condicoesDeUso('open_charge_map', 'EZVolt', 'CC0').texto, /Domínio público/);
  });

  test('RN05: o lugar do Google sempre leva as condições do Google: só sobre mapa do Google, sem voz e sem IA', () => {
    const c = pinoDoGoogle({ id: 'google-x', lat: -23, lng: -45.5, data_fonte: '2026-11-19T12:00:00Z' }).condicoes_de_uso;
    assert.deepEqual([c.licenca, c.atribuicao, c.exibicao, c.pode_ler_em_voz, c.pode_usar_em_ia], ['Termos do Google Maps Platform', 'Google Maps', 'somente_sobre_mapa_google', false, false]);
  });

  test('RN05: todo item entregue tem condições de uso, qualquer que seja a origem', () => {
    for (const origem of ['open_charge_map', 'verificacao_propria', 'google']) {
      const c = condicoesDeUso(origem, 'P', 'CC0');
      assert.ok(c.licenca && c.texto && c.exibicao, origem);
    }
  });

  test('RN13: a data de importação do OCM não torna o posto verificado; só a verificação em campo', () => {
    const importado = pinoDaBase({ ...base, origem: 'open_charge_map', provedor: 'P', licenca: 'CC0', verificado: false });
    assert.deepEqual(importado.verificacao, { situacao: 'nao_verificado', data: null });
    assert.equal(importado.atualizado_em, '2026-11-19');
    const verificado = pinoDaBase({ ...base, origem: 'open_charge_map', provedor: 'P', licenca: 'CC0', verificado: true, data_observacao: '2026-11-10' });
    assert.deepEqual(verificado.verificacao, { situacao: 'verificado', data: '2026-11-10' });
  });
});
