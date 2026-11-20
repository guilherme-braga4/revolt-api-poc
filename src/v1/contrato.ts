// Contrato da API /v1: formas de pedido e de resposta. A especificação OpenAPI é gerada destas classes, e os testes
// de contrato (Newman) comparam cada resposta real com ela, recusando campo a mais ou a menos.
import { ApiProperty } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsBoolean, IsDefined, IsIn, IsInt, IsNumber, IsOptional, Max, Min, ValidateNested } from 'class-validator';
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

// Observação de motorista (RN15 do app, RF19 e RN20 da obtenção): nunca torna o posto verificado.
export class ConfirmacaoMotorista {
  @ApiProperty({ ...DIA, description: 'Dia da observação de motorista mais recente que o Curador não removeu.' }) data: string;
}

export class Pino {
  @ApiProperty({ description: 'ocm-<n>, propria-<n> ou google-<identificador>.', example: 'ocm-9001' }) id: string;
  @ApiProperty({ type: Localizacao }) localizacao: Localizacao;
  @ApiProperty({ type: String, nullable: true, description: 'null nos lugares de origem google (o nome só vem na ficha).' }) nome: string | null;
  @ApiProperty({ enum: SITUACOES }) situacao: string;
  @ApiProperty({ type: [String], enum: TIPOS_CONECTOR, nullable: true, description: 'Tipos de conector, para marcar a compatibilidade com o carro. null nos lugares de origem google.' })
  conectores: string[] | null;
  @ApiProperty({ type: Number, nullable: true, description: 'Maior potência nominal em kW. null quando desconhecida.' }) potencia_max_kw: number | null;
  @ApiProperty({
    type: String, enum: ['publico', 'restrito'], nullable: true,
    description: 'Acesso, o mesmo do filtro publico: a verificação em campo vence o tipo de uso do OCM. null quando não informado e nos lugares de origem google.',
  })
  acesso: string | null;
  @ApiProperty({
    type: Boolean, nullable: true,
    description: 'Posto gratuito, pela mesma regra do filtro gratuito sobre o texto do preço. null quando o preço não é informado e nos lugares de origem google.',
  })
  gratuito: boolean | null;
  @ApiProperty({ enum: ORIGENS, description: 'De onde vem o item. Define as condições de uso.' }) origem: string;
  @ApiProperty({ type: Verificacao }) verificacao: Verificacao;
  @ApiProperty({
    type: ConfirmacaoMotorista, nullable: true,
    description: 'Check-in de motorista (RN15 do app): mostrar "confirmado por motorista", à parte da verificação em campo. null quando não há.',
  })
  confirmacao_motorista: ConfirmacaoMotorista | null;
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

// O que um motorista observou no posto, sem o autor (RN12 do app). Nunca traz dado do Google (RN13 do app).
export class ContribuicaoNaFicha {
  @ApiProperty({ enum: ['observacao_motorista'], description: 'Origem da informação: distinta da verificação em campo do Curador (RN15 do app).' }) origem: string;
  @ApiProperty({ ...DIA, description: 'Dia da observação, informado pelo motorista (o check-in pode ser enviado depois, sem conexão).' }) data: string;
  @ApiProperty({ description: 'O motorista carregou.' }) carregou: boolean;
  @ApiProperty({ type: String, enum: TIPOS_CONECTOR, nullable: true, description: 'Conector usado.' }) conector: string | null;
  @ApiProperty({ type: Boolean, nullable: true, description: 'O carregador funcionou.' }) funcionou: boolean | null;
  @ApiProperty({ type: Number, nullable: true, description: 'Potência vista, em kW.' }) potencia_kw: number | null;
  @ApiProperty({ type: String, nullable: true, description: 'Preço visto, em texto livre.' }) preco: string | null;
  @ApiProperty({ enum: ['sim', 'nao'], description: 'O posto estava como o app informou.' }) estava_como_informado: string;
  @ApiProperty({ type: String, nullable: true, description: 'Caminho da foto (GET /v1/fotos/{id}), sem autor. null sem foto.', example: null })
  foto: string | null;
  @ApiProperty({ description: 'O Curador corrigiu valores desta observação; a ficha mostra os valores corrigidos.' }) corrigida: boolean;
}

export class Ficha {
  @ApiProperty({ example: 'ocm-9001' }) id: string;
  @ApiProperty({ type: Localizacao }) localizacao: Localizacao;
  @ApiProperty({ enum: ORIGENS }) origem: string;
  @ApiProperty({ type: Verificacao }) verificacao: Verificacao;
  @ApiProperty({ ...DIA, description: 'Dia da informação mais confiável. Na ficha de origem google, o dia da consulta.' }) atualizado_em: string;
  @ApiProperty({ type: CondicoesDeUso }) condicoes_de_uso: CondicoesDeUso;
  @ApiProperty({ type: Atributos }) atributos: Atributos;
  @ApiProperty({
    type: ConfirmacaoMotorista, nullable: true,
    description: 'Check-in de motorista mais recente (RN15 do app), à parte da verificação em campo. null quando não há.',
  })
  confirmacao_motorista: ConfirmacaoMotorista | null;
  @ApiProperty({ type: [ContribuicaoNaFicha], description: 'Até 10 observações de motoristas, das mais recentes, sem as removidas pelo Curador.' })
  contribuicoes: ContribuicaoNaFicha[];
  @ApiProperty({ type: String, nullable: true, description: 'Lugar de origem google que o Curador confirmou ser este posto (google-<identificador>). Ele não sai separado no mapa.' })
  lugar_vinculado: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'uri', description: 'Abre o lugar no Google Maps, sem consulta paga. Só na origem google.' })
  link_externo: string | null;
}

