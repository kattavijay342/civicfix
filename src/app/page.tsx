import { Hero } from "@/components/sections/Hero";
import { FeatureStrip } from "@/components/sections/FeatureStrip";
import { HowItWorks } from "@/components/sections/HowItWorks";
import { ProblemTypes } from "@/components/sections/ProblemTypes";
import { AIIntelligence } from "@/components/sections/AIIntelligence";
import { ComplaintGenerator } from "@/components/sections/ComplaintGenerator";
import { IssueExplorer } from "@/components/sections/IssueExplorer";
import { ResolutionShowcase } from "@/components/sections/ResolutionShowcase";
import { DashboardPreview } from "@/components/sections/DashboardPreview";
import { IssueMapSection } from "@/components/sections/IssueMapSection";
import { About } from "@/components/sections/About";
import { FinalCTA } from "@/components/sections/FinalCTA";

export default function Home() {
  return (
    <>
      <Hero />
      <FeatureStrip />
      <HowItWorks />
      <ProblemTypes />
      <AIIntelligence />
      <ComplaintGenerator />
      <IssueExplorer />
      <ResolutionShowcase />
      <DashboardPreview />
      <IssueMapSection />
      <About />
      <FinalCTA />
    </>
  );
}
