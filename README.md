# REVOLT · API agregadora de eletropostos (POC)

Prova de conceito da API que obtém, guarda e entrega dados de eletropostos do Open Charge Map (OCM), do Google Places (só identificador e coordenada, por varredura) e da verificação própria em campo.

- Fonte de verdade: PRD "Obtenção dos Dados dos Eletropostos", versão 0.2, **ainda não aprovado**. Esta POC não é a implementação aprovada das Alterações do §7.
- Os endpoints são provisórios: o contrato da API não está decidido (RF14).
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

Os eletropostos internalizados na base estão na view **`eletroposto`** (revolt → Schemas → public → Views). A view já fala o vocabulário do REVOLT. Ela junta a cópia do OCM e os registros próprios, com a última verificação de cada um.

```sql
SELECT id, nome, situacao, conectores, provedor, licenca, verificado, data_observacao
FROM eletroposto
ORDER BY nome;
```

- Os lugares do Google não estão na view. Deles a base guarda só o identificador e a coordenada (até 30 dias), na tabela `google_lugar`, e o andamento da varredura fica em `google_celula`.
- As colunas `local` são `geography`. Para ver a coordenada, use `ST_AsText(local)`. A view também traz `lat` e `lng`.
- As tabelas cruas continuam disponíveis para conferência: `ocm_posto`, `posto_proprio`, `verificacao` etc.

## O que o App chama

O App usa só dois endpoints. Os dois respondem no formato do domínio do REVOLT, e nenhum nome de campo do OCM ou do Google chega ao App.

| Método e caminho | O que faz | RF |
|---|---|---|
| `GET /eletropostos?lat=&lng=&raio_km=` | Eletropostos da área, lidos só da base: cópia do OCM, registros próprios e lugares do Google trazidos pela varredura. Raio de até 3.000 km, o que cobre o Brasil inteiro. Não consulta nenhuma fonte externa. | RF03, RF04 |
| `GET /eletropostos/:id` | Detalhe de um eletroposto. Com `google-…`, a ficha vem do Google na hora, é traduzida e não é gravada. | RF05 |

Cada eletroposto tem o mesmo formato, venha de onde vier:

```json
{
  "id": "ocm-9001",
  "nome": "Posto exemplo",
  "endereco": "Rua Exemplo, 100, São José dos Campos",
  "localizacao": { "lat": -23.19, "lng": -45.88 },
  "situacao": "operacional",
  "conectores": [{ "tipo": "CCS2", "potencia_kw": 60, "quantidade": 2, "disponiveis": null }],
  "preco": null,
  "horario": null,
  "pagamento": null,
  "fonte": { "origem": "open_charge_map", "provedor": "Open Charge Map Contributors", "licenca": "CC BY 4.0", "condicoes_uso": "…", "data": "2026-11-12T06:00:00Z" },
  "verificacao": {
    "situacao": "verificado",
    "origem": "verificacao_propria",
    "licenca": "Própria (REVOLT)",
    "data": "2026-11-10",
    "autor": "Curador",
    "funcionamento": "funcionando",
    "conectores": [{ "tipo": "CCS2", "potencia_kw": 60, "quantidade": 2, "disponiveis": null }],
    "preco": "R$ 2,10/kWh",
    "lugar_google": null
  }
}
```

O exemplo omite alguns campos de `verificacao`: `condicoes_uso`, `regras_cobranca`, `taxa_ociosidade`, `pre_autorizacao`, `app_exigido`, `pagamento_sem_app` e `acesso`.

- **`id`:** `ocm-<id do OCM>`, `propria-<id do registro próprio>` ou `google-<place_id>`.
- **`fonte`:** de onde vem o dado do eletroposto, com licença, condições de uso e data. A `origem` é `open_charge_map`, `verificacao_propria` ou `google`.
- **`verificacao`:** só a observação em campo torna o eletroposto verificado. Ela vem neste bloco, com a sua própria origem e licença, e não mistura com o dado da fonte. Sem observação, o bloco é `{ "situacao": "nao_verificado" }`.
- **Um item por eletroposto:** o posto do OCM verificado em campo é um item só. O registro próprio vira item à parte (`propria-…`) só quando não há posto do OCM ligado a ele na cópia, por ser um posto novo ou por ter saído da fonte.
- **Google na lista:** o item traz só `id`, `localizacao` e `fonte`. Nome, endereço, conectores, horário e pagamento vêm no detalhe, porque não podem ser guardados. Um lugar do Google a menos de 100 m de um posto do OCM entregue é tratado como o mesmo posto e não aparece.
- **`situacao`:** `operacional`, `fora_de_operacao`, `planejado`, `fechado_definitivamente` ou `desconhecida`.
- **`conectores[].tipo`:** `CCS2`, `CCS1`, `TIPO_2`, `TIPO_1`, `CHADEMO`, `GBT`, `TESLA`, `TOMADA`, `OUTRO` ou `DESCONHECIDO`. A verificação em campo só aceita estes valores.
- **`pagamento`** (só no detalhe do Google): `cartao_credito`, `cartao_debito`, `nfc` e `somente_dinheiro`.

A resposta da área também traz `fontes`, com o que cada fonte entregou. Para o Google, `duplicados_do_ocm` conta os lugares escondidos por estarem colados a um posto do OCM.

