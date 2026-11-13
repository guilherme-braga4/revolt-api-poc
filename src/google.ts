import { Body, Controller, HttpCode, HttpException, Injectable, NotFoundException, Post } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { readFileSync } from 'node:fs';
import { Db } from './db.js';

// Tabela do Google de nov/2026, ainda não conferida na fatura (RF09).
const PRECOS = {
  busca_area: { sku: 'Nearby Search Pro (id e coordenada)', gratis_mes: 5000, usd_por_mil: 32 },
  ficha: { sku: 'Place Details Enterprise + Atmosphere', gratis_mes: 1000, usd_por_mil: 25 },
};
// Varredura: o país é dividido em células de 0,6°. Cada célula é coberta por um círculo de até ~47 km, abaixo do limite
// de 50 km da busca do Google. Se a busca volta cheia (20 lugares, o máximo), a célula é dividida em 4 e cada parte é buscada.
const TAM_CELULA = 0.6;
const TAM_MINIMO = 0.01;
const MAX_LUGARES = 20;
const LIMITE_DIARIO = 500;
// A coordenada só pode ficar guardada 30 dias (RN07): célula com lugares é refeita a cada 25. Célula vazia, a cada 90.
const DIAS_COM_LUGARES = 25;
const DIAS_VAZIA = 90;
const REGIAO = process.env.REGIAO_VARREDURA ?? 'db/brasil.geojson';
const CELULA_PENDENTE = `NOT subdividida AND (consultada_em IS NULL
  OR consultada_em < now() - make_interval(days => CASE WHEN lugares > 0 THEN ${DIAS_COM_LUGARES} ELSE ${DIAS_VAZIA} END))`;

// Só os campos da ficha, porque os campos pedidos definem o preço (RF05).
const CAMPOS_FICHA = 'id,displayName,formattedAddress,location,businessStatus,currentOpeningHours,evChargeOptions,paymentOptions,googleMapsUri';

@Injectable()
export class GoogleService {
  constructor(private db: Db) {}

  async gasto() {
    const [teto] = await this.db.query('SELECT valor_usd::float8 AS valor_usd, alterado_em, alterado_por FROM teto_google');
    const contagem = await this.db.query(
      `SELECT tipo, count(*)::int AS consultas FROM consulta_google WHERE feita_em >= date_trunc('month', now()) GROUP BY tipo`,
    );
    const por_tipo = Object.entries(PRECOS).map(([tipo, preco]) => {
      const consultas = contagem.find((c) => c.tipo === tipo)?.consultas ?? 0;
      return { tipo, ...preco, consultas, gasto_usd: (Math.max(0, consultas - preco.gratis_mes) * preco.usd_por_mil) / 1000 };
    });
    const gasto_usd = por_tipo.reduce((soma, t) => soma + t.gasto_usd, 0);
    const teto_atingido = gasto_usd >= teto.valor_usd;
    return {
      mes: new Date().toISOString().slice(0, 7),
      teto_usd: teto.valor_usd,
      teto_alterado_em: teto.alterado_em,
      teto_alterado_por: teto.alterado_por,
      gasto_usd,
      teto_atingido,
      aviso: teto_atingido ? 'Teto de gasto com o Google atingido: nenhuma consulta nova será feita.' : null,
      por_tipo,
    };
  }

  // Toda chamada ao Google passa por aqui: confere fonte e teto antes, registra a consulta paga depois.
  private async chamar(tipo: keyof typeof PRECOS, url: string, init: RequestInit) {
    if (!(await this.db.fonteLigada('google'))) return { motivo: 'desligada' };
    if (!process.env.GOOGLE_PLACES_API_KEY) return { motivo: 'sem_chave' };
    const gasto = await this.gasto();
    const t = gasto.por_tipo.find((p) => p.tipo === tipo);
    const custoDaProxima = t.consultas + 1 > t.gratis_mes ? t.usd_por_mil / 1000 : 0;
    if (gasto.gasto_usd + custoDaProxima >= gasto.teto_usd) return { motivo: 'teto_atingido' }; // RN15

    let resposta: Response;
    try {
      resposta = await fetch(url, init);
    } catch {
      resposta = null;
    }
    await this.db.query('INSERT INTO consulta_google (tipo, resultado) VALUES ($1, $2)', [tipo, resposta ? String(resposta.status) : 'sem_resposta']);
    if (!resposta || resposta.status >= 500) return { motivo: 'fora_do_ar' };
    return { resposta };
  }

