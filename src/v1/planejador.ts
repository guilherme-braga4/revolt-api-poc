// Paradas e plano B de uma viagem (fluxo core). RN10 e RN11 do app; D-06 e D-07 da arquitetura.
// Só contas, sem banco nem rede: os testes unitários (teste/planejador.test.mjs) exercitam as regras daqui.

export type Coordenada = { lat: number; lng: number };

// O mínimo que o planejador precisa saber de um posto. Na API, é o pino do mapa.
export interface Posto {
  id: string;
  origem: string;
  situacao: string;
  conectores: string[] | null;
  localizacao: Coordenada;
}

// Posto perto da linha da rota. km: distância da origem até o ponto da linha mais perto do posto, medida sobre a linha.
// desvio_km: distância em linha reta do posto até a linha.
export interface PostoNaRota<T extends Posto = Posto> {
  posto: T;
  km: number;
  desvio_km: number;
}

export interface Parada<T extends Posto = Posto> {
  parada: PostoNaRota<T>;
  plano_b: PostoNaRota<T> | null;
}

// Perna da viagem mais longa que a autonomia: de um ponto de recarga (a origem ou uma parada) até o próximo posto
// compatível (ou o destino). distancia_km é o que a perna consome, com os desvios.
export interface TrechoSemCobertura {
  de_km: number;
  ate_km: number;
  distancia_km: number;
  inicio: Coordenada;
  fim: Coordenada;
}

// RN10: paradas e plano B só de postos do Open Charge Map e próprios. Lugar do Google nunca entra na conta, mesmo que chegue aqui.
export const ORIGENS_DE_PARADA = ['open_charge_map', 'verificacao_propria'];
// Posto fora de operação, fechado ou só planejado não serve de parada. Situação desconhecida serve: é a da maioria do OCM.
export const SITUACOES_DE_PARADA = ['operacional', 'desconhecida'];
// Dois postos a até 100 m são o mesmo posto (a regra dos 100 m da obtenção): um não é plano B do outro.
export const MESMO_POSTO_M = 100;

export const compativel = (p: Posto, conectores: string[]) =>
  ORIGENS_DE_PARADA.includes(p.origem) && SITUACOES_DE_PARADA.includes(p.situacao) && (p.conectores ?? []).some((c) => conectores.includes(c));

