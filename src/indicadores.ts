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

// RN21 do app: os indicadores não identificam motoristas. Cada grupo chega do banco já agregado, sem autor; com menos de
// MINIMO_MOTORISTAS motoristas distintos, sai sem números, só marcado como suprimido.
export const MINIMO_MOTORISTAS = 5;

function semIdentificar(motoristas: number, numeros: Record<string, number | null>) {
  const suprimido = motoristas < MINIMO_MOTORISTAS;
  const saida: Record<string, number | boolean | null> = {};
  for (const [nome, valor] of Object.entries(numeros)) saida[nome] = suprimido ? null : valor;
  saida.suprimido = suprimido;
  return saida;
}

type Grupo = { motoristas: number; dados_ate: string | null };

// RF15 do app: parcela das chegadas em que o posto estava como o app informou (o indicador principal) e check-ins por
// semana no corredor. Cada indicador traz o dia mais recente dos dados usados.
export function indicadoresDoApp(chegadas: Grupo & { chegadas: number; como_informado: number }, semanas: (Grupo & { semana: string; checkins: number })[]) {
  return {
    minimo_motoristas_por_grupo: MINIMO_MOTORISTAS,
    como_informado: {
      ...semIdentificar(chegadas.motoristas, {
        chegadas: chegadas.chegadas,
        como_informado: chegadas.como_informado,
        parcela: chegadas.chegadas ? chegadas.como_informado / chegadas.chegadas : null,
      }),
      dados_ate: chegadas.dados_ate,
    },
    checkins_por_semana_no_corredor: {
      semanas: semanas.map((s) => ({ semana: s.semana, ...semIdentificar(s.motoristas, { checkins: s.checkins }) })),
      dados_ate: semanas.map((s) => s.dados_ate).sort().pop() ?? null,
    },
  };
}
