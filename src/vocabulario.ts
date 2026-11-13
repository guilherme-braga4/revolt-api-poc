// Vocabulário do REVOLT, comum à obtenção e à API /v1. O app só vê estes nomes e valores, nunca os campos das fontes.
import { condicoesOcm } from './ocm.js';

export const TIPOS_CONECTOR = ['CCS2', 'CCS1', 'TIPO_2', 'TIPO_1', 'CHADEMO', 'GBT', 'TESLA', 'TOMADA', 'OUTRO', 'DESCONHECIDO'];
// Carga rápida: conector de corrente contínua. Provisório, a revisar com o Curador.
export const TIPOS_RAPIDA = ['CCS2', 'CCS1', 'CHADEMO'];
export const ORIGENS = ['open_charge_map', 'verificacao_propria', 'google'];
export const SITUACOES = ['operacional', 'fora_de_operacao', 'planejado', 'fechado_definitivamente', 'desconhecida'];
export const FUNCIONAMENTOS = ['funcionando', 'parcial', 'nao_funcionando', 'desativado', 'inexistente'];
export const ACESSOS = ['publico', 'restrito'];
export const PAGAMENTOS = ['cartao_credito', 'cartao_debito', 'nfc', 'somente_dinheiro'];

export const LICENCA_PROPRIA = 'Própria (REVOLT)';
export const CONDICOES_PROPRIA = 'Dado próprio do REVOLT, observado em campo pelo Curador.';
export const LICENCA_GOOGLE = 'Termos do Google Maps Platform';
export const CONDICOES_GOOGLE =
  'Exibir só em mapa do Google, com a atribuição do Google. Proibido ler por voz, usar em IA, repassar a terceiros ' +
  'ou guardar algo além do identificador e, por até 30 dias, da coordenada.';

// Condições de uso que acompanham todo item entregue (RN05 da obtenção, RNF-01). O app aplica estas regras sem
// precisar saber de qual fonte veio cada item.
export function condicoesDeUso(origem: string, provedor?: string, licenca?: string) {
  if (origem === 'google')
    return { licenca: LICENCA_GOOGLE, atribuicao: 'Google Maps', exibicao: 'somente_sobre_mapa_google', pode_ler_em_voz: false, pode_usar_em_ia: false, texto: CONDICOES_GOOGLE };
  if (origem === 'open_charge_map')
    return { licenca, atribuicao: `${provedor} via Open Charge Map`, exibicao: 'livre', pode_ler_em_voz: true, pode_usar_em_ia: true, texto: condicoesOcm(provedor, licenca) };
  return { licenca: LICENCA_PROPRIA, atribuicao: null, exibicao: 'livre', pode_ler_em_voz: true, pode_usar_em_ia: true, texto: CONDICOES_PROPRIA };
}

// Situação do posto segundo a última verificação em campo (mesma tradução da view eletroposto).
export const SITUACAO_POR_FUNCIONAMENTO = {
  funcionando: 'operacional',
  parcial: 'operacional',
  nao_funcionando: 'fora_de_operacao',
  desativado: 'fora_de_operacao',
  inexistente: 'fechado_definitivamente',
};

// Data no fuso de Brasília (AAAA-MM-DD). Toda data de item é um dia: o app mostra "hoje", "há 3 dias" (RNF-02).
export const diaEmBrasilia = (instante: Date | string) =>
  new Date(instante).toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });

export const NAO_VERIFICADO = { situacao: 'nao_verificado', data: null };
