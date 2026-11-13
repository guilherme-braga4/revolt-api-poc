// Contrato da API /v1: formas de pedido e de resposta. A especificação OpenAPI é gerada destas classes, e os testes
// de contrato (Newman) comparam cada resposta real com ela, recusando campo a mais ou a menos.
import { ApiProperty } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsBoolean, IsIn, IsInt, IsNumber, IsOptional, Max, Min } from 'class-validator';
import { ACESSOS, FUNCIONAMENTOS, ORIGENS, PAGAMENTOS, SITUACOES, TIPOS_CONECTOR } from '../vocabulario.js';

const DIA = { type: String, format: 'date', example: '2026-11-12' };
const comoBooleano = ({ value }) => (value === 'true' ? true : value === 'false' ? false : value);
const comoLista = ({ value }) => (typeof value === 'string' ? value.split(',').filter(Boolean) : value);

// ---------- Pedido do mapa ----------

export class PedidoMapa {
  @ApiProperty({
    description: 'Janela visível do mapa: oeste,sul,leste,norte (longitude e latitude em graus, WGS 84). O que passa dos limites do mundo é recortado.',
    example: '-45.93,-23.24,-45.83,-23.14',
    type: String,
  })
  @Transform(({ value }) => String(value).split(',').map(Number))
  @IsNumber({ allowNaN: false, allowInfinity: false }, { each: true, message: 'bbox precisa ser oeste,sul,leste,norte em graus' })
  @ArrayMinSize(4) @ArrayMaxSize(4)
  bbox: number[];

  @ApiProperty({ description: 'Zoom do mapa do Google (0 a 22).', example: 14, type: 'integer' })
  @Type(() => Number) @IsInt() @Min(0) @Max(22)
  zoom: number;

  @ApiProperty({
    required: false,
    description: 'Perfil do carro: tipos de conector aceitos, separados por vírgula. Esconde os postos sem nenhum deles e os de conector desconhecido.',
    example: 'CCS2,TIPO_2',
    type: String,
  })
  @IsOptional() @Transform(comoLista) @IsIn(TIPOS_CONECTOR, { each: true, message: `conectores aceita: ${TIPOS_CONECTOR.join(', ')}` })
  conectores?: string[];

  @ApiProperty({ required: false, description: 'Potência mínima em kW. Esconde os postos abaixo dela e os de potência desconhecida.', example: 50, type: Number })
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0.1)
  potencia_min?: number;

  @ApiProperty({ required: false, description: 'Só carga rápida: pelo menos um conector CCS2, CCS1 ou CHADEMO.', type: Boolean })
  @IsOptional() @Transform(comoBooleano) @IsBoolean()
  rapida?: boolean;

  @ApiProperty({ required: false, description: 'Só acesso público. Esconde os restritos e os de acesso desconhecido.', type: Boolean })
  @IsOptional() @Transform(comoBooleano) @IsBoolean()
  publico?: boolean;

  @ApiProperty({ required: false, description: 'Só gratuitos, pelo preço informado. Esconde os pagos e os de preço desconhecido.', type: Boolean })
  @IsOptional() @Transform(comoBooleano) @IsBoolean()
  gratuito?: boolean;
}

// ---------- Partes comuns dos itens ----------

export class Localizacao {
  @ApiProperty({ example: -23.19 }) lat: number;
  @ApiProperty({ example: -45.88 }) lng: number;
}

export class CondicoesDeUso {
  @ApiProperty({ description: 'Licença ou termos da fonte.', example: 'CC BY 4.0' }) licenca: string;
  @ApiProperty({ type: String, nullable: true, description: 'Crédito que o app mostra com o dado. null quando não há.', example: 'Open Charge Map Contributors via Open Charge Map' })
  atribuicao: string | null;
  @ApiProperty({ enum: ['livre', 'somente_sobre_mapa_google'], description: 'Onde o item pode aparecer. Lugares de origem google só sobre o mapa do Google, com o logo.' })
  exibicao: string;
  @ApiProperty({ description: 'false: o item nunca é lido em voz (RN07 do app).' }) pode_ler_em_voz: boolean;
  @ApiProperty({ description: 'false: o item nunca entra em recurso de IA (RN07 do app).' }) pode_usar_em_ia: boolean;
  @ApiProperty({ description: 'As condições por extenso.' }) texto: string;
}

