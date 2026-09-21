import { LoadingState } from "@/components/ui/LoadingState";

export default function ReportDetailLoading() {
  return (
    <div className="bg-surface-muted">
      <div className="mx-auto max-w-5xl px-4 py-10 sm:px-6 sm:py-14 lg:px-8">
        <LoadingState label="Loading report…" rows={1} />
      </div>
    </div>
  );
}
