import { NavLink, Outlet } from "react-router-dom";
import { WIZARD_STEPS } from "../wizard";

/**
 * App shell for the six-step wizard: a header, the step navigation, and an
 * {@link Outlet} where the active step's page renders. The active step is derived
 * from the current route by `NavLink`, which also sets `aria-current`.
 */
export function WizardLayout() {
  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto max-w-4xl px-6 py-4">
          <p className="text-sm font-semibold tracking-tight text-indigo-600">
            DataStack One
          </p>
        </div>
      </header>

      <div className="mx-auto max-w-4xl px-6 py-8">
        <nav aria-label="Pipeline steps" className="mb-8">
          <ol className="flex flex-wrap gap-2">
            {WIZARD_STEPS.map((step, index) => (
              <li key={step.slug}>
                <NavLink
                  to={`/${step.slug}`}
                  className={({ isActive }) =>
                    [
                      "flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm font-medium transition-colors",
                      isActive
                        ? "border-indigo-600 bg-indigo-600 text-white"
                        : "border-slate-200 bg-white text-slate-600 hover:border-slate-300",
                    ].join(" ")
                  }
                >
                  <span
                    aria-hidden="true"
                    className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-black/10 text-xs"
                  >
                    {index + 1}
                  </span>
                  {step.label}
                </NavLink>
              </li>
            ))}
          </ol>
        </nav>

        <main>
          <Outlet />
        </main>
      </div>
    </div>
  );
}
