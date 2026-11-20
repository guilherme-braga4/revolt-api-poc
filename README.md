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
| `POST /v1/viagens/planejar` | Planeja uma viagem: paradas e plano B entre os postos do OCM e próprios, trechos sem cobertura e os lugares do Google ao longo da mesma rota do Google. | Atestado do app |
| `GET /v1/conta` | Confere o token da conta e devolve o identificador. Base das rotas com conta das fases 2 e 3. | Conta |
| `GET /v1/curador/indicadores?de=&ate=` | Indicadores do app para o Curador (Fase 4), só agregados. | Conta de Curador |
| `POST /v1/eventos` | Telemetria própria do app (Fase 4, D-10), sem pessoa. | Nenhuma (ritmo por IP) |

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
- **Observações de motoristas (Alteração 6 da obtenção):** `contribuicoes` traz até 10 check-ins, dos mais recentes, com `origem: "observacao_motorista"`, a data da observação e o que o motorista viu, nunca o autor (RN12). `confirmacao_motorista` (`{ data }` ou null) está na ficha e em todo pino, inclusive nos lugares do Google, para o app mostrar "confirmado por motorista" à parte da verificação em campo (RN15). A observação nunca torna o posto verificado e não muda os atributos nem `atualizado_em`. As removidas pelo Curador saem da entrega. As recusadas (sem data, com data no futuro ou com campo fora da lista, como um dado do Google) são contadas para o Curador.
- `lugar_vinculado` aponta o lugar do Google que o Curador confirmou ser o mesmo posto. `link_externo` abre o lugar no Google Maps, sem consulta paga, e só existe na ficha do Google.
- Ficha do Google sem atestado: 401. Muitas fichas seguidas no mesmo aparelho: 429. Teto atingido, Google desligado ou fora do ar: 503. Nos dois últimos casos a resposta traz `link_externo`, para o app oferecer o Google Maps.

**Planejar viagem (`POST /v1/viagens/planejar`)**

- Corpo: `{ "origem": { "lat", "lng" }, "destino": { "lat", "lng" }, "conectores": ["CCS2", …], "autonomia_km": 250 }`. `conectores` não aceita `OUTRO` nem `DESCONHECIDO`. A autonomia vale como veio, de 10 a 2.000 km: o app desconta a reserva que o motorista quiser.
- A API pede uma rota ao Google e, sobre a linha dela, escolhe as paradas entre os postos do OCM e próprios entregues (fonte e provedor ligados) e compatíveis com o carro: pelo menos um conector do carro e situação operacional ou desconhecida, a até 5 km da linha (RN10). Lugares do Google nunca entram nessa conta.
- A cada perna, se o destino está ao alcance, acabou. Senão, fica o posto mais adiante ao alcance que tem plano B; só quando nenhum tem, o mais adiante, com `aviso: "sem_plano_b"` (RN11). O alcance conta o trecho sobre a rota mais o desvio, em linha reta, para sair dela e voltar.
- Plano B: outro posto compatível que o carro alcança com a autonomia que sobra ao chegar à parada, se ela não servir. Fica o mais perto. Posto a até 100 m da parada é o mesmo posto, e o posto de onde o carro saiu não conta.
- Sem nenhum posto compatível ao alcance, a perna até o próximo posto compatível (ou o destino) vira um item de `trechos_sem_cobertura` (`de_km`, `ate_km`, `distancia_km`, `inicio`, `fim`). O plano segue de lá, e a parada logo depois do trecho vem sem plano B.
- Na mesma rota, a API faz a busca do Google ao longo dela e devolve em `eletropostos_google` todos os lugares, separados das paradas, no formato do pino do mapa, com origem `google` e não verificados. Isso inclui os já vinculados a um posto próprio ou a menos de 100 m de um do OCM (Q14), e o mesmo posto pode aparecer como parada e como lugar do Google.
- `rota.linha` (formato codificado do Google) serve só para desenhar sobre o mapa do Google. `link_externo` abre a viagem no Google Maps com origem, destino e até 9 paradas; o navegador do celular aceita só 3. O link é público, sem chave e sem custo.
- Nada da viagem fica guardado, só o identificador de cada lugar do Google, que permite pedir a ficha depois. A busca não renova a coordenada de quem já estava na base.
- Sem a rota não há paradas. Com o teto atingido, o Google desligado pelo Curador, fora do ar ou sem responder em `GOOGLE_TEMPO_LIMITE_MS` (padrão 10 s), sem chave ou com resposta inválida, vem 200 com `disponivel: false`, `motivo: "rota_indisponivel"`, a `causa` e `mensagem`. `link_externo` então abre só o destino. Se o Google responde que não há rota de carro, o motivo é `sem_rota`.
- Sem a busca (só ela fora do ar ou fora do teto), as paradas saem iguais e `eletropostos_google` traz `disponivel: false` com o motivo.
- Sem atestado: 401. Muitas viagens seguidas no mesmo aparelho: 429. Pedido inválido: 400. Base fora do ar: 503, e o Google não é consultado sem conferir o teto.
- SKUs: a rota pede só distância, duração e linha, sem trânsito, sem paradas intermediárias e sem modificador de local, e fica no **Compute Routes Essentials** (10 mil grátis por mês, depois US$ 5 por mil). A busca pede só `places.id,places.location` e fica no **Text Search Pro** (5 mil grátis, depois US$ 32 por mil): só identificadores seria grátis, mas o mapa precisa da coordenada. Uma página de até 20 lugares por pedido. Cada consulta é conferida no teto antes de sair, primeiro a rota e depois a busca.
- Volume real: numa cópia do banco com os 2.416 postos do OCM, a consulta dos postos ao longo de rotas sintéticas de 400 a 1.000 km leva de 30 a 80 ms, e a escolha das paradas, menos de 3 ms.

