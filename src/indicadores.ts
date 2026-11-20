// Contas dos indicadores do Curador, sem banco, para os testes unitários. Fluxo no-core (§4 da arquitetura): o mais simples.

const diasEntre = (de: string, ate: string) => Math.round((Date.parse(ate) - Date.parse(de)) / 86_400_000);

function mediana(valores: number[]) {
  if (!valores.length) return null;
  const v = [...valores].sort((a, b) => a - b);
  const meio = Math.floor(v.length / 2);
  return v.length % 2 ? v[meio] : (v[meio - 1] + v[meio]) / 2;
}

// UC07 da obtenção: situação do corredor a partir das linhas da visão eletroposto no trecho. Lugar do Google nunca entra
// (RN18), e só a verificação própria torna o posto verificado e conta para preço e regras de cobrança (RN13).
export function situacaoDoCorredor(linhas: any[], hoje: string) {
  const postos = linhas
    .filter((l) => l.origem === 'open_charge_map' || l.origem === 'verificacao_propria')
    .map((l) => ({
      id: l.id,
      origem: l.origem,
      nome: l.nome,
      verificado: l.verificado === true,
      ultima_verificacao: l.verificado === true ? l.data_observacao : null,
      tem_preco: l.verificado === true && !!l.preco_observado,
      tem_regras_cobranca: l.verificado === true && !!l.regras_cobranca,
    }));
  const verificados = postos.filter((p) => p.verificado);
  const parcela = (n: number) => (postos.length ? n / postos.length : null);
  return {
    indicadores: {
      postos: postos.length,
      verificados: verificados.length,
      parcela_verificados: parcela(verificados.length),
      idade_mediana_ultima_verificacao_dias: mediana(verificados.map((p) => diasEntre(p.ultima_verificacao, hoje))),
      com_preco_e_regras: postos.filter((p) => p.tem_preco && p.tem_regras_cobranca).length,
      parcela_com_preco_e_regras: parcela(postos.filter((p) => p.tem_preco && p.tem_regras_cobranca).length),
    },
    postos,
  };
}
