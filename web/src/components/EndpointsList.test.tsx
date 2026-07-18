// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { EndpointsList } from "./EndpointsList";
import type { PublishedEndpoint } from "../lib/endpoints";

/**
 * Component test for EndpointsList (TASKS V4.2, PRD FR11/FR12): the data panel's endpoints section
 * renders each published endpoint's name, row count, and the REST + CSV links straight off the URLs
 * the backend derived. Asserts the rendered content and the exact hrefs, not merely mount.
 */
describe("EndpointsList", () => {
  afterEach(cleanup);

  const ENDPOINTS: PublishedEndpoint[] = [
    {
      name: "overdue_report",
      endpoint: "/api/serve/overdue_report",
      csvEndpoint: "/api/serve/overdue_report.csv",
      rowCount: 1234,
    },
    {
      name: "branch_report",
      endpoint: "/api/serve/branch_report",
      csvEndpoint: "/api/serve/branch_report.csv",
      rowCount: 4,
    },
  ];

  it("renders each endpoint's name and row count", () => {
    render(<EndpointsList endpoints={ENDPOINTS} />);
    const region = screen.getByRole("region", { name: "Published endpoints" });
    expect(within(region).getByText("overdue_report")).toBeTruthy();
    expect(within(region).getByText("branch_report")).toBeTruthy();
    // Row counts are humanized.
    expect(within(region).getByText("1,234 rows")).toBeTruthy();
    expect(within(region).getByText("4 rows")).toBeTruthy();
  });

  it("links each endpoint to its REST and CSV URLs", () => {
    render(<EndpointsList endpoints={[ENDPOINTS[1]!]} />);
    const rest = screen.getByRole("link", { name: "REST" });
    const csv = screen.getByRole("link", { name: "CSV" });
    expect(rest.getAttribute("href")).toBe("/api/serve/branch_report");
    expect(csv.getAttribute("href")).toBe("/api/serve/branch_report.csv");
    // Opens without discarding the chat session.
    expect(rest.getAttribute("target")).toBe("_blank");
  });

  it("renders one row per endpoint", () => {
    render(<EndpointsList endpoints={ENDPOINTS} />);
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
  });
});
