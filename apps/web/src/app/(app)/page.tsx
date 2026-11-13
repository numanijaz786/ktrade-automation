import { redirect } from 'next/navigation';

export default function Home() {
  // The dashboard page is not built yet; the market overview is the first page on real data.
  redirect('/market/overview');
}
