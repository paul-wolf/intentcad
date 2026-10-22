import { describe, it, expect } from 'vitest';
import type { Entity } from '@/types/document';
import { newPlanOperation } from '@/cam/resolve';
import { shapesText } from './opText';

const line = (id: string, a: [number, number], b: [number, number]): Entity =>
  ({ id, type: 'line', points: [{ x: a[0], y: a[1] }, { x: b[0], y: b[1] }] }) as Entity;
const sides = [line('a', [0, 0], [40, 0]), line('b', [40, 0], [40, 30]), line('c', [40, 30], [0, 30]), line('d', [0, 30], [0, 0])];
const circle = { id: 'h', type: 'circle', center: { x: 20, y: 15 }, radius: 2 } as Entity;

describe('what an operation cuts', () => {
  it('counts lines that meet end to end as one outline', () => {
    const all = [...sides, circle];
    expect(shapesText(newPlanOperation('profile', 's', ['a', 'b', 'c', 'd'], 'outside'), all)).toBe('1 outline (4 lines)');
    expect(shapesText(newPlanOperation('pocket', 's', ['a', 'b', 'c', 'd', 'h'], 'inside'), all)).toBe('2 outlines (5 shapes)');
    expect(shapesText(newPlanOperation('profile', 's', ['h'], 'outside'), all)).toBe('1 shape');
    expect(shapesText(newPlanOperation('drill', 's', ['h'], 'on'), all)).toBe('');
  });
});
