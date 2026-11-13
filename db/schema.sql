-- Esquema da POC. A API aplica este arquivo ao subir; tudo é idempotente.
CREATE EXTENSION IF NOT EXISTS postgis;

-- Cópia do Open Charge Map (RF01). Só registros abertos e que não citam o PlugShare.
CREATE TABLE IF NOT EXISTS ocm_posto (
  ocm_id integer PRIMARY KEY,
  provedor_id integer NOT NULL,
  provedor text NOT NULL,
  licenca text NOT NULL CHECK (licenca IN ('CC0', 'CC BY 4.0')),
  obtido_em timestamptz NOT NULL,
  titulo text,
  endereco text,
  operacional boolean,
  situacao text,
  local geography(Point, 4326) NOT NULL,
  dados jsonb NOT NULL -- registro como veio da fonte
);
CREATE INDEX IF NOT EXISTS ocm_posto_local ON ocm_posto USING gist (local);
-- Janela do mapa (/v1/mapa): retângulo em graus, por isso o índice é sobre a geometria.
CREATE INDEX IF NOT EXISTS ocm_posto_local_geom ON ocm_posto USING gist ((local::geometry));

-- Cada atualização da cópia, com contagens e falha visível ao Curador (RF02, UC01).
CREATE TABLE IF NOT EXISTS atualizacao_ocm (
  id serial PRIMARY KEY,
  iniciada_em timestamptz NOT NULL DEFAULT now(),
  terminada_em timestamptz,
  resultado text, -- ok | falha | ignorada
  motivo text,
  contagens jsonb
);

-- Registro próprio (UC04). ocm_id sem chave estrangeira: o registro continua se o OCM deixar de listar o posto.
CREATE TABLE IF NOT EXISTS posto_proprio (
  id serial PRIMARY KEY,
  ocm_id integer UNIQUE,
  google_place_id text UNIQUE, -- vínculo confirmado pelo Curador (RF08); nenhum outro campo do Google
  vinculado_em timestamptz,
  vinculado_por text,
  criado_em timestamptz NOT NULL DEFAULT now()
);

-- Verificações em campo (RF07). Uma nova não apaga as anteriores; a mais recente é a vigente (RN14).
CREATE TABLE IF NOT EXISTS verificacao (
  id serial PRIMARY KEY,
  posto_proprio_id integer NOT NULL REFERENCES posto_proprio (id),
  origem text NOT NULL CHECK (origem = 'campo'),
  licenca text NOT NULL DEFAULT 'Própria (REVOLT)',
  autor text NOT NULL,
  data_observacao date NOT NULL,
  registrada_em timestamptz NOT NULL DEFAULT now(),
  local geography(Point, 4326) NOT NULL,
  conectores jsonb,
  funcionamento text,
  preco text,
  regras_cobranca text,
  taxa_ociosidade text,
  pre_autorizacao text,
  app_exigido text,
  pagamento_sem_app boolean,
  acesso text
);

-- Do Google só o identificador (sem prazo) e a coordenada com data (até 30 dias) (RN06, RN07).
CREATE TABLE IF NOT EXISTS google_lugar (
  place_id text PRIMARY KEY,
  local geography(Point, 4326),
  coordenada_obtida_em timestamptz
);
CREATE INDEX IF NOT EXISTS google_lugar_local ON google_lugar USING gist (local);
CREATE INDEX IF NOT EXISTS google_lugar_local_geom ON google_lugar USING gist ((local::geometry));

-- Células da varredura do Google (seed e atualização diária). Substitui a busca por área na hora do pedido.
DROP TABLE IF EXISTS google_area;
CREATE TABLE IF NOT EXISTS google_celula (
  id serial PRIMARY KEY,
  lat_min numeric NOT NULL,
  lng_min numeric NOT NULL,
  tam numeric NOT NULL, -- lado em graus
  subdividida boolean NOT NULL DEFAULT false, -- a busca voltou cheia: as 4 partes são buscadas no lugar dela
  consultada_em timestamptz,
  lugares integer, -- quantos lugares a última busca devolveu
  UNIQUE (lat_min, lng_min, tam)
);