export class Verificacao {
  @ApiProperty({ enum: ['verificado', 'nao_verificado'], description: 'Só observação em campo do Curador torna o posto verificado.' }) situacao: string;
  @ApiProperty({ ...DIA, nullable: true, description: 'Dia da observação em campo vigente. null quando não verificado.' }) data: string | null;
}

// ---------- Resposta do mapa ----------

export class Pino {
  @ApiProperty({ description: 'ocm-<n>, propria-<n> ou google-<identificador>.', example: 'ocm-9001' }) id: string;
  @ApiProperty({ type: Localizacao }) localizacao: Localizacao;
  @ApiProperty({ type: String, nullable: true, description: 'null nos lugares de origem google (o nome só vem na ficha).' }) nome: string | null;
  @ApiProperty({ enum: SITUACOES }) situacao: string;
  @ApiProperty({ type: [String], enum: TIPOS_CONECTOR, nullable: true, description: 'Tipos de conector, para marcar a compatibilidade com o carro. null nos lugares de origem google.' })
  conectores: string[] | null;
  @ApiProperty({ type: Number, nullable: true, description: 'Maior potência nominal em kW. null quando desconhecida.' }) potencia_max_kw: number | null;
  @ApiProperty({ enum: ORIGENS, description: 'De onde vem o item. Define as condições de uso.' }) origem: string;
  @ApiProperty({ type: Verificacao }) verificacao: Verificacao;
  @ApiProperty({ ...DIA, description: 'Dia da informação mais confiável: a verificação em campo, se houver; senão, o dia em que a fonte foi obtida.' })
  atualizado_em: string;
  @ApiProperty({ type: CondicoesDeUso }) condicoes_de_uso: CondicoesDeUso;
}

export class Grupo {
  @ApiProperty({ type: Localizacao, description: 'Centro dos postos do grupo.' }) localizacao: Localizacao;
  @ApiProperty({ type: 'integer', description: 'Quantidade de postos do OCM e próprios no grupo. Nunca inclui lugares de origem google.', example: 12 })
  quantidade: number;
  @ApiProperty({ type: [Number], description: 'Extensão dos postos do grupo (oeste,sul,leste,norte), para aproximar ao tocar.', minItems: 4, maxItems: 4 })
  bbox: number[];
}

export class OcultosPorMotivo {
  @ApiProperty({ type: 'integer' }) conector: number;
  @ApiProperty({ type: 'integer' }) potencia: number;
  @ApiProperty({ type: 'integer' }) rapida: number;
  @ApiProperty({ type: 'integer' }) publico: number;
  @ApiProperty({ type: 'integer' }) gratuito: number;
}

export class OcultosSemContagem {
  @ApiProperty({ description: 'Há lugares de origem google na janela que não aparecem. Nunca vem com número (RN08 do app).' }) ha_ocultos: boolean;
  @ApiProperty({ enum: ['filtro', 'zoom'], type: String, nullable: true, description: 'filtro: algum filtro está ativo; zoom: só aparecem a partir do zoom alto.' })
  motivo: string | null;
}

export class Ocultos {
  @ApiProperty({ type: 'integer', description: 'Postos do OCM e próprios da janela escondidos pelos filtros.' }) total: number;
  @ApiProperty({ type: OcultosPorMotivo, description: 'Quantos cada filtro esconde. Um posto escondido por dois filtros conta nos dois.' })
  por_motivo: OcultosPorMotivo;
  @ApiProperty({ type: OcultosSemContagem }) sem_contagem: OcultosSemContagem;
}

