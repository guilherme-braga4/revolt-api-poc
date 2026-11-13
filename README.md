# REVOLT · API de eletropostos (POC e /v1)

API que obtém, guarda e entrega dados de eletropostos do Open Charge Map (OCM), do Google Places (só identificador e coordenada, por varredura) e da verificação própria em campo. Desde a Fase 0 da arquitetura, entrega ao app do motorista pelo contrato `/v1`.

- Fontes de verdade:
  - PRD "Obtenção dos Dados dos Eletropostos", versão 0.5, aprovado em 12/11/2026;
  - PRD "App do Motorista", versão 0.2, aprovado em 12/11/2026;
  - Arquitetura TO-BE do app do motorista, versão 0.3: decisões D-02 (evoluir esta POC), D-03 (pinos por janela), D-04 (login gerenciado) e D-09 (atestado do app e trava contra robô).
- Esta base ainda é a POC evoluída: a obtenção (OCM, varredura, verificação) não foi reescrita como a implementação final das Alterações do PRD de obtenção.
- NestJS 12, TypeScript 7, Postgres 17 com PostGIS, Node 24.

## Subir

```bash
docker compose up -d --wait
npm install
cp .env.example .env   # cole as chaves no .env; ele não é versionado
npm start              # API em http://localhost:3333
```

O esquema do banco é criado pela própria API ao subir (`db/schema.sql`).

## Ver os eletropostos no DBeaver

Use a conexão PostgreSQL **REVOLT POC**:

| Campo | Valor |
|---|---|
| Host | `localhost` |
| Porta | `5433` (a 5432 é de outro container) |
| Banco | `revolt` (o dos testes é `revolt_teste`) |
| Usuário | `revolt` |
| Senha | `revolt_local` |

Os eletropostos internalizados na base estão na view **`eletroposto`** (revolt → Schemas → public → Views). A view já fala o vocabulário do REVOLT. Ela junta as três origens: a cópia do OCM, os registros próprios, com a última verificação de cada um, e os lugares do Google trazidos pela varredura.

```sql
-- Contagem por origem
SELECT origem, count(*) AS total, count(*) FILTER (WHERE duplicado_do_ocm) AS duplicados_do_ocm
FROM eletroposto GROUP BY origem;

-- O que o App vê (sem os lugares do Google colados a um posto do OCM)
SELECT id, origem, nome, situacao, lat, lng, provedor, verificado
FROM eletroposto
WHERE NOT coalesce(duplicado_do_ocm, false)
ORDER BY origem, nome;
```

- Do Google a base guarda só o identificador e a coordenada. Por isso as linhas `google` vêm com `nome`, conectores e endereço vazios, e a situação é `desconhecida`. A ficha completa só existe no detalhe da API, buscada na hora e não gravada.
- A coluna `duplicado_do_ocm` marca o lugar do Google a menos de 100 m de um posto do OCM entregue. O App não mostra esse lugar. Nas outras origens a coluna é nula.
- A view só mostra coordenadas do Google com até 30 dias, como pedem os termos. As tabelas de origem são `google_lugar` (identificador e coordenada) e `google_celula` (andamento da varredura).
- A view não aplica as chaves de fonte e de provedor. A API aplica, e por isso a contagem do App pode ficar um pouco abaixo da view.
- As colunas `local` são `geography`. Para ver a coordenada, use `ST_AsText(local)`. A view também traz `lat` e `lng`.
- As tabelas cruas continuam disponíveis para conferência: `ocm_posto`, `posto_proprio`, `verificacao` etc.
- A tabela `corredor_verificado` guarda as áreas que o Curador já percorreu. Hoje tem só a Via Dutra: os 85 pontos do Discovery com folga de 3 km. O mapa avisa quando a janela está fora dela.

## O que o app chama: contrato /v1

O app usa só os caminhos sob `/v1`, em JSON e no vocabulário do REVOLT. Nenhum campo do OCM ou do Google chega ao app com o nome da fonte. O formato exato está na especificação OpenAPI gerada pela própria API:

- versionada em `openapi/v1.json`, regenerada com `npm run openapi` (o `npm test` reprova se ela estiver diferente do que a API serve);
- servida em `GET /v1/openapi.json`, com a página navegável em `/v1/docs`.

