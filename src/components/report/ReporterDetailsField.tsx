"use client";

import { User, Phone } from "lucide-react";
import { cn } from "@/lib/utils";

interface ReporterDetailsFieldProps {
  name: string;
  mobile: string;
  onNameChange: (value: string) => void;
  onMobileChange: (value: string) => void;
  nameError?: string;
  mobileError?: string;
}

export function ReporterDetailsField({
  name,
  mobile,
  onNameChange,
  onMobileChange,
  nameError,
  mobileError,
}: ReporterDetailsFieldProps) {
  return (
    <section className="rounded-2xl border border-border bg-white p-6">
      <div className="flex items-center gap-2">
        <User className="h-4 w-4 text-civic-700" aria-hidden="true" />
        <h2 className="text-sm font-semibold text-foreground">Your Details</h2>
      </div>
      <p className="mt-1 text-xs text-foreground-muted">
        These details help us identify and follow up on the report.
      </p>

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <div>
          <label className="text-xs font-medium text-foreground-muted" htmlFor="reporter-name">
            Full Name <span className="text-priority-critical">*</span>
          </label>
          <input
            id="reporter-name"
            value={name}
            onChange={(e) => onNameChange(e.target.value)}
            placeholder="Enter your name"
            className={cn(
              "mt-1.5 w-full rounded-lg border bg-white px-3 py-2.5 text-sm text-foreground focus-visible:border-civic-400",
              nameError ? "border-priority-critical" : "border-border",
            )}
          />
          {nameError && <p className="mt-1 text-xs font-medium text-priority-critical">{nameError}</p>}
        </div>

        <div>
          <label className="text-xs font-medium text-foreground-muted" htmlFor="reporter-mobile">
            Mobile Number <span className="text-priority-critical">*</span>
          </label>
          <div
            className={cn(
              "mt-1.5 flex items-center rounded-lg border bg-white pl-3 focus-within:border-civic-400",
              mobileError ? "border-priority-critical" : "border-border",
            )}
          >
            <Phone className="h-3.5 w-3.5 shrink-0 text-foreground-muted" aria-hidden="true" />
            <span className="ml-1.5 shrink-0 text-sm font-medium text-foreground-muted">+91</span>
            <input
              id="reporter-mobile"
              type="tel"
              inputMode="numeric"
              value={mobile}
              onChange={(e) => onMobileChange(e.target.value.replace(/\D/g, "").slice(0, 10))}
              placeholder="XXXXX XXXXX"
              className="w-full bg-transparent px-2 py-2.5 text-sm text-foreground focus-visible:outline-none"
            />
          </div>
          {mobileError && <p className="mt-1 text-xs font-medium text-priority-critical">{mobileError}</p>}
        </div>
      </div>

      <p className="mt-4 text-[11px] text-foreground-muted">
        Your contact details are used only for report follow-up.
      </p>
    </section>
  );
}
