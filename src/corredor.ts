import { Controller, Get, Logger, UseGuards } from '@nestjs/common';
import { Db } from './db.js';
import { situacaoDoCorredor } from './indicadores.js';
import { CuradorGuard } from './v1/acesso.js';
import { OCM_E_PROPRIOS_LIGADOS } from './v1/mapa.js';
import { diaEmBrasilia } from './vocabulario.js';

// UC07 da obtenção (RF11): situação do corredor da Via Dutra para o Curador. Só leitura: nenhum dado muda.
@UseGuards(CuradorGuard)
@Controller('corredor')
export class CorredorController {
  constructor(private db: Db) {}

  @Get()
  async situacao() {
    // Postos do OCM e próprios entregues dentro do trecho, sem o duplicado oculto pelo Curador. O filtro de entrega já deixa
    // de fora os lugares do Google (RN18).
    const linhas = await this.db.query(
      `SELECT e.id, e.origem, e.nome, e.verificado, e.data_observacao, e.preco_observado, e.regras_cobranca
       FROM eletroposto e
       WHERE ST_Intersects((SELECT area FROM corredor_verificado WHERE nome = 'Via Dutra'), e.local::geometry)
         AND ${OCM_E_PROPRIOS_LIGADOS} AND e.id NOT IN (SELECT oculto FROM vinculo_duplicado)
       ORDER BY e.lng`,
    );
    // Data dos dados usados: a última atualização do OCM que deu certo (com falha depois, a cópia é a dessa data).
    const [ocm] = await this.db.query(`SELECT max(terminada_em) AS em FROM atualizacao_ocm WHERE resultado = 'ok'`);
    const situacao = situacaoDoCorredor(linhas, diaEmBrasilia(new Date()));
    const ultimaVerificacao = situacao.postos.map((p) => p.ultima_verificacao).filter(Boolean).sort().pop() ?? null;
    new Logger('Corredor').log(
      `situação da Via Dutra consultada: ${situacao.postos.length} postos, OCM de ${ocm.em?.toISOString() ?? 'nunca'}, ` +
        `verificação mais recente ${ultimaVerificacao ?? 'nenhuma'}`,
    );
    return { corredor: 'Via Dutra', consultado_em: new Date(), ocm_atualizado_em: ocm.em, ultima_verificacao: ultimaVerificacao, ...situacao };
  }
}
