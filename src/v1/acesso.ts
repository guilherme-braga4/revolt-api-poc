// Autenticação da /v1 (D-04 e D-09 da arquitetura).
// - Conta: token do provedor de login gerenciado (ex.: Firebase Authentication) em "Authorization: Bearer". A API só
//   valida a assinatura, o emissor e o público. Nada de senha guardada pelo REVOLT.
// - Atestado do app: token do serviço de atestado (ex.: Firebase App Check) em "X-Atestado-App". Sem ele, o pedido não
//   recebe dados do Google (RN18 da obtenção) nem gasta ficha paga.
// - Trava contra ritmo de robô: limite de fichas do Google e de viagens planejadas (rota e busca do Google) por aparelho,
//   bem acima do uso humano. Não é limite por pessoa.
import {
  ArgumentsHost, CanActivate, Catch, Controller, ExceptionFilter, ExecutionContext, ForbiddenException, Get, HttpException, Injectable, Logger,
  Req, UnauthorizedException, UseFilters, UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags, ApiUnauthorizedResponse } from '@nestjs/swagger';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { Db } from '../db.js';
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

// Pedidos que consultam o Google na hora, por aparelho a cada 10 minutos. Cada viagem planejada faz duas consultas pagas.
const LIMITES = { fichas: Number(process.env.LIMITE_FICHAS_GOOGLE ?? 60), rotas: Number(process.env.LIMITE_ROTAS_GOOGLE ?? 20) };
const JANELA_MS = 10 * 60 * 1000;

@Injectable()
export class Acesso {
  private conta = verificador('CONTA');
  private atestado = verificador('ATESTADO');
  private janelas = { fichas: new Map<string, { inicio: number; n: number }>(), rotas: new Map<string, { inicio: number; n: number }>() };

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

  // Janela fixa de 10 minutos por aparelho (cabeçalho X-Aparelho, gerado pelo app na instalação; sem ele, o IP), contada
  // à parte para fichas e para rotas.
  dentroDoRitmo(req, tipo: keyof typeof LIMITES): boolean {
    const janelas = this.janelas[tipo];
    const chave = String(req.headers['x-aparelho'] ?? req.ip).slice(0, 100);
    const agora = Date.now();
    if (janelas.size > 10000) for (const [k, j] of janelas) if (agora - j.inicio >= JANELA_MS) janelas.delete(k);
    let janela = janelas.get(chave);
    if (!janela || agora - janela.inicio >= JANELA_MS) janelas.set(chave, (janela = { inicio: agora, n: 0 }));
    return ++janela.n <= LIMITES[tipo];
  }
}

// Contas com papel de Curador: identificadores do provedor de login, separados por vírgula (no-core; sem papel no provedor).
const CURADORES = new Set((process.env.CURADOR_CONTAS ?? '').split(',').map((s) => s.trim()).filter(Boolean));

// Rotas que exigem conta. A primeira entrada cria a conta (UC07): do provedor de login, só o identificador. O papel segue
// CURADOR_CONTAS a cada pedido. Guarda a conta em req.conta.
@Injectable()
export class ContaGuard implements CanActivate {
  constructor(
    private acesso: Acesso,
    private db: Db,
  ) {}

  async canActivate(contexto: ExecutionContext) {
    const req = contexto.switchToHttp().getRequest();
    const token = await this.acesso.contaDe(req);
    if (!token?.sub) throw new UnauthorizedException({ erro: 'conta_necessaria', mensagem: 'Entre com uma conta para continuar.' });
    [req.conta] = await this.db.query(
      `INSERT INTO conta (sub, papel) VALUES ($1, $2) ON CONFLICT (sub) DO UPDATE SET papel = EXCLUDED.papel
       RETURNING id, sub, papel, pseudonimo, bloqueada_em`,
      [token.sub, CURADORES.has(token.sub) ? 'curador' : 'motorista'],
    );
    return true;
  }
}

// Rotas do Curador: moderação (UC08) e operação do módulo obtenção.
@Injectable()
export class CuradorGuard extends ContaGuard {
  async canActivate(contexto: ExecutionContext) {
    await super.canActivate(contexto);
    if (contexto.switchToHttp().getRequest().conta.papel !== 'curador')
      throw new ForbiddenException({ erro: 'papel_curador_necessario', mensagem: 'Só a conta do Curador pode usar esta rota.' });
    return true;
  }
}

const CODIGOS = { 400: 'pedido_invalido', 401: 'nao_autorizado', 403: 'proibido', 404: 'nao_encontrado', 429: 'muitos_pedidos' };

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
  @ApiOperation({
    summary: 'Conta do token',
    description:
      'Valida o token do provedor de login (D-04) e cria a conta na primeira entrada. A conta só é exigida para contribuir e ' +
      'salvar viagens. Diz o papel (o app mostra as telas do Curador) e se a conta foi bloqueada para contribuir.',
  })
  @ApiOkResponse({ type: Conta })
  @ApiUnauthorizedResponse({ type: Erro })
  conta(@Req() req) {
    return { id: req.conta.sub, papel: req.conta.papel, bloqueada: req.conta.bloqueada_em !== null };
  }
}