| Método e caminho | O que faz | Autenticação |
|---|---|---|
| `GET /v1/mapa?bbox=&zoom=` e filtros | Pinos e grupos da janela do mapa, lidos só da base. Nunca consulta fonte externa. | Atestado do app para receber lugares do Google |
| `GET /v1/eletropostos/:id` | Ficha de um posto. Com `google-…`, a ficha vem do Google na hora, é traduzida e não é gravada. | Atestado do app para a ficha do Google |
| `GET /v1/conta` | Confere o token da conta e devolve o identificador. Base das rotas com conta das fases 2 e 3. | Conta |

**Mapa (`GET /v1/mapa`)**

- `bbox=oeste,sul,leste,norte` em graus e `zoom` de 0 a 22. A janela pode ter até 8 blocos de 256 px de lado no zoom pedido; acima disso, 400. O que passar dos limites do mundo é recortado.
- Filtros: `conectores=CCS2,TIPO_2`, `potencia_min=50` (kW), `rapida=true` (CCS2, CCS1 ou CHAdeMO), `publico=true` e `gratuito=true`. Posto sem o dado que o filtro pede fica oculto e entra na contagem daquele filtro.
- A partir do zoom 13, os postos vêm um a um, e os lugares do Google entram só sem filtro e com atestado válido. Abaixo do zoom 13, o servidor junta os postos do OCM e próprios numa grade de 4×4 células por bloco: célula com um posto vira pino, com mais vira grupo com `quantidade` e `bbox`. Lugar do Google nunca entra em grupo nem em contagem.
- `ocultos`: `total` e `por_motivo` contam os postos do OCM e próprios escondidos pelos filtros (um posto escondido por dois filtros conta nos dois). `sem_contagem` avisa, sem número, que há lugares do Google escondidos pelo filtro ou pelo zoom.
- `mapa_vazio`, quando não há pino nem grupo: `filtro_ativo`, `zoom_insuficiente`, `fonte_indisponivel`, `fora_do_corredor` ou `nenhum_posto_conhecido`, nessa ordem de precedência.
- `corredor_verificado` diz se a janela toca a área já percorrida. `fontes` diz se cada fonte está `ligada`, `desligada` ou `nao_autorizada` (Google sem atestado).

Todo pino traz `origem`, `verificacao`, `atualizado_em` e `condicoes_de_uso`:

```json
{
  "id": "ocm-9001",
  "localizacao": { "lat": -23.19, "lng": -45.88 },
  "nome": "Posto exemplo",
  "situacao": "operacional",
  "conectores": ["CCS2"],
  "potencia_max_kw": 60,
  "origem": "open_charge_map",
  "verificacao": { "situacao": "verificado", "data": "2026-11-10" },
  "atualizado_em": "2026-11-10",
  "condicoes_de_uso": {
    "licenca": "CC BY 4.0",
    "atribuicao": "Open Charge Map Contributors via Open Charge Map",
    "exibicao": "livre",
    "pode_ler_em_voz": true,
    "pode_usar_em_ia": true,
    "texto": "…"
  }
}
```

- O lugar do Google no mapa traz só `id`, `localizacao` e os quatro campos; `nome`, `conectores` e `potencia_max_kw` vêm nulos. As condições dele dizem `exibicao: somente_sobre_mapa_google`, sem voz e sem IA, com atribuição "Google Maps".
- Datas de item são dias (`AAAA-MM-DD`, horário de Brasília). A disponibilidade do Google traz `informada_em` com a hora.

**Ficha (`GET /v1/eletropostos/:id`)**

- `id` é `ocm-<id do OCM>`, `propria-<id do registro próprio>` ou `google-<place_id>`.
- Cada atributo vem como `{ "valor", "origem", "data" }`. `valor: null` quer dizer "não informado". A verificação em campo vigente vence o dado da fonte, atributo por atributo.
- `lugar_vinculado` aponta o lugar do Google que o Curador confirmou ser o mesmo posto. `link_externo` abre o lugar no Google Maps, sem consulta paga, e só existe na ficha do Google.
- Ficha do Google sem atestado: 401. Muitas fichas seguidas no mesmo aparelho: 429. Teto atingido, Google desligado ou fora do ar: 503. Nos dois últimos casos a resposta traz `link_externo`, para o app oferecer o Google Maps.

Todo erro da `/v1` sai como `{ "erro", "mensagem" }`.

### Autenticação (D-04 e D-09)

A API não guarda senha. Ela só valida tokens assinados (RS256), conferindo a chave publicada, o emissor e o público.

