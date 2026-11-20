// Testes unitários do planejador de viagem (RN10 e RN11 do app), sobre o código compilado: npm run test:unidade.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { compativel, decodificarLinha, linkGoogleMaps, planejarParadas } from '../dist/v1/planejador.js';

const ORIGEM = { lat: -23.19, lng: -45.88 };
const DESTINO = { lat: -22.52, lng: -44.1 };
// Posto a km da origem, sobre uma linha reta norte-sul (1 km de rota ~ 0,009° de latitude), com 0,5 km de desvio.
const posto = (id, km, { desvio = 0.5, origem = 'open_charge_map', situacao = 'operacional', conectores = ['CCS2'], localizacao } = {}) => ({
  posto: { id, origem, situacao, conectores, localizacao: localizacao ?? { lat: -23 + km * 0.009, lng: -45 } },
  km,
  desvio_km: desvio,
});
const planejar = (candidatos, e = {}) =>
  planejarParadas({ candidatos, distancia_km: 150, autonomia_km: 100, conectores: ['CCS2'], origem: ORIGEM, destino: DESTINO, ...e });
const ids = (r) => r.paradas.map((p) => [p.parada.posto.id, p.plano_b?.posto.id ?? null]);

describe('RN10: paradas só de postos do OCM e próprios compatíveis com o carro', () => {
  test('lugar do Google no melhor ponto da rota não vira parada nem plano B', () => {
    // Se valessem, os dois lugares do Google seriam a parada (mais adiante, e um é plano B do outro).
    const google = { origem: 'google', situacao: 'desconhecida' };
    const r = planejar([posto('ocm-1', 60), posto('ocm-2', 62), posto('google-x', 90, google), posto('google-y', 92, google)]);
    assert.deepEqual(ids(r), [['ocm-2', 'ocm-1']]);
  });

  test('posto próprio serve de parada e de plano B', () => {
    const r = planejar([posto('propria-1', 60, { origem: 'verificacao_propria' }), posto('propria-2', 62, { origem: 'verificacao_propria' })]);
    assert.deepEqual(ids(r), [['propria-2', 'propria-1']]);
  });

  test('posto sem conector do carro não vira parada nem plano B', () => {
    const r = planejar([posto('ocm-1', 60), posto('ocm-tipo2', 90, { conectores: ['TIPO_2'] }), posto('ocm-2', 62)]);
    assert.deepEqual(ids(r), [['ocm-2', 'ocm-1']]);
  });

  test('posto fora de operação, fechado ou só planejado não vira parada; situação desconhecida vira', () => {
    const fora = ['fora_de_operacao', 'fechado_definitivamente', 'planejado'].map((s, i) => posto(`ocm-${s}`, 90 + i, { situacao: s }));
    const r = planejar([...fora, posto('ocm-desconhecida', 70, { situacao: 'desconhecida' })]);
    assert.deepEqual(ids(r), [['ocm-desconhecida', null]]);
  });

  test('conector desconhecido ou ausente não é compatível', () => {
    const p = (conectores) => ({ id: 'x', origem: 'open_charge_map', situacao: 'operacional', conectores, localizacao: ORIGEM });
    assert.equal(compativel(p(null), ['CCS2']), false);
    assert.equal(compativel(p(['DESCONHECIDO']), ['CCS2']), false);
    assert.equal(compativel(p(['TIPO_2', 'CCS2']), ['CCS2']), true);
  });
});

describe('RN11: toda parada tem plano B ao alcance, ou aviso', () => {
  test('parada com outro posto compatível ao alcance mostra esse posto como plano B', () => {
    const r = planejar([posto('ocm-a', 80), posto('ocm-b', 85)]);
    assert.deepEqual(ids(r), [['ocm-b', 'ocm-a']]);
  });

  test('parada sem alternativa ao alcance vem sem plano B', () => {
    assert.deepEqual(ids(planejar([posto('ocm-a', 80)])), [['ocm-a', null]]);
  });

  test('prefere a parada com plano B à mais adiante sem plano B', () => {
    const r = planejar([posto('ocm-a', 50), posto('ocm-b', 52), posto('ocm-c', 95)]);
    assert.deepEqual(ids(r), [['ocm-b', 'ocm-a']]);
  });

  test('o plano B precisa caber na autonomia que sobra ao chegar à parada', () => {
    // Parada no km 90 sem desvio: sobram 10 km. Plano B a 9,5 km cabe; a 10,5 km, não.
    const cabe = planejar([posto('ocm-s', 90, { desvio: 0 }), posto('ocm-b', 99.5, { desvio: 0 })]);
    assert.deepEqual(ids(cabe), [['ocm-s', 'ocm-b']]);
    const naoCabe = planejar([posto('ocm-s', 90, { desvio: 0 }), posto('ocm-b', 100.5, { desvio: 0 })]);
    assert.deepEqual(ids(naoCabe)[0], ['ocm-s', null]);
  });

  test('posto a até 100 m da parada é o mesmo posto, não plano B', () => {
    const perto = { lat: -22.2, lng: -45 };
    const r = planejar([posto('ocm-s', 90, { localizacao: perto }), posto('ocm-t', 90.05, { localizacao: { lat: -22.2004, lng: -45 } })]);
    assert.equal(r.paradas[0].plano_b, null);
  });

  test('o posto de onde o carro saiu não é plano B da parada seguinte', () => {
    // Para no km 100 (sem plano B) e depois no km 110; o único posto ao alcance da segunda é o km 100, de onde saiu.
    const r = planejar([posto('ocm-p', 100), posto('ocm-s', 110)], { distancia_km: 215, autonomia_km: 105 });
    assert.deepEqual(ids(r), [['ocm-p', null], ['ocm-s', null]]);
  });
});

