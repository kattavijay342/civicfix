interface Segment {
  label: string;
  value: number;
  color: string;
}

export function DonutChart({ segments, size = 160 }: { segments: Segment[]; size?: number }) {
  const total = segments.reduce((sum, s) => sum + s.value, 0) || 1;
  const radius = 15.9155;
  const circumference = 2 * Math.PI * radius;

  const arcs = segments.reduce<{ label: string; color: string; dash: number; offset: number }[]>(
    (acc, s) => {
      const dash = (s.value / total) * circumference;
      const offset = acc.length ? acc[acc.length - 1].offset + acc[acc.length - 1].dash : 0;
      return [...acc, { label: s.label, color: s.color, dash, offset }];
    },
    [],
  );

  return (
    <div className="flex items-center gap-6">
      <svg viewBox="0 0 36 36" width={size} height={size} className="shrink-0 -rotate-90">
        <circle cx="18" cy="18" r={radius} fill="none" stroke="var(--color-surface-muted)" strokeWidth="4" />
        {arcs.map((arc) => (
          <circle
            key={arc.label}
            cx="18"
            cy="18"
            r={radius}
            fill="none"
            stroke={arc.color}
            strokeWidth="4"
            strokeDasharray={`${arc.dash} ${circumference - arc.dash}`}
            strokeDashoffset={-arc.offset}
            strokeLinecap="butt"
          />
        ))}
      </svg>
      <ul className="flex flex-1 flex-col gap-2">
        {segments.map((s) => (
          <li key={s.label} className="flex items-center justify-between gap-3 text-xs">
            <span className="flex items-center gap-2 text-foreground-muted">
              <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: s.color }} />
              {s.label}
            </span>
            <span className="font-semibold text-foreground">{s.value}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