**Viagens salvas (`GET`, `POST`, `PUT` e `DELETE /v1/viagens`, com conta)**

- Corpo de `POST` e `PUT /v1/viagens/:id`: o mesmo do planejar mais `nome` (até 100 caracteres). A API guarda só nome, origem, destino, conectores e autonomia: nada do Google, nem rota, nem paradas (RN21 e termos do Google). Campo a mais: 400.
- `GET` lista as viagens da conta, das alteradas mais recentemente. Para abrir uma viagem, o app manda os mesmos dados ao planejar de novo.
- Viagem de outra conta ou inexistente: 404. As viagens somem com a exclusão da conta. Sem conta, a viagem fica só no aparelho (UC04).
- Planejar não guarda nada ligado à pessoa, mesmo com a conta no pedido (RN21).

**Check-in (`POST /v1/checkins`, com conta)**

- Corpo: `{ "chave", "eletroposto_id", "data_observacao", "carregou", "conector"?, "funcionou"?, "potencia_kw"?, "preco"?, "estava_como_informado": "sim" | "nao", "foto"? }`. A `chave` é um UUID gerado pelo app para cada check-in: reenviar a mesma chave (fila sem conexão) devolve 200 com a contribuição que já existe, sem duplicar. Check-in novo: 201.
- `data_observacao` é o dia em que o motorista viu, não o do envio, e não pode ser no futuro. Campo fora da lista (um dado do Google, por exemplo) é recusado (RN13). As recusas por validação ficam contadas por motivo para o Curador.
- A contribuição (módulo app) liga a conta ao que ela enviou; a observação (módulo obtenção) guarda o que o motorista viu, com o pseudônimo da conta como autor. Num lugar do Google, só o identificador dele.
- Sem conta: 401 `conta_necessaria`, e o app convida a entrar. Conta bloqueada pelo Curador: 403 `conta_bloqueada`. Posto desconhecido: 404.
- **Foto:** JPEG em base64, de até 500 KB. A API recomprime (sharp, no máximo 1.600 px de lado), o que descarta todo metadado, e guarda numa tabela própria. Sai por `GET /v1/fotos/:id`, sem autor, com identificador aleatório. Outro formato ou mais de 500 KB: 400 `foto_invalida`.

**Reportes (`POST /v1/reportes` e `GET /v1/reportes/meus`, com conta)**

- Corpo: `{ "eletroposto_id", "tipo", "outro_eletroposto_id"?, "detalhe"?, "foto"? }`. Tipos: `inexistente`, `acesso_restrito`, `duplicado` (exige `outro_eletroposto_id`, diferente do primeiro), `preco_errado`, `fora_de_servico` e `outro` (exige `detalhe`). A foto segue as regras do check-in.
- O mesmo problema já aberto (posto, tipo e, no duplicado, o outro posto) recebe mais um envio, sem criar outro reporte: a resposta traz `somado_a_aberto` e `envios`.
- `GET /v1/reportes/meus` lista os últimos 100 envios da conta, com `situacao` (`aberto` ou `resolvido`) e, depois de resolvido, a `resolucao` do Curador.

