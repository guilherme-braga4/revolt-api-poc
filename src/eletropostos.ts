import { Controller, Get, NotFoundException, Param, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsLatitude, IsLongitude, IsNumber, Max, Min } from 'class-validator';
import { Db } from './db.js';
import { CONDICOES_GOOGLE, GoogleService, LICENCA_GOOGLE } from './google.js';
import { condicoesOcm } from './ocm.js';

// Vocabulário do REVOLT. O App só vê estes valores, nunca os nomes de campo das fontes.
export const TIPOS_CONECTOR = ['CCS2', 'CCS1', 'TIPO_2', 'TIPO_1', 'CHADEMO', 'GBT', 'TESLA', 'TOMADA', 'OUTRO', 'DESCONHECIDO'];
export const LICENCA_PROPRIA = 'Própria (REVOLT)';
export const CONDICOES_PROPRIA = 'Dado próprio do REVOLT, observado em campo pelo Curador.';

// Tradução da ficha do Google para o domínio. A ficha é traduzida na hora e nunca gravada (RN08).
const TIPO_GOOGLE = {
  EV_CONNECTOR_TYPE_CCS_COMBO_2: 'CCS2',
  EV_CONNECTOR_TYPE_CCS_COMBO_1: 'CCS1',
  EV_CONNECTOR_TYPE_TYPE_2: 'TIPO_2',
  EV_CONNECTOR_TYPE_J1772: 'TIPO_1',
  EV_CONNECTOR_TYPE_CHADEMO: 'CHADEMO',
  EV_CONNECTOR_TYPE_UNSPECIFIED_GB_T: 'GBT',
  EV_CONNECTOR_TYPE_TESLA: 'TESLA',
  EV_CONNECTOR_TYPE_NACS: 'TESLA',
  EV_CONNECTOR_TYPE_UNSPECIFIED_WALL_OUTLET: 'TOMADA',
  EV_CONNECTOR_TYPE_OTHER: 'OUTRO',
};
const SITUACAO_GOOGLE = { OPERATIONAL: 'operacional', CLOSED_TEMPORARILY: 'fora_de_operacao', CLOSED_PERMANENTLY: 'fechado_definitivamente' };
const PAGAMENTO_GOOGLE = { acceptsCreditCards: 'cartao_credito', acceptsDebitCards: 'cartao_debito', acceptsNfc: 'nfc', acceptsCashOnly: 'somente_dinheiro' };

const NAO_VERIFICADO = { situacao: 'nao_verificado' };
const fonteGoogle = (data: string) => ({ origem: 'google', provedor: null, licenca: LICENCA_GOOGLE, condicoes_uso: CONDICOES_GOOGLE, data });
const conector = (c) => ({ tipo: c.tipo, potencia_kw: c.potencia_kw ?? null, quantidade: c.quantidade ?? null, disponiveis: c.disponiveis ?? null });

// Linha da view eletroposto (OCM ou registro próprio) → eletroposto do domínio.
function daBase(e, propriaLigada: boolean) {
  return {
    id: e.id,
    nome: e.nome,
    endereco: e.endereco,
    localizacao: { lat: e.lat, lng: e.lng },
    situacao: e.situacao,
    conectores: e.conectores.map(conector),
    preco: e.preco,
    horario: null,
    pagamento: null,
    fonte:
      e.origem === 'open_charge_map'
        ? { origem: e.origem, provedor: e.provedor, licenca: e.licenca, condicoes_uso: condicoesOcm(e.provedor, e.licenca), data: e.data_fonte }
        : { origem: e.origem, provedor: null, licenca: LICENCA_PROPRIA, condicoes_uso: CONDICOES_PROPRIA, data: e.data_fonte },
    // Só observação própria torna o posto verificado (RN13). Ela vem num bloco à parte, com a sua origem.
    verificacao:
      e.verificado && propriaLigada
        ? {
            situacao: 'verificado',
            origem: 'verificacao_propria',
            licenca: LICENCA_PROPRIA,
            condicoes_uso: CONDICOES_PROPRIA,
            data: e.data_observacao,
            autor: e.autor,
            funcionamento: e.funcionamento,
            conectores: e.conectores_observados?.map(conector) ?? null,
            preco: e.preco_observado,
            regras_cobranca: e.regras_cobranca,
            taxa_ociosidade: e.taxa_ociosidade,
            pre_autorizacao: e.pre_autorizacao,
            app_exigido: e.app_exigido,
            pagamento_sem_app: e.pagamento_sem_app,
            acesso: e.acesso,
            lugar_google: e.google_place_id ? `google-${e.google_place_id}` : null,
          }
        : NAO_VERIFICADO,
  };
}

// Lugar do Google na lista: só o que pode ser guardado (identificador e coordenada). O resto vem no detalhe.
const daListaGoogle = (g) => ({
  id: g.id,
  nome: null,
  endereco: null,
  localizacao: { lat: g.lat, lng: g.lng },
  situacao: 'desconhecida',
  conectores: null,
  preco: null,
  horario: null,
  pagamento: null,
  fonte: fonteGoogle(g.data_fonte),
  verificacao: NAO_VERIFICADO,
});

