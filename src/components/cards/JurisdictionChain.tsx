import { MapPin, Landmark, Building2, Flag } from "lucide-react";
import type { CivicLocation } from "@/lib/types";
import { locationJurisdictionChain } from "@/lib/location-format";
import { cn } from "@/lib/utils";

const icons = [MapPin, Landmark, Building2, Flag];

export function JurisdictionChain({ location }: { location: CivicLocation }) {
  const chain = locationJurisdictionChain(location);

  return (
    <div className="rounded-2xl border border-border bg-white p-6">
      <h2 className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
        <MapPin className="h-4 w-4 text-civic-700" aria-hidden="true" />
        Civic Jurisdiction
      </h2>
      <ol className="mt-4 flex flex-col gap-1">
        {chain.map((step, i) => {
          const Icon = icons[i] ?? MapPin;
          const isLast = i === chain.length - 1;
          return (
            <li key={step}>
              <div className="flex items-center gap-3 text-sm">
                <span
                  className={cn(
                    "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg",
                    i === 0 ? "bg-civic-600 text-white" : "bg-civic-50 text-civic-700",
                  )}
                >
                  <Icon className="h-4 w-4" aria-hidden="true" />
                </span>
                <span className={i === 0 ? "font-semibold text-foreground" : "font-medium text-foreground-muted"}>
                  {step}
                </span>
              </div>
              {!isLast && (
                <div className="ml-4 py-0.5 text-foreground-muted" aria-hidden="true">
                  ↓
                </div>
              )}
            </li>
          );
        })}
      </ol>
      {(location.source === "demo" || location.source === "search") && (
        <p className="mt-4 border-t border-border pt-3 text-[11px] text-foreground-muted">
          Demo location match — not a real geocoding/jurisdiction lookup yet.
        </p>
      )}
    </div>
  );
}
