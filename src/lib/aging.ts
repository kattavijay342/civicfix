export function agingLabel(days: number) {
  if (days === 0) return "Resolved";
  if (days >= 15) return `${days}+ days pending`;
  return `${days} day${days === 1 ? "" : "s"} pending`;
}

export function agingClass(days: number) {
  if (days === 0) return "font-medium text-foreground-muted";
  if (days >= 15) return "font-bold text-priority-critical";
  if (days >= 7) return "font-semibold text-priority-high";
  return "font-medium text-foreground-muted";
}
