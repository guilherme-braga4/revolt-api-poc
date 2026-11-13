#!/usr/bin/env bash
# Roda a coleção do Postman pelo Newman contra a API de teste (porta 3334) e os dublês (porta 4010).
# Nenhuma chamada sai para o OCM ou o Google reais: o .env.teste aponta os dois para os dublês.
# Variáveis já definidas no ambiente valem mais que o .env.teste (ex.: outro banco *_teste ou outras portas).
set -euo pipefail
cd "$(dirname "$0")/.."

# Banco já no ar (ex.: subido por outra cópia do repositório)? Usa ele.
docker inspect -f '{{.State.Running}}' revolt-poc-db 2>/dev/null | grep -q true || docker compose up -d --wait
npx tsc
node --env-file=.env.teste teste/apoio.mjs > /dev/null & APOIO=$!
node --env-file=.env.teste dist/main.js > /dev/null & API=$!
trap 'kill $APOIO $API 2>/dev/null' EXIT

until curl -so /dev/null localhost:${APOIO_PORT:-4010} && curl -so /dev/null localhost:${PORT:-3334}; do sleep 0.5; done

# O contrato versionado precisa ser o que a API serve. Mudou o código da /v1? Rode "npm run openapi".
curl -s localhost:${PORT:-3334}/v1/openapi.json > dist/openapi-servido.json
node -e 'const [a, b] = process.argv.slice(1).map((f) => JSON.stringify(JSON.parse(require("fs").readFileSync(f))));
if (a !== b) { console.error("openapi/v1.json está diferente do que a API serve: rode npm run openapi"); process.exit(1); }' openapi/v1.json dist/openapi-servido.json

npx newman run postman/revolt-api-poc.postman_collection.json -e postman/revolt-api-poc-teste.postman_environment.json "$@"
