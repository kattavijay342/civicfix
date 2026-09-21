import { LoadingState } from "@/components/ui/LoadingState";

export default function AdminLoading() {
  return (
    <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6 sm:py-14 lg:px-8">
      <LoadingState label="Loading admin panel…" />
    </div>
  );
}
