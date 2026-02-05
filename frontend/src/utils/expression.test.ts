import { describe, it, expect } from 'vitest';
import { evaluateExpression, isExpression, isValidParamName } from './expression';

describe('evaluateExpression', () => {
  it('evaluates plain numbers', () => {
    expect(evaluateExpression('42', {})).toBe(42);
    expect(evaluateExpression('3.14', {})).toBeCloseTo(3.14);
  });

  it('evaluates addition and subtraction', () => {
    expect(evaluateExpression('1 + 2', {})).toBe(3);
    expect(evaluateExpression('10 - 3', {})).toBe(7);
    expect(evaluateExpression('1 + 2 + 3', {})).toBe(6);
  });

  it('evaluates multiplication and division', () => {
    expect(evaluateExpression('3 * 4', {})).toBe(12);
    expect(evaluateExpression('10 / 4', {})).toBe(2.5);
  });

  it('respects operator precedence', () => {
    expect(evaluateExpression('2 + 3 * 4', {})).toBe(14);
    expect(evaluateExpression('10 - 6 / 2', {})).toBe(7);
  });

  it('handles parentheses', () => {
    expect(evaluateExpression('(2 + 3) * 4', {})).toBe(20);
    expect(evaluateExpression('((1 + 2))', {})).toBe(3);
  });

  it('handles unary minus', () => {
    expect(evaluateExpression('-5', {})).toBe(-5);
    expect(evaluateExpression('-(3 + 2)', {})).toBe(-5);
    expect(evaluateExpression('2 * -3', {})).toBe(-6);
  });

  it('resolves variables', () => {
    expect(evaluateExpression('x', { x: 10 })).toBe(10);
    expect(evaluateExpression('bolt_hole', { bolt_hole: 5 })).toBe(5);
    expect(evaluateExpression('bolt_hole / 2', { bolt_hole: 5 })).toBe(2.5);
  });

  it('resolves multiple variables', () => {
    expect(evaluateExpression('a + b * c', { a: 1, b: 2, c: 3 })).toBe(7);
  });

  it('throws on unknown variable', () => {
    expect(() => evaluateExpression('unknown', {})).toThrow("Unknown variable: 'unknown'");
  });

  it('throws on empty expression', () => {
    expect(() => evaluateExpression('', {})).toThrow('Empty expression');
    expect(() => evaluateExpression('  ', {})).toThrow('Empty expression');
  });

  it('throws on unexpected character', () => {
    expect(() => evaluateExpression('2 @ 3', {})).toThrow("Unexpected character: '@'");
  });

  it('throws on missing closing paren', () => {
    expect(() => evaluateExpression('(2 + 3', {})).toThrow('Expected closing parenthesis');
  });

  it('throws on trailing tokens', () => {
    expect(() => evaluateExpression('2 3', {})).toThrow("Unexpected token: '3'");
  });

  it('handles division by zero (returns Infinity)', () => {
    expect(evaluateExpression('1 / 0', {})).toBe(Infinity);
  });
});

describe('isExpression', () => {
  it('returns true for strings containing letters', () => {
    expect(isExpression('bolt_hole')).toBe(true);
    expect(isExpression('bolt_hole / 2')).toBe(true);
    expect(isExpression('a + b')).toBe(true);
  });

  it('returns false for pure numeric strings', () => {
    expect(isExpression('42')).toBe(false);
    expect(isExpression('3.14')).toBe(false);
    expect(isExpression('1 + 2')).toBe(false);
  });
});

describe('isValidParamName', () => {
  it('accepts valid names', () => {
    expect(isValidParamName('x')).toBe(true);
    expect(isValidParamName('bolt_hole')).toBe(true);
    expect(isValidParamName('_private')).toBe(true);
    expect(isValidParamName('A1')).toBe(true);
  });

  it('rejects invalid names', () => {
    expect(isValidParamName('')).toBe(false);
    expect(isValidParamName('1abc')).toBe(false);
    expect(isValidParamName('a b')).toBe(false);
    expect(isValidParamName('a-b')).toBe(false);
  });
});