-- Cada consulta paga ao Google, para apurar o gasto do mês por tipo (RF09).
CREATE TABLE IF NOT EXISTS consulta_google (
  id serial PRIMARY KEY,
  tipo text NOT NULL, -- busca_area | ficha
  feita_em timestamptz NOT NULL DEFAULT now(),
  resultado text
);

-- Controle de fontes e do teto (RF09, RF10), com data e autor da última mudança.
CREATE TABLE IF NOT EXISTS fonte (
  nome text PRIMARY KEY CHECK (nome IN ('ocm', 'google', 'propria')),
  ligada boolean NOT NULL,
  alterada_em timestamptz NOT NULL DEFAULT now(),
  alterada_por text NOT NULL
);
INSERT INTO fonte (nome, ligada, alterada_por)
VALUES ('ocm', true, 'sistema'), ('google', true, 'sistema'), ('propria', true, 'sistema')
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS ocm_provedor (
  provedor_id integer PRIMARY KEY,
  ligado boolean NOT NULL,
  alterado_em timestamptz NOT NULL DEFAULT now(),
  alterado_por text NOT NULL
);

CREATE TABLE IF NOT EXISTS teto_google (
  id integer PRIMARY KEY CHECK (id = 1),
  valor_usd numeric NOT NULL,
  alterado_em timestamptz NOT NULL DEFAULT now(),
  alterado_por text NOT NULL
);
INSERT INTO teto_google (id, valor_usd, alterado_por)
VALUES (1, 50, 'Curador, decisão de 12/11/2026')
ON CONFLICT DO NOTHING;

