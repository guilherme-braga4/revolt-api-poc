// GET /v1/mapa: pinos por janela do mapa, com agrupamento por grade no PostGIS e contagem de ocultos (fluxo core).
// UC01, RF01 a RF03 e RN03 a RN08 do app; D-03 da arquitetura; UC02, RN17, RN18 e RN21 da obtenção.
import { BadRequestException, Controller, Get, Query, Req, UseFilters } from '@nestjs/common';
import { ApiBadRequestResponse, ApiHeader, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Db } from '../db.js';
import { NAO_VERIFICADO, SITUACAO_POR_FUNCIONAMENTO, TIPOS_RAPIDA, condicoesDeUso, diaEmBrasilia } from '../vocabulario.js';
import { Acesso, ErrosV1 } from './acesso.js';
import { Erro, PedidoMapa, RespostaMapa } from './contrato.js';

// A partir deste zoom os postos vêm um a um, sem agrupamento, e os lugares de origem google aparecem (D-03).
export const ZOOM_ALTO = 13;
// Janela de no máximo 8 blocos de 256 px de lado no zoom pedido: um aparelho com tela grande cabe com folga. Limita o
// tamanho da resposta (RNF-04) sem depender do app.
const BLOCOS_MAX = 8;
// Abaixo do zoom alto, cada bloco de 256 px é dividido em 4 x 4 células de 64 px; os postos de uma célula viram um grupo.
const CELULAS_POR_BLOCO = 4;
// Preço que indica posto gratuito, no texto livre da fonte ou da verificação. Heurística, a revisar com dados reais.
const GRATUITO = String.raw`(gr[aá]tis|gratuit|free|sem custo|^\s*(r\$\s*)?0+([.,]0+)?\s*$)`;

// Itens do OCM e próprios que podem ser entregues: fonte e provedor ligados pelo Curador (RF10 da obtenção).
export const OCM_E_PROPRIOS_LIGADOS = `(
  (origem = 'open_charge_map' AND (SELECT ligada FROM fonte WHERE nome = 'ocm')
     AND provedor_id NOT IN (SELECT provedor_id FROM ocm_provedor WHERE NOT ligado))
  OR (origem = 'verificacao_propria' AND (SELECT ligada FROM fonte WHERE nome = 'propria')))`;

// Lugares de origem google que podem ser entregues (RN17 e RN21 da obtenção): camada ligada, coordenada no prazo (a
// view já corta as de mais de 30 dias), a mais de 100 m de um posto do OCM entregue e sem vínculo com um item entregue.
export const LUGARES_GOOGLE_ENTREGAVEIS = `
  origem = 'google' AND (SELECT ligada FROM fonte WHERE nome = 'google') AND NOT duplicado_do_ocm
  AND google_place_id NOT IN (
    SELECT google_place_id FROM eletroposto WHERE origem <> 'google' AND google_place_id IS NOT NULL AND ${OCM_E_PROPRIOS_LIGADOS})`;