**Moderação (`GET /v1/curador/fila` e `POST /v1/curador/decisoes`, conta de Curador)**

- A fila traz os reportes abertos, dos mais antigos, com cada envio (conta, detalhe e foto); os 10 postos com mais reportes abertos; as contribuições ainda sem decisão de aceitar ou corrigir; e as contagens de observações recebidas, recusadas e removidas (Alteração 6).
- Toda decisão leva `tipo` e `motivo`, e fica registrada com a data e a conta do Curador. Tipos:
  - `aceitar_contribuicao` (`contribuicao_id`): só tira da fila;
  - `corrigir_contribuicao` (`contribuicao_id`, `valores`): a ficha passa a mostrar os valores corrigidos, com `corrigida: true`, e os originais ficam no registro da decisão;
  - `remover_contribuicao` (`contribuicao_id`): a contribuição sai da ficha e a confirmação de motorista é recalculada;
  - `remover_foto` (`foto_id`): a foto é apagada e `GET /v1/fotos/:id` passa a responder 404;
  - `resolver_reporte` (`reporte_id`, `resolucao`): `duplicado_confirmado` (só para reporte de duplicado, com `manter`, um dos dois postos), `inexistente`, `acesso_restrito`, `verificacao_em_campo` ou `improcedente`. O motorista vê a resolução em `GET /v1/reportes/meus`;
  - `bloquear_conta` (`conta_id`, que vem na fila): a conta deixa de contribuir (403 `conta_bloqueada`), mas continua vendo os próprios reportes.
- **Duplicado confirmado:** os dois registros continuam na base, sem fusão. Um vínculo marca o outro posto como oculto, e o mapa e o planejador deixam de mostrá-lo. Vale para OCM×OCM, próprio×OCM e lugar do Google.
- Alvo inexistente ou já decidido (contribuição removida, reporte resolvido, conta já bloqueada): 404. Sem conta: 401. Conta sem papel de Curador: 403 `papel_curador_necessario`.

**Indicadores (`GET /v1/curador/indicadores`, conta de Curador, Fase 4)**

- Período por `?de=AAAA-MM-DD&ate=AAAA-MM-DD`, em dias de Brasília. Padrão: os últimos 30 dias, até hoje. `de` depois de `ate` ou data malformada: 400.
- `como_informado`, o indicador principal (RF15): das chegadas do período (check-ins não removidos pelo Curador), quantas tiveram a resposta "estava como o app informou" e a parcela.
- `checkins_por_semana_no_corredor`: check-ins por semana, de segunda a domingo, em postos do OCM e próprios dentro do corredor da Via Dutra. Só as semanas com algum check-in aparecem. Check-in em lugar do Google não entra, porque a posição do Google não pode ser usada em conta do REVOLT.
- `retorno_30_dias`: motoristas que voltam em 30 dias, pelo identificador rotativo dos eventos `app_aberto`. Dos identificadores com a primeira abertura nos 30 dias que terminam 30 dias antes de `ate` (`primeira_abertura`), quantos abriram o app de novo em outro dia, em até 30 dias. A janela fica 30 dias para trás para todos terem tido 30 dias para voltar.
- `uso_do_app`: as contagens da telemetria no período, por tipo, e as somas de trechos sem cobertura e de paradas sem plano B.
- **RN21:** as contas agregam no banco, e nenhum autor, conta ou identificador sai da consulta. Grupo com menos de 5 motoristas distintos (`minimo_motoristas_por_grupo`) sai com os números em `null` e `suprimido: true`. As contagens de `uso_do_app` não passam por isso, porque nenhum evento tem pessoa ou aparelho.
- Cada indicador traz `dados_ate`, o dia mais recente dos dados usados; a resposta traz `calculado_em`.

**Telemetria (`POST /v1/eventos`, sem conta e sem atestado, Fase 4)**

- Corpo: `{ "eventos": [ { "tipo", "dia", ... } ] }`, de 1 a 100 eventos. `dia` é o dia do evento em Brasília, de hoje até 30 dias atrás: o app junta os eventos e manda depois o que ficou sem conexão. Resposta: 204.
- Tipos (lista fechada):
  - `app_aberto`, com `id_rotativo`: um UUID v4 aleatório que o app sorteia e troca 30 dias depois de sorteado. O app manda um por dia;
  - `uso_sem_conexao` e `legenda_aberta` (Alteração 4 do app);
  - `viagem_planejada`, com `trechos_sem_cobertura` e `paradas_sem_plano_b` (0 a 50); `viagem_salva`; `viagem_aberta_na_navegacao` (UC04).
