import { BadRequestException, Body, Controller, Get, HttpCode, NotFoundException, Param, ParseIntPipe, Patch, Post, Put } from '@nestjs/common';
import { IsBoolean, IsNotEmpty, IsNumber, IsString, Min } from 'class-validator';
import { Db } from './db.js';
import { GoogleService } from './google.js';

class Autor {
  @IsString() @IsNotEmpty() autor: string;
}
class MudarFonte extends Autor {
  @IsBoolean() ligada: boolean;
}
class MudarProvedor extends Autor {
  @IsBoolean() ligado: boolean;
}
class MudarTeto extends Autor {
  @IsNumber() @Min(0) valor_usd: number;
}

// UC06: teto de gasto e controle de fontes (RF09, RF10). Toda mudança guarda data e autor.
@Controller('controle')
export class ControleController {
  constructor(
    private db: Db,
    private google: GoogleService,
  ) {}

  @Get('gasto')
  gasto() {
    return this.google.gasto();
  }

  @Put('teto')
  async teto(@Body() b: MudarTeto) {
    await this.db.query('UPDATE teto_google SET valor_usd = $1, alterado_em = now(), alterado_por = $2', [b.valor_usd, b.autor]);
    return this.google.gasto();
  }

  @Get('fontes')
  async fontes() {
    return {
      fontes: await this.db.query('SELECT * FROM fonte ORDER BY nome'),
      provedores_ocm: await this.db.query(
        `SELECT provedor_id, c.provedor, c.licenca, coalesce(c.registros, 0) AS registros, coalesce(p.ligado, true) AS ligado,
                p.alterado_em, p.alterado_por
         FROM (SELECT provedor_id, provedor, licenca, count(*)::int AS registros FROM ocm_posto GROUP BY 1, 2, 3) c
         FULL JOIN ocm_provedor p USING (provedor_id) ORDER BY registros DESC`,
      ),
    };
  }

  @Patch('fontes/:nome')
  async mudarFonte(@Param('nome') nome: string, @Body() b: MudarFonte) {
    const [f] = await this.db.query(
      'UPDATE fonte SET ligada = $2, alterada_em = now(), alterada_por = $3 WHERE nome = $1 RETURNING *',
      [nome, b.ligada, b.autor],
    );
    if (!f) throw new NotFoundException('fonte não existe');
    return f;
  }

  // Excluir desliga a fonte e apaga os dados dela. Registros próprios, inclusive os vinculados, continuam.
  @Post('fontes/:nome/excluir-dados')
  @HttpCode(200)
  async excluirFonte(@Param('nome') nome: string, @Body() b: Autor) {
    if (nome !== 'ocm' && nome !== 'google') throw new BadRequestException('só as fontes ocm e google podem ter os dados excluídos');
    await this.mudarFonte(nome, { ligada: false, autor: b.autor });
    const apagados =
      nome === 'ocm'
        ? (await this.db.query('DELETE FROM ocm_posto RETURNING ocm_id')).length
        : (await this.db.query('DELETE FROM google_lugar RETURNING place_id')).length;
    if (nome === 'google') await this.db.query('DELETE FROM google_celula');
    return { fonte: nome, ligada: false, apagados };
  }

  @Patch('provedores-ocm/:id')
  async mudarProvedor(@Param('id', ParseIntPipe) id: number, @Body() b: MudarProvedor) {
    const [p] = await this.db.query(
      `INSERT INTO ocm_provedor (provedor_id, ligado, alterado_por) VALUES ($1, $2, $3)
       ON CONFLICT (provedor_id) DO UPDATE SET ligado = $2, alterado_em = now(), alterado_por = $3 RETURNING *`,
      [id, b.ligado, b.autor],
    );
    return p;
  }

  @Post('provedores-ocm/:id/excluir-dados')
  @HttpCode(200)
  async excluirProvedor(@Param('id', ParseIntPipe) id: number, @Body() b: Autor) {
    await this.mudarProvedor(id, { ligado: false, autor: b.autor });
    const apagados = await this.db.query('DELETE FROM ocm_posto WHERE provedor_id = $1 RETURNING ocm_id', [id]);
    return { provedor_id: id, ligado: false, apagados: apagados.length };
  }
}
