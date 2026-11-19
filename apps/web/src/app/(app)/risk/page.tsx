'use client';

import { Disclaimer } from '@/components/advisor/advisor-bits';
import { RiskPage } from '@/components/advisor/risk-panel';
import { PageHeader } from '@/components/page-header';

export default function RiskManagementPage() {
  return (
    <div className="space-y-6">
      <PageHeader
        title="Risk Management"
        description="Decide how much you are willing to lose on one idea, and see the limits that protect the portfolio."
      />
      <RiskPage />
      <Disclaimer />
    </div>
  );
}
