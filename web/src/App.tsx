import { Navigate, Route, Routes } from "react-router-dom";
import { WizardLayout } from "./components/WizardLayout";
import { CreatePage } from "./pages/Create";
import { ConnectPage } from "./pages/Connect";
import { PlanPage } from "./pages/Plan";
import { ReviewPage } from "./pages/Review";
import { RunPage } from "./pages/Run";
import { RunDetailPage } from "./pages/RunDetail";
import { ServePage } from "./pages/Serve";
import { NotFoundPage } from "./pages/NotFound";

/**
 * Route table for the wizard. Every step renders inside {@link WizardLayout};
 * `/` redirects to the first step and unknown paths fall through to a 404 page.
 * Router context (BrowserRouter in the app, MemoryRouter in tests) is provided
 * by the caller so this component stays environment-agnostic.
 *
 * `/runs/:runId` is the one non-step route: a run's lineage detail (FR12) is a view *of* a run
 * rather than a stage of the wizard, so it renders in the same shell but marks no step active.
 */
export function App() {
  return (
    <Routes>
      <Route element={<WizardLayout />}>
        <Route index element={<Navigate to="/create" replace />} />
        <Route path="create" element={<CreatePage />} />
        <Route path="connect" element={<ConnectPage />} />
        <Route path="plan" element={<PlanPage />} />
        <Route path="review" element={<ReviewPage />} />
        <Route path="run" element={<RunPage />} />
        <Route path="runs/:runId" element={<RunDetailPage />} />
        <Route path="serve" element={<ServePage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
