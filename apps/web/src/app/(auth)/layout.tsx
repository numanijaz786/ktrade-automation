import { CandlestickChart } from 'lucide-react';

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-svh flex-col items-center justify-center gap-6 bg-muted/40 px-4 py-10">
      <div className="flex items-center gap-2 font-semibold">
        <span className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
          <CandlestickChart className="size-4" aria-hidden="true" />
        </span>
        PSX Smart Trading
      </div>
      <div className="w-full max-w-sm">{children}</div>
      <p className="max-w-sm text-center text-xs text-muted-foreground">
        Demo build: sign-in is simulated and no credentials leave your browser. Tokens are never stored in localStorage; the real BFF uses httpOnly cookies.
      </p>
    </main>
  );
}
