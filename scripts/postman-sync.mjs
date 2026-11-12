// Envia as coleções e os environments da pasta postman/ para a sua conta Postman (sentido único: repositório → conta).
// Atualiza pelo nome se já existirem; senão, cria. Uso: npm run postman:sync
// Lê do .env: POSTMAN_API_KEY e, opcional, POSTMAN_WORKSPACE_ID (sem ele, usa o primeiro workspace pessoal).
import { readdirSync, readFileSync } from 'node:fs';

const chave = process.env.POSTMAN_API_KEY;
if (!chave) throw new Error('Defina POSTMAN_API_KEY no .env');

async function api(metodo, caminho, corpo) {
  const resposta = await fetch(`https://api.getpostman.com${caminho}`, {
    method: metodo,
    headers: { 'X-Api-Key': chave, 'Content-Type': 'application/json' },
    body: corpo && JSON.stringify(corpo),
  });
  const json = await resposta.json();
  if (!resposta.ok) throw new Error(`${metodo} ${caminho}: ${resposta.status} ${JSON.stringify(json)}`);
  return json;
}
const ler = (arquivo) => JSON.parse(readFileSync(new URL(`../postman/${arquivo}`, import.meta.url), 'utf8'));

let workspace = process.env.POSTMAN_WORKSPACE_ID;
if (!workspace) {
  const { workspaces } = await api('GET', '/workspaces');
  const pessoal = workspaces.find((w) => w.type === 'personal');
  workspace = pessoal.id;
  console.log(`Workspace: ${pessoal.name}`);
}

const arquivos = readdirSync(new URL('../postman/', import.meta.url));

const { collections } = await api('GET', `/collections?workspace=${workspace}`);
for (const arquivo of arquivos.filter((a) => a.endsWith('.postman_collection.json'))) {
  const colecao = ler(arquivo);
  const c = collections.find((x) => x.name === colecao.info.name);
  if (c) await api('PUT', `/collections/${c.uid}`, { collection: colecao });
  else await api('POST', `/collections?workspace=${workspace}`, { collection: colecao });
  console.log(`Coleção "${colecao.info.name}" ${c ? 'atualizada' : 'criada'}`);
}

const { environments } = await api('GET', `/environments?workspace=${workspace}`);
for (const arquivo of arquivos.filter((a) => a.endsWith('.postman_environment.json'))) {
  const { name, values } = ler(arquivo);
  const e = environments.find((x) => x.name === name);
  if (e) await api('PUT', `/environments/${e.uid}`, { environment: { name, values } });
  else await api('POST', `/environments?workspace=${workspace}`, { environment: { name, values } });
  console.log(`Environment "${name}" ${e ? 'atualizado' : 'criado'}`);
}
