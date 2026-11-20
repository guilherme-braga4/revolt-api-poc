// Observação de motorista (Alteração 6 do PRD de obtenção: UC09, RF19 e RN20). O módulo app repassa cada check-in como
// observação, com autor pseudônimo e a data da observação. Ela nunca torna o posto verificado e nunca traz dado do Google.
import type { ValidationError } from 'class-validator';

// Por que uma observação é recusada, a partir dos erros de validação do pedido (lista fechada de campos) e do dia de hoje
// em Brasília (AAAA-MM-DD). null: aceita. O autor vem da conta: sem conta, o pedido nem chega aqui (401).
export function motivoDaRecusa(erros: ValidationError[], dataObservacao: unknown, hoje: string): string | null {
  // Campo fora da lista, como nome, endereço ou avaliação copiados do Google (RN13 do app).
  if (erros.some((e) => e.constraints?.whitelistValidation)) return 'campo_nao_aceito';
  if (erros.some((e) => e.property === 'data_observacao')) return dataObservacao == null ? 'sem_data' : 'data_invalida';
  if (erros.length) return 'pedido_invalido';
  if (String(dataObservacao) > hoje) return 'data_futura';
  return null;
}

// O posto existe na base: cópia do OCM, registro próprio ou lugar do Google guardado (mesmo com a coordenada vencida, o
// identificador fica). $1 identificador como o mapa e a ficha entregam.
export const SQL_ELETROPOSTO_EXISTE = `
  SELECT CASE
    WHEN $1 ~ '^ocm-\\d+$' THEN EXISTS (SELECT 1 FROM ocm_posto WHERE ocm_id = substr($1, 5)::int)
    WHEN $1 ~ '^propria-\\d+$' THEN EXISTS (SELECT 1 FROM posto_proprio WHERE id = substr($1, 9)::int)
    WHEN $1 LIKE 'google-%' THEN EXISTS (SELECT 1 FROM google_lugar WHERE place_id = substr($1, 8))
    ELSE false
  END AS existe`;
