// @ts-nocheck
'use client';

import { useEffect } from 'react';

export default function useAutoResizeTextarea(ref, value, baseHeight = 24) {
  useEffect(() => {
    const node = ref?.current;
    if (!node) return;
    node.style.height = `${baseHeight}px`;
    const nextHeight = node.scrollHeight <= baseHeight + 4 ? baseHeight : node.scrollHeight;
    node.style.height = `${nextHeight}px`;
  }, [ref, value, baseHeight]);
}
