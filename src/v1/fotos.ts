// Fotos de check-ins e reportes (RF08 e UC06 do app). A API aceita só JPEG de até 500 KB e recomprime, o que descarta todo
// metadado (EXIF, GPS). A foto sai por GET /v1/fotos/:id, sem autor; o identificador é aleatório.
import { BadRequestException, Controller, Get, NotFoundException, Param, ParseUUIDPipe, Res, UseFilters } from '@nestjs/common';
import { ApiBadRequestResponse, ApiNotFoundResponse, ApiOkResponse, ApiOperation, ApiParam, ApiProduces, ApiTags } from '@nestjs/swagger';
import sharp from 'sharp';
import { Db } from '../db.js';
import { ErrosV1 } from './acesso.js';
import { Erro } from './contrato.js';

export const FOTO_MAX_BYTES = 500 * 1024;
const LADO_MAX_PX = 1600;

const fotoInvalida = (mensagem: string) => new BadRequestException({ erro: 'foto_invalida', mensagem });

// JPEG em base64 -> JPEG recomprimido, sem metadados (o sharp não copia nenhum por padrão), no máximo 1600 px de lado.
export async function recomprimir(base64: string): Promise<Buffer> {
  const original = Buffer.from(base64, 'base64');
  if (original.length > FOTO_MAX_BYTES) throw fotoInvalida('A foto passa de 500 KB.');
  if (original.subarray(0, 3).toString('hex') !== 'ffd8ff') throw fotoInvalida('A foto precisa ser JPEG.');
  try {
    return await sharp(original, { failOn: 'error' })
      .rotate() // aplica a orientação do EXIF antes de descartá-lo
      .resize({ width: LADO_MAX_PX, height: LADO_MAX_PX, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 80, mozjpeg: true })
      .toBuffer();
  } catch {
    throw fotoInvalida('A foto não pôde ser lida como JPEG.');
  }
}

export const caminhoDaFoto = (id: string | null) => (id ? `/v1/fotos/${id}` : null);

@ApiTags('contribuicoes')
@UseFilters(ErrosV1)
@Controller('v1/fotos')
export class FotosController {
  constructor(private db: Db) {}

  @Get(':id')
  @ApiOperation({ summary: 'Foto de um check-in ou reporte', description: 'JPEG recomprimido pela API, sem metadados e sem autor. Sai da base quando o Curador remove.' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiProduces('image/jpeg')
  @ApiOkResponse({ description: 'A foto.', content: { 'image/jpeg': { schema: { type: 'string', format: 'binary' } } } })
  @ApiBadRequestResponse({ type: Erro })
  @ApiNotFoundResponse({ type: Erro, description: 'Foto inexistente ou removida pelo Curador.' })
  async foto(@Param('id', new ParseUUIDPipe()) id: string, @Res() res) {
    const [f] = await this.db.query('SELECT jpeg FROM foto WHERE id = $1', [id]);
    if (!f) throw new NotFoundException('foto não encontrada');
    res.type('image/jpeg').send(f.jpeg);
  }
}
