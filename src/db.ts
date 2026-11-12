import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import pg from 'pg';

pg.types.setTypeParser(1082, (data) => data); // colunas date voltam como 'AAAA-MM-DD', sem fuso

@Injectable()
export class Db implements OnModuleInit, OnModuleDestroy {
  pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

  async onModuleInit() {
    await this.pool.query(readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8'));
  }

  onModuleDestroy() {
    return this.pool.end();
  }

  async query(sql: string, params: unknown[] = []) {
    return (await this.pool.query(sql, params)).rows;
  }

  async fonteLigada(nome: string): Promise<boolean> {
    const [f] = await this.query('SELECT ligada FROM fonte WHERE nome = $1', [nome]);
    return f.ligada;
  }
}
