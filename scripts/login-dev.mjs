// Dublê do login gerenciado (D-04) só para desenvolvimento local: publica um JWKS e emite tokens de conta de teste.
// Uso: node scripts/login-dev.mjs   (porta LOGIN_DEV_PORTA, padrão 4039; só aceita conexões da própria máquina)
//   GET /jwks.json               chave pública, para CONTA_JWKS_URL=http://localhost:4039/jwks.json
//   GET /token?sub=motorista-dev token RS256 por 12 h, emissor revolt-login-dev e público revolt-app-dev
// A API precisa de CONTA_EMISSOR=revolt-login-dev e CONTA_PUBLICO=revolt-app-dev; a conta Curador é a de CURADOR_CONTAS.
// A chave nasce a cada vez que o dublê sobe: os tokens anteriores deixam de valer. Nunca use fora da máquina de desenvolvimento.
import { createServer } from 'node:http';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';

const porta = Number(process.env.LOGIN_DEV_PORTA ?? 4039);
const { publicKey, privateKey } = await generateKeyPair('RS256');
const jwks = JSON.stringify({ keys: [{ ...(await exportJWK(publicKey)), kid: 'login-dev', alg: 'RS256', use: 'sig' }] });

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  res.setHeader('Content-Type', 'application/json');
  if (url.pathname === '/jwks.json') return res.end(jwks);
  const sub = url.searchParams.get('sub') ?? '';
  if (url.pathname === '/token' && /^[\w.-]{1,64}$/.test(sub)) {
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: 'RS256', kid: 'login-dev' })
      .setSubject(sub)
      .setIssuer('revolt-login-dev')
      .setAudience('revolt-app-dev')
      .setIssuedAt()
      .setExpirationTime('12h')
      .sign(privateKey);
    return res.end(JSON.stringify({ token }));
  }
  res.statusCode = 400;
  res.end(JSON.stringify({ erro: 'use GET /jwks.json ou GET /token?sub=<identificador>' }));
}).listen(porta, '127.0.0.1', () => console.log(`login de desenvolvimento em http://localhost:${porta}`));
