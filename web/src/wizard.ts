/**
 * The six-step pipeline wizard, in order. This is the single source of truth for
 * the flow: routing, the stepper, and page headings all derive from it, so a step
 * is added or renamed in exactly one place.
 *
 * Pure data — no React, no I/O — so it can be unit-tested and imported anywhere.
 */
export interface WizardStep {
  /** URL segment for the step, e.g. "create" → `/create`. */
  readonly slug: string;
  /** Short label shown in the stepper. */
  readonly label: string;
  /** Full heading shown at the top of the step's page. */
  readonly title: string;
  /** One-line description of what the step does. */
  readonly summary: string;
}

export const WIZARD_STEPS: readonly WizardStep[] = [
  {
    slug: "create",
    label: "Create",
    title: "Create project",
    summary: "Name the project and pick its business domain, volume, and warehouse.",
  },
  {
    slug: "connect",
    label: "Connect",
    title: "Connect source",
    summary: "Upload a loan CSV and let the agent profile its schema.",
  },
  {
    slug: "plan",
    label: "Plan",
    title: "Architecture plan",
    summary: "Review the generated ELT plan, transform SQL, and DQ checks.",
  },
  {
    slug: "review",
    label: "Review",
    title: "Review artifacts",
    summary: "Inspect every generated artifact before anything runs.",
  },
  {
    slug: "run",
    label: "Run",
    title: "Run pipeline",
    summary: "Execute the six stages, approving each write step as it is asked.",
  },
  {
    slug: "serve",
    label: "Serve",
    title: "Serve output",
    summary: "Preview the served table, download the CSV, and hit the REST endpoint.",
  },
] as const;