- **Conta** (`Authorization: Bearer <token>`): token do login gerenciado. Exigida só para contribuir.
- **Atestado do app** (`X-Atestado-App: <token>`): prova que o pedido vem do app do REVOLT. Sem ele, o mapa não traz lugares do Google e a ficha do Google é recusada (RN18 da obtenção).
- **Trava contra robô:** cada aparelho (cabeçalho `X-Aparelho`, gerado pelo app na instalação; sem ele, o IP) pode abrir até `LIMITE_FICHAS_GOOGLE` fichas do Google a cada 10 minutos. Não é limite por pessoa.

| Variável | Produção (Firebase), a conferir na Fase 1 |
|---|---|
| `CONTA_JWKS_URL` | `https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com` |
| `CONTA_EMISSOR` | `https://securetoken.google.com/<id do projeto>` |
| `CONTA_PUBLICO` | `<id do projeto>` |
| `ATESTADO_JWKS_URL` | `https://firebaseappcheck.googleapis.com/v1/jwks` |
| `ATESTADO_EMISSOR` | `https://firebaseappcheck.googleapis.com/<número do projeto>` |
| `ATESTADO_PUBLICO` | `projects/<número do projeto>` |
| `LIMITE_FICHAS_GOOGLE` | `60` |

Com `ATESTADO_JWKS_URL` vazio, o atestado fica desligado e a API avisa no log. Serve só para desenvolvimento local. Com `CONTA_JWKS_URL` vazio, nenhuma conta é aceita.

### Testar a API do app

A coleção **"REVOLT · App (POC)"** roda contra a API local com a base real: especificação, mapa no zoom alto, mapa do Brasil no zoom 4, mapa com filtro e a ficha de um posto do OCM.

1. Suba a API com `npm start`.
2. No Postman, escolha o environment **"REVOLT API POC · local (base real)"**, que aponta para `http://localhost:3333`.
3. Rode os pedidos da coleção. Pelo terminal, rode `npm run test:app`.

- **Testes:** toda resposta passa pela mesma conferência de contrato da coleção de testes. Os testes conferem o formato, não os valores, porque a base real muda a cada atualização do OCM.
- **Somente leitura e sem custo:** a coleção não apaga nem altera nada e não abre ficha do Google, a única consulta paga (1.000 gratuitas por mês, dentro do teto de US$ 50).
- **Atenção:** não rode a coleção de testes "REVOLT · API (obtenção e /v1)" no environment local. Ela apaga dados e desligaria fontes na base real.

### Medir o mapa

```bash
node --env-file=.env scripts/medir-mapa.mjs http://localhost:3333 30
```

Pede janelas em volta de postos reais nos zooms 4 a 16, no tamanho de um celular e no máximo permitido, com gzip, e mostra o tempo (p50, p95, máximo) e o tamanho comprimido. Medição de 12/11/2026 numa cópia da base real (2.416 postos do OCM e 10.019 lugares do Google), com 30 janelas por caso: p95 de até 59 ms e no máximo 37 KB comprimidos, contra o limite de 1 s e 150 KB da RNF-04. A visão do Brasil no zoom 4 caiu de 6,5 MB em 1,5 s para 4,7 KB em 58 ms.

## Importar o OCM e pedir uma área

```bash
curl -X POST localhost:3333/ocm/atualizar
curl "localhost:3333/v1/mapa?bbox=-45.93,-23.24,-45.83,-23.14&zoom=14"
curl localhost:3333/v1/eletropostos/ocm-481262
```

A primeira linha importa o Brasil inteiro do acesso ao vivo do OCM. A segunda pede o mapa de São José dos Campos, na Via Dutra. A terceira abre a ficha de um posto.

- A atualização do OCM roda sozinha todo dia às 3h. O `POST /ocm/atualizar` é o disparo manual.
- O pedido de área nunca consulta o Google. Os lugares do Google entram na base pela varredura, descrita abaixo.

## Varredura do Google (seed e atualização diária)

```bash
curl -X POST localhost:3333/google/varredura -H 'Content-Type: application/json' -d '{"limite": 5000}'
```

- **Como funciona:** o Brasil (contorno do IBGE, `db/brasil.geojson`, com folga de ~11 km porque o contorno simplificado corta trechos do litoral) é dividido em células de 0,6°. Cada célula é coberta por uma busca do Google num círculo de até 47 km, que pede só identificador e coordenada. Quando a busca volta cheia (20 lugares, o máximo do Google), a célula é dividida em 4 e cada parte é buscada. Abaixo de 0,01° a célula não é mais dividida, e o resultado da rodada conta essas células em `cheias_no_minimo`: ali pode haver mais de 20 lugares que não entram.
- **Seed:** é o disparo manual acima. O `limite` é o número máximo de buscas desta rodada. A rodada para antes do limite se a fonte estiver desligada, se o teto for atingido ou se o Google falhar, e o que faltou fica pendente para a próxima.
- **Atualização diária:** roda sozinha às 5h, com até 500 buscas, e **só depois que o seed foi disparado à mão**. Subir a API não gera chamada paga.
  - Célula com lugares é refeita a cada 25 dias, porque a coordenada só pode ficar guardada 30.
  - Célula vazia é refeita a cada 90 dias.
