import { BadRequestException, Body, ConflictException, Controller, Get, HttpCode, NotFoundException, Param, ParseIntPipe, Post, UseGuards } from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  IsArray, IsBoolean, IsDateString, IsIn, IsInt, IsLatitude, IsLongitude, IsNotEmpty, IsNumber, IsOptional, IsPositive, IsString, ValidateIf,
  ValidateNested,
} from 'class-validator';
import { Db } from './db.js';
import { CuradorGuard } from './v1/acesso.js';
import { ACESSOS, LICENCA_PROPRIA, RESTRICOES_ACESSO, TIPOS_CONECTOR } from './vocabulario.js';

class Localizacao {
  @IsLatitude() lat: number;
  @IsLongitude() lng: number;
}

class Conector {
  @IsIn(TIPOS_CONECTOR, { message: `tipo do conector precisa ser um destes: ${TIPOS_CONECTOR.join(', ')}` }) tipo: string;
  @IsOptional() @IsNumber() potencia_kw?: number;
  @IsOptional() @IsInt() quantidade?: number;
}

// Cada carregador verificado diz se funcionou e a potência observada na recarga, ou null quando não houve recarga (marca
// de não observada). Sem uma das duas informações, a verificação é recusada (RF07).
class CarregadorObservado {
  @IsIn(TIPOS_CONECTOR, { message: `tipo do carregador precisa ser um destes: ${TIPOS_CONECTOR.join(', ')}` }) tipo: string;
  @IsBoolean({ message: 'cada carregador precisa dizer se funcionou (funcionou: true ou false)' }) funcionou: boolean;
  @ValidateIf((c) => c.potencia_observada_kw !== null)
  @IsPositive({ message: 'potencia_observada_kw precisa ser a potência observada na recarga, ou null quando não houve recarga' })
  potencia_observada_kw: number | null;
}

// Atributos do RF07. Qualquer campo fora desta lista, como os do Google, é recusado pela validação (RN10).
export class NovaVerificacao {
  @IsOptional() @IsInt() posto_proprio_id?: number;
  @IsOptional() @IsInt() ocm_id?: number;
  @IsIn(['campo'], { message: 'origem precisa ser "campo": só observação em campo é aceita, nunca dado do Google (RN01, RN10)' })
  origem: string;
  @IsString() @IsNotEmpty() autor: string;
  @IsDateString() data_observacao: string;
  @ValidateNested() @Type(() => Localizacao) localizacao: Localizacao;
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => Conector) conectores?: Conector[];
  @IsOptional() @IsIn(['funcionando', 'parcial', 'nao_funcionando', 'desativado', 'inexistente']) funcionamento?: string;
  @IsOptional() @IsString() preco?: string;
  @IsOptional() @IsString() regras_cobranca?: string;
  @IsOptional() @IsString() taxa_ociosidade?: string;
  @IsOptional() @IsString() pre_autorizacao?: string;
  @IsOptional() @IsString() app_exigido?: string;
  @IsOptional() @IsBoolean() pagamento_sem_app?: boolean;
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => CarregadorObservado) carregadores?: CarregadorObservado[];
  @IsOptional() @IsIn(ACESSOS) acesso?: string;
  @ValidateIf((v) => v.acesso === 'restrito' || v.acesso_restricao !== undefined)
  @IsIn(RESTRICOES_ACESSO, { message: `acesso restrito exige acesso_restricao, um destes: ${RESTRICOES_ACESSO.join(', ')}` })
  acesso_restricao?: string;
}

class Vinculo {
  @IsString() @IsNotEmpty() place_id: string;
  @IsString() @IsNotEmpty() autor: string;
}

// Operação do módulo obtenção: só a conta com papel de Curador.
@UseGuards(CuradorGuard)
@Controller()
export class PropriosController {
  constructor(private db: Db) {}