// Uma consulta só, para a resposta sair de um único retrato da base. $1-$4 janela, $5-$9 filtros, $10 lado da célula
// em graus (null = sem agrupamento), $11 trazer os lugares de origem google, $12 só saber se existem.
const SQL_MAPA = `
WITH base AS MATERIALIZED (
  SELECT e.id, e.origem, e.nome, e.lat, e.lng, e.provedor, e.licenca, e.data_fonte, e.situacao, e.funcionamento, e.data_observacao,
         v.vigente AS verificado,
         CASE WHEN v.vigente THEN coalesce(e.conectores_observados, e.conectores) ELSE e.conectores END AS conectores,
         CASE WHEN v.vigente THEN coalesce(e.acesso, e.acesso_fonte) ELSE e.acesso_fonte END AS acesso,
         CASE WHEN v.vigente THEN coalesce(e.preco_observado, e.preco) ELSE e.preco END AS preco
  FROM eletroposto e,
       LATERAL (SELECT e.verificado AND (SELECT ligada FROM fonte WHERE nome = 'propria') AS vigente) v
  WHERE e.origem <> 'google' AND e.local::geometry && ST_MakeEnvelope($1, $2, $3, $4, 4326) AND ${OCM_E_PROPRIOS_LIGADOS}
),
com_filtros AS MATERIALIZED (
  SELECT b.*, x.tipos, x.potencia_max_kw,
         ($5::text[] IS NULL OR x.tipos && $5::text[]) AS ok_conector,
         ($6::numeric IS NULL OR coalesce(x.potencia_max_kw >= $6::numeric, false)) AS ok_potencia,
         (NOT $7::boolean OR x.tipos && '{${TIPOS_RAPIDA.join(',')}}'::text[]) AS ok_rapida,
         (NOT $8::boolean OR coalesce(b.acesso = 'publico', false)) AS ok_publico,
         (NOT $9::boolean OR coalesce(b.preco ~* '${GRATUITO}', false)) AS ok_gratuito
  FROM base b,
       LATERAL (SELECT ARRAY(SELECT DISTINCT c->>'tipo' FROM jsonb_array_elements(b.conectores) c ORDER BY 1) AS tipos,
                       (SELECT max((c->>'potencia_kw')::numeric) FROM jsonb_array_elements(b.conectores) c) AS potencia_max_kw) x
),
visiveis AS (
  SELECT * FROM com_filtros WHERE ok_conector AND ok_potencia AND ok_rapida AND ok_publico AND ok_gratuito
),
celulas AS (
  SELECT floor(lng / $10::float8) AS cx, floor(lat / $10::float8) AS cy, count(*)::int AS quantidade,
         round(avg(lat)::numeric, 6)::float8 AS lat, round(avg(lng)::numeric, 6)::float8 AS lng,
         min(lng) AS oeste, min(lat) AS sul, max(lng) AS leste, max(lat) AS norte
  FROM visiveis WHERE $10::float8 IS NOT NULL GROUP BY 1, 2
),
lugares AS NOT MATERIALIZED (
  SELECT id, lat, lng, data_fonte FROM eletroposto
  WHERE local::geometry && ST_MakeEnvelope($1, $2, $3, $4, 4326) AND ${LUGARES_GOOGLE_ENTREGAVEIS}
)
SELECT
  (SELECT row_to_json(o) FROM (
     SELECT count(*) FILTER (WHERE NOT (ok_conector AND ok_potencia AND ok_rapida AND ok_publico AND ok_gratuito))::int AS total,
            count(*) FILTER (WHERE NOT ok_conector)::int AS conector, count(*) FILTER (WHERE NOT ok_potencia)::int AS potencia,
            count(*) FILTER (WHERE NOT ok_rapida)::int AS rapida, count(*) FILTER (WHERE NOT ok_publico)::int AS publico,
            count(*) FILTER (WHERE NOT ok_gratuito)::int AS gratuito
     FROM com_filtros) o) AS ocultos,
  (SELECT coalesce(json_agg(c ORDER BY c.cy, c.cx), '[]') FROM celulas c WHERE c.quantidade > 1) AS grupos,
  (SELECT coalesce(json_agg(v ORDER BY v.id), '[]') FROM (
     SELECT id, origem, nome, lat, lng, provedor, licenca, data_fonte, situacao, funcionamento, data_observacao, verificado, tipos, potencia_max_kw
     FROM visiveis vi
     WHERE $10::float8 IS NULL
        OR EXISTS (SELECT 1 FROM celulas c WHERE c.quantidade = 1 AND c.cx = floor(vi.lng / $10::float8) AND c.cy = floor(vi.lat / $10::float8))) v
  ) AS pinos,
  CASE WHEN $11::boolean THEN (SELECT coalesce(json_agg(l ORDER BY l.id), '[]') FROM lugares l) END AS lugares,
  CASE WHEN $12::boolean THEN EXISTS (SELECT 1 FROM lugares) END AS ha_lugares_ocultos,
  EXISTS (SELECT 1 FROM corredor_verificado WHERE ST_Intersects(area, ST_MakeEnvelope($1, $2, $3, $4, 4326))) AS corredor_verificado,
  (SELECT json_object_agg(nome, ligada) FROM fonte) AS fontes_ligadas`;

const coordenada = (lat: number, lng: number) => ({ lat: +lat.toFixed(6), lng: +lng.toFixed(6) });

const pinoDaBase = (e) => ({
  id: e.id,
  localizacao: coordenada(e.lat, e.lng),
  nome: e.nome,
  situacao: (e.verificado && SITUACAO_POR_FUNCIONAMENTO[e.funcionamento]) || e.situacao,
  conectores: e.tipos,
  potencia_max_kw: e.potencia_max_kw,
  origem: e.origem,
  // Só observação em campo torna o posto verificado (RN13 da obtenção), e ela vale como a informação mais confiável.
  verificacao: e.verificado ? { situacao: 'verificado', data: e.data_observacao } : NAO_VERIFICADO,
  atualizado_em: e.verificado ? e.data_observacao : diaEmBrasilia(e.data_fonte),
  condicoes_de_uso: condicoesDeUso(e.origem, e.provedor, e.licenca),
});

// Do Google, a base só tem identificador e coordenada (RN06). O resto vem na ficha, buscada na hora.
const pinoDoGoogle = (g) => ({
  id: g.id,
  localizacao: coordenada(g.lat, g.lng),
  nome: null,
  situacao: 'desconhecida',
  conectores: null,
  potencia_max_kw: null,
  origem: 'google',
  verificacao: NAO_VERIFICADO,
  atualizado_em: diaEmBrasilia(g.data_fonte),
  condicoes_de_uso: condicoesDeUso('google'),
});

