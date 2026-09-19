import { Reveal } from "@/components/ui/Reveal";
import { ComplaintDocument, type ComplaintFields } from "@/components/cards/ComplaintDocument";

const contentEn: ComplaintFields = {
  subject: "Pothole on MG Road, Sector 4 requires urgent repair",
  description:
    "A large pothole (approx. 2 feet wide) has formed on the main carriageway of MG Road, Sector 4, posing a risk to two-wheeler riders and vehicles, especially during night hours and rain.",
  location: "MG Road, Sector 4, near City Central Park",
  impact: "Increased risk of accidents, vehicle damage, and traffic slowdown during peak hours.",
  action: "Immediate inspection and repair of the affected road surface by the Municipal Roads Department.",
};

const contentTe: ComplaintFields = {
  subject: "MG రోడ్, సెక్టార్ 4లో గుంతకు తక్షణ మరమ్మతు అవసరం",
  description:
    "MG రోడ్, సెక్టార్ 4 ప్రధాన రహదారిపై దాదాపు 2 అడుగుల వెడల్పు గల పెద్ద గుంత ఏర్పడింది, ఇది ముఖ్యంగా రాత్రి వేళల్లో మరియు వర్షం సమయంలో వాహనదారులకు ప్రమాదకరంగా మారింది.",
  location: "MG రోడ్, సెక్టార్ 4, సిటీ సెంట్రల్ పార్క్ సమీపంలో",
  impact: "ప్రమాదాల ప్రమాదం, వాహన నష్టం మరియు రద్దీ వేళల్లో ట్రాఫిక్ ఆలస్యం పెరుగుతుంది.",
  action: "మున్సిపల్ రోడ్స్ విభాగం ద్వారా దెబ్బతిన్న రహదారి ఉపరితలాన్ని తక్షణమే తనిఖీ చేసి మరమ్మతు చేయాలి.",
};

export function ComplaintGenerator() {
  return (
    <section id="complaint-generator" className="scroll-mt-16 bg-surface-muted py-20 sm:py-28">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <Reveal className="mx-auto max-w-2xl text-center">
          <span className="text-sm font-semibold text-civic-700">Complaint Generator</span>
          <h2 className="mt-2 text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
            Your complaint is ready.
          </h2>
          <p className="mt-3 text-base leading-relaxed text-foreground-muted">
            AI turns the report into a structured, department-ready complaint — editable,
            copyable, and bilingual.
          </p>
        </Reveal>

        <Reveal delayMs={120} className="mt-12">
          <ComplaintDocument
            issueId="CF-1042"
            contentEn={contentEn}
            contentTe={contentTe}
            imageSrc="/images/before-pothole.jpg"
            imageAlt="Photo evidence attached to the complaint: pothole on MG Road, Sector 4"
          />
        </Reveal>
      </div>
    </section>
  );
}
