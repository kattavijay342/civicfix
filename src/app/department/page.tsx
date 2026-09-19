import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { ClipboardList, ListChecks, Loader2, CheckCircle2 } from "lucide-react";
import { IssueCard } from "@/components/cards/IssueCard";
import { DashboardStat } from "@/components/cards/DashboardStat";
import { EmptyState } from "@/components/ui/EmptyState";
import { getSessionProfile } from "@/lib/supabase/server";
import { getAssignedIssues } from "@/lib/data/department";

export const metadata: Metadata = {
  title: "Department Dashboard — CivicFix",
};

export default async function DepartmentDashboardPage() {
  const session = await getSessionProfile();
  if (!session) redirect("/sign-in");
  if (session.profile.role !== "department_incharge" && session.profile.role !== "admin") {
    redirect("/dashboard");
  }

  const issues = await getAssignedIssues(session.user.id);
  const inProgress = issues.filter((i) => i.status === "IN_PROGRESS" || i.status === "ACKNOWLEDGED").length;
  const resolved = issues.filter((i) => i.status === "RESOLVED").length;

  return (
    <div className="mx-auto max-w-7xl px-4 py-10 sm:px-6 sm:py-14 lg:px-8">
      <span className="text-sm font-semibold text-civic-700">Department In-charge</span>
      <h1 className="mt-1 text-3xl font-semibold tracking-tight text-foreground">Assigned Reports</h1>
      <p className="mt-1 max-w-2xl text-sm text-foreground-muted">
        Reports routed to you. Update status, add action notes, and submit resolution evidence.
      </p>

      <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <DashboardStat icon={ListChecks} label="Assigned" value={String(issues.length)} tone="civic" />
        <DashboardStat icon={Loader2} label="In Progress" value={String(inProgress)} />
        <DashboardStat icon={CheckCircle2} label="Resolved" value={String(resolved)} />
      </div>

      {issues.length === 0 ? (
        <div className="mt-8">
          <EmptyState
            icon={<ClipboardList className="h-5 w-5" aria-hidden="true" />}
            title="No reports assigned yet"
            description="Reports routed to your department will appear here."
          />
        </div>
      ) : (
        <div className="mt-8 grid grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-3">
          {issues.map((issue) => (
            <IssueCard key={issue.id} issue={issue} />
          ))}
        </div>
      )}
    </div>
  );
}
