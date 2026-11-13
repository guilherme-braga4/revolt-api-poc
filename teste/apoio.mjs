// Servidor de apoio aos testes do Postman/Newman. Não chama nenhum serviço real.
// 1) Dublês do Open Charge Map (/ocm/v3/poi) e do Google Places (/google/v1/...), com contagem de chamadas.
// 2) Preparo e inspeção do banco de teste (/__apoio/...): reset, coordenadas antigas e busca de texto nas tabelas.
// 3) Dublês do login gerenciado e do atestado do app (/__apoio/jwks e /__apoio/token), com chaves geradas ao subir.
import { generateKeyPairSync } from 'node:crypto';
import http from 'node:http';
import { exportJWK, SignJWT } from 'jose';
import pg from 'pg';

const banco = new URL(process.env.DATABASE_URL).pathname.slice(1);
if (!banco.endsWith('_teste')) throw new Error(`o apoio só roda contra um banco *_teste, não contra "${banco}"`);
const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });

// ---------- Dublê do Open Charge Map ----------
const CC_BY = { ID: 1, Title: 'Open Charge Map Contributors', IsOpenDataLicensed: true, License: 'Licensed under Creative Commons Attribution 4.0 International (CC BY 4.0)' };
const CC0 = { ID: 3501, Title: 'EZVolt (dublê)', IsOpenDataLicensed: true, License: 'Licensed under CC0 by data sharing agreement' };
const CC0_HIFEN = { ...CC0, License: 'CC-0' }; // o OCM real também escreve a licença assim
const FECHADA = { ID: 99, Title: 'Rede Fechada (dublê)', IsOpenDataLicensed: false, License: 'Todos os direitos reservados' };

const poi = (ID, provedor, lat, lng, extra = {}) => ({
  ID,
  DataProviderID: provedor.ID,
  DataProvider: provedor,
  StatusType: { ID: 50, Title: 'Operational', IsOperational: true },
  DateLastVerified: new Date().toISOString(), // verificado "hoje" na fonte: não pode virar verificado no REVOLT (RN13)
  AddressInfo: { Title: `Posto dublê ${ID}`, AddressLine1: 'Rodovia Presidente Dutra', Town: 'Cidade', StateOrProvince: 'SP', Latitude: lat, Longitude: lng },
  Connections: [{ ConnectionType: { Title: 'CCS (Type 2)' }, PowerKW: 60, Quantity: 2 }],
  ...extra,
});

const OCM_V1 = [
  poi(9001, CC_BY, -23.19, -45.88), // São José dos Campos
  poi(9002, CC0, -23.195, -45.885, { StatusType: { ID: 100, Title: 'Not Operational', IsOperational: false } }),
  poi(9003, FECHADA, -23.191, -45.882), // licença não aberta: não entra
  poi(9004, CC_BY, -23.192, -45.883, { GeneralComments: 'Fonte: PlugShare' }), // cita o PlugShare: não entra
  poi(9005, CC_BY, -23.193, -45.884, { UserComments: [{ Comment: 'Visto em https://www.plugshare.com/location/12345' }] }),
  poi(9006, CC0_HIFEN, -22.4689, -44.4469), // Resende
  poi(9010, CC_BY, -23.0204, -45.554), // Taubaté
];
// Segunda versão da fonte: 9001 alterado, 9010 saiu e 9011 é novo.
const OCM_V2 = [
  ...OCM_V1.filter((p) => p.ID !== 9010).map((p) => (p.ID === 9001 ? { ...p, UsageCost: 'R$ 2,00/kWh' } : p)),
  poi(9011, CC_BY, -22.8162, -45.1935), // Guaratinguetá
];

