// @ts-nocheck
'use client';

export default function OperationsSplitLayout({
  left,
  right,
  className = '',
}) {
  return (
    <section className={`grid gap-4 lg:grid-cols-[1.15fr_0.85fr] ${className}`.trim()}>
      <div>{left}</div>
      <div>{right}</div>
    </section>
  );
}