export class SituacaoFonte {
  @ApiProperty({ enum: ORIGENS }) origem: string;
  @ApiProperty({ enum: ['ligada', 'desligada', 'nao_autorizada'], description: 'nao_autorizada: o pedido não veio do app atestado e não recebe dados do Google.' })
  situacao: string;
}

export class Janela {
  @ApiProperty({ type: [Number], minItems: 4, maxItems: 4 }) bbox: number[];
  @ApiProperty({ type: 'integer' }) zoom: number;
}

export class RespostaMapa {
  @ApiProperty({ type: Janela }) janela: Janela;
  @ApiProperty({ type: [Pino], description: 'Postos um a um. Lugares de origem google só a partir do zoom alto e sem nenhum filtro ativo.' }) pinos: Pino[];
  @ApiProperty({ type: [Grupo], description: 'Agrupamentos por grade abaixo do zoom alto.' }) grupos: Grupo[];
  @ApiProperty({ type: Ocultos }) ocultos: Ocultos;
  @ApiProperty({
    enum: ['filtro_ativo', 'zoom_insuficiente', 'fonte_indisponivel', 'fora_do_corredor', 'nenhum_posto_conhecido'],
    type: String,
    nullable: true,
    description: 'Motivo do mapa vazio (RN03 do app). null quando há pino ou grupo.',
  })
  mapa_vazio: string | null;
  @ApiProperty({ description: 'A janela toca um corredor verificado pelo Curador. false: mostrar o aviso de área não verificada (RN05 do app).' })
  corredor_verificado: boolean;
  @ApiProperty({ type: [SituacaoFonte] }) fontes: SituacaoFonte[];
}

// ---------- Ficha ----------

export class Conector {
  @ApiProperty({ enum: TIPOS_CONECTOR }) tipo: string;
  @ApiProperty({ type: Number, nullable: true }) potencia_kw: number | null;
  @ApiProperty({ type: Number, nullable: true }) quantidade: number | null;
}

export class Carregador {
  @ApiProperty({ enum: TIPOS_CONECTOR }) tipo: string;
  @ApiProperty({ type: Boolean, nullable: true }) funcionou: boolean | null;
  @ApiProperty({ type: Number, nullable: true, description: 'null quando não houve recarga (nunca zero).' }) potencia_observada_kw: number | null;
}

export class Acesso {
  @ApiProperty({ enum: ACESSOS }) tipo: string;
  @ApiProperty({ type: String, nullable: true, description: 'Tipo de restrição, quando restrito.' }) restricao: string | null;
}

export class DisponibilidadeConector {
  @ApiProperty({ enum: TIPOS_CONECTOR }) tipo: string;
  @ApiProperty({ type: Number, nullable: true }) disponiveis: number | null;
  @ApiProperty({ type: Number, nullable: true }) fora_de_operacao: number | null;
}

export class Disponibilidade {
  @ApiProperty({ type: [DisponibilidadeConector] }) conectores: DisponibilidadeConector[];
  @ApiProperty({ type: String, format: 'date-time', description: 'Horário da informação. Sem horário, a disponibilidade não é entregue (RN02 do app).' })
  informada_em: string;
}

// Cada atributo da ficha diz de onde veio e de quando é (RF04 do app). valor null = "não informado".
function atributo(nome: string, valor: Record<string, unknown>, descricao?: string) {
  class Atributo {
    @ApiProperty({ ...valor, nullable: true, description: descricao ?? 'null = não informado.' }) valor: unknown;
    @ApiProperty({ enum: ORIGENS, type: String, nullable: true }) origem: string | null;
    @ApiProperty({ ...DIA, nullable: true }) data: string | null;
  }
  Object.defineProperty(Atributo, 'name', { value: nome });
  return Atributo;
}
const AtributoTexto = atributo('AtributoTexto', { type: String });
const AtributoBooleano = atributo('AtributoBooleano', { type: Boolean });
const AtributoSituacao = atributo('AtributoSituacao', { type: String, enum: SITUACOES });
const AtributoFuncionamento = atributo('AtributoFuncionamento', { type: String, enum: FUNCIONAMENTOS });
const AtributoConectores = atributo('AtributoConectores', { type: [Conector] });
const AtributoCarregadores = atributo('AtributoCarregadores', { type: [Carregador] }, 'Funcionamento e potência observados por carregador.');
const AtributoAcesso = atributo('AtributoAcesso', { type: Acesso });
const AtributoHorario = atributo('AtributoHorario', { type: [String] }, 'Horário de funcionamento, um texto por dia.');
const AtributoPagamento = atributo('AtributoPagamento', { type: [String], enum: PAGAMENTOS });
const AtributoDisponibilidade = atributo('AtributoDisponibilidade', { type: Disponibilidade });

