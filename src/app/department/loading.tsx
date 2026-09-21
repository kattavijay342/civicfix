import { LoadingState } from "@/components/ui/LoadingState";

export default function DepartmentLoading() {
  return (
    <div className="mx-auto max-w-7xl px-4 py-10 sm:px-6 sm:py-14 lg:px-8">
      <LoadingState label="Loading assigned reports…" />
    </div>
  );
}
