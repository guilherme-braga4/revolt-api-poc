import { BadGatewayException, Controller, Get, HttpCode, Injectable, Post } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Db } from './db.js';

// Condições de uso que acompanham cada posto do OCM entregue (RN05).
export function condicoesOcm(provedor: string, licenca: string) {
  return licenca === 'CC0'
    ? `Domínio público (CC0). Crédito recomendado: "${provedor}" via Open Charge Map.`
    : `Atribuição obrigatória (CC BY 4.0): "${provedor}" via Open Charge Map, indicando se o dado foi alterado.`;
}

// Só CC0 e CC BY 4.0 entram (RN03). Qualquer outra licença devolve null.
function licencaAberta(provedor: any): string | null {
  if (!provedor?.IsOpenDataLicensed) return null;
  if (/CC-?0|public domain/i.test(provedor.License)) return 'CC0'; // o OCM escreve "CC0" e "CC-0"
  if (/CC[ -]?BY 4\.0|Attribution 4\.0/i.test(provedor.License)) return 'CC BY 4.0';
  return null;
}

@Injectable()
export class OcmService {
  constructor(private db: Db) {}

  // Atualização diária (RF02). A falha fica registrada em atualizacao_ocm.
  @Cron('0 3 * * *')
  async atualizacaoDiaria() {
    await this.atualizar();
  }

  async atualizar() {
    const [registro] = await this.db.query('INSERT INTO atualizacao_ocm DEFAULT VALUES RETURNING id');
    if (!(await this.db.fonteLigada('ocm'))) return this.terminar(registro.id, 'ignorada', 'fonte ocm desligada', null);

    try {
      const url = `${process.env.OCM_URL}/poi?countrycode=BR&opendata=true&maxresults=10000&compact=false&verbose=false`;
      const resposta = await fetch(url, { headers: { 'X-API-Key': process.env.OCM_API_KEY } });
      if (!resposta.ok) throw new Error(`OCM respondeu ${resposta.status}`);
      const recebidos: any[] = await resposta.json();

      const desligados = (await this.db.query('SELECT provedor_id FROM ocm_provedor WHERE NOT ligado')).map((p) => p.provedor_id);
      const descartados = { licenca_nao_aberta: 0, cita_plugshare: 0, provedor_desligado: 0, sem_coordenada: 0 };
      const aceitos = [];
      for (const poi of recebidos) {
        const licenca = licencaAberta(poi.DataProvider);
        const a = poi.AddressInfo ?? {};
        if (!licenca) descartados.licenca_nao_aberta++;
        else if (JSON.stringify(poi).toLowerCase().includes('plugshare')) descartados.cita_plugshare++; // RN04, qualquer campo
        else if (desligados.includes(poi.DataProviderID)) descartados.provedor_desligado++;
        else if (a.Latitude == null || a.Longitude == null) descartados.sem_coordenada++;
        else
          aceitos.push({
            ocm_id: poi.ID,
            provedor_id: poi.DataProviderID,
            provedor: poi.DataProvider.Title,
            licenca,
            titulo: a.Title,
            endereco: [a.AddressLine1, a.Town, a.StateOrProvince].filter(Boolean).join(', '),
            operacional: poi.StatusType?.IsOperational ?? null,
            situacao: poi.StatusType?.Title ?? null,
            lat: a.Latitude,
            lng: a.Longitude,
            dados: poi,
          });
      }

      // Troca atômica: a cópia nova só substitui a anterior se tudo der certo (RF02).
      const cliente = await this.db.pool.connect();
      try {
        await cliente.query('BEGIN');
        await cliente.query('CREATE TEMP TABLE novo (LIKE ocm_posto) ON COMMIT DROP');
        await cliente.query(
          `INSERT INTO novo (ocm_id, provedor_id, provedor, licenca, obtido_em, titulo, endereco, operacional, situacao, local, dados)
           SELECT (r->>'ocm_id')::int, (r->>'provedor_id')::int, r->>'provedor', r->>'licenca', now(), r->>'titulo', r->>'endereco',
                  (r->>'operacional')::boolean, r->>'situacao',
                  ST_SetSRID(ST_MakePoint((r->>'lng')::float8, (r->>'lat')::float8), 4326)::geography, r->'dados'
           FROM jsonb_array_elements($1::jsonb) r`,
          [JSON.stringify(aceitos)],
        );
        const {
          rows: [mudancas],
        } = await cliente.query(
          `SELECT count(*) FILTER (WHERE o.ocm_id IS NULL)::int AS novos,
                  count(*) FILTER (WHERE o.dados <> n.dados)::int AS alterados,
                  (SELECT count(*)::int FROM ocm_posto WHERE ocm_id NOT IN (SELECT ocm_id FROM novo)) AS retirados
           FROM novo n LEFT JOIN ocm_posto o USING (ocm_id)`,
        );
        await cliente.query('DELETE FROM ocm_posto');
        await cliente.query('INSERT INTO ocm_posto SELECT * FROM novo');
        await cliente.query('COMMIT');
        return this.terminar(registro.id, 'ok', null, { recebidos: recebidos.length, aceitos: aceitos.length, descartados, ...mudancas });
      } catch (erro) {
        await cliente.query('ROLLBACK');
        throw erro;
      } finally {
        cliente.release();
      }
    } catch (erro) {
      return this.terminar(registro.id, 'falha', String(erro.message ?? erro), null);
    }
  }

  private async terminar(id: number, resultado: string, motivo: string, contagens: object) {
    const [registro] = await this.db.query(
      'UPDATE atualizacao_ocm SET terminada_em = now(), resultado = $2, motivo = $3, contagens = $4 WHERE id = $1 RETURNING *',
      [id, resultado, motivo, contagens],
    );
    return registro;
  }
}

@Controller('ocm')
export class OcmController {
  constructor(
    private ocm: OcmService,
    private db: Db,
  ) {}

  // Disparo manual da atualização diária (POC).
  @Post('atualizar')
  @HttpCode(200)
  async atualizar() {
    const registro = await this.ocm.atualizar();
    if (registro.resultado === 'falha') throw new BadGatewayException(registro);
    return registro;
  }

  @Get('atualizacoes')
  atualizacoes() {
    return this.db.query('SELECT * FROM atualizacao_ocm ORDER BY id DESC LIMIT 20');
  }
}
