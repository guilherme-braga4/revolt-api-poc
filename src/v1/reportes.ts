// POST /v1/reportes e GET /v1/reportes/meus: reportar um problema no posto e acompanhar a resolução (no-core). UC06 e RF09 do app.
import { BadRequestException, Body, Controller, Get, NotFoundException, Post, Req, UseFilters, UseGuards } from '@nestjs/common';
import {
  ApiBadRequestResponse, ApiBearerAuth, ApiCreatedResponse, ApiForbiddenResponse, ApiNotFoundResponse, ApiOkResponse, ApiOperation, ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { randomUUID } from 'node:crypto';
import { Db } from '../db.js';
import { SQL_ELETROPOSTO_EXISTE } from '../observacoes.js';
import { ContaGuard, ContribuicaoGuard, ErrosV1 } from './acesso.js';
import { Erro, MeuReporte, PedidoReporte, ReporteRecebido } from './contrato.js';
import { caminhoDaFoto, recomprimir } from './fotos.js';

// O mesmo problema aberto recebe mais um envio, em vez de outro reporte. xmax = 0 diz que o reporte acabou de ser criado.
const SQL_REPORTE = `
WITH r AS (
  INSERT INTO reporte (eletroposto_id, tipo, outro_eletroposto_id) VALUES ($1, $2, $3)
  ON CONFLICT (eletroposto_id, tipo, (coalesce(outro_eletroposto_id, ''))) WHERE resolvido_em IS NULL DO UPDATE SET tipo = EXCLUDED.tipo
  RETURNING id, xmax = 0 AS novo
),
f AS (INSERT INTO foto (id, jpeg) SELECT $6::uuid, $7::bytea WHERE $6::uuid IS NOT NULL),
e AS (INSERT INTO reporte_envio (reporte_id, conta_id, detalhe, foto_id) SELECT id, $4::int, $5::text, $6::uuid FROM r)
SELECT r.id, r.novo, (SELECT count(*) FROM reporte_envio WHERE reporte_id = r.id)::int + 1 AS envios FROM r`;

@ApiTags('contribuicoes')
@UseFilters(ErrosV1)
@Controller('v1/reportes')
export class ReportesController {
  constructor(private db: Db) {}

  @Post()
  @UseGuards(ContribuicaoGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Reportar um problema no posto',
    description: 'Exige conta não bloqueada. Vai para a fila do Curador. O mesmo problema já aberto (posto, tipo e, no duplicado, o outro posto) recebe mais um envio, sem criar outro reporte.',
  })
  @ApiCreatedResponse({ type: ReporteRecebido })
  @ApiBadRequestResponse({ type: Erro })
  @ApiUnauthorizedResponse({ type: Erro, description: 'Sem conta (erro conta_necessaria).' })
  @ApiForbiddenResponse({ type: Erro, description: 'Conta bloqueada pelo Curador (erro conta_bloqueada).' })
  @ApiNotFoundResponse({ type: Erro, description: 'Posto desconhecido.' })
  async reportar(@Body() p: PedidoReporte, @Req() req): Promise<ReporteRecebido> {
    const outro = p.tipo === 'duplicado' ? p.outro_eletroposto_id : null;
    if (outro === p.eletroposto_id) throw new BadRequestException('o posto duplicado precisa ser outro posto');
    for (const id of [p.eletroposto_id, outro].filter(Boolean)) {
      const [{ existe }] = await this.db.query(SQL_ELETROPOSTO_EXISTE, [id]);
      if (!existe) throw new NotFoundException(`eletroposto não encontrado: ${id}`);
    }
    const jpeg = p.foto ? await recomprimir(p.foto) : null;
    const [r] = await this.db.query(SQL_REPORTE, [p.eletroposto_id, p.tipo, outro, req.conta.id, p.detalhe ?? null, jpeg ? randomUUID() : null, jpeg]);
    return { id: r.id, somado_a_aberto: !r.novo, envios: r.envios, situacao: 'aberto' };
  }

  @Get('meus')
  @UseGuards(ContaGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Meus reportes', description: 'Os últimos 100 envios da conta, com a situação e, depois de resolvido, a resolução do Curador.' })
  @ApiOkResponse({ type: [MeuReporte] })
  @ApiUnauthorizedResponse({ type: Erro })
  async meus(@Req() req): Promise<MeuReporte[]> {
    const linhas = await this.db.query(
      `SELECT r.id, r.eletroposto_id, r.tipo, r.outro_eletroposto_id, e.detalhe, e.foto_id, e.enviado_em, r.resolucao, r.resolvido_em
       FROM reporte_envio e JOIN reporte r ON r.id = e.reporte_id
       WHERE e.conta_id = $1 ORDER BY e.enviado_em DESC, e.id DESC LIMIT 100`,
      [req.conta.id],
    );
    return linhas.map(({ foto_id, enviado_em, resolvido_em, ...l }) => ({
      ...l,
      foto: caminhoDaFoto(foto_id),
      enviado_em: enviado_em.toISOString(),
      situacao: resolvido_em ? 'resolvido' : 'aberto',
      resolvido_em: resolvido_em?.toISOString() ?? null,
    }));
  }
}