  // UC04: verifica um posto do OCM, um registro próprio existente ou cria um posto novo.
  @Post('verificacoes')
  async registrar(@Body() v: NovaVerificacao) {
    if (v.acesso_restricao && v.acesso !== 'restrito') throw new BadRequestException(['acesso_restricao só vale com acesso restrito']);
    let id = v.posto_proprio_id;
    if (id) {
      const [p] = await this.db.query('SELECT id FROM posto_proprio WHERE id = $1', [id]);
      if (!p) throw new NotFoundException('posto_proprio_id não existe');
    } else if (v.ocm_id) {
      const [o] = await this.db.query('SELECT 1 FROM ocm_posto WHERE ocm_id = $1', [v.ocm_id]);
      if (!o) throw new NotFoundException('ocm_id não está na cópia do OCM');
      [{ id }] = await this.db.query(
        'INSERT INTO posto_proprio (ocm_id) VALUES ($1) ON CONFLICT (ocm_id) DO UPDATE SET ocm_id = EXCLUDED.ocm_id RETURNING id',
        [v.ocm_id],
      );
    } else {
      [{ id }] = await this.db.query('INSERT INTO posto_proprio DEFAULT VALUES RETURNING id');
    }

    await this.db.query(
      `INSERT INTO verificacao (posto_proprio_id, origem, autor, data_observacao, local, conectores, funcionamento, preco,
                                regras_cobranca, taxa_ociosidade, pre_autorizacao, app_exigido, pagamento_sem_app, acesso, carregadores,
                                acesso_restricao)
       VALUES ($1, $2, $3, $4, ST_SetSRID(ST_MakePoint($5, $6), 4326)::geography, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
      [
        id, v.origem, v.autor, v.data_observacao, v.localizacao.lng, v.localizacao.lat, v.conectores ? JSON.stringify(v.conectores) : null,
        v.funcionamento, v.preco, v.regras_cobranca, v.taxa_ociosidade, v.pre_autorizacao, v.app_exigido, v.pagamento_sem_app, v.acesso,
        v.carregadores ? JSON.stringify(v.carregadores) : null, v.acesso_restricao,
      ],
    );
    return this.posto(id);
  }

  @Get('postos-proprios/:id')
  async posto(@Param('id', ParseIntPipe) id: number) {
    const [p] = await this.db.query(
      `SELECT p.id, p.ocm_id, CASE WHEN p.ocm_id IS NULL THEN NULL ELSE o.ocm_id IS NOT NULL END AS ocm_listado,
              p.google_place_id, p.vinculado_em, p.vinculado_por, p.criado_em
       FROM posto_proprio p LEFT JOIN ocm_posto o ON o.ocm_id = p.ocm_id WHERE p.id = $1`,
      [id],
    );
    if (!p) throw new NotFoundException('posto próprio não existe');
    const verificacoes = await this.db.query(
      `SELECT id, origem, licenca, autor, data_observacao, registrada_em, ST_Y(local::geometry) AS lat, ST_X(local::geometry) AS lng,
              conectores, funcionamento, preco, regras_cobranca, taxa_ociosidade, pre_autorizacao, app_exigido, pagamento_sem_app, acesso,
              carregadores, acesso_restricao
       FROM verificacao WHERE posto_proprio_id = $1 ORDER BY data_observacao DESC, id DESC`,
      [id],
    );
    return { ...p, licenca: LICENCA_PROPRIA, verificacoes };
  }

  // RF08: o Curador confirma que o lugar do Google é este posto. Só o identificador é guardado.
  @Post('postos-proprios/:id/vinculo-google')
  @HttpCode(200)
  async vincular(@Param('id', ParseIntPipe) id: number, @Body() b: Vinculo) {
    const [lugar] = await this.db.query('SELECT 1 FROM google_lugar WHERE place_id = $1', [b.place_id]);
    if (!lugar) throw new NotFoundException('place_id não está entre os lugares do Google guardados');
    const [outro] = await this.db.query('SELECT id FROM posto_proprio WHERE google_place_id = $1 AND id <> $2', [b.place_id, id]);
    if (outro) throw new ConflictException(`place_id já vinculado ao posto próprio ${outro.id}`);
    const [p] = await this.db.query(
      'UPDATE posto_proprio SET google_place_id = $2, vinculado_em = now(), vinculado_por = $3 WHERE id = $1 RETURNING id',
      [id, b.place_id, b.autor],
    );
    if (!p) throw new NotFoundException('posto próprio não existe');
    return this.posto(id);
  }
}
