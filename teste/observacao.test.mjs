// Testes unitários da observação de motorista (Alteração 6 do PRD de obtenção), sobre o código compilado.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { motivoDaRecusa } from '../dist/observacoes.js';

const erro = (property, constraints) => ({ property, constraints, children: [] });
const HOJE = '2026-11-20';

describe('Recusa de observação de motorista (RF19 e RN20 da obtenção)', () => {
  test('observação completa, com data de hoje ou do passado (enviada depois, sem conexão), é aceita', () => {
    assert.equal(motivoDaRecusa([], HOJE, HOJE), null);
    assert.equal(motivoDaRecusa([], '2026-11-02', HOJE), null);
  });

  test('sem data é recusada', () => {
    assert.equal(motivoDaRecusa([erro('data_observacao', { isDateString: 'x' })], undefined, HOJE), 'sem_data');
  });

  test('data malformada é recusada como inválida', () => {
    assert.equal(motivoDaRecusa([erro('data_observacao', { matches: 'x' })], '20/11/2026', HOJE), 'data_invalida');
  });

  test('data no futuro é recusada', () => {
    assert.equal(motivoDaRecusa([], '2026-11-21', HOJE), 'data_futura');
  });

  test('campo fora da lista, como um dado do Google, é recusado antes de qualquer outro motivo', () => {
    const erros = [erro('displayName', { whitelistValidation: 'x' }), erro('data_observacao', { isDateString: 'x' })];
    assert.equal(motivoDaRecusa(erros, undefined, HOJE), 'campo_nao_aceito');
  });

  test('outro erro de validação é pedido inválido', () => {
    assert.equal(motivoDaRecusa([erro('carregou', { isBoolean: 'x' })], HOJE, HOJE), 'pedido_invalido');
  });
});