- Recusado com 400 (o app não deve repetir): tipo fora da lista, campo a mais (uma posição, por exemplo), `id_rotativo` fora de `app_aberto` ou ausente nele, contagens fora de `viagem_planejada` ou ausentes nela, dia no futuro ou de mais de 30 dias atrás. Um evento inválido recusa o envio inteiro.
- A API guarda só a contagem por dia e tipo. Os dias de uso de cada `id_rotativo` ficam à parte, só para o retorno em 30 dias, e são apagados com 90 dias (RNF-09) a cada envio.
- Ritmo: `LIMITE_EVENTOS` envios por IP a cada 10 minutos (padrão 120); acima disso, 429 `muitos_pedidos`. Por IP e não por `X-Aparelho`, porque a telemetria não leva identificador estável do aparelho.

Todo erro da `/v1` sai como `{ "erro", "mensagem" }`.

**Base de dados fora do ar ou lenta:** o mapa e a ficha respondem 503 com `erro: "base_indisponivel"`, nunca ficam pendurados. A ficha do Google ainda traz `link_externo`. Cada etapa de acesso ao banco tem prazo (`BANCO_TEMPO_LIMITE_MS`, padrão 5 s): conseguir uma conexão e executar a consulta. O Postgres cancela a consulta que passa do prazo, a conexão que não responde sai do pool, e a que cai parada é descartada sem derrubar o processo. Depois de uma queda, o pedido seguinte abre conexão nova, sem reiniciar a API. Se o servidor encerra a conexão antes de responder (reinício do Postgres), a consulta é repetida até 2 vezes numa conexão nova, porque não chegou a ser aplicada. As tarefas que processam a base inteira (atualização do OCM, grade e expiração do Google, exclusão de dados de uma fonte) usam outro pool, com prazo de 10 minutos: a atualização do OCM com o volume real leva de 1,6 s a 3 s, e chega a 9 s no teto de 10 mil postos da consulta ao OCM.

### Autenticação (D-04 e D-09)

A API não guarda senha. Ela só valida tokens assinados (RS256), conferindo a chave publicada, o emissor e o público.

- **Conta** (`Authorization: Bearer <token>`): token do login gerenciado. Exigida só para contribuir e salvar viagens. A primeira entrada cria a conta, que guarda só o identificador do provedor (`sub`), o papel, o bloqueio e um pseudônimo, que é o autor das observações no módulo obtenção. `GET /v1/conta` devolve `{ id, papel, bloqueada }`.
- **Exclusão (`DELETE /v1/conta`, 204):** apaga a conta e as viagens salvas. As contribuições e os reportes continuam, sem conta, e cada observação da pessoa ganha um autor aleatório próprio: nada liga as observações à pessoa nem entre si (UC07, RF10). Vale também para conta bloqueada. Entrar de novo com o mesmo login cria uma conta nova, sem nada da anterior.
- **Papel de Curador:** as contas listadas em `CURADOR_CONTAS` (identificadores do provedor, separados por vírgula) têm papel `curador`. O papel é conferido a cada pedido: tirar uma conta da lista a devolve a `motorista`. Sem papel no provedor de login, sem mexer no console do Firebase.
- **Atestado do app** (`X-Atestado-App: <token>`): prova que o pedido vem do app do REVOLT. Sem ele, o mapa não traz lugares do Google e a ficha do Google é recusada (RN18 da obtenção).
- **Trava contra robô:** cada aparelho (cabeçalho `X-Aparelho`, gerado pelo app na instalação; sem ele, o IP) pode abrir até `LIMITE_FICHAS_GOOGLE` fichas do Google e planejar até `LIMITE_ROTAS_GOOGLE` viagens a cada 10 minutos, contados à parte. Não é limite por pessoa.

