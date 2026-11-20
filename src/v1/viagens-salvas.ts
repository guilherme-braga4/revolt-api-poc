// GET, POST, PUT e DELETE /v1/viagens: viagens salvas com conta, para abrir em outro aparelho (UC04, RF06, RN21). No-core.
// Guarda só o que o motorista informou: nome, origem, destino, conectores e autonomia. Nada do Google: nem rota, nem paradas.
import { Body, Controller, Delete, Get, HttpCode, NotFoundException, Param, ParseIntPipe, Post, Put, Req, UseFilters, UseGuards } from '@nestjs/common';
import {
  ApiBadRequestResponse, ApiBearerAuth, ApiCreatedResponse, ApiNoContentResponse, ApiNotFoundResponse, ApiOkResponse, ApiOperation, ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Db } from '../db.js';
import { ContaGuard, ErrosV1 } from './acesso.js';
import { Erro, PedidoViagemSalva, ViagemSalva } from './contrato.js';

const COLUNAS = 'id, nome, origem, destino, conectores, autonomia_km::float8 AS autonomia_km, criada_em, atualizada_em';
const saida = (v): ViagemSalva => ({ ...v, criada_em: v.criada_em.toISOString(), atualizada_em: v.atualizada_em.toISOString() });
const valores = (p: PedidoViagemSalva) => [
  p.nome, { lat: p.origem.lat, lng: p.origem.lng }, { lat: p.destino.lat, lng: p.destino.lng }, p.conectores, p.autonomia_km,
];

@ApiTags('viagens')
@UseFilters(ErrosV1)
@UseGuards(ContaGuard)
@ApiBearerAuth()
@ApiUnauthorizedResponse({ type: Erro, description: 'Sem conta (erro conta_necessaria).' })
@Controller('v1/viagens')
export class ViagensSalvasController {
  constructor(private db: Db) {}

  @Get()
  @ApiOperation({ summary: 'Viagens salvas da conta', description: 'Das alteradas mais recentemente. Para planejar de novo, o app manda os mesmos dados ao planejar.' })
  @ApiOkResponse({ type: [ViagemSalva] })
  async listar(@Req() req): Promise<ViagemSalva[]> {
    const r = await this.db.query(`SELECT ${COLUNAS} FROM viagem WHERE conta_id = $1 ORDER BY atualizada_em DESC, id DESC`, [req.conta.id]);
    return r.map(saida);
  }

  @Post()
  @ApiOperation({ summary: 'Salvar uma viagem', description: 'Guarda só nome, origem, destino, conectores e autonomia. Viagem não salva não deixa registro (RN21).' })
  @ApiCreatedResponse({ type: ViagemSalva })
  @ApiBadRequestResponse({ type: Erro })
  async salvar(@Body() p: PedidoViagemSalva, @Req() req): Promise<ViagemSalva> {
    const [v] = await this.db.query(
      `INSERT INTO viagem (conta_id, nome, origem, destino, conectores, autonomia_km) VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${COLUNAS}`,
      [req.conta.id, ...valores(p)],
    );
    return saida(v);
  }

  @Put(':id')
  @ApiOperation({ summary: 'Editar uma viagem salva', description: 'Troca todos os dados da viagem.' })
  @ApiOkResponse({ type: ViagemSalva })
  @ApiBadRequestResponse({ type: Erro })
  @ApiNotFoundResponse({ type: Erro, description: 'Viagem inexistente ou de outra conta.' })
  async editar(@Param('id', ParseIntPipe) id: number, @Body() p: PedidoViagemSalva, @Req() req): Promise<ViagemSalva> {
    const [v] = await this.db.query(
      `UPDATE viagem SET nome = $3, origem = $4, destino = $5, conectores = $6, autonomia_km = $7, atualizada_em = now()
       WHERE id = $1 AND conta_id = $2 RETURNING ${COLUNAS}`,
      [id, req.conta.id, ...valores(p)],
    );
    if (!v) throw new NotFoundException('viagem não encontrada');
    return saida(v);
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Apagar uma viagem salva' })
  @ApiNoContentResponse({ description: 'Viagem apagada.' })
  @ApiBadRequestResponse({ type: Erro, description: 'Identificador que não é número.' })
  @ApiNotFoundResponse({ type: Erro, description: 'Viagem inexistente ou de outra conta.' })
  async apagar(@Param('id', ParseIntPipe) id: number, @Req() req) {
    const [v] = await this.db.query('DELETE FROM viagem WHERE id = $1 AND conta_id = $2 RETURNING id', [id, req.conta.id]);
    if (!v) throw new NotFoundException('viagem não encontrada');
  }
}
