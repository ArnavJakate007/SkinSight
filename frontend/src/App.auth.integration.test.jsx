import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import App from "./App";

function mockJsonResponse(payload, status = 200) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  });
}

describe("App auth to recovery integration", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.history.replaceState({}, "", "/");

    global.fetch = vi.fn((input) => {
      const url = String(input);

      if (url.endsWith("/auth/login")) {
        return mockJsonResponse({
          access_token: "test-token",
          token_type: "bearer",
          user: {
            id: "usr_test_123",
            name: "Test User",
            email: "tester@example.com",
            created_at: "2026-04-19T00:00:00+00:00",
          },
        });
      }

      if (url.endsWith("/auth/me")) {
        return mockJsonResponse({
          id: "usr_test_123",
          name: "Test User",
          email: "tester@example.com",
          created_at: "2026-04-19T00:00:00+00:00",
        });
      }

      return mockJsonResponse({ detail: "Not found" }, 404);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prefills recovery user ID from signed-in profile and shows profile panel", async () => {
    render(<App />);

    fireEvent.change(screen.getByLabelText(/email/i), {
      target: { value: "tester@example.com" },
    });
    fireEvent.change(screen.getByLabelText(/password/i), {
      target: { value: "Passw0rd!" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Login" }));

    const enterButton = await screen.findByRole("button", { name: "Enter Product" });
    fireEvent.click(enterButton);

    await screen.findByRole("button", { name: "Recovery Dashboard" });
    fireEvent.click(screen.getByRole("button", { name: "Recovery Dashboard" }));

    await waitFor(() => {
      expect(screen.getByLabelText(/user id/i)).toHaveValue("user_tester_at_example_com");
    });

    fireEvent.click(screen.getByRole("button", { name: "Show Profile" }));

    await screen.findByRole("heading", { name: "Profile" });
    expect(screen.getByText("tester@example.com")).toBeInTheDocument();
    expect(screen.getAllByText("user_tester_at_example_com").length).toBeGreaterThan(0);
  });
});
