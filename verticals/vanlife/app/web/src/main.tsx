// GENERATED FROM assembly.manifest.yaml — DO NOT EDIT
import { StrictMode, useState, type JSX, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Routes, Route, Navigate, useNavigate } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { httpBatchLink } from "@trpc/client";
import { AppShell, type NavItem } from "@elements/shell-app-shell";
import { LoginPage } from "@elements/identity-session-auth/client";
import { bespokePages, trpc } from "@vanlife/bespoke/client";

function LoginScreen(): JSX.Element {
  const utils = trpc.useUtils();
  const login = trpc.auth.login.useMutation();
  return (
    <LoginPage
      appName="Dilly-Dally"
      onLogin={async (email, password) => {
        try {
          await login.mutateAsync({ email, password });
          await utils.auth.me.invalidate();
          return { ok: true };
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : "Sign-in failed" };
        }
      }}
    />
  );
}

function Shell(props: { user: { email: string; role: string }; children: ReactNode }): JSX.Element {
  const utils = trpc.useUtils();
  const navigate = useNavigate();
  const logout = trpc.auth.logout.useMutation();
  const nav: NavItem[] = bespokePages
    .filter((p) => p.nav)
    .map((p) => ({ label: p.nav!.label, to: p.path, requiresRole: p.requiresRole }));
  return (
    <AppShell
      appName="Dilly-Dally"
      nav={nav}
      user={props.user}
      onLogout={() => {
        void logout.mutateAsync().then(() => utils.auth.me.invalidate()).then(() => navigate("/"));
      }}
    >
      {props.children}
    </AppShell>
  );
}

function Root(): JSX.Element {
  const me = trpc.auth.me.useQuery();
  if (me.isLoading) return <p style={{ padding: 24 }}>Loading…</p>;
  if (!me.data) return <LoginScreen />;
  const user = me.data;
  return (
    <Shell user={user}>
      <Routes>
        {bespokePages.map((p) => (
          <Route
            key={p.path}
            path={p.path}
            element={
              // Role gates hold at the ROUTE level, not just in the nav:
              // direct navigation to a reserved screen redirects home.
              p.requiresRole && p.requiresRole !== user.role ? (
                <Navigate to="/" replace />
              ) : (
                <p.component user={user} />
              )
            }
          />
        ))}
      </Routes>
    </Shell>
  );
}

function App(): JSX.Element {
  const [queryClient] = useState(() => new QueryClient());
  const [trpcClient] = useState(() =>
    trpc.createClient({ links: [httpBatchLink({ url: "/trpc" })] }),
  );
  return (
    <StrictMode>
      <trpc.Provider client={trpcClient} queryClient={queryClient}>
        <QueryClientProvider client={queryClient}>
          <BrowserRouter>
            <Root />
          </BrowserRouter>
        </QueryClientProvider>
      </trpc.Provider>
    </StrictMode>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