export function distanciaM(a: Coordenada, b: Coordenada) {
  const rad = Math.PI / 180;
  const h = Math.sin(((b.lat - a.lat) * rad) / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(((b.lng - a.lng) * rad) / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
}

// Ponto de partida ou de chegada de uma perna: a origem, uma parada ou o destino.
type Ponto = { km: number; desvio_km: number; localizacao: Coordenada; id?: string };
const ponto = (c: PostoNaRota): Ponto => ({ km: c.km, desvio_km: c.desvio_km, localizacao: c.posto.localizacao, id: c.posto.id });

// O que se gasta de autonomia de um ponto a outro: o trecho sobre a rota mais sair dela e voltar a ela. O desvio é em
// linha reta, sem o caminho real das ruas; com o limite de desvio de poucos km, a diferença é pequena.
const custo = (a: Ponto, b: Ponto) => Math.abs(b.km - a.km) + a.desvio_km + b.desvio_km;

// Ordem de preferência entre candidatos: mais adiante na rota, depois menor desvio, depois o identificador (resposta estável).
const maisAdiante = (a: PostoNaRota, b: PostoNaRota) => b.km - a.km || a.desvio_km - b.desvio_km || a.posto.id.localeCompare(b.posto.id);

// Plano B de uma parada (RN11): outro posto compatível que o motorista alcança se chegar à parada e ela não servir, com a
// autonomia que sobra lá. Entre os possíveis, o mais perto; empate, o mais adiante.
function planoB<T extends Posto>(parada: PostoNaRota<T>, de: Ponto, usaveis: PostoNaRota<T>[], autonomia: number) {
  const sobra = autonomia - custo(de, ponto(parada));
  const alvo = ponto(parada);
  let melhor: PostoNaRota<T> | null = null;
  for (const c of usaveis) {
    if (c.posto.id === parada.posto.id || c.posto.id === de.id) continue;
    if (distanciaM(c.posto.localizacao, parada.posto.localizacao) <= MESMO_POSTO_M) continue;
    const ida = custo(alvo, ponto(c));
    if (ida > sobra) continue;
    if (!melhor || ida < custo(alvo, ponto(melhor)) || (ida === custo(alvo, ponto(melhor)) && maisAdiante(c, melhor) < 0)) melhor = c;
  }
  return melhor;
}

// Escolhe as paradas ao longo da rota, da origem ao destino, saindo da origem com a autonomia informada.
// A cada perna: se o destino está ao alcance, acabou. Senão, entre os postos compatíveis ao alcance, fica o mais adiante que
// tem plano B; só quando nenhum tem, o mais adiante, sem plano B (o app avisa naquela parada). Sem nenhum posto ao alcance,
// a perna até o próximo posto compatível (ou o destino) vira trecho sem cobertura, e o plano segue de lá: esse posto é a
// parada seguinte, e vem sem plano B, porque nem ele está ao alcance.
export function planejarParadas<T extends Posto>(e: {
  candidatos: PostoNaRota<T>[];
  distancia_km: number;
  autonomia_km: number;
  conectores: string[];
  origem: Coordenada;
  destino: Coordenada;
}): { paradas: Parada<T>[]; trechos_sem_cobertura: TrechoSemCobertura[] } {
  const usaveis = e.candidatos.filter((c) => compativel(c.posto, e.conectores));
  const destino: Ponto = { km: e.distancia_km, desvio_km: 0, localizacao: e.destino };
  const paradas: Parada<T>[] = [];
  const trechos: TrechoSemCobertura[] = [];
  let atual: Ponto = { km: 0, desvio_km: 0, localizacao: e.origem };

  while (custo(atual, destino) > e.autonomia_km) {
    const adiante = usaveis.filter((c) => c.km > atual.km).sort(maisAdiante);
    const alcance = adiante.filter((c) => custo(atual, ponto(c)) <= e.autonomia_km);
    let escolhida: PostoNaRota<T>;
    let reserva: PostoNaRota<T> | null = null;
    if (alcance.length) {
      for (const c of alcance) {
        reserva = planoB(c, atual, usaveis, e.autonomia_km);
        if (reserva) {
          escolhida = c;
          break;
        }
      }
      escolhida ??= alcance[0];
    } else {
      // O próximo posto compatível na rota; empate no km, o de menor desvio.
      escolhida = adiante.reduce<PostoNaRota<T>>((a, c) => (!a || c.km < a.km || (c.km === a.km && c.desvio_km < a.desvio_km) ? c : a), undefined);
      const fim = escolhida ? ponto(escolhida) : destino;
      trechos.push({ de_km: atual.km, ate_km: fim.km, distancia_km: custo(atual, fim), inicio: atual.localizacao, fim: fim.localizacao });
      if (!escolhida) break;
    }
    paradas.push({ parada: escolhida, plano_b: reserva });
    atual = ponto(escolhida);
  }
  return { paradas, trechos_sem_cobertura: trechos };
}

// Linha codificada do Google (Encoded Polyline Algorithm, precisão de 5 casas) em coordenadas. Linha malformada é erro.
export function decodificarLinha(linha: string): Coordenada[] {
  const pontos: Coordenada[] = [];
  let i = 0;
  let lat = 0;
  let lng = 0;
  while (i < linha.length) {
    const deltas = [0, 0];
    for (const eixo of [0, 1]) {
      let valor = 0;
      let desloca = 0;
      let b: number;
      do {
        if (i >= linha.length) throw new Error('linha codificada cortada no meio de um ponto');
        b = linha.charCodeAt(i++) - 63;
        if (b < 0 || b > 63) throw new Error(`caractere inválido na linha codificada, posição ${i - 1}`);
        valor |= (b & 0x1f) << desloca;
        desloca += 5;
      } while (b >= 0x20);
      deltas[eixo] = valor & 1 ? ~(valor >> 1) : valor >> 1;
    }
    lat += deltas[0];
    lng += deltas[1];
    if (Math.abs(lat) > 90e5 || Math.abs(lng) > 180e5) throw new Error('coordenada fora dos limites na linha codificada');
    pontos.push({ lat: lat / 1e5, lng: lng / 1e5 });
  }
  return pontos;
}

// O link de rotas do Google Maps aceita até 9 paradas (3 no navegador do celular) e não precisa de chave nem gera custo.
export const MAX_PARADAS_NO_LINK = 9;

// Link público do Google Maps para a viagem (RF07). Sem origem, o Google Maps parte de onde o aparelho está.
export function linkGoogleMaps(destino: Coordenada, origem?: Coordenada, paradas: Coordenada[] = []) {
  const texto = (c: Coordenada) => `${c.lat},${c.lng}`;
  const p = new URLSearchParams({ api: '1' });
  if (origem) p.set('origin', texto(origem));
  p.set('destination', texto(destino));
  if (paradas.length) p.set('waypoints', paradas.slice(0, MAX_PARADAS_NO_LINK).map(texto).join('|'));
  p.set('travelmode', 'driving');
  return `https://www.google.com/maps/dir/?${p}`;
}
