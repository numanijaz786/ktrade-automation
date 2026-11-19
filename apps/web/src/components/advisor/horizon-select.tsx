'use client';

import { NativeSelect } from '@/components/native-select';
import { Label } from '@/components/ui/label';
import { HORIZON_LABEL } from '@/lib/api/advisor-rules';
import { ADVISOR_HORIZONS, type AdvisorHorizon } from '@/lib/api/types-advisor';

export function HorizonSelect({
  value,
  onChange,
  id = 'advisor-horizon',
}: {
  value: AdvisorHorizon;
  onChange: (h: AdvisorHorizon) => void;
  id?: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <Label htmlFor={id} className="whitespace-nowrap">
        Time frame
      </Label>
      <NativeSelect
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value as AdvisorHorizon)}
        className="w-40"
      >
        {ADVISOR_HORIZONS.map((h) => (
          <option key={h} value={h}>
            {HORIZON_LABEL[h]}
          </option>
        ))}
      </NativeSelect>
    </div>
  );
}
