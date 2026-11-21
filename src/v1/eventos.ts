// POST /v1/eventos: telemetria própria do app (D-10), sem SDK de terceiros, sem conta e sem pessoa. No-core.
import { BadRequestException, Body, Controller, HttpCode, HttpException, Post, Req, UseFilters } from '@nestjs/common';
import { ApiBadRequestResponse, ApiBody, ApiNoContentResponse, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Db } from '../db.js';
import { diaEmBrasilia } from '../vocabulario.js';
import { Acesso, ErrosV1 } from './acesso.js';
import { Erro, PedidoEventos } from './contrato.js';

// Campo que só vale num tipo de evento, e é obrigatório nele. O identificador rotativo nunca vai junto de outro evento, para
// nenhum evento poder ser ligado a outro.
const CAMPO_DO_TIPO = { id_rotativo: 'app_aberto', trechos_sem_cobertura: 'viagem_planejada', paradas_sem_plano_b: 'viagem_planejada' };

// Uma instrução só: soma as contagens do dia por tipo, guarda os dias de uso de cada identificador rotativo e apaga os dias
// de uso com mais de 90 dias (RNF-09).
const SQL_EVENTOS = `
WITH e AS (
  SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(tipo text, dia date, id_rotativo uuid, trechos_sem_cobertura int, paradas_sem_plano_b int)
),
contagem AS (
  INSERT INTO evento_dia (dia, tipo, quantidade, trechos_sem_cobertura, paradas_sem_plano_b)
  SELECT dia, tipo, count(*), coalesce(sum(trechos_sem_cobertura), 0), coalesce(sum(paradas_sem_plano_b), 0) FROM e GROUP BY dia, tipo
  ON CONFLICT (dia, tipo) DO UPDATE SET quantidade = evento_dia.quantidade + EXCLUDED.quantidade,
    trechos_sem_cobertura = evento_dia.trechos_sem_cobertura + EXCLUDED.trechos_sem_cobertura,
    paradas_sem_plano_b = evento_dia.paradas_sem_plano_b + EXCLUDED.paradas_sem_plano_b
),
aberturas AS (
  INSERT INTO abertura (id_rotativo, dia) SELECT DISTINCT id_rotativo, dia FROM e WHERE tipo = 'app_aberto' ON CONFLICT DO NOTHING
)
DELETE FROM abertura WHERE dia < $2::date - 90`;

@ApiTags('telemetria')
@UseFilters(ErrosV1)
@Controller('v1/eventos')
export class EventosController {
  constructor(
    private db: Db,
    private acesso: Acesso,
  ) {}

  @Post()
  @HttpCode(204)
  @ApiOperation({
    summary: 'Eventos de telemetria do app',
    description:
      'Sem conta e sem atestado. Lista fechada de tipos, nenhum dado pessoal e nenhum identificador estável do aparelho: só o ' +
      'identificador aleatório de app_aberto, que o app troca a cada 30 dias, para o retorno em 30 dias. O app junta os eventos ' +
      '(até 100 por envio) e manda depois o que juntou sem conexão, de até 30 dias atrás. Envio recusado (400) não deve ser ' +
      'repetido. A API guarda só a contagem por dia e tipo; os dias de uso de cada identificador são apagados em 90 dias.',
  })
  @ApiBody({ type: PedidoEventos })
  @ApiNoContentResponse({ description: 'Eventos contados.' })
  @ApiBadRequestResponse({ type: Erro, description: 'Tipo fora da lista, campo a mais ou fora do seu tipo, ou dia fora do intervalo (erro pedido_invalido).' })
  @ApiResponse({ status: 429, type: Erro, description: 'Muitos envios do mesmo IP em 10 minutos (erro muitos_pedidos). Tente mais tarde.' })
  async receber(@Body() pedido: PedidoEventos, @Req() req) {
    if (!this.acesso.dentroDoRitmo(req, 'eventos'))
      throw new HttpException({ erro: 'muitos_pedidos', mensagem: 'Muitos envios de telemetria em pouco tempo. Tente de novo mais tarde.' }, 429);
    const hoje = diaEmBrasilia(new Date());
    const limite = new Date(Date.parse(hoje) - 30 * 86_400_000).toISOString().slice(0, 10);
    for (const e of pedido.eventos) {
      if (e.dia > hoje || e.dia < limite) throw new BadRequestException(`dia precisa estar entre ${limite} e ${hoje}`);
      for (const [campo, tipo] of Object.entries(CAMPO_DO_TIPO))
        if ((e[campo] != null) !== (e.tipo === tipo)) throw new BadRequestException(`${campo} vai só no evento ${tipo}, e é obrigatório nele`);
    }
    await this.db.query(SQL_EVENTOS, [JSON.stringify(pedido.eventos), hoje]);
  }
}
