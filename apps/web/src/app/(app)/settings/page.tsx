'use client';

import { useState } from 'react';
import { Power, PowerOff } from 'lucide-react';
import { toast } from 'sonner';
import { PageHeader, Section } from '@/components/page-header';
import { StepUpDialog } from '@/components/step-up-dialog';
import { QueryState } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useKillSwitch, useSetKillSwitch } from '@/lib/api/hooks';

export default function SettingsPage() {
  return (
    <div className="space-y-8">
      <PageHeader title="Settings" description="Safety controls for live trading." />
      <KillSwitchSection />
    </div>
  );
}

function KillSwitchSection() {
  const q = useKillSwitch();
  const set = useSetKillSwitch();
  const [reason, setReason] = useState('');
  const [open, setOpen] = useState(false);
  const reasonOk = reason.trim().length >= 3;
  return (
    <Section title="Kill switch" className="scroll-mt-24">
      <div id="kill-switch" />
      <QueryState query={q} rows={2}>
        {(ks) => {
          const enable = !ks.liveTradingEnabled;
          return (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2" data-testid="kill-switch-state">
                  {ks.liveTradingEnabled ? (
                    <>
                      <Power className="size-4" aria-hidden="true" /> Live trading enabled
                    </>
                  ) : (
                    <>
                      <PowerOff className="size-4 text-destructive" aria-hidden="true" /> Live trading off
                      (kill switch engaged)
                    </>
                  )}
                </CardTitle>
                <CardDescription>
                  While off, live orders cannot be previewed or approved. Even when on, execution stays
                  manual: you place each approved order yourself in the KTrade app. Paper trading is never
                  affected.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="space-y-1.5">
                  <Label htmlFor="ks-reason">Reason (recorded in the audit log)</Label>
                  <Textarea
                    id="ks-reason"
                    value={reason}
                    maxLength={500}
                    onChange={(e) => setReason(e.target.value)}
                    placeholder={
                      enable ? 'e.g. Starting manual live trading this week' : 'e.g. Pausing live trading'
                    }
                  />
                </div>
                <Button
                  variant={enable ? 'default' : 'destructive'}
                  disabled={!reasonOk || set.isPending}
                  onClick={() => setOpen(true)}
                >
                  {enable ? 'Enable live trading…' : 'Engage kill switch…'}
                </Button>
                <StepUpDialog
                  open={open}
                  onOpenChange={setOpen}
                  title={enable ? 'Enable live trading' : 'Engage kill switch'}
                  confirmLabel={enable ? 'Enable' : 'Engage'}
                  onVerified={async (token) => {
                    await set.mutateAsync({
                      liveTradingEnabled: enable,
                      reason: reason.trim(),
                      stepUpToken: token,
                    });
                    setReason('');
                    toast.success(enable ? 'Live trading enabled' : 'Kill switch engaged');
                  }}
                />
              </CardContent>
            </Card>
          );
        }}
      </QueryState>
    </Section>
  );
}