- **Custo:** cada busca é uma Nearby Search Pro, a US$ 32 por mil, com 5.000 gratuitas por mês, e conta no teto de US$ 50. O seed do Brasil deve ficar entre 2.200 e 4.000 buscas, dependendo de quantas células voltarem cheias. Acompanhe em `GET /controle/gasto`.
- **Termos do Google:** guardar o identificador sem prazo e a coordenada por até 30 dias é permitido. Varrer o país para pré-carregar esses dados não é autorizado pelos termos do Google Maps Platform ("pre-fetch, index", seção 3.2.3). O risco foi aceito pelo produto em 12/11/2026. A exibição continua obrigada a usar mapa do Google, com atribuição.

## Endpoints do Curador e da operação

Estes endpoints não são para o app. **Eles ainda não têm autenticação:** antes de publicar a API, precisam ficar atrás da conta com papel de Curador (Fase 3) ou fora da internet.

| Método e caminho | O que faz | RF |
|---|---|---|
| `POST /ocm/atualizar` | Importa o Brasil do OCM e troca a cópia de uma vez. Responde 502 se falhar. | RF01, RF02 |
| `GET /ocm/atualizacoes` | Últimas atualizações, com contagens e motivo das falhas. | RF02 |
| `POST /google/varredura` | Seed e atualização dos lugares do Google por células. Corpo opcional: `{ "limite": n }`. | RF04, RF06 |
| `POST /google/expirar` | Apaga coordenadas do Google com mais de 30 dias. Também roda todo dia às 4h. | RF06 |
| `POST /verificacoes` | Registra uma verificação em campo: de um posto do OCM (`ocm_id`), de um registro próprio (`posto_proprio_id`) ou de um posto novo. | RF07 |
| `GET /postos-proprios/:id` | Registro próprio com o histórico de verificações. | RF07 |
| `POST /postos-proprios/:id/vinculo-google` | Guarda o `place_id` no registro próprio quando o Curador confirma que é o mesmo posto. | RF08 |
| `GET /controle/gasto` · `PUT /controle/teto` | Gasto do mês por tipo de consulta e teto do Google. | RF09 |
| `GET /controle/fontes` · `PATCH /controle/fontes/:nome` · `PATCH /controle/provedores-ocm/:id` | Liga e desliga as fontes `ocm`, `google` e `propria` e cada provedor do OCM. | RF10 |
| `POST /controle/fontes/:nome/excluir-dados` · `POST /controle/provedores-ocm/:id/excluir-dados` | Desliga e apaga os dados da fonte ou do provedor. Registros próprios continuam. | RF10 |

Exemplos de corpo estão na coleção do Postman.

## Testes

A coleção do Postman cobre os critérios de aceite do PRD de obtenção (RF01 a RF10 e a regra dos 100 m do RF18), inclusive os casos negativos, e o contrato `/v1`: filtros e contagem de ocultos, grupos, motivos de mapa vazio, atestado, trava contra robô e conta. Ela roda contra uma API de teste na porta 3334 e um servidor de apoio na porta 4010 (`teste/apoio.mjs`). O servidor de apoio faz o papel do OCM, do Google, do login gerenciado e do atestado do app. **Nenhum teste chama o OCM ou o Google reais.**

Toda resposta da `/v1` passa por um script da coleção que a compara com a especificação OpenAPI servida pela API: campo a mais, campo a menos ou tipo errado reprova. Todo pino e toda ficha também precisam trazer `origem`, `verificacao`, `atualizado_em` e `condicoes_de_uso` (RNF-01).

**Pelo Newman, de uma vez:**

```bash
npm test
```

O script sobe o banco (se ainda não estiver no ar), a API de teste e o apoio, confere que `openapi/v1.json` é o que a API serve, roda a coleção e derruba tudo. Variáveis já definidas no ambiente valem mais que o `.env.teste`: dá para rodar contra outro banco `*_teste` e em outras portas, passando também `--env-var base_url=… --env-var apoio_url=…` para o Newman.