-- Corredores verificados pelo Curador (RN05 do app): fora deles, o mapa avisa que a área não foi verificada.
-- Semente: a Via Dutra do Discovery, 85 pontos a cada 4 km, sem os 30 km urbanos de cada ponta, com 3 km de cada lado.
CREATE TABLE IF NOT EXISTS corredor_verificado (
  nome text PRIMARY KEY,
  area geometry NOT NULL, -- polígono em graus (SRID 4326)
  definido_em timestamptz NOT NULL DEFAULT now(),
  definido_por text NOT NULL
);
INSERT INTO corredor_verificado (nome, area, definido_por)
SELECT 'Via Dutra', ST_Buffer(ST_GeomFromText('SRID=4326;LINESTRING(
  -46.2944 -23.39776, -46.25971 -23.38119, -46.22608 -23.36485, -46.19078 -23.35174, -46.1544 -23.34108, -46.1202 -23.32361,
  -46.0822 -23.31725, -46.04535 -23.30761, -46.00813 -23.29711, -45.97619 -23.27632, -45.94406 -23.25576, -45.91402 -23.2329,
  -45.88654 -23.20728, -45.85462 -23.18705, -45.82035 -23.16974, -45.78604 -23.15246, -45.75173 -23.13518, -45.71747 -23.11782,
  -45.68495 -23.09796, -45.65364 -23.07641, -45.61944 -23.05901, -45.58369 -23.04482, -45.55838 -23.02896, -45.54019 -23.02512,
  -45.50837 -23.00438, -45.47404 -22.98719, -45.43976 -22.96994, -45.40546 -22.95272, -45.37117 -22.93548, -45.3369 -22.91823,
  -45.30325 -22.90007, -45.27265 -22.87776, -45.23811 -22.86405, -45.21829 -22.83434, -45.18596 -22.81991, -45.16243 -22.79203,
  -45.13166 -22.76991, -45.10088 -22.7478, -45.07006 -22.72578, -45.0392 -22.70378, -45.00835 -22.68178, -44.97727 -22.66127,
  -44.94674 -22.64173, -44.91375 -22.62445, -44.88825 -22.59942, -44.8661 -22.57434, -44.84089 -22.55935, -44.80652 -22.54838,
  -44.7739 -22.53721, -44.73753 -22.52627, -44.70153 -22.51496, -44.66591 -22.50062, -44.6331 -22.50153, -44.59474 -22.50473,
  -44.56006 -22.48999, -44.52528 -22.47526, -44.48878 -22.46497, -44.45077 -22.46112, -44.4401 -22.46011, -44.40143 -22.45632,
  -44.36267 -22.45299, -44.32392 -22.44956, -44.29043 -22.46056, -44.26099 -22.48173, -44.23005 -22.50023, -44.20177 -22.52308,
  -44.18261 -22.55116, -44.1526 -22.56053, -44.12238 -22.56475, -44.1008 -22.58964, -44.0643 -22.59007, -44.027 -22.5814,
  -43.99138 -22.5803, -43.95754 -22.58806, -43.93212 -22.60909, -43.90694 -22.63221, -43.88683 -22.66205, -43.85161 -22.66798,
  -43.82663 -22.66881, -43.82835 -22.68156, -43.80216 -22.6897, -43.76661 -22.69738, -43.73469 -22.71278, -43.69659 -22.71921,
  -43.65814 -22.7252)')::geography, 3000)::geometry, 'Discovery de 12/11/2026 (semente; o trecho é do Curador)'
ON CONFLICT DO NOTHING;

-- Visão de domínio: todos os eletropostos da base no vocabulário do REVOLT. É o que GET /eletropostos lê.
-- - Cópia do OCM. Um posto do OCM com verificação própria é uma linha só.
-- - Registro próprio: linha separada só quando não há posto do OCM ligado a ele na cópia (posto novo ou que saiu da fonte).
-- - Lugares do Google trazidos pela varredura, com coordenada de até 30 dias (RN07). Deles só há identificador e
--   coordenada: nome, endereço e conectores ficam vazios porque não podem ser guardados. duplicado_do_ocm marca o lugar
--   a menos de 100 m de um posto do OCM entregue (fonte e provedor ligados): é o mesmo posto e não sai na lista.
DROP VIEW IF EXISTS eletroposto;
CREATE VIEW eletroposto AS
WITH ultima AS (
  SELECT DISTINCT ON (v.posto_proprio_id) v.*, p.ocm_id, p.google_place_id
  FROM verificacao v JOIN posto_proprio p ON p.id = v.posto_proprio_id
  ORDER BY v.posto_proprio_id, v.data_observacao DESC, v.id DESC
)
SELECT 'ocm-' || o.ocm_id AS id,
       'open_charge_map' AS origem,
       o.titulo AS nome,
       o.endereco,
       ST_Y(o.local::geometry) AS lat,
       ST_X(o.local::geometry) AS lng,
       CASE
         WHEN o.situacao ILIKE 'planned%' THEN 'planejado'
         WHEN o.situacao ILIKE 'removed%' THEN 'fechado_definitivamente'
         WHEN o.situacao ILIKE 'temporarily%' THEN 'fora_de_operacao'
         WHEN o.operacional THEN 'operacional'
         WHEN NOT o.operacional THEN 'fora_de_operacao'
         ELSE 'desconhecida'
       END AS situacao,
       (SELECT coalesce(jsonb_agg(jsonb_build_object(
                 'tipo', CASE
                   WHEN t ILIKE 'CCS%Type 2%' THEN 'CCS2'
                   WHEN t ILIKE 'CCS%Type 1%' THEN 'CCS1'
                   WHEN t ILIKE '%CHAdeMO%' THEN 'CHADEMO'
                   WHEN t ILIKE 'Type 2%' THEN 'TIPO_2'
                   WHEN t ILIKE 'Type 1%' OR t ILIKE '%J1772%' THEN 'TIPO_1'
                   WHEN t ILIKE 'GB-T%' THEN 'GBT'
                   WHEN t ILIKE '%Tesla%' OR t ILIKE '%NACS%' THEN 'TESLA'
                   WHEN t ILIKE '%CEE%' OR t ILIKE '%IEC 60309%' OR t ILIKE '%Schuko%' OR t ILIKE '%NBR 14136%' THEN 'TOMADA'
                   WHEN t IS NULL OR t = 'Unknown' THEN 'DESCONHECIDO'
                   ELSE 'OUTRO'
                 END,
                 'potencia_kw', (c->>'PowerKW')::numeric,
                 'quantidade', (c->>'Quantity')::int)), '[]'::jsonb)
        FROM jsonb_array_elements(coalesce(o.dados->'Connections', '[]'::jsonb)) c,
             LATERAL (SELECT c->'ConnectionType'->>'Title' AS t) x) AS conectores,
       o.dados->>'UsageCost' AS preco,
       o.provedor_id,
       o.provedor,
       o.licenca,
       o.obtido_em AS data_fonte,
       u.posto_proprio_id IS NOT NULL AS verificado,
       u.data_observacao,
       u.autor,
       u.funcionamento,
       u.conectores AS conectores_observados,
       u.preco AS preco_observado,
       u.regras_cobranca,
       u.taxa_ociosidade,
       u.pre_autorizacao,
       u.app_exigido,
       u.pagamento_sem_app,
       u.acesso,
       u.google_place_id,
       u.posto_proprio_id,
       o.ocm_id,
       o.local,
       NULL::boolean AS duplicado_do_ocm,
       CASE WHEN o.dados->'UsageType'->>'Title' ILIKE 'public%' THEN 'publico'
            WHEN o.dados->'UsageType'->>'Title' ILIKE 'priv%' THEN 'restrito'
       END AS acesso_fonte -- tipo de uso informado pelo OCM, no vocabulário do REVOLT
FROM ocm_posto o
LEFT JOIN ultima u ON u.ocm_id = o.ocm_id
UNION ALL
SELECT 'propria-' || u.posto_proprio_id,
       'verificacao_propria',
       NULL,
       NULL,
       ST_Y(u.local::geometry),
       ST_X(u.local::geometry),
       CASE u.funcionamento
         WHEN 'funcionando' THEN 'operacional'
         WHEN 'parcial' THEN 'operacional'
         WHEN 'nao_funcionando' THEN 'fora_de_operacao'
         WHEN 'desativado' THEN 'fora_de_operacao'
         WHEN 'inexistente' THEN 'fechado_definitivamente'
         ELSE 'desconhecida'
       END,
       coalesce(u.conectores, '[]'::jsonb),
       u.preco,
       NULL,
       NULL,
       u.licenca,
       u.data_observacao::timestamptz,
       true,
       u.data_observacao,
       u.autor,
       u.funcionamento,
       u.conectores,
       u.preco,
       u.regras_cobranca,
       u.taxa_ociosidade,
       u.pre_autorizacao,
       u.app_exigido,
       u.pagamento_sem_app,
       u.acesso,
       u.google_place_id,
       u.posto_proprio_id,
       u.ocm_id,
       u.local,
       NULL,
       NULL
FROM ultima u
WHERE u.ocm_id IS NULL OR NOT EXISTS (SELECT 1 FROM ocm_posto o WHERE o.ocm_id = u.ocm_id)
UNION ALL
SELECT 'google-' || g.place_id,
       'google',
       NULL,
       NULL,
       ST_Y(g.local::geometry),
       ST_X(g.local::geometry),
       'desconhecida',
       '[]'::jsonb,
       NULL,
       NULL,
       NULL,
       'Termos do Google Maps Platform',
       g.coordenada_obtida_em,
       false,
       NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, -- observação própria: não há
       g.place_id,
       NULL,
       NULL,
       g.local,
       EXISTS (SELECT 1 FROM ocm_posto o
               WHERE ST_DWithin(o.local, g.local, 100) AND (SELECT ligada FROM fonte WHERE nome = 'ocm')
                 AND o.provedor_id NOT IN (SELECT provedor_id FROM ocm_provedor WHERE NOT ligado)),
       NULL
FROM google_lugar g
WHERE g.coordenada_obtida_em >= now() - interval '30 days';
