// GET /v1/eletropostos/:id: a ficha de um posto (fluxo core). UC02, RF04, RF05, RN01, RN02, RN06 e RN20 do app;
// UC03, RN08 e RN15 da obtenção; D-09 da arquitetura.
import { BadRequestException, Controller, Get, HttpException, NotFoundException, Param, Req, UnauthorizedException, UseFilters } from '@nestjs/common';
import {
  ApiBadRequestResponse, ApiHeader, ApiNotFoundResponse, ApiOkResponse, ApiOperation, ApiParam, ApiResponse, ApiTags, ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Db } from '../db.js';
import { GoogleService } from '../google.js';
import { NAO_VERIFICADO, SITUACAO_POR_FUNCIONAMENTO, condicoesDeUso, diaEmBrasilia } from '../vocabulario.js';
import { Acesso, ErrosV1 } from './acesso.js';
import { Erro, Ficha, FichaIndisponivel } from './contrato.js';
import { OCM_E_PROPRIOS_LIGADOS } from './mapa.js';

const NAO_INFORMADO = { valor: null, origem: null, data: null };
const conector = (c) => ({ tipo: c.tipo, potencia_kw: c.potencia_kw ?? null, quantidade: c.quantidade ?? null });

// Ficha de um posto do OCM ou próprio: cada atributo vem da verificação em campo vigente, se ela informou; senão, da
// fonte do registro. Sempre com origem e data (RF04 do app).
function fichaDaBase(e) {
  // Com a fonte própria desligada, a verificação não vale (RF10 da obtenção).
  const verificacao = e.verificado && e.propria_ligada ? { origem: 'verificacao_propria', data: e.data_observacao } : null;
  const fonte = { origem: e.origem, data: e.origem === 'verificacao_propria' ? e.data_observacao : diaEmBrasilia(e.data_fonte) };
  const de = (observado, daFonte) =>
    verificacao && observado != null ? { valor: observado, ...verificacao } : daFonte != null ? { valor: daFonte, ...fonte } : NAO_INFORMADO;
  const acesso = (tipo) => (tipo ? { tipo, restricao: null } : null);

  return {
    id: e.id,
    localizacao: { lat: e.lat, lng: e.lng },
    origem: e.origem,
    verificacao: verificacao ? { situacao: 'verificado', data: e.data_observacao } : NAO_VERIFICADO,
    atualizado_em: verificacao ? e.data_observacao : fonte.data,
    condicoes_de_uso: condicoesDeUso(e.origem, e.provedor, e.licenca),
    atributos: {
      nome: de(null, e.nome),
      endereco: de(null, e.endereco),
      situacao: de(SITUACAO_POR_FUNCIONAMENTO[e.funcionamento], e.situacao),
      conectores: de(e.conectores_observados?.map(conector), e.conectores?.length ? e.conectores.map(conector) : null),
      funcionamento: de(e.funcionamento, null),
      carregadores: NAO_INFORMADO, // a verificação em campo ainda não registra cada carregador (RF07 da obtenção)
      preco: de(e.preco_observado, e.preco),
      regras_cobranca: de(e.regras_cobranca, null),
      taxa_ociosidade: de(e.taxa_ociosidade, null),
      pre_autorizacao: de(e.pre_autorizacao, null),
      app_exigido: de(e.app_exigido, null),
      pagamento_sem_app: de(e.pagamento_sem_app, null),
      acesso: de(acesso(e.acesso), acesso(e.acesso_fonte)),
      horario: NAO_INFORMADO,
      pagamento: NAO_INFORMADO,
      disponibilidade: NAO_INFORMADO, // nenhuma fonte aberta informa disponibilidade
    },
    // Lugar do Google que o Curador confirmou ser este posto (RN17 da obtenção). Só o identificador, nenhum campo do Google.
    lugar_vinculado: e.propria_ligada && e.google_place_id ? `google-${e.google_place_id}` : null,
    link_externo: null,
  };
}

// Tradução da ficha do Google para o vocabulário do REVOLT. A ficha é traduzida na hora e nunca gravada (RN08).
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

// Link público do Google Maps pelo identificador do lugar: abrir não gera consulta paga do REVOLT (RN20 do app).
const linkPublico = (placeId: string) =>
  `https://www.google.com/maps/search/?api=1&query=eletroposto&query_place_id=${encodeURIComponent(placeId)}`;

function fichaDoGoogle(placeId: string, f) {
  const hoje = { origem: 'google', data: diaEmBrasilia(new Date()) };
  const de = (valor) => (valor == null ? NAO_INFORMADO : { valor, ...hoje });
  const grupos = f.evChargeOptions?.connectorAggregation ?? [];
  // Disponibilidade só com o horário da informação (RN02 do app).
  const comHorario = grupos.filter((g) => g.availabilityLastUpdateTime);
  const disponibilidade = comHorario.length
    ? {
        conectores: comHorario.map((g) => ({ tipo: TIPO_GOOGLE[g.type] ?? 'DESCONHECIDO', disponiveis: g.availableCount ?? null, fora_de_operacao: g.outOfServiceCount ?? null })),
        informada_em: comHorario.map((g) => g.availabilityLastUpdateTime).sort().at(-1),
      }
    : null;

  return {
    id: `google-${placeId}`,
    localizacao: { lat: f.location.latitude, lng: f.location.longitude },
    origem: 'google',
    verificacao: NAO_VERIFICADO,
    atualizado_em: hoje.data,
    condicoes_de_uso: condicoesDeUso('google'),
    atributos: {
      nome: de(f.displayName?.text),
      endereco: de(f.formattedAddress),
      situacao: de(SITUACAO_GOOGLE[f.businessStatus]),
      conectores: de(grupos.length ? grupos.map((g) => conector({ tipo: TIPO_GOOGLE[g.type] ?? 'DESCONHECIDO', potencia_kw: g.maxChargeRateKw, quantidade: g.count })) : null),
      funcionamento: NAO_INFORMADO,
      carregadores: NAO_INFORMADO,
      preco: NAO_INFORMADO,
      regras_cobranca: NAO_INFORMADO,
      taxa_ociosidade: NAO_INFORMADO,
      pre_autorizacao: NAO_INFORMADO,
      app_exigido: NAO_INFORMADO,
      pagamento_sem_app: NAO_INFORMADO,
      acesso: NAO_INFORMADO,
      horario: de(f.currentOpeningHours?.weekdayDescriptions),
      pagamento: de(f.paymentOptions ? Object.keys(PAGAMENTO_GOOGLE).filter((k) => f.paymentOptions[k]).map((k) => PAGAMENTO_GOOGLE[k]) : null),
      disponibilidade: de(disponibilidade),
    },
    lugar_vinculado: null,
    link_externo: f.googleMapsUri ?? linkPublico(placeId),
  };
}

