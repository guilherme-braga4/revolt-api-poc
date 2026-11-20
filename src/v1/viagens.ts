// POST /v1/viagens/planejar: paradas e plano B de uma viagem, com os lugares do Google ao longo da mesma rota (fluxo core).
// UC04, RF06 (planejar), RF07 (link), RN10 e RN11 do app; UC10, RF21, RN15, RN21 e RN22 da obtenção; D-06, D-07 e D-09 da
// arquitetura. Uma rota do Google por viagem serve às paradas, à busca do Google e à linha no mapa. Nada da viagem é guardado.
import { Body, Controller, HttpCode, HttpException, Post, Req, UnauthorizedException, UseFilters } from '@nestjs/common';
import {
  ApiBadRequestResponse, ApiHeader, ApiOkResponse, ApiOperation, ApiResponse, ApiServiceUnavailableResponse, ApiTags, ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Db } from '../db.js';
import { GoogleService } from '../google.js';
import { condicoesDeUso } from '../vocabulario.js';
import { Acesso, ErrosV1 } from './acesso.js';
import { Erro, PedidoPlanejarViagem, type Pino, RespostaPlanejarViagem } from './contrato.js';
import { POSTOS_ENTREGUES, TIPOS_E_POTENCIA, pinoDaBase, pinoDoGoogle } from './mapa.js';
import { type Coordenada, type Posto, type PostoNaRota, decodificarLinha, linkGoogleMaps, planejarParadas } from './planejador.js';

// Postos a até 5 km da linha da rota entram como candidatos a parada e a plano B.
const DESVIO_MAX_M = 5000;

// Candidatos ao longo da linha. As contas de posição são feitas na projeção policônica do Brasil (SIRGAS 2000, EPSG:5880),
// em metros, sobre a linha simplificada a 20 m; o comprimento total vem da linha original, medido no elipsoide. Só postos
// de OCM e próprios entram (RN10): os lugares do Google não são lidos. $1 linha em GeoJSON, $2 desvio máximo em metros.
const SQL_CANDIDATOS = `
WITH linha AS MATERIALIZED (
  SELECT plana, comprimento_m, ST_Transform(ST_Buffer(plana, $2), 4326) AS faixa
  FROM (SELECT ST_Simplify(ST_Transform(g, 5880), 20) AS plana, ST_Length(g::geography) AS comprimento_m
        FROM (SELECT ST_SetSRID(ST_GeomFromGeoJSON($1), 4326) AS g) entrada) l
),
b AS MATERIALIZED (
  ${POSTOS_ENTREGUES} AND ST_Intersects(e.local::geometry, (SELECT faixa FROM linha))
)
SELECT (SELECT comprimento_m FROM linha) / 1000 AS distancia_km,
       (SELECT coalesce(json_agg(c ORDER BY c.km, c.id), '[]') FROM (
          SELECT b.id, b.origem, b.nome, b.lat, b.lng, b.provedor, b.licenca, b.data_fonte, b.situacao, b.funcionamento,
                 b.data_observacao, b.verificado, x.tipos, x.potencia_max_kw,
                 ST_LineLocatePoint(l.plana, p.ponto) * l.comprimento_m / 1000 AS km,
                 ST_Distance(l.plana, p.ponto) / 1000 AS desvio_km
          FROM b, linha l, ${TIPOS_E_POTENCIA},
               LATERAL (SELECT ST_Transform(ST_SetSRID(ST_MakePoint(b.lng, b.lat), 4326), 5880) AS ponto) p) c
       ) AS candidatos`;

