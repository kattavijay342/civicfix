import Image from "next/image";
import { ArrowRight, CheckCircle2 } from "lucide-react";

interface BeforeAfterCardProps {
  beforeSrc: string;
  beforeAlt: string;
  afterSrc: string;
  afterAlt: string;
  title: string;
  department: string;
  resolvedDate: string;
}

export function BeforeAfterCard({
  beforeSrc,
  beforeAlt,
  afterSrc,
  afterAlt,
  title,
  department,
  resolvedDate,
}: BeforeAfterCardProps) {
  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-white shadow-[0_20px_50px_-28px_rgba(20,64,47,0.3)]">
      <div className="grid grid-cols-2">
        <div className="relative aspect-[4/3]">
          <Image
            src={beforeSrc}
            alt={beforeAlt}
            fill
            sizes="(min-width: 640px) 260px, 50vw"
            className="object-cover"
          />
          <span className="absolute left-2 top-2 rounded-full bg-black/65 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide text-white">
            Before
          </span>
        </div>
        <div className="relative aspect-[4/3]">
          <Image
            src={afterSrc}
            alt={afterAlt}
            fill
            sizes="(min-width: 640px) 260px, 50vw"
            className="object-cover"
          />
          <span className="absolute left-2 top-2 rounded-full bg-civic-600 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide text-white">
            After
          </span>
        </div>
      </div>
      <div className="flex items-center gap-1.5 justify-center bg-surface-muted py-1.5 text-foreground-muted">
        <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
      </div>
      <div className="p-5">
        <div className="flex items-center gap-1.5 text-civic-700">
          <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
          <span className="text-xs font-semibold uppercase tracking-wide">Resolved</span>
        </div>
        <h3 className="mt-1.5 text-sm font-semibold text-foreground">{title}</h3>
        <p className="mt-1 text-xs text-foreground-muted">
          {department} &middot; Resolved {resolvedDate}
        </p>
      </div>
    </div>
  );
}