| Variável | Produção (Firebase), a conferir na Fase 1 |
|---|---|
| `CONTA_JWKS_URL` | `https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com` |
| `CONTA_EMISSOR` | `https://securetoken.google.com/<id do projeto>` |
| `CONTA_PUBLICO` | `<id do projeto>` |
| `CURADOR_CONTAS` | identificador (`sub`) da conta do Curador no Firebase |
| `ATESTADO_JWKS_URL` | `https://firebaseappcheck.googleapis.com/v1/jwks` |
| `ATESTADO_EMISSOR` | `https://firebaseappcheck.googleapis.com/<número do projeto>` |
| `ATESTADO_PUBLICO` | `projects/<número do projeto>` |
| `LIMITE_FICHAS_GOOGLE` | `60` |
| `LIMITE_ROTAS_GOOGLE` | `20` |

Com `ATESTADO_JWKS_URL` vazio, o atestado fica desligado e a API avisa no log. Serve só para desenvolvimento local. Com `CONTA_JWKS_URL` vazio, nenhuma conta é aceita.

**Contas no desenvolvimento local:** `node scripts/login-dev.mjs` sobe um dublê do login em `http://localhost:4039` (só aceita conexões da própria máquina). Ele publica a chave em `/jwks.json` e emite tokens de 12 h em `/token?sub=<identificador>`. Suba a API com `CONTA_JWKS_URL=http://localhost:4039/jwks.json`, `CONTA_EMISSOR=revolt-login-dev`, `CONTA_PUBLICO=revolt-app-dev` e, para ter um Curador, `CURADOR_CONTAS=curador-dev`. A chave muda a cada vez que o dublê sobe.

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

Estes endpoints não são para o app. Desde a Fase 3, todos exigem a conta com papel de Curador (`Authorization: Bearer <token>` de uma conta listada em `CURADOR_CONTAS`). Sem conta: 401 `conta_necessaria`. Conta sem o papel: 403 `papel_curador_necessario`. Na coleção, o script da coleção pede ao dublê do login o token da conta `curador-teste` e o põe em todo pedido a essas rotas.

| Método e caminho | O que faz | RF |
|---|---|---|
| `POST /ocm/atualizar` | Importa o Brasil do OCM e troca a cópia de uma vez. Responde 502 se falhar. | RF01, RF02 |
| `GET /ocm/atualizacoes` | Últimas atualizações, com contagens e motivo das falhas. | RF02 |
| `POST /google/varredura` | Seed e atualização dos lugares do Google por células. Corpo opcional: `{ "limite": n }`. | RF04, RF06 |
| `POST /google/expirar` | Apaga coordenadas do Google com mais de 30 dias. Também roda todo dia às 4h. | RF06 |
| `POST /verificacoes` | Registra uma verificação em campo: de um posto do OCM (`ocm_id`), de um registro próprio (`posto_proprio_id`) ou de um posto novo. Desde a Fase 4, com cada carregador (`carregadores`: `tipo`, `funcionou` e `potencia_observada_kw`, `null` quando não houve recarga) e, no acesso restrito, o tipo de restrição (`acesso_restricao`: `marca_de_veiculo`, `clientes_ou_hospedes`, `moradores` ou `horario`). | RF07 |
| `GET /postos-proprios/:id` | Registro próprio com o histórico de verificações. | RF07 |
| `POST /postos-proprios/:id/vinculo-google` | Guarda o `place_id` no registro próprio quando o Curador confirma que é o mesmo posto. | RF08 |
| `GET /controle/gasto` · `PUT /controle/teto` | Gasto do mês por tipo de consulta e teto do Google. | RF09 |
| `GET /controle/fontes` · `PATCH /controle/fontes/:nome` · `PATCH /controle/provedores-ocm/:id` | Liga e desliga as fontes `ocm`, `google` e `propria` e cada provedor do OCM. | RF10 |
| `POST /controle/fontes/:nome/excluir-dados` · `POST /controle/provedores-ocm/:id/excluir-dados` | Desliga e apaga os dados da fonte ou do provedor. Registros próprios continuam. | RF10 |
| `GET /controle/avisos` | Avisos ao Curador, calculados na hora (Fase 4): `teto_atingido`, `teto_proximo` (80% do teto ou mais), `gasto_nao_apurado`, `fonte_desligada`, `provedor_ocm_desligado` e `atualizacao_ocm_falhou`, cada um com `mensagem` e `desde`. Sem e-mail nem push. | RF09, UC06 |
| `GET /controle/historico` | Toda mudança de teto, fonte e provedor e toda exclusão de dados, com `alvo`, `de`, `para`, `autor` e `feita_em`, da mais recente para a mais antiga (Fase 4). | UC06 |
| `GET /corredor` | Situação do corredor da Via Dutra (Fase 4): postos do OCM e próprios do trecho, cada um com `verificado`, `ultima_verificacao`, `tem_preco` e `tem_regras_cobranca`, e os indicadores (parcela verificada, idade mediana da última verificação e parcela com preço e regras), com `ocm_atualizado_em` (última atualização do OCM que deu certo) e `ultima_verificacao`. Nenhum lugar do Google. | RF11, UC07 |