**Pelo Postman:**

1. Em dois terminais, rode `npm run apoio` e `npm run start:teste`.
2. Leve a coleção e o environment da pasta `postman/` para o Postman de um destes jeitos:
   - importando os arquivos;
   - com `npm run postman:sync`, que envia para a sua conta todas as coleções e todos os environments da pasta (precisa de `POSTMAN_API_KEY` no `.env`).
3. Escolha o environment "REVOLT API POC · teste (dublês)" e rode a coleção inteira no Runner, na ordem. O primeiro pedido zera o banco `revolt_teste`.

## Decisões

Escolhas de engenharia que os PRDs e a arquitetura deixam em aberto.

- **Contrato `/v1` (Fase 0):** substitui o `GET /eletropostos` e o `GET /eletropostos/:id` da POC, que foram removidos. A ficha antiga do Google não passava pelo atestado.
- **Janela do mapa:** retângulo (`bbox`) com zoom, até 8 blocos de 256 px de lado. A partir do zoom 13 (`ZOOM_ALTO`), tudo vem um a um. Abaixo dele, grade de 4×4 células por bloco, ancorada em 0,0, para a mesma área cair sempre na mesma célula.
- **Google por varredura:** previsto no PRD de obtenção a partir da versão 0.5 (Alteração 3).
- **Duplicados:** lugar do Google a menos de 100 m de um posto do OCM entregue não sai no mapa (RN17). Com o provedor ou a fonte desse posto desligados, o lugar volta. A distância é provisória e pode juntar postos vizinhos de redes diferentes.
- **Filtro de gratuito:** heurística sobre o texto do preço ("grátis", "gratuito", "free", "sem custo", "0" ou "R$ 0"), a revisar com dados reais. Preço não informado é oculto e contado.
- **Acesso:** do OCM vem do tipo de uso ("Public…" é público, "Priv…" é restrito); a verificação em campo vence. O tipo da restrição ainda não é registrado.
- **Gasto:** cada chamada ao Google é contada por tipo, com a faixa gratuita e o preço da tabela de nov/2026: busca de área a US$ 32 por mil, com 5.000 gratuitas, e ficha a US$ 25 por mil, com 1.000 gratuitas. O Google não é chamado se o gasto do mês mais o custo da próxima consulta atingir o teto. Os preços precisam ser conferidos na primeira fatura.
- **PlugShare:** é excluído todo registro do OCM que tenha "plugshare" em qualquer campo, sem diferenciar maiúsculas.
- **Licença:** entram só os registros com `IsOpenDataLicensed` e licença CC0 ou CC BY 4.0. O OCM escreve a CC0 de dois jeitos, "CC0" e "CC-0", e os dois são aceitos.
- **Verificação:** exige `origem: "campo"`, autor, data e localização. Qualquer campo fora da lista do RF07 é recusado, e isso inclui os campos do Google.
- **Formato do domínio:** a tradução do OCM para o vocabulário do REVOLT, que cobre situação, tipo de conector e acesso, é feita na view `eletroposto`. A tradução da ficha do Google é feita na API, na hora do pedido. Os valores da fonte que não têm correspondência viram `OUTRO` ou `desconhecida`.
- **Fonte do OCM desligada:** a verificação própria de um posto do OCM some do app junto com o posto. O registro próprio continua na base e em `GET /postos-proprios/:id`.
- **Excluir dados:** também desliga a fonte ou o provedor, para que os dados não voltem na próxima atualização.

## Fora desta fase

- Planejador de rota (Fase 2), check-in, reportes e moderação (Fase 3), indicadores (Fase 4) e publicação da API.
- Autenticação das rotas do Curador e da operação: depende do papel de Curador (Fase 3). Bloqueia a publicação.
- Cada carregador da ficha (`carregadores`) e o tipo de restrição de acesso: a verificação em campo ainda não registra esses dados, então saem como "não informado".
- Telemetria, alertas ao Curador e histórico das mudanças de fontes e teto (guarda só a última, com data e autor).
- Separação do banco em esquemas de obtenção e de app: as tabelas continuam no `public`.
- A trava contra robô guarda a contagem na memória e usa o IP quando falta `X-Aparelho`. Atrás de um proxy, a API precisa confiar no cabeçalho do proxy para ver o IP real.
- Os WON'T do PRD de obtenção: devolução ao OCM (RF12), regras do app (RF13), cópia periódica do Google (RF15) e outras fontes (RF16).
