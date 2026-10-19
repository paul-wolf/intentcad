import { beforeEach, describe, expect, it } from 'vitest';
import { useDocumentStore } from './documentStore';
import { createEmptyDocument } from '@/utils/document';

const s = () => useDocumentStore.getState();
const step = (label: string, name: string) => { s().beginTransaction(label); s().setDocumentName(name); };
const labels = () => ({
  done: s().undoStack.map((e) => e.label),
  undone: [...s().redoStack].reverse().map((e) => e.label),   // next redo first
});

describe('history', () => {
  beforeEach(() => {
    s().setDocument(createEmptyDocument('S0'));
    step('A', 'S1'); step('B', 'S2'); step('C', 'S3');
  });

  it('keeps step names through undo and redo', () => {
    s().undo();
    expect(s().document.name).toBe('S2');
    expect(labels()).toEqual({ done: ['A', 'B'], undone: ['C'] });
    s().undo(); s().redo(); s().redo();
    expect(s().document.name).toBe('S3');
    expect(labels()).toEqual({ done: ['A', 'B', 'C'], undone: [] });
  });

  it('goes to the state just after a step, and back again', () => {
    s().goToHistory(1);                       // just after A
    expect(s().document.name).toBe('S1');
    expect(labels()).toEqual({ done: ['A'], undone: ['B', 'C'] });
    s().redo();                               // redoes B
    expect(s().document.name).toBe('S2');
    s().goToHistory(0);                       // Start
    expect(s().document.name).toBe('S0');
    expect(labels()).toEqual({ done: [], undone: ['A', 'B', 'C'] });
    s().goToHistory(3);                       // just after C
    expect(s().document.name).toBe('S3');
    expect(labels()).toEqual({ done: ['A', 'B', 'C'], undone: [] });
  });

  it('drops the undone steps once a new one is made', () => {
    s().goToHistory(1);
    step('D', 'S4');
    expect(labels()).toEqual({ done: ['A', 'D'], undone: [] });
    s().undo();
    expect(s().document.name).toBe('S1');
  });

  it('names steps that older saves called Current', () => {
    const e = s().undoStack[0]!;
    s().restoreHistory({ undo: [{ ...e, label: 'Current' }], redo: [] });
    expect(s().undoStack[0]!.label).toBe('Earlier step');
  });
});