Exemplos de corpo estão na coleção do Postman.

## Testes

A coleção do Postman cobre os critérios de aceite do PRD de obtenção (RF01 a RF10 e a regra dos 100 m do RF18), inclusive os casos negativos, e o contrato `/v1`: filtros e contagem de ocultos, grupos, motivos de mapa vazio, atestado, trava contra robô e conta. Ela roda contra uma API de teste na porta 3334 e um servidor de apoio na porta 4010 (`teste/apoio.mjs`). O servidor de apoio faz o papel do OCM, do Google, do login gerenciado e do atestado do app. **Nenhum teste chama o OCM ou o Google reais.**

A API de teste fala com o banco por um proxy do servidor de apoio (porta 4011, em `DATABASE_URL`); o apoio fala direto (`BANCO_DIRETO_URL`). Com isso, a seção 10 da coleção simula quedas do banco: conexões derrubadas pelo Postgres, consulta lenta, conexões meio abertas que nunca respondem e mais pedidos simultâneos que o pool. Ela confere que cada pedido falha com 503 dentro do prazo e que o seguinte volta a responder sem reiniciar a API. No fim, a atualização do OCM espera uma trava de 7 s na tabela `ocm_posto` e precisa terminar: as tarefas longas não ficam presas ao prazo dos pedidos.

A seção 11, no fim porque zera a base, cobre o planejador de viagem com postos do OCM e um posto próprio ao longo da Dutra:
- parada com plano B;
- parada sem plano B;
- trecho sem cobertura, com um lugar do Google guardado no meio dele, que não pode virar parada;
- destino ao alcance;
- carro sem posto compatível;
- os lugares do Google na mesma rota, inclusive um a 40 m de uma parada;
- só o identificador guardado e a linha da rota não guardada;
- gasto por tipo e ficha de um lugar vindo da rota;
- nenhum lugar do Google, só a busca fora do ar, sem rota, linha inválida, Google fora do ar ou lento, teto atingido e Google desligado;
- sem atestado, pedidos inválidos e ritmo de robô.

Toda viagem planejada também passa pelas regras RN10 e RN11 conferidas na resposta. A seção confere ainda o corpo e a máscara de campos que chegam ao dublê, para a rota e a busca não subirem de SKU. As regras do planejador também têm testes unitários (`teste/planejador.test.mjs`, com `npm run test:unidade`), que o `npm test` roda antes da coleção.

A seção 13 cobre a Fase 4: o prazo da busca no OCM (um dublê que responde depois do prazo), a verificação com cada carregador e o tipo de restrição e as recusas, cada aviso ao Curador e o histórico do controle, a situação do corredor no trecho de teste do UC07, os indicadores contra uma contagem manual (seis motoristas, nove check-ins, uma remoção pelo Curador e a supressão de grupos pequenos) e a telemetria (cada tipo, as recusas, o retorno em 30 dias, a limpeza dos 90 dias e o ritmo por IP). Os indicadores e o corredor também têm testes unitários (`teste/indicadores.test.mjs`), inclusive os de RN13, RN18 e RN21.

A seção 14 fecha as lacunas da auditoria de aceite (Wave E): a varredura pedida sem conta ou por motorista não começa (RN21), o mapa com as três origens e filtro de conector (Alteração 1 do app) e o lugar do Google vinculado a um posto próprio, que sai do mapa mas continua na rota (Alteração 7 da obtenção). Ela começa zerando o banco. As regras da obtenção também têm testes unitários: `teste/obtencao.test.mjs` (RN01, RN03, RN04, RN05, RN10, RN13 e RN19) e `teste/google.test.mjs` (RN15 e RN21, com banco e Google falsos).

Toda resposta da `/v1` passa por um script da coleção que a compara com a especificação OpenAPI servida pela API: campo a mais, campo a menos ou tipo errado reprova. Todo pino e toda ficha também precisam trazer `origem`, `verificacao`, `atualizado_em` e `condicoes_de_uso` (RNF-01).