// ---------- Dublê do Google Places ----------
const LUGARES = [
  { id: 'dubleA', lat: -23.186, lng: -45.876, nome: 'Eletroposto Dublê A', endereco: 'Rua do Dublê, 1 - São José dos Campos' },
  { id: 'dubleB', lat: -23.187, lng: -45.875, nome: 'Eletroposto Dublê B', endereco: 'Rua do Dublê, 2 - São José dos Campos' },
  // A uns 40 m do posto 9001 do OCM: é o mesmo posto e não pode sair duplicado na lista.
  { id: 'dubleOcm', lat: -23.1902, lng: -45.8803, nome: 'Eletroposto Dublê do OCM', endereco: 'Rodovia Presidente Dutra - São José dos Campos' },
  // 24 lugares numa diagonal da região de teste: a primeira busca volta cheia (20) e a célula precisa ser dividida.
  ...Array.from({ length: 24 }, (_, k) => ({
    id: `massa${String(k + 1).padStart(2, '0')}`,
    lat: -23.38 + k * 0.0243,
    lng: -46.18 + k * 0.0243,
    nome: `Eletroposto Dublê da diagonal ${k + 1}`,
    endereco: 'Estrada do Dublê',
  })),
];
const distanciaM = (a, b) => {
  const rad = Math.PI / 180;
  const x = (b.lng - a.lng) * rad * Math.cos(((a.lat + b.lat) / 2) * rad);
  const y = (b.lat - a.lat) * rad;
  return Math.sqrt(x * x + y * y) * 6371000;
};
// O dubleA informa disponibilidade com horário; os outros, não.
const DISPONIBILIDADE = { dubleA: { availableCount: 1, outOfServiceCount: 0, availabilityLastUpdateTime: '2026-11-12T10:00:00Z' } };
const ficha = (l) => ({
  id: l.id,
  displayName: { text: l.nome, languageCode: 'pt-BR' },
  formattedAddress: l.endereco,
  location: { latitude: l.lat, longitude: l.lng },
  businessStatus: 'OPERATIONAL',
  currentOpeningHours: { openNow: true, weekdayDescriptions: ['segunda-feira: Atendimento 24 horas'] },
  evChargeOptions: {
    connectorCount: 2,
    connectorAggregation: [{ type: 'EV_CONNECTOR_TYPE_CCS_COMBO_2', maxChargeRateKw: 60, count: 2, ...DISPONIBILIDADE[l.id] }],
  },
  paymentOptions: { acceptsCreditCards: true },
  googleMapsUri: `https://maps.google.com/?cid=${l.id}`,
});

// ---------- Dublês do login gerenciado e do atestado do app ----------
// Uma chave publicada no JWKS e outra, desconhecida, para o teste de assinatura inválida.
const chave = generateKeyPairSync('rsa', { modulusLength: 2048 });
const chaveDesconhecida = generateKeyPairSync('rsa', { modulusLength: 2048 });
const JWKS = { keys: [{ ...(await exportJWK(chave.publicKey)), kid: 'teste', alg: 'RS256', use: 'sig' }] };
const EMISSORES = {
  conta: [process.env.CONTA_EMISSOR, process.env.CONTA_PUBLICO],
  atestado: [process.env.ATESTADO_EMISSOR, process.env.ATESTADO_PUBLICO],
};
async function token({ tipo = 'atestado', sub = 'pessoa-teste', expirado = false, publico, chave_desconhecida = false }) {
  const [emissor, publicoPadrao] = EMISSORES[tipo];
  const agora = Math.floor(Date.now() / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: 'RS256', kid: 'teste', typ: 'JWT' })
    .setIssuer(emissor)
    .setAudience(publico ?? publicoPadrao)
    .setSubject(sub)
    .setIssuedAt(agora - 120)
    .setExpirationTime(expirado ? agora - 60 : agora + 3600)
    .sign((chave_desconhecida ? chaveDesconhecida : chave).privateKey);
}

// ---------- Estado dos dublês ----------
let estado;
const zerar = () => (estado = { ocm: 'v1', google: 'ok', chamadas: { ocm: 0, google_busca: 0, google_ficha: 0 }, mascaras: {}, raio_max_m: 0 });
zerar();