const daFichaGoogle = (f) => ({
  id: `google-${f.id}`,
  nome: f.displayName?.text ?? null,
  endereco: f.formattedAddress ?? null,
  localizacao: { lat: f.location.latitude, lng: f.location.longitude },
  situacao: SITUACAO_GOOGLE[f.businessStatus] ?? 'desconhecida',
  conectores: (f.evChargeOptions?.connectorAggregation ?? []).map((g) =>
    conector({ tipo: TIPO_GOOGLE[g.type] ?? 'DESCONHECIDO', potencia_kw: g.maxChargeRateKw, quantidade: g.count, disponiveis: g.availableCount }),
  ),
  preco: null,
  horario: f.currentOpeningHours?.weekdayDescriptions ?? null,
  pagamento: f.paymentOptions ? Object.keys(PAGAMENTO_GOOGLE).filter((k) => f.paymentOptions[k]).map((k) => PAGAMENTO_GOOGLE[k]) : null,
  fonte: fonteGoogle(new Date().toISOString()),
  verificacao: NAO_VERIFICADO,
});

class Area {
  @Type(() => Number) @IsLatitude() lat: number;
  @Type(() => Number) @IsLongitude() lng: number;
  // Até 3.000 km: um círculo no centro do Brasil cobre o país inteiro (visão do país no App).
  @Type(() => Number) @IsNumber() @Min(0.1) @Max(3000) raio_km: number;
}

// Respeita as fontes e os provedores desligados pelo Curador (RF10).
const FONTES_LIGADAS = `(
  (origem = 'open_charge_map' AND (SELECT ligada FROM fonte WHERE nome = 'ocm')
     AND provedor_id NOT IN (SELECT provedor_id FROM ocm_provedor WHERE NOT ligado))
  OR (origem = 'verificacao_propria' AND (SELECT ligada FROM fonte WHERE nome = 'propria'))
  OR (origem = 'google' AND (SELECT ligada FROM fonte WHERE nome = 'google')))`;

// O que o App chama. Fala só o vocabulário do REVOLT; origem, licença e condições de uso vão no bloco "fonte".
@Controller('eletropostos')
export class EletropostosController {
  constructor(
    private db: Db,
    private google: GoogleService,
  ) {}

  // RF03: eletropostos de uma área, lidos só da base: a cópia do OCM, os registros próprios e os lugares do Google
  // trazidos pela varredura. Nenhuma fonte externa é consultada na hora do pedido.
  @Get()
  async area(@Query() q: Area) {
    const ligadas = Object.fromEntries((await this.db.query('SELECT nome, ligada FROM fonte')).map((f) => [f.nome, f.ligada]));
    const area = [q.lng, q.lat, q.raio_km * 1000];
    const naArea = `ST_DWithin(local, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography, $3)`;

    // Tudo vem da view eletroposto. Lugar do Google vinculado a um item entregue sai da lista (RN12), e o que duplica
    // um posto do OCM entregue também (duplicado_do_ocm, calculado na view).
    const linhas = await this.db.query(
      `SELECT * FROM eletroposto
       WHERE ${naArea} AND ${FONTES_LIGADAS}
         AND (origem <> 'google' OR google_place_id NOT IN (
               SELECT google_place_id FROM eletroposto WHERE origem <> 'google' AND google_place_id IS NOT NULL AND ${FONTES_LIGADAS}))`,
      area,
    );
    const base = linhas.filter((e) => e.origem !== 'google');
    const google = linhas.filter((e) => e.origem === 'google');
    const googleNovos = google.filter((g) => !g.duplicado_do_ocm);

    return {
      area: q,
      fontes: {
        open_charge_map: { ligada: ligadas.ocm, itens: base.filter((e) => e.origem === 'open_charge_map').length },
        verificacao_propria: { ligada: ligadas.propria, itens: base.filter((e) => e.origem === 'verificacao_propria').length },
        google: { ligada: ligadas.google, itens: googleNovos.length, duplicados_do_ocm: google.length - googleNovos.length },
      },
      eletropostos: [...base.map((e) => daBase(e, ligadas.propria)), ...googleNovos.map(daListaGoogle)],
    };
  }

  // Detalhe de um eletroposto. Para o Google, a ficha vem na hora, é traduzida e descartada (RF05).
  @Get(':id')
  async detalhe(@Param('id') id: string) {
    if (id.startsWith('google-')) return daFichaGoogle(await this.google.ficha(id.slice('google-'.length)));
    const [e] = await this.db.query(`SELECT * FROM eletroposto WHERE id = $1 AND ${FONTES_LIGADAS}`, [id]);
    if (!e) throw new NotFoundException('eletroposto não encontrado');
    return daBase(e, await this.db.fonteLigada('propria'));
  }
}