const MENSAGENS_ROTA = {
  teto_atingido: 'O teto mensal de gasto com o Google foi atingido, e sem a rota do Google não há como sugerir paradas. Abra o destino no Google Maps.',
  desligada: 'O Google está desligado pelo Curador, e sem a rota do Google não há como sugerir paradas. Abra o destino no Google Maps.',
  fora_do_ar: 'O Google não respondeu, e sem a rota não há como sugerir paradas. Tente de novo mais tarde ou abra o destino no Google Maps.',
  sem_chave: 'A consulta de rotas não está configurada, e sem a rota não há como sugerir paradas. Abra o destino no Google Maps.',
  erro_da_fonte: 'O Google recusou o pedido de rota, e sem a rota não há como sugerir paradas. Abra o destino no Google Maps.',
  sem_rota: 'O Google não encontrou rota de carro entre a origem e o destino.',
};
const MENSAGENS_LUGARES = {
  teto_atingido: 'O teto mensal de gasto com o Google foi atingido: a viagem segue só com postos do Open Charge Map e próprios.',
  desligada: 'Os lugares do Google estão desligados pelo Curador: a viagem segue sem eles.',
  fora_do_ar: 'O Google não respondeu: a viagem segue sem os lugares do Google. Tente de novo mais tarde.',
  sem_chave: 'A consulta ao Google não está configurada: a viagem segue sem os lugares do Google.',
  erro_da_fonte: 'O Google recusou a consulta: a viagem segue sem os lugares do Google.',
  sem_rota: 'Sem rota entre a origem e o destino, não há lugares do Google ao longo dela.',
};

const umaCasa = (n: number) => Math.round(n * 10) / 10;
const naRota = <T extends Posto>(c: PostoNaRota<T>) => ({ km_na_rota: umaCasa(c.km), desvio_km: umaCasa(c.desvio_km), eletroposto: c.posto });

@ApiTags('viagens')
@UseFilters(ErrosV1)
@Controller('v1/viagens')
export class ViagensController {
  constructor(
    private db: Db,
    private google: GoogleService,
    private acesso: Acesso,
  ) {}