// ---------- Planejamento de viagem ----------

export class Ponto {
  @ApiProperty({ example: -23.19, minimum: -90, maximum: 90 })
  @IsNumber({ allowNaN: false, allowInfinity: false }) @Min(-90) @Max(90)
  lat: number;

  @ApiProperty({ example: -45.88, minimum: -180, maximum: 180 })
  @IsNumber({ allowNaN: false, allowInfinity: false }) @Min(-180) @Max(180)
  lng: number;
}

// Conector desconhecido ou "outro" não descreve um carro: não serve para escolher parada compatível.
export const CONECTORES_DE_CARRO = TIPOS_CONECTOR.filter((t) => !['OUTRO', 'DESCONHECIDO'].includes(t));

export class PedidoPlanejarViagem {
  @ApiProperty({ type: Ponto, description: 'Origem da viagem (WGS 84).' })
  @IsDefined() @ValidateNested() @Type(() => Ponto)
  origem: Ponto;

  @ApiProperty({ type: Ponto, description: 'Destino da viagem (WGS 84).', example: { lat: -22.52, lng: -44.1 } })
  @IsDefined() @ValidateNested() @Type(() => Ponto)
  destino: Ponto;

  @ApiProperty({
    type: [String],
    enum: CONECTORES_DE_CARRO,
    description: 'Conectores que o carro aceita. Só posto com pelo menos um deles vira parada ou plano B.',
    example: ['CCS2', 'TIPO_2'],
  })
  @IsArray() @ArrayMinSize(1) @ArrayUnique()
  @IsIn(CONECTORES_DE_CARRO, { each: true, message: `conectores aceita: ${CONECTORES_DE_CARRO.join(', ')}` })
  conectores: string[];

  @ApiProperty({
    description: 'Quantos km o carro anda com a carga de saída e com cada recarga. O planejador não guarda reserva: mande já descontada a margem que o motorista quer.',
    minimum: 10,
    maximum: 2000,
    example: 250,
  })
  @IsNumber({ allowNaN: false, allowInfinity: false }) @Min(10) @Max(2000)
  autonomia_km: number;
}

