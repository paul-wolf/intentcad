import { describe, expect, it } from 'vitest';
import type { ContextFile, ContextFiles } from '@/api/client';
import {
  acceptable, asksForFile, chatUsageNote, detailLabel, seesSpend, spendLine, spendNote, usageLabel, fileTokens, filesToSend,
  includedPages, pageRanges, skipList, togglePage, tokensLabel,
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

describe('the AI spend', () => {
  const NORMAL = { is_staff: false, is_superuser: false };
  const STAFF = { is_staff: true, is_superuser: false };
  const SUPER = { is_staff: false, is_superuser: true };
  const USAGE = {
    document: { edits: 2, tokens_in: 300, tokens_out: 60, cost_usd: 0.03 },
    all_time: { edits: 3, tokens_in: 350, tokens_out: 70, cost_usd: 0.4412 },
  };

  it('is for staff and superusers only', () => {
    expect(seesSpend(STAFF)).toBe(true);
    expect(seesSpend(SUPER)).toBe(true);
    expect(seesSpend(NORMAL)).toBe(false);
    expect(seesSpend(null)).toBe(false);
  });

  it('shows the status line to staff and superusers, not to anyone else', () => {
    const line = 'AI spend · this model $0.030 (2) · all-time $0.44 (3)';
    expect(spendLine(STAFF, USAGE)).toBe(line);
    expect(spendLine(SUPER, USAGE)).toBe(line);
    expect(spendLine(NORMAL, USAGE)).toBeNull();
    expect(spendLine(undefined, USAGE)).toBeNull();
    expect(spendLine(STAFF, null)).toBeNull();   // not fetched yet
  });

  it('shows the chat’s per-call notes to staff and superusers, not to anyone else', () => {
    const note = '900 in · 80 out · $0.004';
    expect(chatUsageNote(STAFF, note)).toBe(note);
    expect(chatUsageNote(SUPER, note)).toBe(note);
    expect(chatUsageNote(NORMAL, note)).toBeNull();   // a note saved earlier stays hidden
    expect(chatUsageNote(STAFF, undefined)).toBeNull();
  });

  it('notes an edit’s spend only when the response carries it', () => {
    expect(spendNote({ tokens_in: 900, tokens_out: 80, cost_usd: 0.004 })).toBe('900 in · 80 out · $0.004');
    expect(spendNote({})).toBeUndefined();   // a normal user's response: no spend fields
  });
});

describe('a question that asks for a file', () => {
  it('spots a request for a photo, drawing or datasheet', () => {
    expect(asksForFile('Could you send a photo of the board from above?')).toBe(true);
    expect(asksForFile('Do you have a drawing or the datasheet with the hole positions?')).toBe(true);
    expect(asksForFile('Can you attach an image showing the measurements?')).toBe(true);
  });
  it('leaves other questions and errors alone', () => {
    expect(asksForFile('Should the holes be M3 or M4?')).toBe(false);
    expect(asksForFile('⚠ The photo upload failed')).toBe(false);
  });
});