**Pelo Newman, de uma vez:**

```bash
npm test
```

O script roda os testes unitários, sobe o banco (se ainda não estiver no ar), a API de teste e o apoio, confere que `openapi/v1.json` é o que a API serve, roda a coleção e derruba tudo. Variáveis já definidas no ambiente valem mais que o `.env.teste`: dá para rodar contra outro banco `*_teste` e em outras portas, passando também `--env-var base_url=… --env-var apoio_url=…` para o Newman.

**Pelo Postman:**

1. Em dois terminais, rode `npm run apoio` e, depois que ele subir, `npm run start:teste`.
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
- **Acesso:** do OCM vem do tipo de uso ("Public…" é público, "Priv…" é restrito); a verificação em campo vence. Desde a Fase 4, a verificação registra o tipo de restrição, e a ficha mostra o tipo que veio dela.
- **Gasto:** cada chamada ao Google é contada por tipo, com a faixa gratuita e o preço da tabela de nov/2026: busca de área a US$ 32 por mil, com 5.000 gratuitas, e ficha a US$ 25 por mil, com 1.000 gratuitas. A rota (Compute Routes Essentials, US$ 5 por mil, 10.000 gratuitas) e a busca ao longo da rota (Text Search Pro, US$ 32 por mil, 5.000 gratuitas) foram conferidas na página oficial de preços em 19/11/2026. O Google não é chamado se o gasto do mês mais o custo da próxima consulta atingir o teto. Os preços precisam ser conferidos na primeira fatura.
- **PlugShare:** é excluído todo registro do OCM que tenha "plugshare" em qualquer campo, sem diferenciar maiúsculas.
- **Licença:** entram só os registros com `IsOpenDataLicensed` e licença CC0 ou CC BY 4.0. O OCM escreve a CC0 de dois jeitos, "CC0" e "CC-0", e os dois são aceitos.
- **Planejar viagem:** `POST /v1/viagens/planejar`, sob `/v1/viagens`, onde ficam as viagens salvas da Fase 2. É `POST` porque cada pedido gasta consultas pagas e guarda identificadores.
  - **Mudança de contrato em relação à arquitetura:** a tabela da seção 6 da arquitetura (v0.4) não pede autenticação para o planejar. Aqui ele exige o atestado do app (`X-Atestado-App`) e passa pela trava contra robô. Motivo: cada pedido gasta uma rota e uma busca pagas do Google, e sem atestado um robô esgotaria o teto do mês (D-09), como na ficha do Google. Consequência: até o app mandar o atestado, o planejar real responde 401 `atestado_invalido`.
  - Os lugares do Google na rota vêm na mesma resposta. O antigo `POST /v1/viagens/eletropostos-google` foi retirado: com dois pedidos, o app pagaria duas rotas por viagem, e a D-07 pede uma.
  - A rota é conferida no teto sozinha e antes da busca: sem ela não há paradas, e sem a busca a viagem segue só com OCM e próprios.
  - O motivo da viagem sem rota é `rota_indisponivel`, com a `causa` à parte: para o app, o efeito é o mesmo (sem paradas e com o link do destino), e a causa muda só o texto.
  - As contas de posição usam a projeção policônica do Brasil (EPSG:5880), sobre a linha simplificada a 20 m. O comprimento total é medido no elipsoide.
  - O limite de 5 km de desvio, a regra "o mais adiante com plano B" e a falta de reserva na autonomia são escolhas de engenharia, a revisar com o Curador.
  - A mesma chave do Google serve às fichas, à varredura, à rota e à busca, e precisa liberar também o Routes API.