export class RotaGoogle {
  @ApiProperty({
    description: 'Linha da rota no formato codificado do Google (Encoded Polyline), só para desenhar sobre o mapa do Google. Não é guardada.',
    example: '_p~iF~ps|U_ulLnnqC_mqNvxq`@',
  })
  linha: string;
  @ApiProperty({ type: 'integer', description: 'Distância da rota do Google, em metros.', example: 287000 }) distancia_m: number;
  @ApiProperty({ type: 'integer', description: 'Duração da rota do Google sem trânsito, em segundos.', example: 12600 }) duracao_s: number;
  @ApiProperty({ enum: ['google'] }) origem: string;
  @ApiProperty({ type: CondicoesDeUso }) condicoes_de_uso: CondicoesDeUso;
}

export class PostoNaRota {
  @ApiProperty({ description: 'Distância aproximada desde a origem, em km, medida sobre a linha da rota até o ponto mais perto do posto.', example: 96.4 })
  km_na_rota: number;
  @ApiProperty({ description: 'Distância em linha reta do posto até a linha da rota, em km.', example: 0.8 }) desvio_km: number;
  @ApiProperty({ type: Pino, description: 'O posto, como no mapa. Sempre de origem open_charge_map ou verificacao_propria (RN10).' })
  eletroposto: Pino;
}

export class Parada extends PostoNaRota {
  @ApiProperty({ type: 'integer', description: 'Posição da parada na viagem, a partir de 1.', example: 1 }) ordem: number;
  @ApiProperty({
    type: PostoNaRota,
    nullable: true,
    description:
      'Plano B (RN11): outro posto compatível que o carro alcança com a autonomia que sobra ao chegar à parada, se ela não servir. ' +
      'É o mais perto da parada. null quando não há nenhum; aí aviso vem sem_plano_b.',
  })
  plano_b: PostoNaRota | null;
  @ApiProperty({ enum: ['sem_plano_b'], type: String, nullable: true, description: 'sem_plano_b: o app avisa nesta parada que não há alternativa ao alcance.' })
  aviso: string | null;
}

export class TrechoSemCobertura {
  @ApiProperty({ description: 'Onde o trecho começa, em km desde a origem: a origem ou a parada anterior, o último ponto de recarga.', example: 96.4 })
  de_km: number;
  @ApiProperty({ description: 'Onde o trecho acaba, em km desde a origem: o próximo posto compatível, ou o destino se não houver.', example: 175.2 })
  ate_km: number;
  @ApiProperty({ description: 'Quanto o trecho consome, em km, com os desvios até os postos. É maior que a autonomia.', example: 80.1 })
  distancia_km: number;
  @ApiProperty({ type: Localizacao, description: 'Coordenada do começo: a origem pedida ou o posto da parada anterior.' }) inicio: Localizacao;
  @ApiProperty({ type: Localizacao, description: 'Coordenada do fim: o próximo posto compatível ou o destino pedido.' }) fim: Localizacao;
}

export const MOTIVOS_LUGARES_GOOGLE = ['teto_atingido', 'desligada', 'fora_do_ar', 'sem_chave', 'erro_da_fonte', 'sem_rota'];

export class LugaresGoogleNaViagem {
  @ApiProperty({ description: 'true: a busca do Google ao longo da rota foi feita (a lista pode estar vazia). false: veja motivo.' })
  disponivel: boolean;
  @ApiProperty({
    enum: MOTIVOS_LUGARES_GOOGLE,
    type: String,
    nullable: true,
    description:
      'Por que não há lugares do Google: teto do mês atingido, camada desligada pelo Curador, Google fora do ar ou lento, consulta ' +
      'não configurada, consulta recusada pelo Google, ou sem rota entre os pontos. null quando disponível.',
  })
  motivo: string | null;
  @ApiProperty({ type: String, nullable: true, description: 'Texto para o app mostrar quando não disponível.' }) mensagem: string | null;
  @ApiProperty({
    type: [Pino],
    description:
      'Todos os lugares que a busca do Google devolveu ao longo da rota, na ordem do Google, inclusive os já vinculados a um posto ' +
      'próprio ou perto de um do OCM (Q14): o mesmo posto pode aparecer como parada e como lugar do Google. Origem google, não ' +
      'verificados, sem nome nem conectores (vêm na ficha), sem plano B e fora das paradas (RN10).',
  })
  eletropostos: Pino[];
}

