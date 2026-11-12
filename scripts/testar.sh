#!/usr/bin/env bash
# Roda a coleção do Postman pelo Newman contra a API de teste (porta 3334) e os dublês (porta 4010).
# Nenhuma chamada sai para o OCM ou o Google reais: o .env.teste aponta os dois para os dublês.
set -euo pipefail
cd "$(dirname "$0")/.."

docker compose up -d --wait
npx tsc
node --env-file=.env.teste teste/apoio.mjs > /dev/null & APOIO=$!
node --env-file=.env.teste dist/main.js > /dev/null & API=$!
trap 'kill $APOIO $API 2>/dev/null' EXIT

until curl -so /dev/null localhost:4010 && curl -so /dev/null localhost:3334; do sleep 0.5; done

npx newman run postman/revolt-api-poc.postman_collection.json -e postman/revolt-api-poc-teste.postman_environment.json "$@"
