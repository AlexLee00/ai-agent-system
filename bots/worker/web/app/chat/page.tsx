// @ts-nocheck
import { redirect } from 'next/navigation';

export default function WorkerChatPage({ searchParams }) {
  const prompt = typeof searchParams?.prompt === 'string' ? searchParams.prompt : '';
  const selectedBot = typeof searchParams?.selectedBot === 'string' ? searchParams.selectedBot : '';

  const qs = new URLSearchParams();
  if (prompt) qs.set('prompt', prompt);
  if (selectedBot) qs.set('selectedBot', selectedBot);

  redirect(qs.toString() ? `/dashboard?${qs.toString()}` : '/dashboard');
}
