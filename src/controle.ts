import { BadRequestException, Body, Controller, Get, HttpCode, NotFoundException, Param, ParseIntPipe, Patch, Post, Put, UseGuards } from '@nestjs/common';
import { IsBoolean, IsNotEmpty, IsNumber, IsString, Min } from 'class-validator';
import { Db } from './db.js';
import { CuradorGuard } from './v1/acesso.js';
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

// UC06: teto de gasto e controle de fontes (RF09, RF10). Toda mudança guarda data e autor, e entra no histórico.
// Operação do módulo obtenção: só a conta com papel de Curador.
@UseGuards(CuradorGuard)
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

  // Avisos ao Curador, calculados na hora e lidos por esta rota, sem e-mail nem push (RF09, UC06; RNF-11 da arquitetura).
  @Get('avisos')
  async avisos() {
    const avisos = [];
    try {
      const g = await this.google.gasto();
      const parcela = g.teto_usd > 0 ? g.gasto_usd / g.teto_usd : 1;
      if (g.teto_atingido) avisos.push({ tipo: 'teto_atingido', mensagem: g.aviso, desde: null });
      else if (parcela >= 0.8)
        avisos.push({ tipo: 'teto_proximo', mensagem: `O gasto com o Google do mês chegou a ${Math.floor(parcela * 100)}% do teto.`, desde: null });
    } catch {
      // Sem apuração, cada chamada ao Google também falha antes de sair (GoogleService.chamar confere o gasto antes).
      avisos.push({ tipo: 'gasto_nao_apurado', mensagem: 'O gasto com o Google não pôde ser apurado; nenhuma consulta ao Google sai até a apuração voltar.', desde: null });
    }
    for (const f of await this.db.query('SELECT nome, alterada_em, alterada_por FROM fonte WHERE NOT ligada ORDER BY nome'))
      avisos.push({ tipo: 'fonte_desligada', mensagem: `A fonte ${f.nome} está desligada (por ${f.alterada_por}).`, desde: f.alterada_em });
    for (const p of await this.db.query('SELECT provedor_id, alterado_em, alterado_por FROM ocm_provedor WHERE NOT ligado ORDER BY provedor_id'))
      avisos.push({
        tipo: 'provedor_ocm_desligado', mensagem: `O provedor ${p.provedor_id} do OCM está desligado (por ${p.alterado_por}).`, desde: p.alterado_em,
      });
    const [ocm] = await this.db.query(`SELECT resultado, motivo, terminada_em FROM atualizacao_ocm WHERE resultado <> 'ignorada' ORDER BY id DESC LIMIT 1`);
    if (ocm?.resultado === 'falha')
      avisos.push({ tipo: 'atualizacao_ocm_falhou', mensagem: `A última atualização do OCM falhou: ${ocm.motivo}. A cópia anterior continua.`, desde: ocm.terminada_em });
    return { avisos };
  }

  // Mudanças de teto, fontes e provedores do OCM, da mais recente para a mais antiga (UC06).
  @Get('historico')
  historico() {
    return this.db.query('SELECT alvo, de, para, autor, feita_em FROM historico_controle ORDER BY id DESC LIMIT 500');
  }

  @Put('teto')
  async teto(@Body() b: MudarTeto) {
    await this.db.query(
      `WITH antes AS (SELECT valor_usd FROM teto_google),
            mudou AS (UPDATE teto_google SET valor_usd = $1::numeric, alterado_em = now(), alterado_por = $2::text RETURNING valor_usd)
       INSERT INTO historico_controle (alvo, de, para, autor) SELECT 'teto', antes.valor_usd::text, mudou.valor_usd::text, $2::text FROM antes, mudou`,
      [b.valor_usd, b.autor],
    );
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
      `WITH antes AS (SELECT ligada FROM fonte WHERE nome = $1::text),
            mudou AS (UPDATE fonte SET ligada = $2::boolean, alterada_em = now(), alterada_por = $3::text WHERE nome = $1::text RETURNING *),
            registro AS (INSERT INTO historico_controle (alvo, de, para, autor)
                         SELECT 'fonte:' || $1::text, CASE WHEN antes.ligada THEN 'ligada' ELSE 'desligada' END,
                                CASE WHEN mudou.ligada THEN 'ligada' ELSE 'desligada' END, $3::text
                         FROM antes, mudou)
       SELECT * FROM mudou`,
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
        ? (await this.db.tarefa('DELETE FROM ocm_posto RETURNING ocm_id')).length
        : (await this.db.tarefa('DELETE FROM google_lugar RETURNING place_id')).length;
    if (nome === 'google') await this.db.tarefa('DELETE FROM google_celula');
    await this.db.query('INSERT INTO historico_controle (alvo, para, autor) VALUES ($1, $2, $3)', [
      `fonte:${nome}`, `dados excluídos (${apagados} registros)`, b.autor,
    ]);
    return { fonte: nome, ligada: false, apagados };
  }

  @Patch('provedores-ocm/:id')
  async mudarProvedor(@Param('id', ParseIntPipe) id: number, @Body() b: MudarProvedor) {
    const [p] = await this.db.query(
      `WITH antes AS (SELECT coalesce((SELECT ligado FROM ocm_provedor WHERE provedor_id = $1::int), true) AS ligado),
            mudou AS (INSERT INTO ocm_provedor (provedor_id, ligado, alterado_por) VALUES ($1::int, $2::boolean, $3::text)
                      ON CONFLICT (provedor_id) DO UPDATE SET ligado = $2::boolean, alterado_em = now(), alterado_por = $3::text RETURNING *),
            registro AS (INSERT INTO historico_controle (alvo, de, para, autor)
                         SELECT 'provedor_ocm:' || $1::int, CASE WHEN antes.ligado THEN 'ligado' ELSE 'desligado' END,
                                CASE WHEN mudou.ligado THEN 'ligado' ELSE 'desligado' END, $3::text
                         FROM antes, mudou)
       SELECT * FROM mudou`,
      [id, b.ligado, b.autor],
    );
    return p;
  }

  @Post('provedores-ocm/:id/excluir-dados')
  @HttpCode(200)
  async excluirProvedor(@Param('id', ParseIntPipe) id: number, @Body() b: Autor) {
    await this.mudarProvedor(id, { ligado: false, autor: b.autor });
    const apagados = await this.db.tarefa('DELETE FROM ocm_posto WHERE provedor_id = $1 RETURNING ocm_id', [id]);
    await this.db.query('INSERT INTO historico_controle (alvo, para, autor) VALUES ($1, $2, $3)', [
      `provedor_ocm:${id}`, `dados excluídos (${apagados.length} registros)`, b.autor,
    ]);
    return { provedor_id: id, ligado: false, apagados: apagados.length };
  }
}
