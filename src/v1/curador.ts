// GET /v1/curador/fila e POST /v1/curador/decisoes: moderação dentro do app, para a conta com papel de Curador (no-core).
// UC08 e RF11 do app; remoção de observação da Alteração 6 da obtenção.
import { BadRequestException, Body, Controller, Get, NotFoundException, Post, Req, UseFilters, UseGuards } from '@nestjs/common';
import {
  ApiBadRequestResponse, ApiBearerAuth, ApiCreatedResponse, ApiForbiddenResponse, ApiNotFoundResponse, ApiOkResponse, ApiOperation, ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Db } from '../db.js';
import { CuradorGuard, ErrosV1 } from './acesso.js';
import { CAMPOS_CORRIGIVEIS, DecisaoRegistrada, Erro, FilaCurador, PedidoDecisao } from './contrato.js';
import { caminhoDaFoto } from './fotos.js';

const SQL_FILA = `
SELECT
  (SELECT coalesce(json_agg(x ORDER BY x.aberto_em, x.id), '[]') FROM (
     SELECT r.id, r.eletroposto_id, r.tipo, r.outro_eletroposto_id, r.aberto_em,
            (SELECT count(*) FROM reporte r2 WHERE r2.resolvido_em IS NULL AND r2.eletroposto_id = r.eletroposto_id)::int AS abertos_no_posto,
            (SELECT json_agg(json_build_object('conta_id', e.conta_id, 'detalhe', e.detalhe, 'foto_id', e.foto_id, 'enviado_em', e.enviado_em)
                             ORDER BY e.enviado_em, e.id)
             FROM reporte_envio e WHERE e.reporte_id = r.id) AS envios
     FROM reporte r WHERE r.resolvido_em IS NULL ORDER BY r.aberto_em, r.id LIMIT 100) x) AS reportes,
  (SELECT coalesce(json_agg(x ORDER BY x.abertos DESC, x.eletroposto_id), '[]') FROM (
     SELECT eletroposto_id, count(*)::int AS abertos FROM reporte WHERE resolvido_em IS NULL GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 10) x) AS postos_com_mais_reportes,
  (SELECT coalesce(json_agg(x ORDER BY x.recebida_em DESC, x.id DESC), '[]') FROM (
     SELECT c.id, c.conta_id, o.eletroposto_id, o.data_observacao AS data, o.carregou, o.conector, o.funcionou, o.potencia_kw::float8 AS potencia_kw,
            o.preco, o.estava_como_informado, o.foto_id, o.corrigida_em IS NOT NULL AS corrigida, c.recebida_em
     FROM contribuicao c JOIN observacao o ON o.id = c.observacao_id
     WHERE o.removida_em IS NULL
       AND NOT EXISTS (SELECT 1 FROM decisao d WHERE d.alvo = 'contribuicao ' || c.id AND d.tipo IN ('aceitar_contribuicao', 'corrigir_contribuicao'))
     ORDER BY c.recebida_em DESC, c.id DESC LIMIT 50) x) AS contribuicoes,
  (SELECT count(*)::int FROM observacao) AS recebidas,
  (SELECT count(*)::int FROM observacao_recusada) AS recusadas,
  (SELECT count(*)::int FROM observacao WHERE removida_em IS NOT NULL) AS removidas`;

// Uma decisão é uma instrução só: o efeito (CTE alvo, que devolve o alvo e os dados guardados), o registro com data e
// motivo e, no duplicado confirmado, o vínculo que oculta um dos postos. $1 tipo, $2 motivo, $3 conta do Curador.
const decidir = (efeito: string) => `
WITH alvo AS (${efeito}),
d AS (
  INSERT INTO decisao (tipo, alvo, motivo, dados, curador_conta_id) SELECT $1::text, alvo, $2::text, dados, $3::int FROM alvo
  RETURNING id, tipo, alvo, dados, decidida_em
),
v AS (
  INSERT INTO vinculo_duplicado (oculto, mantido, decisao_id) SELECT dados->>'oculto', dados->>'mantido', id FROM d WHERE dados ? 'oculto'
  ON CONFLICT (oculto) DO UPDATE SET mantido = EXCLUDED.mantido, decisao_id = EXCLUDED.decisao_id
)
SELECT id, tipo, alvo, decidida_em FROM d`;

const DA_CONTRIBUICAO = `FROM contribuicao c JOIN observacao o ON o.id = c.observacao_id WHERE c.id = $4::int AND o.removida_em IS NULL`;
const EFEITOS = {
  aceitar_contribuicao: () => `SELECT 'contribuicao ' || c.id AS alvo, NULL::jsonb AS dados ${DA_CONTRIBUICAO}`,
  remover_contribuicao: () => `
    UPDATE observacao o SET removida_em = now(), motivo_remocao = $2::text FROM contribuicao c
    WHERE c.id = $4::int AND o.id = c.observacao_id AND o.removida_em IS NULL
    RETURNING 'contribuicao ' || c.id AS alvo, NULL::jsonb AS dados`,
  // Os valores originais vão para o registro da decisão; a observação fica com os corrigidos.
  corrigir_contribuicao: (campos: string[]) => `
    UPDATE observacao o SET ${campos.map((k, i) => `${k} = $${i + 5}`).join(', ')}, corrigida_em = now()
    FROM (SELECT o.id, c.id AS contribuicao, jsonb_build_object(${campos.map((k) => `'${k}', o.${k}`).join(', ')}) AS originais ${DA_CONTRIBUICAO}) antes
    WHERE o.id = antes.id
    RETURNING 'contribuicao ' || antes.contribuicao AS alvo, jsonb_build_object('originais', antes.originais) AS dados`,
  remover_foto: () => `DELETE FROM foto WHERE id = $4::uuid RETURNING 'foto ' || id AS alvo, NULL::jsonb AS dados`,
  resolver_reporte: () => `
    UPDATE reporte SET resolvido_em = now(), resolucao = $5::text, motivo_resolucao = $2::text WHERE id = $4::int AND resolvido_em IS NULL
    RETURNING 'reporte ' || id AS alvo,
              CASE WHEN $5::text = 'duplicado_confirmado' THEN jsonb_build_object('resolucao', $5::text, 'mantido', $6::text,
                     'oculto', CASE WHEN eletroposto_id = $6::text THEN outro_eletroposto_id ELSE eletroposto_id END)
                   ELSE jsonb_build_object('resolucao', $5::text) END AS dados`,
  bloquear_conta: () => `UPDATE conta SET bloqueada_em = now() WHERE id = $4::int AND bloqueada_em IS NULL RETURNING 'conta ' || id AS alvo, NULL::jsonb AS dados`,
};

