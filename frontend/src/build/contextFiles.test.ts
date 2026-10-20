import { describe, expect, it } from 'vitest';
import type { ContextFile, ContextFiles } from '@/api/client';
import {
  acceptable, detailLabel, usageLabel, fileTokens, filesToSend, includedPages, pageRanges, skipList, togglePage, tokensLabel,
} from './contextFiles';

const file = (id: string, over: Partial<ContextFile> = {}): ContextFile => ({
  id, scope: 'project', project_id: 'p', document_id: null, filename: `${id}.pdf`, title: `${id}.pdf`, note: '',
  content_type: 'application/pdf', size: 10 * 1024 * 1024, page_count: 7, width: null, height: null,
  in_context: true, pages: null, page_tokens: [1000, 2000, 1500, 1500, 1500, 1600, 1600], est_tokens: 10700,
  created_at: '2026-10-20T00:00:00Z', ...over,
});

const files = (project: ContextFile[], part: ContextFile[] = []): ContextFiles => ({ project, part, project_id: 'p' });

describe('what the next message sends', () => {
  it('sends the files in context, the project’s first', () => {
    const c = files([file('sheet')], [file('photo', { scope: 'part', page_count: null, content_type: 'image/jpeg' })]);
    expect(filesToSend(c, new Set()).map((f) => f.id)).toEqual(['sheet', 'photo']);
  });

  it('leaves out a file toggled off in its card', () => {
    const c = files([file('sheet', { in_context: false }), file('drawing')]);
    expect(filesToSend(c, new Set()).map((f) => f.id)).toEqual(['drawing']);
    expect(skipList(c, new Set())).toEqual([]);
  });

  it('a chip removed for this message is skipped on the request, and only that file', () => {
    const c = files([file('sheet'), file('drawing')]);
    const skipped = new Set(['sheet']);
    expect(filesToSend(c, skipped).map((f) => f.id)).toEqual(['drawing']);
    expect(skipList(c, skipped)).toEqual(['sheet']);
  });

  it('a file already off in context is not listed as skipped', () => {
    const c = files([file('sheet', { in_context: false })]);
    expect(skipList(c, new Set(['sheet']))).toEqual([]);
  });

  it('a PDF with every page excluded is not sent', () => {
    const c = files([file('sheet', { pages: [] })]);
    expect(filesToSend(c, new Set())).toEqual([]);
  });

  it('nothing loaded sends nothing', () => {
    expect(filesToSend(null, new Set())).toEqual([]);
  });
});

describe('pages and tokens', () => {
  it('counts the tokens of the included pages', () => {
    expect(fileTokens(file('a'))).toBe(10700);
    expect(fileTokens(file('a', { pages: [2, 6] }))).toBe(3600);
  });

  it('toggles a page, back to null (all) when every page is in', () => {
    const f = file('a');
    expect(togglePage(f, 3)).toEqual([1, 2, 4, 5, 6, 7]);
    expect(togglePage(file('a', { pages: [1, 2, 4, 5, 6, 7] }), 3)).toBeNull();
    expect(includedPages(file('a', { pages: [9, 2] }))).toEqual([2]);
  });

  it('labels', () => {
    expect(pageRanges([1, 2, 3, 6])).toBe('1–3, 6');
    expect(detailLabel(file('a'))).toBe('7 pages · 10.0 MB');
    expect(detailLabel(file('a', { pages: [5, 6] }))).toBe('pages 5–6 of 7 · 10.0 MB');
    expect(detailLabel(file('a', { page_count: null, width: 1600, height: 1200, size: 240 * 1024 })))
      .toBe('1600 × 1200 · 240 KB');
    expect(tokensLabel(950)).toBe('950');
    expect(tokensLabel(2494)).toBe('2.5k');
    expect(tokensLabel(10700)).toBe('11k');
  });

  it('accepts PDFs and photos, by type or extension', () => {
    expect(acceptable({ name: 'x.pdf', type: 'application/pdf' })).toBe(true);
    expect(acceptable({ name: 'IMG_0412.HEIC', type: '' })).toBe(true);
    expect(acceptable({ name: 'image.png', type: 'image/png' })).toBe(true);
    expect(acceptable({ name: 'part.step', type: '' })).toBe(false);
    expect(acceptable({ name: 'anim.gif', type: 'image/gif' })).toBe(false);
  });

  it('labels a call’s usage, with the cached input', () => {
    expect(usageLabel({ tokens_in: 14200, tokens_out: 1200, cost_usd: 0.0312, cache_read_tokens: 10700 }))
      .toBe('14k in (11k cached) · 1.2k out · $0.031');
    expect(usageLabel({ tokens_in: 900, tokens_out: 80, cost_usd: 0.004 })).toBe('900 in · 80 out · $0.004');
  });
});