  @Post('planejar')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Planejar uma viagem: paradas, plano B, trechos sem cobertura e lugares do Google na rota',
    description:
      'Pede ao Google uma rota entre origem e destino (Compute Routes Essentials) e escolhe, sobre a linha dela, paradas entre os ' +
      `postos do OCM e próprios compatíveis com o carro a até ${DESVIO_MAX_M / 1000} km da linha (RN10), cada uma com um plano B ao ` +
      'alcance ou o aviso de que não há (RN11), e marca os trechos sem posto compatível ao alcance (UC04). Na mesma rota, faz a ' +
      'busca do Google ao longo dela (Text Search Pro, id e coordenada) e entrega os lugares separados das paradas. As duas ' +
      'consultas são pagas e conferidas uma a uma no teto do mês: primeiro a rota, depois a busca. Sem a rota (teto atingido, ' +
      'Google desligado ou fora do ar), não há paradas: 200 com disponivel false, motivo rota_indisponivel e link_externo para ' +
      'abrir só o destino no Google Maps. Sem a busca, a viagem segue só com OCM e próprios. Nada é guardado além do ' +
      'identificador de cada lugar do Google, que permite pedir a ficha depois.',
  })
  @ApiHeader({ name: 'X-Atestado-App', required: true, description: 'Token do atestado do app (D-09).' })
  @ApiHeader({ name: 'X-Aparelho', required: false, description: 'Identificador do aparelho, gerado pelo app, para a trava contra ritmo de robô.' })
  @ApiOkResponse({ type: RespostaPlanejarViagem })
  @ApiBadRequestResponse({ type: Erro, description: 'Origem, destino, conectores ou autonomia ausentes ou fora dos limites.' })
  @ApiUnauthorizedResponse({ type: Erro, description: 'Pedido sem atestado do app (erro atestado_invalido). O Google não é consultado.' })
  @ApiResponse({ status: 429, type: Erro, description: 'Ritmo de robô: muitas viagens pelo mesmo aparelho (erro ritmo_de_robo). O Google não é consultado.' })
  @ApiServiceUnavailableResponse({ type: Erro, description: 'Base de dados fora do ar (erro base_indisponivel). Sem conferir o teto, o Google não é consultado.' })
  async planejar(@Body() pedido: PedidoPlanejarViagem, @Req() req): Promise<RespostaPlanejarViagem> {
    // Cada viagem gera consultas pagas ao Google: só o app do REVOLT pede (RN18 da obtenção, D-09).
    if (!(await this.acesso.appAtestado(req)))
      throw new UnauthorizedException({ erro: 'atestado_invalido', mensagem: 'Pedido sem atestado do app: o planejamento de viagem só atende o app do REVOLT.' });
    if (!this.acesso.dentroDoRitmo(req, 'rotas'))
      throw new HttpException({ erro: 'ritmo_de_robo', mensagem: 'Muitas viagens planejadas em pouco tempo neste aparelho. Tente de novo em alguns minutos.' }, 429);

    const { origem, destino } = pedido;
    const r = await this.google.rota(origem, destino);
    let pontos: Coordenada[];
    try {
      pontos = r.rota ? decodificarLinha(r.rota.linha) : [];
    } catch {
      pontos = []; // linha malformada: o Google respondeu algo que não é rota
    }
    if (pontos.length < 2) {
      const motivo = r.motivo ?? 'erro_da_fonte';
      return {
        disponivel: false,
        motivo: motivo === 'sem_rota' ? 'sem_rota' : 'rota_indisponivel',
        causa: motivo === 'sem_rota' ? null : motivo,
        mensagem: MENSAGENS_ROTA[motivo],
        rota: null,
        paradas: [],
        trechos_sem_cobertura: [],
        eletropostos_google: { disponivel: false, motivo, mensagem: MENSAGENS_LUGARES[motivo], eletropostos: [] },
        link_externo: linkGoogleMaps(destino),
      };
    }

    const linhaGeoJson = JSON.stringify({ type: 'LineString', coordinates: pontos.map((p) => [p.lng, p.lat]) });
    const [[base], lugares] = await Promise.all([this.db.query(SQL_CANDIDATOS, [linhaGeoJson, DESVIO_MAX_M]), this.google.lugaresAoLongoDaRota(r.rota.linha)]);
    const candidatos: PostoNaRota<Pino>[] = base.candidatos.map((c) => ({ posto: pinoDaBase(c), km: c.km, desvio_km: c.desvio_km }));
    const plano = planejarParadas({
      candidatos,
      distancia_km: base.distancia_km,
      autonomia_km: pedido.autonomia_km,
      conectores: pedido.conectores,
      origem,
      destino,
    });

    const agora = new Date();
    return {
      disponivel: true,
      motivo: null,
      causa: null,
      mensagem: null,
      rota: { ...r.rota, origem: 'google', condicoes_de_uso: condicoesDeUso('google') },
      paradas: plano.paradas.map((p, i) => ({
        ordem: i + 1,
        ...naRota(p.parada),
        plano_b: p.plano_b ? naRota(p.plano_b) : null,
        aviso: p.plano_b ? null : 'sem_plano_b',
      })),
      trechos_sem_cobertura: plano.trechos_sem_cobertura.map((t) => ({
        de_km: umaCasa(t.de_km),
        ate_km: umaCasa(t.ate_km),
        distancia_km: umaCasa(t.distancia_km),
        inicio: t.inicio,
        fim: t.fim,
      })),
      eletropostos_google: {
        disponivel: !lugares.motivo,
        motivo: lugares.motivo ?? null,
        mensagem: lugares.motivo ? MENSAGENS_LUGARES[lugares.motivo] : null,
        eletropostos: (lugares.lugares ?? []).map((l) => pinoDoGoogle({ id: `google-${l.id}`, lat: l.lat, lng: l.lng, data_fonte: agora })),
      },
      link_externo: linkGoogleMaps(destino, origem, plano.paradas.map((p) => p.parada.posto.localizacao)),
    };
  }
}
