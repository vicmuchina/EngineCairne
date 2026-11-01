"use client";

import * as React from "react";

import { PrinterIcon } from "lucide-react";

import { Button } from "@/components/ui/button";

export function PrintTrigger({ auto }: { auto: boolean }) {
  React.useEffect(() => {
    if (!auto) return;
    const timer = window.setTimeout(() => window.print(), 500);
    return () => window.clearTimeout(timer);
  }, [auto]);

  return (
    <Button size="sm" onClick={() => window.print()}>
      <PrinterIcon data-icon="inline-start" />
      Print / Save PDF
    </Button>
  );
}
