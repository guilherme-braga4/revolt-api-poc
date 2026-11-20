// POST /v1/checkins: check-in depois da recarga (fluxo core). UC05, RF08, RN12, RN13 e RN15 do app; Alteração 6 da obtenção.
// A contribuição (módulo app) liga a conta ao que ela enviou; a observação (módulo obtenção) guarda o que o motorista viu,
// com o pseudônimo da conta como autor. As duas entram na mesma instrução, e a chave do app evita duplicar o reenvio.
import { BadRequestException, Body, Controller, NotFoundException, Post, Req, Res, UseFilters, UseGuards } from '@nestjs/common';
import {
  ApiBadRequestResponse, ApiBearerAuth, ApiBody, ApiCreatedResponse, ApiForbiddenResponse, ApiNotFoundResponse, ApiOkResponse, ApiOperation, ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { randomUUID } from 'node:crypto';
import { Db } from '../db.js';
import { SQL_ELETROPOSTO_EXISTE, motivoDaRecusa } from '../observacoes.js';
import { diaEmBrasilia } from '../vocabulario.js';
import { ContribuicaoGuard, ErrosV1 } from './acesso.js';
import { CheckinRecebido, Erro, PedidoCheckin } from './contrato.js';
import { caminhoDaFoto, recomprimir } from './fotos.js';

const MENSAGENS_RECUSA = {
  campo_nao_aceito: 'O check-in aceita só o que o motorista observou: há campo fora da lista, como um dado do Google.',
  sem_data: 'Falta a data da observação.',
  data_invalida: 'A data da observação precisa ser AAAA-MM-DD.',
  data_futura: 'A data da observação não pode ser no futuro.',
};

// Grava a observação, a foto e a contribuição de uma vez, só se a conta ainda não enviou esta chave. Com a chave repetida,
// devolve a contribuição que já existe. As chaves estrangeiras são conferidas no fim da instrução inteira.
const SQL_CHECKIN = `
WITH nova AS (
  INSERT INTO observacao (eletroposto_id, autor, data_observacao, carregou, conector, funcionou, potencia_kw, preco, estava_como_informado, foto_id)
  SELECT $3::text, $4::uuid, $5::date, $6::boolean, $7::text, $8::boolean, $9::numeric, $10::text, $11::text, $12::uuid
  WHERE NOT EXISTS (SELECT 1 FROM contribuicao WHERE conta_id = $1::int AND chave = $2::uuid)
  RETURNING id, eletroposto_id, data_observacao, foto_id
),
nova_foto AS (
  INSERT INTO foto (id, jpeg) SELECT foto_id, $13::bytea FROM nova WHERE foto_id IS NOT NULL
),
nova_contribuicao AS (
  INSERT INTO contribuicao (conta_id, chave, observacao_id) SELECT $1::int, $2::uuid, id FROM nova
  ON CONFLICT (conta_id, chave) DO NOTHING
  RETURNING id, recebida_em
)
SELECT c.id, n.eletroposto_id, n.data_observacao, n.foto_id, c.recebida_em, true AS nova FROM nova_contribuicao c, nova n
UNION ALL
SELECT c.id, o.eletroposto_id, o.data_observacao, o.foto_id, c.recebida_em, false
FROM contribuicao c JOIN observacao o ON o.id = c.observacao_id WHERE c.conta_id = $1::int AND c.chave = $2::uuid`;

@ApiTags('contribuicoes')
@UseFilters(ErrosV1)
@Controller('v1/checkins')
export class CheckinsController {
  constructor(private db: Db) {}

  @Post()
  @UseGuards(ContribuicaoGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Check-in depois da recarga',
    description:
      'Exige conta não bloqueada. Entra na ficha como observação de motorista, com a data e sem o autor, e nunca torna o posto ' +
      'verificado. O check-in guardado sem conexão vai depois, com a data da observação e a mesma chave: reenviar não duplica. ' +
      'Num lugar do Google, guarda só o identificador dele. Pedidos recusados por validação são contados para o Curador.',
  })
  @ApiBody({ type: PedidoCheckin })
  @ApiCreatedResponse({ type: CheckinRecebido, description: 'Check-in recebido.' })
  @ApiOkResponse({ type: CheckinRecebido, description: 'Esta conta já enviou esta chave: nada foi duplicado.' })
  @ApiBadRequestResponse({ type: Erro, description: 'Pedido inválido (erro pedido_invalido) ou foto que não é JPEG de até 500 KB (erro foto_invalida).' })
  @ApiUnauthorizedResponse({ type: Erro, description: 'Sem conta (erro conta_necessaria): o app convida a entrar e guarda o check-in.' })
  @ApiForbiddenResponse({ type: Erro, description: 'Conta bloqueada pelo Curador (erro conta_bloqueada).' })
  @ApiNotFoundResponse({ type: Erro, description: 'Posto desconhecido.' })
  async checkin(@Body() corpo: unknown, @Req() req, @Res({ passthrough: true }) res): Promise<CheckinRecebido> {
    // Validação aqui, e não no pipe global, para contar as recusas (RF19 da obtenção).
    const pedido = plainToInstance(PedidoCheckin, corpo ?? {});
    const erros = await validate(pedido, { whitelist: true, forbidNonWhitelisted: true });
    const motivo = motivoDaRecusa(erros, pedido.data_observacao, diaEmBrasilia(new Date()));
    if (motivo) {
      await this.db.query('INSERT INTO observacao_recusada (motivo) VALUES ($1)', [motivo]);
      const detalhes = erros.flatMap((e) => Object.values(e.constraints ?? {})).join('; ');
      throw new BadRequestException({ erro: 'pedido_invalido', mensagem: MENSAGENS_RECUSA[motivo] ?? detalhes });
    }

    const [{ existe }] = await this.db.query(SQL_ELETROPOSTO_EXISTE, [pedido.eletroposto_id]);
    if (!existe) throw new NotFoundException('eletroposto não encontrado');
    const jpeg = pedido.foto ? await recomprimir(pedido.foto) : null;

    const p = pedido;
    const params = [req.conta.id, p.chave, p.eletroposto_id, req.conta.pseudonimo, p.data_observacao, p.carregou, p.conector ?? null,
      p.funcionou ?? null, p.potencia_kw ?? null, p.preco ?? null, p.estava_como_informado, jpeg ? randomUUID() : null, jpeg];
    let [r] = await this.db.query(SQL_CHECKIN, params);
    // Dois envios da mesma chave ao mesmo tempo: o segundo não vê o primeiro na própria instrução. Basta ler de novo.
    if (!r) [r] = await this.db.query(SQL_CHECKIN, params);
    res.status(r.nova ? 201 : 200);
    return {
      id: r.id,
      chave: p.chave,
      eletroposto_id: r.eletroposto_id,
      data_observacao: r.data_observacao,
      foto: caminhoDaFoto(r.foto_id),
      recebido_em: r.recebida_em.toISOString(),
    };
  }
}
