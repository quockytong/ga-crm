import { QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ApiError } from "@/client/lib/api";
import { buildRouter } from "@/client/router";
import "./styles.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: (count, error) => !(error instanceof ApiError) && count < 2 },
  },
  queryCache: new QueryCache({
    // Session ended or the account was disabled while the app was open.
    onError: (error, query) => {
      if (error instanceof ApiError && error.status === 401 && query.queryKey[0] !== "me") {
        window.location.assign("/login");
      }
    },
  }),
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={buildRouter(queryClient)} />
    </QueryClientProvider>
  </StrictMode>,
);