@ApiTags('curador')
@UseFilters(ErrosV1)
@UseGuards(CuradorGuard)
@ApiBearerAuth()
@Controller('v1/curador')
export class CuradorController {
  constructor(private db: Db) {}

  @Get('fila')
  @ApiOperation({
    summary: 'Fila de moderação',
    description: 'Reportes abertos dos mais antigos, postos com mais reportes abertos, contribuições ainda sem decisão e as contagens de observações.',
  })
  @ApiOkResponse({ type: FilaCurador })
  @ApiUnauthorizedResponse({ type: Erro })
  @ApiForbiddenResponse({ type: Erro, description: 'Conta sem papel de Curador (erro papel_curador_necessario).' })
  async fila(): Promise<FilaCurador> {
    const [r] = await this.db.query(SQL_FILA);
    const iso = (t: string) => new Date(t).toISOString();
    return {
      reportes: r.reportes.map((x) => ({
        ...x,
        aberto_em: iso(x.aberto_em),
        envios: x.envios.map(({ foto_id, ...e }) => ({ ...e, foto: caminhoDaFoto(foto_id), enviado_em: iso(e.enviado_em) })),
      })),
      postos_com_mais_reportes: r.postos_com_mais_reportes,
      contribuicoes: r.contribuicoes.map(({ foto_id, ...c }) => ({ origem: 'observacao_motorista', ...c, foto: caminhoDaFoto(foto_id), recebida_em: iso(c.recebida_em) })),
      observacoes: { recebidas: r.recebidas, recusadas: r.recusadas, removidas: r.removidas },
    };
  }

  @Post('decisoes')
  @ApiOperation({
    summary: 'Registrar uma decisão',
    description:
      'Aceitar, corrigir ou remover uma contribuição, remover uma foto, resolver um reporte ou bloquear uma conta, sempre com motivo. ' +
      'Remover tira a contribuição da ficha. Corrigir faz a ficha mostrar os valores corrigidos e guarda os originais no registro. ' +
      'O duplicado confirmado oculta um dos dois postos no mapa e no planejador, sem fundir os dados. O motorista que reportou vê a resolução.',
  })
  @ApiCreatedResponse({ type: DecisaoRegistrada })
  @ApiBadRequestResponse({ type: Erro })
  @ApiUnauthorizedResponse({ type: Erro })
  @ApiForbiddenResponse({ type: Erro, description: 'Conta sem papel de Curador (erro papel_curador_necessario).' })
  @ApiNotFoundResponse({ type: Erro, description: 'Alvo inexistente ou já decidido (contribuição removida, reporte resolvido, conta já bloqueada).' })
  async decidir(@Body() p: PedidoDecisao, @Req() req): Promise<DecisaoRegistrada> {
    const base = [p.tipo, p.motivo, req.conta.id];
    let sql: string;
    let params: unknown[];
    if (p.tipo === 'corrigir_contribuicao') {
      const campos = CAMPOS_CORRIGIVEIS.filter((k) => p.valores[k] !== undefined);
      if (!campos.length) throw new BadRequestException('valores precisa trazer ao menos um campo corrigido');
      [sql, params] = [decidir(EFEITOS.corrigir_contribuicao(campos)), [...base, p.contribuicao_id, ...campos.map((k) => p.valores[k])]];
    } else if (p.tipo === 'resolver_reporte') {
      const [r] = await this.db.query('SELECT tipo, eletroposto_id, outro_eletroposto_id FROM reporte WHERE id = $1 AND resolvido_em IS NULL', [p.reporte_id]);
      if (!r) throw new NotFoundException('reporte não encontrado ou já resolvido');
      if (p.resolucao === 'duplicado_confirmado' && (r.tipo !== 'duplicado' || ![r.eletroposto_id, r.outro_eletroposto_id].includes(p.manter)))
        throw new BadRequestException('duplicado_confirmado vale só para reporte de duplicado, e manter precisa ser um dos dois postos');
      [sql, params] = [decidir(EFEITOS.resolver_reporte()), [...base, p.reporte_id, p.resolucao, p.manter ?? null]];
    } else {
      const alvo = { aceitar_contribuicao: p.contribuicao_id, remover_contribuicao: p.contribuicao_id, remover_foto: p.foto_id, bloquear_conta: p.conta_id }[p.tipo];
      [sql, params] = [decidir(EFEITOS[p.tipo]()), [...base, alvo]];
    }
    const [d] = await this.db.query(sql, params);
    if (!d) throw new NotFoundException('alvo não encontrado ou já decidido');
    return { ...d, decidida_em: d.decidida_em.toISOString() };
  }
}