  // Uma busca do Google num círculo. Guarda só identificador e coordenada com data (RN06, RN07).
  private async buscarCirculo(lat: number, lng: number, raio_m: number): Promise<{ lugares?: number; motivo?: string }> {
    const r = await this.chamar('busca_area', `${process.env.GOOGLE_PLACES_URL}/places:searchNearby`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': process.env.GOOGLE_PLACES_API_KEY,
        'X-Goog-FieldMask': 'places.id,places.location',
      },
      body: JSON.stringify({
        includedTypes: ['electric_vehicle_charging_station'],
        maxResultCount: MAX_LUGARES,
        locationRestriction: { circle: { center: { latitude: lat, longitude: lng }, radius: raio_m } },
      }),
    });
    if (!r.resposta) return { motivo: r.motivo };
    if (!r.resposta.ok) return { motivo: `erro_${r.resposta.status}` };

    const { places = [] } = await r.resposta.json();
    await this.db.query(
      `INSERT INTO google_lugar (place_id, local, coordenada_obtida_em)
       SELECT p->>'id', ST_SetSRID(ST_MakePoint((p->'location'->>'longitude')::float8, (p->'location'->>'latitude')::float8), 4326)::geography, now()
       FROM jsonb_array_elements($1::jsonb) p
       WHERE (SELECT ligada FROM fonte WHERE nome = 'google') -- busca em voo durante uma exclusão não regrava nada
       ON CONFLICT (place_id) DO UPDATE SET local = EXCLUDED.local, coordenada_obtida_em = EXCLUDED.coordenada_obtida_em`,
      [JSON.stringify(places)],
    );
    return { lugares: places.length };
  }

  // Seed e atualização diária dos lugares do Google: busca as células vencidas, uma a uma, até o limite de chamadas.
  // Para na primeira recusa (fonte desligada, teto, sem chave, Google fora do ar). A célula recusada continua pendente.
  async varrer(limite: number) {
    const regiao = readFileSync(new URL(`../${REGIAO}`, import.meta.url), 'utf8');
    // Na primeira vez, cria a grade de células que tocam a região (o contorno do Brasil do IBGE). O contorno é simplificado
    // e corta trechos do litoral (Copacabana fica 10 km fora dele): a folga de 0,1° (~11 km) evita perder essas células.
    await this.db.query(
      `INSERT INTO google_celula (lat_min, lng_min, tam)
       SELECT round(i * t, 6), round(j * t, 6), t
       FROM (SELECT ST_Buffer(ST_GeomFromGeoJSON($1), 0.1) AS g, $2::numeric AS t) r,
            generate_series(floor(ST_YMin(g) / t)::int, floor(ST_YMax(g) / t)::int) i,
            generate_series(floor(ST_XMin(g) / t)::int, floor(ST_XMax(g) / t)::int) j
       WHERE ST_Intersects(g, ST_MakeEnvelope(j * t, i * t, (j + 1) * t, (i + 1) * t, 4326))
         AND NOT EXISTS (SELECT 1 FROM google_celula)`,
      [regiao, TAM_CELULA],
    );

    // cheias_no_minimo: células do menor tamanho que voltaram cheias; ali pode haver mais de 20 lugares que não entram.
    const resultado = { consultadas: 0, subdivididas: 0, cheias_no_minimo: 0, lugares_recebidos: 0, parada: null as string, pendentes: 0 };
    while (resultado.consultadas < limite) {
      const [c] = await this.db.query(
        `SELECT id, lat_min::float8 AS lat_min, lng_min::float8 AS lng_min, tam::float8 AS tam FROM google_celula
         WHERE ${CELULA_PENDENTE}
         ORDER BY consultada_em NULLS FIRST, id LIMIT 1`,
      );
      if (!c) break;

      // Raio que cobre a célula inteira: metade da diagonal, com o grau de longitude da borda mais perto do equador.
      const latEquador = c.lat_min <= 0 && c.lat_min + c.tam >= 0 ? 0 : Math.min(Math.abs(c.lat_min), Math.abs(c.lat_min + c.tam));
      const meioKm = (c.tam / 2) * 111.32;
      const raio_m = Math.ceil(Math.hypot(meioKm, meioKm * Math.cos((latEquador * Math.PI) / 180)) * 1000);
      const r = await this.buscarCirculo(c.lat_min + c.tam / 2, c.lng_min + c.tam / 2, raio_m);
      if (r.motivo) {
        resultado.parada = r.motivo;
        break;
      }
      resultado.consultadas++;
      resultado.lugares_recebidos += r.lugares;

      const dividir = r.lugares >= MAX_LUGARES && c.tam / 2 >= TAM_MINIMO;
      if (r.lugares >= MAX_LUGARES && !dividir) resultado.cheias_no_minimo++;
      await this.db.query('UPDATE google_celula SET consultada_em = now(), lugares = $2, subdividida = $3 WHERE id = $1', [c.id, r.lugares, dividir]);
      if (dividir) {
        resultado.subdivididas++;
        await this.db.query(
          // As 4 partes, sem recorte pelo contorno: a mãe voltou cheia, então há lugares ali. Só se a mãe ainda existe
          // (uma exclusão dos dados do Google no meio da rodada apaga as células).
          `INSERT INTO google_celula (lat_min, lng_min, tam)
           SELECT round(lat + i * t, 6), round(lng + j * t, 6), round(t, 6)
           FROM (SELECT $2::numeric AS lat, $3::numeric AS lng, $4::numeric AS t) p, generate_series(0, 1) i, generate_series(0, 1) j
           WHERE EXISTS (SELECT 1 FROM google_celula WHERE id = $1)
           ON CONFLICT DO NOTHING`,
          [c.id, c.lat_min, c.lng_min, c.tam / 2],
        );
      }
    }

    [{ pendentes: resultado.pendentes }] = await this.db.query(
      `SELECT count(*)::int AS pendentes FROM google_celula
       WHERE ${CELULA_PENDENTE}`,
    );
    if (!resultado.parada && resultado.pendentes > 0) resultado.parada = 'limite';
    return resultado;
  }

  // O diário só roda depois que o seed foi disparado à mão (POST /google/varredura): subir a API não gera chamada paga.
  @Cron('0 5 * * *')
  async varrerDiario() {
    const [{ n }] = await this.db.query('SELECT count(*)::int AS n FROM google_celula');
    if (n > 0) return this.varrer(LIMITE_DIARIO);
  }

  // RF05: a ficha vem do Google na hora, é entregue e descartada (RN08). Só a coordenada é renovada.
  async ficha(placeId: string) {
    const [guardado] = await this.db.query('SELECT 1 FROM google_lugar WHERE place_id = $1', [placeId]);
    if (!guardado) throw new NotFoundException({ disponivel: false, motivo: 'lugar_nao_guardado' });

    const r = await this.chamar('ficha', `${process.env.GOOGLE_PLACES_URL}/places/${encodeURIComponent(placeId)}?languageCode=pt-BR&regionCode=BR`, {
      headers: { 'X-Goog-Api-Key': process.env.GOOGLE_PLACES_API_KEY, 'X-Goog-FieldMask': CAMPOS_FICHA },
    });
    if (!r.resposta) throw new HttpException({ disponivel: false, motivo: r.motivo }, 503);
    if (r.resposta.status === 404) {
      await this.db.query('DELETE FROM google_lugar WHERE place_id = $1', [placeId]);
      throw new NotFoundException({ disponivel: false, motivo: 'lugar_inexistente_no_google' });
    }
    if (!r.resposta.ok) throw new HttpException({ disponivel: false, motivo: `erro_${r.resposta.status}` }, 502);

    const ficha = await r.resposta.json();
    await this.db.query(
      `UPDATE google_lugar SET local = ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography, coordenada_obtida_em = now() WHERE place_id = $1`,
      [placeId, ficha.location.longitude, ficha.location.latitude],
    );
    return ficha;
  }

  // RF06: apaga coordenadas com mais de 30 dias e mantém o identificador.
  @Cron('0 4 * * *')
  async expirar() {
    const apagadas = await this.db.query(
      `UPDATE google_lugar SET local = NULL, coordenada_obtida_em = NULL
       WHERE coordenada_obtida_em < now() - interval '30 days' RETURNING place_id`,
    );
    return { apagadas: apagadas.length, place_ids: apagadas.map((a) => a.place_id) };
  }
}

class Varredura {
  @IsOptional() @IsInt() @Min(1) @Max(20000) limite?: number;
}

@Controller('google')
export class GoogleController {
  constructor(private google: GoogleService) {}

  // Disparo manual da varredura: o seed inicial passa um limite alto; o diário roda sozinho às 5h.
  @Post('varredura')
  @HttpCode(200)
  varrer(@Body() b: Varredura) {
    return this.google.varrer(b.limite ?? LIMITE_DIARIO);
  }

  // Disparo manual da expiração diária (POC).
  @Post('expirar')
  @HttpCode(200)
  expirar() {
    return this.google.expirar();
  }
}