### Testar a API do App

A coleção **"REVOLT · App (POC)"** tem os dois endpoints, com exemplos de resposta salvos, e roda contra a API local com a base real.

1. Suba a API com `npm start`.
2. No Postman, escolha o environment **"REVOLT API POC · local (base real)"**, que aponta para `http://localhost:3333`.
3. Rode os pedidos da coleção. Pelo terminal, rode `npm run test:app`.

- **Testes:** conferem o formato do REVOLT, não os valores, porque a base real muda a cada atualização do OCM.
- **Somente leitura:** a coleção não apaga nem altera nada.
- **Custo:** pedir áreas não custa nada, de qualquer tamanho. Só o detalhe de um `google-…` consulta o Google: é uma ficha paga, com 1.000 gratuitas por mês, dentro do teto de US$ 50.
- **Atenção:** não rode a coleção de testes "REVOLT · API agregadora (POC)" no environment local. Ela apaga dados e desligaria fontes na base real.

## Importar o OCM e pedir uma área

```bash
curl -X POST localhost:3333/ocm/atualizar
curl "localhost:3333/eletropostos?lat=-23.19&lng=-45.88&raio_km=5"
curl localhost:3333/eletropostos/ocm-481262
```

A primeira linha importa o Brasil inteiro do acesso ao vivo do OCM. A segunda pede os eletropostos num raio de 5 km em São José dos Campos, na Via Dutra. A terceira abre um deles.

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

Estes endpoints não são para o App.

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

A coleção do Postman cobre os critérios de aceite de RF01 a RF10, inclusive os casos negativos. Ela roda contra uma API de teste na porta 3334 e um servidor de apoio na porta 4010 (`teste/apoio.mjs`). O servidor de apoio faz o papel do OCM e do Google. **Nenhum teste chama o OCM ou o Google reais.**

**Pelo Newman, de uma vez:**

```bash
npm test
```

O script sobe o banco, a API de teste e o apoio, roda a coleção e derruba tudo.

**Pelo Postman:**

1. Em dois terminais, rode `npm run apoio` e `npm run start:teste`.
2. Leve a coleção e o environment da pasta `postman/` para o Postman de um destes jeitos:
   - importando os arquivos;
   - com `npm run postman:sync`, que envia para a sua conta todas as coleções e todos os environments da pasta (precisa de `POSTMAN_API_KEY` no `.env`).
3. Escolha o environment "REVOLT API POC · teste (dublês)" e rode a coleção inteira no Runner, na ordem. O primeiro pedido zera o banco `revolt_teste`.

## Decisões da POC

Escolhas de engenharia que o PRD deixa em aberto. Todas são provisórias.

- **Área:** círculo com centro e raio de até 3.000 km, lido só da base.
- **Google por varredura, não sob demanda:** diverge do PRD v0.2. A RF04 pede consulta sob demanda para a área pedida, e a RF15 marca a cópia periódica do Google como WON'T. O PRD precisa ser revisto para refletir esta decisão.
- **Duplicados:** lugar do Google a menos de 100 m de um posto do OCM entregue não sai na lista. A distância é provisória e pode juntar postos vizinhos de redes diferentes.
- **Gasto:** cada chamada ao Google é contada por tipo, com a faixa gratuita e o preço da tabela de nov/2026: busca de área a US$ 32 por mil, com 5.000 gratuitas, e ficha a US$ 25 por mil, com 1.000 gratuitas. O Google não é chamado se o gasto do mês mais o custo da próxima consulta atingir o teto. Os preços precisam ser conferidos na primeira fatura.
- **PlugShare:** é excluído todo registro do OCM que tenha "plugshare" em qualquer campo, sem diferenciar maiúsculas.
- **Licença:** entram só os registros com `IsOpenDataLicensed` e licença CC0 ou CC BY 4.0. O OCM escreve a CC0 de dois jeitos, "CC0" e "CC-0", e os dois são aceitos.
- **Verificação:** exige `origem: "campo"`, autor, data e localização. Qualquer campo fora da lista do RF07 é recusado, e isso inclui os campos do Google.
- **Formato do domínio:** a tradução do OCM para o vocabulário do REVOLT, que cobre situação e tipo de conector, é feita na view `eletroposto`. A tradução da ficha do Google é feita na API, na hora do pedido. Os valores da fonte que não têm correspondência viram `OUTRO` ou `desconhecida`.
- **Fonte do OCM desligada:** a verificação própria de um posto do OCM some do App junto com o posto. O registro próprio continua na base e em `GET /postos-proprios/:id`.
- **Excluir dados:** também desliga a fonte ou o provedor, para que os dados não voltem na próxima atualização.

## Fora desta POC

- Tudo o que o PRD marca como WON'T: devolução ao OCM (RF12), regras do app (RF13), contrato da API (RF14), cópia periódica do Google (RF15) e outras fontes (RF16).
- Situação do corredor da Via Dutra (RF11, SHOULD).
- Restringir os dados do Google ao REVOLT (RN11), porque depende de autenticação, que é parte do contrato da API.
- Testes unitários e de integração automatizados fora do Postman, autenticação, histórico das mudanças de fontes e teto (guarda só a última, com data e autor) e aviso ativo ao Curador (as falhas e o teto aparecem nas consultas).
