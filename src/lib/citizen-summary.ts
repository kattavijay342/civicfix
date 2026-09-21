import type { IssueStatus } from "./types";
import type { ReportDetail } from "./data/report-detail";
import { categoryLabels } from "./categories";
import { locationHeadline } from "./location-format";

/**
 * Deterministic, template-based citizen-facing copy — never a live AI call.
 * Every fact used here (title, category, priority, recommended department,
 * assignment) was already computed once at analysis/routing time and is
 * sitting in ai_analyses/report_assignments; this module only narrates
 * already-stored facts, so it costs zero additional Gemini quota and works
 * identically whether or not AI is currently available (Phase 6D §4/§17).
 *
 * Telugu translations are included for every status (extensible, per the
 * spec's own instruction not to build an inconsistent i18n system when no
 * locale/routing architecture exists in this project) but only `.en` is
 * rendered today — see docs/PHASE_6D_REPORT.md for why.
 */
export interface LocalizedText {
  en: string;
  te: string;
}

export const STATUS_EXPLANATIONS: Record<IssueStatus, { whatItMeans: LocalizedText; nextStep: LocalizedText }> = {
  REPORTED: {
    whatItMeans: {
      en: "Your issue has been successfully recorded in CivicFix.",
      te: "మీ సమస్య విజయవంతంగా నమోదు చేయబడింది.",
    },
    nextStep: {
      en: "CivicFix's AI will review it shortly and recommend a priority and department.",
      te: "CivicFix AI త్వరలో దీనిని పరిశీలించి ప్రాధాన్యత మరియు విభాగాన్ని సూచిస్తుంది.",
    },
  },
  AI_ANALYZED: {
    whatItMeans: {
      en: "AI has reviewed your report and classified its priority and category.",
      te: "AI మీ నివేదికను పరిశీలించి దాని ప్రాధాన్యత మరియు వర్గాన్ని వర్గీకరించింది.",
    },
    nextStep: {
      en: "It will next be routed to the department responsible for this type of issue.",
      te: "తదుపరి ఇది ఈ రకమైన సమస్యకు బాధ్యత వహించే విభాగానికి పంపబడుతుంది.",
    },
  },
  ROUTED: {
    whatItMeans: {
      en: "Your report has been sent to the department responsible for this type of issue.",
      te: "మీ నివేదిక ఈ రకమైన సమస్యకు బాధ్యత వహించే విభాగానికి పంపబడింది.",
    },
    nextStep: {
      en: "The department should acknowledge it soon and assign someone to look into it.",
      te: "విభాగం త్వరలో దీనిని గుర్తించి, పరిశీలించడానికి ఎవరినైనా నియమిస్తుంది.",
    },
  },
  ACKNOWLEDGED: {
    whatItMeans: {
      en: "The responsible department has seen your report and confirmed they will act on it.",
      te: "బాధ్యత గల విభాగం మీ నివేదికను చూసి, దానిపై చర్య తీసుకుంటామని ధృవీకరించింది.",
    },
    nextStep: {
      en: "Work should begin soon — the status will change to \"In Progress\" once it does.",
      te: "పని త్వరలో ప్రారంభమవుతుంది — అది జరిగిన తర్వాత స్థితి \"పురోగతిలో\" గా మారుతుంది.",
    },
  },
  IN_PROGRESS: {
    whatItMeans: {
      en: "The responsible department has acknowledged the issue and work has started.",
      te: "మీ సమస్యపై సంబంధిత విభాగం పని ప్రారంభించింది.",
    },
    nextStep: {
      en: "The department should submit resolution evidence after the work is completed.",
      te: "పని పూర్తయిన తర్వాత విభాగం పరిష్కార ఆధారాలను సమర్పించాలి.",
    },
  },
  RESOLVED: {
    whatItMeans: {
      en: "The department has marked this issue resolved and submitted evidence of the fix.",
      te: "మీ సమస్య పరిష్కరించబడినట్లు విభాగం గుర్తించింది. దయచేసి పరిష్కారం నిజంగా జరిగిందో నిర్ధారించండి.",
    },
    nextStep: {
      en: "Please confirm below whether the issue is actually fixed — your confirmation matters.",
      te: "దయచేసి సమస్య నిజంగా పరిష్కరించబడిందో లేదో దిగువ నిర్ధారించండి.",
    },
  },
  REOPENED: {
    whatItMeans: {
      en: "You reported that this issue isn't actually fixed, so it has been reopened.",
      te: "ఈ సమస్య నిజంగా పరిష్కరించబడలేదని మీరు తెలియజేశారు, కాబట్టి ఇది తిరిగి తెరవబడింది.",
    },
    nextStep: {
      en: "The department needs to acknowledge it again before making another attempt to fix it.",
      te: "మళ్లీ పరిష్కరించే ప్రయత్నం చేయడానికి ముందు విభాగం దీనిని మళ్లీ గుర్తించాలి.",
    },
  },
};

/**
 * "Understand your report" — a plain-language paragraph grounded entirely
 * in fields already present on ReportDetail. Never invents an official,
 * a deadline, or a government decision that isn't actually stored.
 */
export function buildCitizenSummary(report: ReportDetail): string {
  const sentences: string[] = [];

  sentences.push(
    `You reported "${report.title}" near ${locationHeadline(report.location)}, categorized as ${categoryLabels[report.category].toLowerCase()}.`
  );

  if (report.aiAnalysis) {
    sentences.push(
      `CivicFix's AI classified it as ${report.aiAnalysis.priority.toLowerCase()}-priority and recommended routing it to ${report.aiAnalysis.recommendedDepartment}.`
    );
  }

  if (report.assignment) {
    sentences.push(
      report.assignment.inchargeName
        ? `It was routed to ${report.assignment.departmentName}, with ${report.assignment.inchargeName} assigned to it.`
        : `It was routed to ${report.assignment.departmentName}.`
    );
  }

  sentences.push(STATUS_EXPLANATIONS[report.status].whatItMeans.en);

  return sentences.join(" ");
}
