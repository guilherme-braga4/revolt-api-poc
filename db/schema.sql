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

-- Visão de domínio: os eletropostos internalizados na base (cópia do OCM e registros próprios), no vocabulário do REVOLT.
-- É a base de GET /eletropostos, que acrescenta os lugares do Google (esses não são internalizados).
-- Um posto do OCM com verificação própria é uma linha só; o registro próprio vira linha separada só quando
-- não há posto do OCM ligado a ele na cópia (posto novo ou que saiu da fonte).
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
       o.local
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
       u.local
FROM ultima u
WHERE u.ocm_id IS NULL OR NOT EXISTS (SELECT 1 FROM ocm_posto o WHERE o.ocm_id = u.ocm_id);
