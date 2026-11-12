import 'reflect-metadata';
import { Module, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { ControleController } from './controle.js';
import { Db } from './db.js';
import { GoogleController, GoogleService } from './google.js';
import { OcmController, OcmService } from './ocm.js';
import { EletropostosController } from './eletropostos.js';
import { PropriosController } from './proprios.js';

@Module({
  imports: [ScheduleModule.forRoot()],
  controllers: [EletropostosController, OcmController, GoogleController, PropriosController, ControleController],
  providers: [Db, OcmService, GoogleService],
})
class AppModule {}

const app = await NestFactory.create(AppModule);
app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
await app.listen(process.env.PORT ?? 3333);
console.log(`API da POC em http://localhost:${process.env.PORT ?? 3333}`);