export const MOTIVOS_VIAGEM = ['rota_indisponivel', 'sem_rota'];
export const CAUSAS_ROTA_INDISPONIVEL = ['teto_atingido', 'desligada', 'fora_do_ar', 'sem_chave', 'erro_da_fonte'];

export class RespostaPlanejarViagem {
  @ApiProperty({ description: 'true: a rota do Google veio e as paradas foram calculadas (as listas podem estar vazias). false: veja motivo.' })
  disponivel: boolean;
  @ApiProperty({
    enum: MOTIVOS_VIAGEM,
    type: String,
    nullable: true,
    description:
      'Por que não há paradas. rota_indisponivel: não foi possível obter a rota do Google agora (veja causa); sem rota não há ' +
      'paradas, e o app oferece link_externo, que abre só o destino no Google Maps. sem_rota: o Google não achou rota de carro ' +
      'entre a origem e o destino. null quando disponível.',
  })
  motivo: string | null;
  @ApiProperty({
    enum: CAUSAS_ROTA_INDISPONIVEL,
    type: String,
    nullable: true,
    description: 'Só com rota_indisponivel: teto do mês atingido, Google desligado pelo Curador, Google fora do ar ou lento, consulta não configurada ou recusada pelo Google.',
  })
  causa: string | null;
  @ApiProperty({ type: String, nullable: true, description: 'Texto para o app mostrar quando não disponível.' }) mensagem: string | null;
  @ApiProperty({ type: RotaGoogle, nullable: true, description: 'Rota do Google, só para desenhar sobre o mapa do Google. null quando não disponível.' })
  rota: RotaGoogle | null;
  @ApiProperty({
    type: [Parada],
    description:
      'Paradas sugeridas, na ordem da viagem, só com postos do OCM e próprios compatíveis com o carro (RN10), cada uma com plano B ' +
      'ou aviso (RN11). Vazia quando o destino está ao alcance da autonomia ou quando não disponível.',
  })
  paradas: Parada[];
  @ApiProperty({
    type: [TrechoSemCobertura],
    description: 'Trechos em que nenhum posto compatível está ao alcance da autonomia (UC04). A parada logo depois de um deles vem sem plano B.',
  })
  trechos_sem_cobertura: TrechoSemCobertura[];
  @ApiProperty({ type: LugaresGoogleNaViagem, description: 'Lugares do Google ao longo da mesma rota, separados das paradas (D-07).' })
  eletropostos_google: LugaresGoogleNaViagem;
  @ApiProperty({
    type: String,
    format: 'uri',
    description:
      'Abre a viagem no Google Maps por link público, sem consulta paga (RF07): origem, destino e as paradas (até 9; o navegador do ' +
      'celular aceita só 3). Sem rota, abre só o destino, partindo de onde o aparelho está.',
  })
  link_externo: string;
}

// ---------- Conta e erros ----------

export class Conta {
  @ApiProperty({ description: 'Identificador da conta no provedor de login.' }) id: string;
  @ApiProperty({ enum: ['motorista', 'curador'], description: 'curador: o app libera as telas de moderação (UC08).' }) papel: string;
  @ApiProperty({ description: 'Bloqueada pelo Curador: não contribui mais e usa o app como quem não tem conta (UC07).' }) bloqueada: boolean;
}

export class Erro {
  @ApiProperty({ example: 'pedido_invalido' }) erro: string;
  @ApiProperty() mensagem: string;
}

export class FichaIndisponivel {
  @ApiProperty({ enum: ['teto_atingido', 'desligada', 'fora_do_ar', 'sem_chave', 'erro_da_fonte', 'ritmo_de_robo', 'base_indisponivel'] }) erro: string;
  @ApiProperty() mensagem: string;
  @ApiProperty({ type: String, format: 'uri', description: 'Abre o lugar no Google Maps, sem consulta paga (RN20 do app).' }) link_externo: string;
}
