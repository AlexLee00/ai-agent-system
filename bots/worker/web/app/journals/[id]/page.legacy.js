import { redirect } from 'next/navigation';

export default function JournalDetailRedirectPage({ params }) {
  redirect(`/work-journals/${params?.id || ''}`);
}
