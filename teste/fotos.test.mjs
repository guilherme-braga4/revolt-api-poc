// Testes unitários da foto de check-in e reporte (RF08 e UC06 do app; RN21: nenhum metadado), sobre o código compilado.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import sharp from 'sharp';
import { FOTO_MAX_BYTES, recomprimir } from '../dist/v1/fotos.js';

const imagem = (largura, altura) => sharp({ create: { width: largura, height: altura, channels: 3, background: { r: 30, g: 120, b: 200 } } });
const comExif = () =>
  imagem(64, 48)
    .withExif({ IFD0: { Make: 'CameraDeTeste', Software: 'AutorSecreto' }, IFD3: { GPSLatitudeRef: 'S', GPSLatitude: '23/1 11/1 0/1' } })
    .jpeg()
    .toBuffer();
const recusa = (mensagem) => (e) => e.getResponse().erro === 'foto_invalida' && e.getResponse().mensagem === mensagem;

describe('Recompressão da foto', () => {
  test('a foto sai como JPEG sem EXIF nem GPS', async () => {
    const original = await comExif();
    assert.ok((await sharp(original).metadata()).exif, 'a foto de teste precisa ter EXIF');
    const saida = await recomprimir(original.toString('base64'));
    const m = await sharp(saida).metadata();
    assert.equal(m.format, 'jpeg');
    assert.equal(m.exif, undefined);
    assert.equal(saida.includes('AutorSecreto'), false);
    assert.equal(saida.includes('CameraDeTeste'), false);
  });

  test('foto grande é reduzida a 1600 px no maior lado', async () => {
    const original = await imagem(3200, 1000).jpeg({ quality: 30 }).toBuffer();
    const m = await sharp(await recomprimir(original.toString('base64'))).metadata();
    assert.deepEqual([m.width, m.height], [1600, 500]);
  });

  test('mais de 500 KB é recusada', async () => {
    const grande = Buffer.concat([Buffer.from('ffd8ff', 'hex'), Buffer.alloc(FOTO_MAX_BYTES)]);
    await assert.rejects(recomprimir(grande.toString('base64')), recusa('A foto passa de 500 KB.'));
  });

  test('PNG é recusado', async () => {
    const png = await imagem(10, 10).png().toBuffer();
    await assert.rejects(recomprimir(png.toString('base64')), recusa('A foto precisa ser JPEG.'));
  });

  test('JPEG corrompido é recusado', async () => {
    const corrompido = Buffer.concat([Buffer.from('ffd8ffe0', 'hex'), Buffer.from('não é imagem')]);
    await assert.rejects(recomprimir(corrompido.toString('base64')), recusa('A foto não pôde ser lida como JPEG.'));
  });
});
