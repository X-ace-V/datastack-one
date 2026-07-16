import type { ReactNode } from "react";
import { WIZARD_STEPS } from "../wizard";

/**
 * Renders a wizard step's heading and summary from the shared step definition,
 * with a slot for the step's own content. Every page uses this so headings stay
 * in sync with {@link WIZARD_STEPS} and can't drift per page.
 */
export function StepShell({ slug, children }: { slug: string; children?: ReactNode }) {
  const step = WIZARD_STEPS.find((s) => s.slug === slug);
  if (!step) throw new Error(`Unknown wizard step: ${slug}`);

  return (
    <section aria-labelledby="step-heading" className="space-y-2">
      <h1 id="step-heading" className="text-2xl font-semibold text-slate-900">
        {step.title}
      </h1>
      <p className="text-slate-600">{step.summary}</p>
      {children}
    </section>
  );
}
