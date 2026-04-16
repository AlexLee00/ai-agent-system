// @ts-nocheck
'use client';

const STORAGE_KEY = 'worker_document_reuse_draft';

export function saveDocumentReuseDraft(target, draft) {
  if (typeof window === 'undefined') return false;
  try {
    const payload = typeof draft === 'string'
      ? {
          target,
          draft,
          createdAt: new Date().toISOString(),
        }
      : {
          target,
          draft: draft?.draft || '',
          documentId: draft?.documentId || null,
          filename: draft?.filename || '',
          category: draft?.category || '',
          reuseEventId: draft?.reuseEventId || null,
          createdAt: new Date().toISOString(),
        };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}

export function consumeDocumentReuseDraft(target) {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.target !== target || !parsed.draft) return null;
    localStorage.removeItem(STORAGE_KEY);
    return parsed;
  } catch {
    return null;
  }
}
