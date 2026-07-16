import { Link } from "react-router-dom";

/** Fallback for any unknown route. */
export function NotFoundPage() {
  return (
    <section aria-labelledby="step-heading" className="space-y-2">
      <h1 id="step-heading" className="text-2xl font-semibold text-slate-900">
        Page not found
      </h1>
      <p className="text-slate-600">
        That route doesn&rsquo;t exist.{" "}
        <Link to="/create" className="text-indigo-600 underline">
          Start over
        </Link>
        .
      </p>
    </section>
  );
}