const TABELAS = ['ocm_posto', 'atualizacao_ocm', 'posto_proprio', 'verificacao', 'google_lugar', 'google_celula', 'consulta_google', 'fonte', 'ocm_provedor', 'teto_google'];

async function lerCorpo(req) {
  let texto = '';
  for await (const parte of req) texto += parte;
  return texto ? JSON.parse(texto) : {};
}

const json = (res, status, corpo) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(corpo));

http
  .createServer((req, res) => tratar(req, res).catch((erro) => json(res, 500, { erro: String(erro.message ?? erro) })))
  .listen(process.env.APOIO_PORT ?? 4010, () => console.log(`Apoio aos testes em http://localhost:${process.env.APOIO_PORT ?? 4010} (banco ${banco})`));

async function tratar(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const rota = `${req.method} ${url.pathname}`;

  if (rota === 'GET /ocm/v3/poi') {
    estado.chamadas.ocm++;
    if (estado.ocm === 'fora_do_ar') return json(res, 503, { erro: 'OCM fora do ar (dublê)' });
    const corpo = JSON.stringify(estado.ocm === 'v2' ? OCM_V2 : OCM_V1);
    if (estado.ocm === 'falha_no_meio') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.write(corpo.slice(0, corpo.length / 2));
      return setTimeout(() => res.destroy(), 50);
    }
    return json(res, 200, JSON.parse(corpo));
  }

  if (rota === 'POST /google/v1/places:searchNearby') {
    estado.chamadas.google_busca++;
    estado.mascaras.busca = req.headers['x-goog-fieldmask'];
    if (estado.google === 'fora_do_ar') return json(res, 503, { error: { code: 503, status: 'UNAVAILABLE' } });
    const corpo = await lerCorpo(req);
    const { center, radius } = corpo.locationRestriction.circle;
    estado.raio_max_m = Math.max(estado.raio_max_m, radius);
    // Como o Google: raio de no máximo 50 km e no máximo maxResultCount (até 20) lugares por busca.
    if (radius > 50000) return json(res, 400, { error: { code: 400, status: 'INVALID_ARGUMENT', message: 'radius > 50000' } });
    const perto = LUGARES.filter((l) => distanciaM({ lat: center.latitude, lng: center.longitude }, l) <= radius).slice(0, corpo.maxResultCount ?? 20);
    // Devolve também o nome, como se o Google mandasse mais do que o pedido: a API não pode guardar.
    return json(res, 200, { places: perto.map((l) => ({ id: l.id, location: { latitude: l.lat, longitude: l.lng }, displayName: { text: l.nome } })) });
  }

  if (req.method === 'GET' && url.pathname.startsWith('/google/v1/places/')) {
    estado.chamadas.google_ficha++;
    estado.mascaras.ficha = req.headers['x-goog-fieldmask'];
    if (estado.google === 'fora_do_ar') return json(res, 503, { error: { code: 503, status: 'UNAVAILABLE' } });
    const lugar = LUGARES.find((l) => l.id === decodeURIComponent(url.pathname.split('/').pop()));
    return lugar ? json(res, 200, ficha(lugar)) : json(res, 404, { error: { code: 404, status: 'NOT_FOUND' } });
  }

  if (rota === 'GET /__apoio/jwks') return json(res, 200, JWKS);
  if (rota === 'POST /__apoio/token') return json(res, 200, { token: await token(await lerCorpo(req)) });
  // Distância em metros entre um lugar do Google guardado e um posto do OCM, pela mesma conta do PostGIS da regra dos 100 m.
  if (rota === 'GET /__apoio/distancia') {
    const { rows } = await db.query(
      'SELECT round(ST_Distance(g.local, o.local)::numeric, 1)::float8 AS metros FROM google_lugar g, ocm_posto o WHERE g.place_id = $1 AND o.ocm_id = $2',
      [url.searchParams.get('place_id'), Number(url.searchParams.get('ocm_id'))],
    );
    return json(res, 200, rows[0] ?? { metros: null });
  }

  if (rota === 'POST /__apoio/reset') {
    zerar();
    await db.query(`TRUNCATE ${TABELAS.filter((t) => !['fonte', 'teto_google'].includes(t)).join(', ')} RESTART IDENTITY CASCADE`);
    await db.query(`UPDATE fonte SET ligada = true, alterada_em = now(), alterada_por = 'reset do teste'`);
    await db.query(`UPDATE teto_google SET valor_usd = 50, alterado_em = now(), alterado_por = 'reset do teste'`);
    return json(res, 200, { ok: true, banco });
  }
  if (rota === 'POST /__apoio/ocm') {
    estado.ocm = (await lerCorpo(req)).modo;
    return json(res, 200, { ocm: estado.ocm });
  }
  if (rota === 'POST /__apoio/google') {
    estado.google = (await lerCorpo(req)).modo;
    return json(res, 200, { google: estado.google });
  }
  if (rota === 'GET /__apoio/chamadas') return json(res, 200, { chamadas: estado.chamadas, mascaras: estado.mascaras, raio_max_m: estado.raio_max_m });

  // Simula a passagem do tempo na varredura: todas as células já consultadas passam a ter sido consultadas há N dias.
  // Uma célula vazia (a busca não trouxe lugar) consultada há N dias.
  if (rota === 'POST /__apoio/celula-vazia') {
    const { lat_min, lng_min, tam, dias } = await lerCorpo(req);
    await db.query(
      `INSERT INTO google_celula (lat_min, lng_min, tam, consultada_em, lugares) VALUES ($1, $2, $3, now() - make_interval(days => $4), 0)
       ON CONFLICT (lat_min, lng_min, tam) DO UPDATE SET consultada_em = EXCLUDED.consultada_em, lugares = 0`,
      [lat_min, lng_min, tam, dias],
    );
    return json(res, 200, { ok: true });
  }
  if (rota === 'POST /__apoio/celulas-antigas') {
    const { dias } = await lerCorpo(req);
    const r = await db.query(`UPDATE google_celula SET consultada_em = now() - make_interval(days => $1) WHERE consultada_em IS NOT NULL`, [dias]);
    return json(res, 200, { ok: true, celulas: r.rowCount });
  }

  // Simula a passagem do tempo: grava um lugar do Google com coordenada obtida há N dias.
  if (rota === 'POST /__apoio/google-lugar') {
    const { place_id, lat, lng, dias } = await lerCorpo(req);
    await db.query(
      `INSERT INTO google_lugar (place_id, local, coordenada_obtida_em)
       VALUES ($1, ST_SetSRID(ST_MakePoint($3, $2), 4326)::geography, now() - make_interval(days => $4))
       ON CONFLICT (place_id) DO UPDATE SET local = EXCLUDED.local, coordenada_obtida_em = EXCLUDED.coordenada_obtida_em`,
      [place_id, lat, lng, dias],
    );
    return json(res, 200, { ok: true });
  }
  if (req.method === 'GET' && url.pathname.startsWith('/__apoio/tabela/')) {
    const tabela = url.pathname.split('/').pop();
    if (!TABELAS.includes(tabela)) return json(res, 404, { erro: 'tabela desconhecida' });
    return json(res, 200, (await db.query(`SELECT * FROM ${tabela}`)).rows);
  }
  // Procura um texto em todas as tabelas, para provar que nada da ficha do Google foi guardado (RN08).
  if (rota === 'GET /__apoio/procurar') {
    const texto = url.searchParams.get('texto');
    const por_tabela = {};
    for (const t of TABELAS) {
      const [{ n }] = (await db.query(`SELECT count(*)::int AS n FROM ${t} WHERE ${t}::text ILIKE '%' || $1 || '%'`, [texto])).rows;
      por_tabela[t] = n;
    }
    return json(res, 200, { texto, total: Object.values(por_tabela).reduce((a, b) => a + b, 0), por_tabela });
  }

  json(res, 404, { erro: `rota do apoio desconhecida: ${rota}` });
}
