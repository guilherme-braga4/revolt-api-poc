// Autenticação da /v1 (D-04 e D-09 da arquitetura).
// - Conta: token do provedor de login gerenciado (ex.: Firebase Authentication) em "Authorization: Bearer". A API só
//   valida a assinatura, o emissor e o público. Nada de senha guardada pelo REVOLT.
// - Atestado do app: token do serviço de atestado (ex.: Firebase App Check) em "X-Atestado-App". Sem ele, o pedido não
//   recebe dados do Google (RN18 da obtenção) nem gasta ficha paga.
// - Trava contra ritmo de robô: limite de fichas do Google por aparelho, bem acima do uso humano. Não é limite por pessoa.
import {
  ArgumentsHost, CanActivate, Catch, Controller, ExceptionFilter, ExecutionContext, Get, HttpException, Injectable, Logger, Req,
  UnauthorizedException, UseFilters, UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags, ApiUnauthorizedResponse } from '@nestjs/swagger';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { Conta, Erro } from './contrato.js';

function verificador(prefixo: 'CONTA' | 'ATESTADO') {
  const url = process.env[`${prefixo}_JWKS_URL`];
  if (!url) return null;
  const emissor = process.env[`${prefixo}_EMISSOR`];
  const publico = process.env[`${prefixo}_PUBLICO`];
  if (!emissor || !publico) throw new Error(`${prefixo}_JWKS_URL exige ${prefixo}_EMISSOR e ${prefixo}_PUBLICO`);
  const chaves = createRemoteJWKSet(new URL(url));
  return async (token: string | undefined): Promise<JWTPayload | null> => {
    if (!token) return null;
    try {
      return (await jwtVerify(token, chaves, { issuer: emissor, audience: publico, algorithms: ['RS256'] })).payload;
    } catch {
      return null;
    }
  };
}

const LIMITE_FICHAS = Number(process.env.LIMITE_FICHAS_GOOGLE ?? 60);
const JANELA_MS = 10 * 60 * 1000;

@Injectable()
export class Acesso {
  private conta = verificador('CONTA');
  private atestado = verificador('ATESTADO');
  private fichas = new Map<string, { inicio: number; n: number }>();

  constructor() {
    if (!this.atestado) new Logger('Acesso').warn('ATESTADO_JWKS_URL vazio: atestado do app desligado (só para desenvolvimento).');
  }

  async appAtestado(req): Promise<boolean> {
    return !this.atestado || (await this.atestado(req.headers['x-atestado-app'])) !== null;
  }

  async contaDe(req): Promise<JWTPayload | null> {
    if (!this.conta) return null;
    return this.conta(/^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1]);
  }

  // Janela fixa de 10 minutos por aparelho (cabeçalho X-Aparelho, gerado pelo app na instalação; sem ele, o IP).
  dentroDoRitmo(req): boolean {
    const chave = String(req.headers['x-aparelho'] ?? req.ip).slice(0, 100);
    const agora = Date.now();
    if (this.fichas.size > 10000) for (const [k, j] of this.fichas) if (agora - j.inicio >= JANELA_MS) this.fichas.delete(k);
    let janela = this.fichas.get(chave);
    if (!janela || agora - janela.inicio >= JANELA_MS) this.fichas.set(chave, (janela = { inicio: agora, n: 0 }));
    return ++janela.n <= LIMITE_FICHAS;
  }
}

// Rotas que exigem conta. Guarda os dados do token em req.conta.
@Injectable()
export class ContaGuard implements CanActivate {
  constructor(private acesso: Acesso) {}

  async canActivate(contexto: ExecutionContext) {
    const req = contexto.switchToHttp().getRequest();
    req.conta = await this.acesso.contaDe(req);
    if (!req.conta) throw new UnauthorizedException({ erro: 'conta_necessaria', mensagem: 'Entre com uma conta para continuar.' });
    return true;
  }
}

const CODIGOS = { 400: 'pedido_invalido', 401: 'nao_autorizado', 404: 'nao_encontrado', 429: 'muitos_pedidos' };

// Todo erro da /v1 sai no mesmo formato: { erro, mensagem } e, na ficha do Google, link_externo.
@Catch()
export class ErrosV1 implements ExceptionFilter {
  catch(e: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse();
    if (!(e instanceof HttpException)) {
      new Logger('ErrosV1').error(e);
      return res.status(500).json({ erro: 'erro_interno', mensagem: 'Erro interno.' });
    }
    const corpo = e.getResponse() as any;
    if (corpo?.erro) return res.status(e.getStatus()).json(corpo);
    const mensagem = typeof corpo === 'string' ? corpo : [].concat(corpo?.message ?? 'Erro.').join('; ');
    res.status(e.getStatus()).json({ erro: CODIGOS[e.getStatus()] ?? 'erro', mensagem });
  }
}

// GET /v1/conta: confere o token de conta e devolve o identificador. Base para as rotas com conta das fases 2 e 3.
@ApiTags('conta')
@UseFilters(ErrosV1)
@Controller('v1/conta')
export class ContaController {
  @Get()
  @UseGuards(ContaGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Conta do token', description: 'Valida o token do provedor de login (D-04). A conta só é exigida para contribuir.' })
  @ApiOkResponse({ type: Conta })
  @ApiUnauthorizedResponse({ type: Erro })
  conta(@Req() req) {
    return { id: req.conta.sub };
  }
}