export class Atributos {
  @ApiProperty({ type: AtributoTexto }) nome: unknown;
  @ApiProperty({ type: AtributoTexto }) endereco: unknown;
  @ApiProperty({ type: AtributoSituacao }) situacao: unknown;
  @ApiProperty({ type: AtributoConectores, description: 'Conectores e potência nominal.' }) conectores: unknown;
  @ApiProperty({ type: AtributoFuncionamento, description: 'Funcionamento do posto na verificação em campo.' }) funcionamento: unknown;
  @ApiProperty({ type: AtributoCarregadores }) carregadores: unknown;
  @ApiProperty({ type: AtributoTexto }) preco: unknown;
  @ApiProperty({ type: AtributoTexto }) regras_cobranca: unknown;
  @ApiProperty({ type: AtributoTexto }) taxa_ociosidade: unknown;
  @ApiProperty({ type: AtributoTexto }) pre_autorizacao: unknown;
  @ApiProperty({ type: AtributoTexto }) app_exigido: unknown;
  @ApiProperty({ type: AtributoBooleano }) pagamento_sem_app: unknown;
  @ApiProperty({ type: AtributoAcesso }) acesso: unknown;
  @ApiProperty({ type: AtributoHorario }) horario: unknown;
  @ApiProperty({ type: AtributoPagamento }) pagamento: unknown;
  @ApiProperty({ type: AtributoDisponibilidade }) disponibilidade: unknown;
}

export class Ficha {
  @ApiProperty({ example: 'ocm-9001' }) id: string;
  @ApiProperty({ type: Localizacao }) localizacao: Localizacao;
  @ApiProperty({ enum: ORIGENS }) origem: string;
  @ApiProperty({ type: Verificacao }) verificacao: Verificacao;
  @ApiProperty({ ...DIA, description: 'Dia da informação mais confiável. Na ficha de origem google, o dia da consulta.' }) atualizado_em: string;
  @ApiProperty({ type: CondicoesDeUso }) condicoes_de_uso: CondicoesDeUso;
  @ApiProperty({ type: Atributos }) atributos: Atributos;
  @ApiProperty({ type: String, nullable: true, description: 'Lugar de origem google que o Curador confirmou ser este posto (google-<identificador>). Ele não sai separado no mapa.' })
  lugar_vinculado: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'uri', description: 'Abre o lugar no Google Maps, sem consulta paga. Só na origem google.' })
  link_externo: string | null;
}

// ---------- Conta e erros ----------

export class Conta {
  @ApiProperty({ description: 'Identificador da conta no provedor de login.' }) id: string;
}

export class Erro {
  @ApiProperty({ example: 'pedido_invalido' }) erro: string;
  @ApiProperty() mensagem: string;
}

export class FichaIndisponivel {
  @ApiProperty({ enum: ['teto_atingido', 'desligada', 'fora_do_ar', 'sem_chave', 'erro_da_fonte', 'ritmo_de_robo'] }) erro: string;
  @ApiProperty() mensagem: string;
  @ApiProperty({ type: String, format: 'uri', description: 'Abre o lugar no Google Maps, sem consulta paga (RN20 do app).' }) link_externo: string;
}
