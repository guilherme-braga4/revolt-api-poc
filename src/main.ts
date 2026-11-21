import 'reflect-metadata';
import { Module, ValidationPipe, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ScheduleModule } from '@nestjs/schedule';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import compression from 'compression';
import { writeFileSync } from 'node:fs';
import { ControleController } from './controle.js';
import { CorredorController } from './corredor.js';
import { Db } from './db.js';
import { GoogleController, GoogleService } from './google.js';
import { OcmController, OcmService } from './ocm.js';
import { PropriosController } from './proprios.js';
import { Acesso, ContaController, ContaGuard, ContribuicaoGuard, CuradorGuard } from './v1/acesso.js';
import { CheckinsController } from './v1/checkins.js';
import { FotosController } from './v1/fotos.js';
import { ReportesController } from './v1/reportes.js';
import { CuradorController } from './v1/curador.js';
import { FichaController } from './v1/ficha.js';
import { MapaController } from './v1/mapa.js';
import { ViagensController } from './v1/viagens.js';
import { EventosController } from './v1/eventos.js';
import { ViagensSalvasController } from './v1/viagens-salvas.js';

// Módulo obtenção: a POC evoluída (OCM, varredura e ficha do Google, verificação própria, teto e fontes). Rotas do Curador.
@Module({
  controllers: [OcmController, GoogleController, PropriosController, ControleController, CorredorController],
  providers: [Db, OcmService, GoogleService, Acesso, ContaGuard, ContribuicaoGuard, CuradorGuard],
  exports: [Db, GoogleService, Acesso, ContaGuard, ContribuicaoGuard, CuradorGuard],
})
class ObtencaoModule {}

// Módulo app: o contrato /v1 consumido pelo app do motorista (D-02).
@Module({
  imports: [ObtencaoModule],
  controllers: [MapaController, FichaController, ViagensController, ContaController, CheckinsController, FotosController, ReportesController, CuradorController,
    ViagensSalvasController, EventosController],
})
class AppV1Module {}

@Module({ imports: [ScheduleModule.forRoot(), ObtencaoModule, AppV1Module] })
class AppModule {}

// Especificação OpenAPI do /v1, gerada das classes do contrato (src/v1/contrato.ts).
function openapi(app: INestApplication) {
  const config = new DocumentBuilder()
    .setTitle('REVOLT · API do app do motorista')
    .setDescription(
      'Contrato /v1, em JSON e no vocabulário do REVOLT. Todo item traz origem, verificacao, atualizado_em e condicoes_de_uso. ' +
        'Datas de item são dias (AAAA-MM-DD, fuso de Brasília). Valores novos podem entrar nas listas fechadas: o app deve tolerá-los.',
    )
    .setVersion('1')
    .addBearerAuth()
    .build();
  return SwaggerModule.createDocument(app, config, { include: [AppV1Module] });
}

const app = await NestFactory.create<NestExpressApplication>(AppModule);
// Check-in e reporte podem trazer uma foto de até 500 KB em base64.
app.useBodyParser('json', { limit: '1mb' });
app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
app.use(compression());
const documento = openapi(app);

if (process.argv.includes('--openapi')) {
  // npm run openapi: grava a especificação no repositório, sem subir o servidor.
  writeFileSync(new URL('../openapi/v1.json', import.meta.url), JSON.stringify(documento, null, 2) + '\n');
  console.log('openapi/v1.json gravado');
  await app.close();
} else {
  SwaggerModule.setup('v1/docs', app, documento, { jsonDocumentUrl: 'v1/openapi.json' });
  await app.listen(process.env.PORT ?? 3333);
  console.log(`API em http://localhost:${process.env.PORT ?? 3333} · contrato em /v1/docs e /v1/openapi.json`);
}