const MENSAGENS = {
  teto_atingido: 'O teto mensal de gasto com o Google foi atingido. Abra o lugar no Google Maps.',
  desligada: 'Os dados do Google estão desligados pelo Curador. Abra o lugar no Google Maps.',
  fora_do_ar: 'O Google não respondeu. Tente de novo ou abra o lugar no Google Maps.',
  sem_chave: 'A consulta ao Google não está configurada. Abra o lugar no Google Maps.',
  erro_da_fonte: 'O Google recusou a consulta. Tente de novo ou abra o lugar no Google Maps.',
  lugar_nao_guardado: 'Lugar desconhecido.',
  lugar_inexistente_no_google: 'O Google informa que o lugar não existe mais.',
};

@ApiTags('ficha')
@UseFilters(ErrosV1)
@Controller('v1/eletropostos')
export class FichaController {
  constructor(
    private db: Db,
    private google: GoogleService,
    private acesso: Acesso,
  ) {}

  @Get(':id')
  @ApiOperation({
    summary: 'Ficha de um posto',
    description:
      'Postos do OCM e próprios vêm da base, com origem e data de cada atributo. Lugares de origem google: a ficha é buscada ' +
      'no Google na hora, entregue e descartada, e exige o atestado do app. Sem ficha (teto, Google fora do ar, camada ' +
      'desligada ou ritmo de robô), a resposta traz link_externo para abrir o lugar no Google Maps sem consulta paga.',
  })
  @ApiParam({ name: 'id', example: 'ocm-9001', description: 'ocm-<n>, propria-<n> ou google-<identificador>' })
  @ApiHeader({ name: 'X-Atestado-App', required: false, description: 'Token do atestado do app (D-09). Obrigatório para a ficha de origem google.' })
  @ApiHeader({ name: 'X-Aparelho', required: false, description: 'Identificador do aparelho, gerado pelo app, para a trava contra ritmo de robô.' })
  @ApiOkResponse({ type: Ficha })
  @ApiBadRequestResponse({ type: Erro })
  @ApiUnauthorizedResponse({ type: Erro, description: 'Ficha de origem google sem atestado do app.' })
  @ApiNotFoundResponse({ type: Erro })
  @ApiResponse({ status: 429, type: FichaIndisponivel, description: 'Ritmo de robô: muitas fichas do Google pelo mesmo aparelho.' })
  @ApiResponse({ status: 503, type: FichaIndisponivel, description: 'Ficha do Google indisponível: teto atingido, camada desligada ou Google fora do ar.' })
  async ficha(@Param('id') id: string, @Req() req) {
    if (id.startsWith('google-')) return this.fichaGoogle(id.slice('google-'.length), req);
    if (!/^(ocm|propria)-\d+$/.test(id)) throw new BadRequestException('id precisa ser ocm-<n>, propria-<n> ou google-<identificador>');

    const [e] = await this.db.query(
      `SELECT e.*, (SELECT ligada FROM fonte WHERE nome = 'propria') AS propria_ligada
       FROM eletroposto e WHERE e.id = $1 AND ${OCM_E_PROPRIOS_LIGADOS}`,
      [id],
    );
    if (!e) throw new NotFoundException('eletroposto não encontrado');
    return fichaDaBase(e);
  }

  private async fichaGoogle(placeId: string, req) {
    // Dados do Google só para o app do REVOLT (RN18 da obtenção, D-09).
    if (!(await this.acesso.appAtestado(req)))
      throw new UnauthorizedException({ erro: 'atestado_invalido', mensagem: 'Pedido sem atestado do app: a ficha do Google só vai para o app do REVOLT.' });
    if (!this.acesso.dentroDoRitmo(req))
      throw new HttpException({ erro: 'ritmo_de_robo', mensagem: 'Muitas fichas do Google em pouco tempo neste aparelho. Abra o lugar no Google Maps.', link_externo: linkPublico(placeId) }, 429);

    try {
      return fichaDoGoogle(placeId, await this.google.ficha(placeId));
    } catch (erro) {
      if (!(erro instanceof HttpException)) throw erro;
      const motivo = (erro.getResponse() as any).motivo;
      if (erro.getStatus() === 404) throw new NotFoundException({ erro: motivo, mensagem: MENSAGENS[motivo] });
      const codigo = erro.getStatus() === 502 ? 'erro_da_fonte' : motivo;
      throw new HttpException({ erro: codigo, mensagem: MENSAGENS[codigo], link_externo: linkPublico(placeId) }, 503);
    }
  }
}