describe('Trechos e alcance', () => {
  test('destino ao alcance: nenhuma parada e nenhum trecho', () => {
    assert.deepEqual(planejar([posto('ocm-a', 50)], { distancia_km: 99 }), { paradas: [], trechos_sem_cobertura: [] });
  });

  test('trecho sem cobertura do último ponto de recarga ao próximo posto compatível, e o plano segue de lá sem plano B', () => {
    const a = posto('ocm-a', 50);
    const b = posto('ocm-b', 140);
    const r = planejar([a, b], { distancia_km: 190, autonomia_km: 60 });
    assert.deepEqual(ids(r), [['ocm-a', null], ['ocm-b', null]]);
    assert.deepEqual(r.trechos_sem_cobertura, [{ de_km: 50, ate_km: 140, distancia_km: 91, inicio: a.posto.localizacao, fim: b.posto.localizacao }]);
  });

  test('sem nenhum posto compatível, a viagem inteira é um trecho sem cobertura', () => {
    const r = planejar([posto('ocm-tipo2', 50, { conectores: ['TIPO_2'] })], { distancia_km: 200 });
    assert.deepEqual(r, { paradas: [], trechos_sem_cobertura: [{ de_km: 0, ate_km: 200, distancia_km: 200, inicio: ORIGEM, fim: DESTINO }] });
  });

  test('o desvio até o posto conta na autonomia', () => {
    // km 95 com 6 km de desvio consome 101 km: fora do alcance de 100.
    const r = planejar([posto('ocm-a', 95, { desvio: 6 })]);
    assert.equal(r.trechos_sem_cobertura.length, 1);
    assert.equal(r.trechos_sem_cobertura[0].distancia_km, 101);
  });
});

describe('Linha do Google e link do Google Maps', () => {
  test('decodifica o exemplo da documentação do Google', () => {
    assert.deepEqual(decodificarLinha('_p~iF~ps|U_ulLnnqC_mqNvxq`@'), [
      { lat: 38.5, lng: -120.2 },
      { lat: 40.7, lng: -120.95 },
      { lat: 43.252, lng: -126.453 },
    ]);
  });

  test('linha cortada ou com caractere inválido é erro', () => {
    assert.throws(() => decodificarLinha('_p~iF~ps|U_ulL'));
    assert.throws(() => decodificarLinha('_p~iF ~ps|U'));
  });

  test('link com origem, destino e paradas, codificado; até 9 paradas', () => {
    const paradas = Array.from({ length: 11 }, (_, i) => ({ lat: -23 + i / 10, lng: -45 }));
    const url = new URL(linkGoogleMaps(DESTINO, ORIGEM, paradas));
    assert.equal(url.origin + url.pathname, 'https://www.google.com/maps/dir/');
    assert.equal(url.searchParams.get('api'), '1');
    assert.equal(url.searchParams.get('origin'), '-23.19,-45.88');
    assert.equal(url.searchParams.get('destination'), '-22.52,-44.1');
    assert.equal(url.searchParams.get('waypoints').split('|').length, 9);
    assert.equal(url.searchParams.get('travelmode'), 'driving');
    assert.match(url.search, /waypoints=-23%2C-45%7C/);
  });

  test('sem rota, o link abre só o destino', () => {
    assert.equal(linkGoogleMaps(DESTINO), 'https://www.google.com/maps/dir/?api=1&destination=-22.52%2C-44.1&travelmode=driving');
  });
});
