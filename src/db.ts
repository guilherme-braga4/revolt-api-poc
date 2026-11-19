import { Injectable, Logger, OnModuleDestroy, OnModuleInit, ServiceUnavailableException } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import pg from 'pg';

pg.types.setTypeParser(1082, (data) => data); // colunas date voltam como 'AAAA-MM-DD', sem fuso

// Nenhum pedido espera o banco para sempre (incidente de 15/11/2026: conexões meio abertas encheram o pool e todo pedido
// seguinte ficou pendurado, mesmo com o banco de volta). Este é o prazo de cada etapa de um pedido: conseguir uma conexão e
// executar a consulta. Passado o prazo, o pedido falha com 503 base_indisponivel e a conexão ruim sai do pool.
const TEMPO_LIMITE_MS = Number(process.env.BANCO_TEMPO_LIMITE_MS) || 5000;
// As tarefas que processam a base inteira (atualização do OCM, grade da varredura, manutenções) têm prazo próprio, bem
// maior: elas podem levar vários segundos, mas também não podem ficar presas para sempre.
const TEMPO_LIMITE_TAREFAS_MS = 10 * 60_000;

// Classes de erro do Postgres que querem dizer "base fora do ar", não "consulta errada": conexão (08), falta de recursos (53),
// intervenção do operador (57, inclui o statement_timeout e o pg_terminate_backend) e falha do sistema (58).
const CLASSES_BASE_FORA = new Set(['08', '53', '57', '58']);
// Conexão encerrada pelo servidor antes de responder: a consulta não foi aplicada e pode ser repetida numa conexão nova.
const CONEXAO_ENCERRADA = new Set(['57P01', '57P02', '57P03']);
const TENTATIVAS = 3;

export class BaseIndisponivel extends ServiceUnavailableException {
  constructor(causa: unknown) {
    super({ erro: 'base_indisponivel', mensagem: 'A base de dados não respondeu. Tente de novo em instantes.' }, { cause: causa });
  }
}

function baseFora(erro: unknown) {
  if (erro instanceof pg.DatabaseError) return CLASSES_BASE_FORA.has(String(erro.code).slice(0, 2));
  // Sem código do Postgres: rede, conexão recusada ou derrubada, prazo estourado. Erro de programação segue como erro interno.
  return !(erro instanceof TypeError || erro instanceof RangeError);
}

@Injectable()
export class Db implements OnModuleInit, OnModuleDestroy {
  private log = new Logger('Db');

  // Pool dos pedidos (app e Curador), com o prazo curto.
  pool = this.criarPool(TEMPO_LIMITE_MS, 10);
  // Pool das tarefas longas. Duas conexões bastam: as tarefas quase nunca se sobrepõem e, quando isso acontece, a de trás
  // espera a vez dentro do prazo das tarefas.
  poolTarefas = this.criarPool(TEMPO_LIMITE_TAREFAS_MS, 2);

  private criarPool(tempoLimiteMs: number, max: number) {
    const pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      max,
      // Esperar uma conexão livre do pool ou abrir uma nova.
      connectionTimeoutMillis: tempoLimiteMs,
      // O Postgres cancela a consulta lenta: ela não segue rodando no servidor depois que o pedido desistiu.
      statement_timeout: tempoLimiteMs,
      // Conexão que não responde nem ao cancelamento (meio aberta): a consulta falha e o pool destrói a conexão.
      query_timeout: tempoLimiteMs + 2000,
      // O sistema também testa as conexões paradas e derruba as que morreram.
      keepAlive: true,
      keepAliveInitialDelayMillis: 10_000,
    });
    // Conexão ociosa que cai (reinício do Postgres, queda de rede) emite 'error' no pool. Sem ouvinte, o Node derruba o
    // processo. O pool já descartou a conexão: o próximo pedido abre outra.
    pool.on('error', (erro) => this.log.warn(`conexão ociosa com o banco caiu e foi descartada: ${erro.message}`));
    return pool;
  }

  // O esquema roda numa conexão própria, sem prazo: criar a extensão PostGIS num banco novo pode demorar.
  async onModuleInit() {
    const cliente = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await cliente.connect();
    try {
      await cliente.query(readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8'));
    } finally {
      await cliente.end();
    }
  }

  async onModuleDestroy() {
    await Promise.all([this.pool.end(), this.poolTarefas.end()]);
  }

  // Consulta de um pedido, com o prazo curto.
  query(sql: string, params: unknown[] = []) {
    return this.consultar(this.pool, sql, params);
  }

  // Consulta de uma tarefa que processa a base inteira, com o prazo das tarefas.
  tarefa(sql: string, params: unknown[] = []) {
    return this.consultar(this.poolTarefas, sql, params);
  }

  private async consultar(pool: pg.Pool, sql: string, params: unknown[]) {
    for (let tentativa = 1; ; tentativa++) {
      try {
        return (await pool.query(sql, params)).rows;
      } catch (erro) {
        if (erro instanceof pg.DatabaseError && CONEXAO_ENCERRADA.has(erro.code) && tentativa < TENTATIVAS) {
          this.log.warn(`o banco encerrou a conexão antes de responder (${erro.code}); repetindo a consulta numa conexão nova`);
          continue;
        }
        if (!baseFora(erro)) throw erro;
        this.log.error(`banco indisponível: ${erro.message}`);
        throw new BaseIndisponivel(erro);
      }
    }
  }

  async fonteLigada(nome: string): Promise<boolean> {
    const [f] = await this.query('SELECT ligada FROM fonte WHERE nome = $1', [nome]);
    return f.ligada;
  }
}