@ApiTags('mapa')
@UseFilters(ErrosV1)
@Controller('v1/mapa')
export class MapaController {
  constructor(
    private db: Db,
    private acesso: Acesso,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Postos da janela visível do mapa',
    description:
      `Lê só a base do REVOLT: nenhuma fonte externa é consultada. Abaixo do zoom ${ZOOM_ALTO}, os postos do OCM e próprios ` +
      `são agrupados por uma grade de ${CELULAS_POR_BLOCO}x${CELULAS_POR_BLOCO} células por bloco de 256 px; célula com um posto ` +
      `só vira pino. A partir do zoom ${ZOOM_ALTO}, tudo vem um a um e os lugares de origem google aparecem, desde que nenhum ` +
      `filtro esteja ativo e o pedido traga o atestado do app. A janela pode ter no máximo ${BLOCOS_MAX} blocos de lado no zoom pedido.`,
  })
  @ApiHeader({ name: 'X-Atestado-App', required: false, description: 'Token do atestado do app (D-09). Sem ele, a resposta não traz dados do Google.' })
  @ApiOkResponse({ type: RespostaMapa })
  @ApiBadRequestResponse({ type: Erro })
  async mapa(@Query() q: PedidoMapa, @Req() req) {
    // Nos zooms baixos a janela do mapa pode passar dos limites do mundo: recorta em vez de recusar.
    const recorte = (v: number, limite: number) => Math.max(-limite, Math.min(limite, v));
    const [oeste, sul, leste, norte] = [recorte(q.bbox[0], 180), recorte(q.bbox[1], 90), recorte(q.bbox[2], 180), recorte(q.bbox[3], 90)];
    if (oeste >= leste || sul >= norte) throw new BadRequestException('bbox precisa ser oeste,sul,leste,norte, com oeste < leste e sul < norte');
    const bloco = 360 / 2 ** q.zoom;
    if (leste - oeste > BLOCOS_MAX * bloco + 1e-9 || norte - sul > BLOCOS_MAX * bloco + 1e-9)
      throw new BadRequestException(`janela grande demais para o zoom ${q.zoom}: no máximo ${+(BLOCOS_MAX * bloco).toFixed(6)} graus de lado`);

    const zoomAlto = q.zoom >= ZOOM_ALTO;
    const filtroAtivo = !!(q.conectores?.length || q.potencia_min || q.rapida || q.publico || q.gratuito);
    const atestado = await this.acesso.appAtestado(req);
    const mostrarGoogle = atestado && zoomAlto && !filtroAtivo;

    const [r] = await this.db.query(SQL_MAPA, [
      oeste, sul, leste, norte,
      q.conectores?.length ? q.conectores : null, q.potencia_min ?? null, !!q.rapida, !!q.publico, !!q.gratuito,
      zoomAlto ? null : bloco / CELULAS_POR_BLOCO,
      mostrarGoogle,
      atestado && !mostrarGoogle,
    ]);

    const pinos = [...r.pinos.map(pinoDaBase), ...(r.lugares ?? []).map(pinoDoGoogle)];
    const grupos = r.grupos.map((c) => ({ localizacao: { lat: c.lat, lng: c.lng }, quantidade: c.quantidade, bbox: [c.oeste, c.sul, c.leste, c.norte] }));
    // Lugares de origem google escondidos: só um aviso, nunca uma contagem (RN08 do app, RN18 da obtenção).
    const semContagem = r.ha_lugares_ocultos ? { ha_ocultos: true, motivo: filtroAtivo ? 'filtro' : 'zoom' } : { ha_ocultos: false, motivo: null };
    const { total, ...por_motivo } = r.ocultos;
    const ligadas = r.fontes_ligadas;
    const fontes = [
      { origem: 'open_charge_map', situacao: ligadas.ocm ? 'ligada' : 'desligada' },
      { origem: 'verificacao_propria', situacao: ligadas.propria ? 'ligada' : 'desligada' },
      { origem: 'google', situacao: !ligadas.google ? 'desligada' : atestado ? 'ligada' : 'nao_autorizada' },
    ];

    // O mapa nunca fica vazio sem explicação (RN03 do app).
    let mapa_vazio = null;
    if (!pinos.length && !grupos.length) {
      if (total > 0 || semContagem.motivo === 'filtro') mapa_vazio = 'filtro_ativo';
      else if (semContagem.motivo === 'zoom') mapa_vazio = 'zoom_insuficiente';
      else if (fontes.some((f) => f.situacao === 'desligada')) mapa_vazio = 'fonte_indisponivel';
      else if (!r.corredor_verificado) mapa_vazio = 'fora_do_corredor';
      else mapa_vazio = 'nenhum_posto_conhecido';
    }

    return {
      janela: { bbox: [oeste, sul, leste, norte], zoom: q.zoom },
      pinos,
      grupos,
      ocultos: { total, por_motivo, sem_contagem: semContagem },
      mapa_vazio,
      corredor_verificado: r.corredor_verificado,
      fontes,
    };
  }
}