- **Verificação:** exige `origem: "campo"`, autor, data e localização. Qualquer campo fora da lista do RF07 é recusado, e isso inclui os campos do Google.
- **Formato do domínio:** a tradução do OCM para o vocabulário do REVOLT, que cobre situação, tipo de conector e acesso, é feita na view `eletroposto`. A tradução da ficha do Google é feita na API, na hora do pedido. Os valores da fonte que não têm correspondência viram `OUTRO` ou `desconhecida`.
- **Fonte do OCM desligada:** a verificação própria de um posto do OCM some do app junto com o posto. O registro próprio continua na base e em `GET /postos-proprios/:id`.
- **Excluir dados:** também desliga a fonte ou o provedor, para que os dados não voltem na próxima atualização.
- **Fase 4:**
  - **Prazo do OCM:** a busca no OCM tem prazo (`OCM_TEMPO_LIMITE_MS`, padrão 60 s), como as chamadas ao Google. Passado o prazo, a atualização falha e a cópia anterior continua.
  - **Carregador sem recarga:** `potencia_observada_kw: null` é a marca de não observada. Zero é recusado, e cada carregador precisa dizer se funcionou.
  - **Avisos:** calculados a cada `GET /controle/avisos`, sem tabela nem envio. O aviso de 80% do teto vem da RNF-11 da arquitetura; o e-mail que ela pede ficou de fora. A falha na apuração aparece quando o gasto do mês não pode ser calculado; nesse caso, nenhuma consulta ao Google sai, porque o gasto é conferido antes de cada uma.
  - **Corredor:** o trecho é o polígono `Via Dutra` de `corredor_verificado`. Preço e regras de cobrança contam só os da verificação própria (RN13): o preço do OCM não conta. Um posto do OCM com a fonte ou o provedor desligados sai do corredor, como sai do mapa.
  - **Indicadores:** mínimo de 5 motoristas distintos por grupo (RN21), escolha de engenharia a revisar com o Curador.
  - **Retorno em 30 dias:** o identificador rotativo dura 30 dias, então cada aparelho conta no máximo uma vez a cada 30 dias. O motorista que volta depois de mais de 30 dias aparece com outro identificador, como quem não voltou, e é isso que o indicador mede.
  - **Telemetria:** só contagens por dia e tipo, sem área: a RNF-09 aceita área de cerca de 5 km, mas nenhum indicador pede. O ritmo é por IP; com muitos aparelhos atrás do mesmo IP da operadora (CGNAT), envios legítimos podem passar do limite e ser perdidos.
- **Moderação (Fase 3):** uma tabela de decisões guarda tipo, alvo, motivo, data, Curador e, na correção, os valores originais. A correção muda a observação e a marca como corrigida; o duplicado confirmado cria um vínculo (`vinculo_duplicado`: oculto e mantido), sem fundir dados, e o posto oculto sai do mapa, do planejador e das paradas. O efeito e o registro da decisão são uma instrução só no banco.

## Pendentes (decisão do Guilherme)

- **Token do Curador:** as rotas do Curador e da operação aceitam só o token do login gerenciado de uma conta em `CURADOR_CONTAS`. Enquanto o login do app (D-04) não existe, só o dublê da coleção emite esse token. Para o Curador real usar essas rotas, falta definir como ele obtém um token do Firebase (entrar pelo app e copiar o token, ou uma tela própria). Até lá, a escolha mais simples e reversível: a API não abre outro caminho de acesso, e as rotas ficam fechadas para quem não tem esse token.
- **Exclusão no provedor de login:** a arquitetura pede que a API apague também a conta no Firebase. Isso exige o Admin SDK com uma credencial de serviço, que não existe aqui. Escolha mais simples e reversível: a API apaga os dados dela, e o app apaga o usuário no Firebase logo depois, com o próprio SDK do cliente.
- **Paradas na viagem salva:** a viagem salva com conta guarda só origem, destino, conectores, autonomia e nome. As paradas que o motorista trocou ou removeu ficam só no aparelho; em outro aparelho, o app planeja de novo e pode sugerir outras paradas.
- **Conta bloqueada que se exclui:** ao entrar de novo, a conta nova não está bloqueada. Impedir isso exigiria guardar o identificador do login depois da exclusão, o que contraria o RF10. Fica assim até decisão contrária.

## Fora desta fase

- A publicação da API.
- Planejador: o acesso restrito, que hoje não impede um posto de virar parada, e mais de 9 paradas no link do Google Maps.
- Avisos ao Curador por e-mail ou push, o aviso de erro alto na API (RNF-11) e a área aproximada nos eventos de telemetria.
- Separação do banco em esquemas de obtenção e de app: as tabelas continuam no `public`.
- A trava contra robô guarda a contagem na memória e usa o IP quando falta `X-Aparelho`. Atrás de um proxy, a API precisa confiar no cabeçalho do proxy para ver o IP real.
- Os WON'T do PRD de obtenção: devolução ao OCM (RF12), regras do app (RF13), cópia periódica do Google (RF15) e outras fontes (RF16).
