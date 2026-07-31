import { useState, type JSX, type FormEvent } from "react";

export interface LoginPageProps {
  appName: string;
  /** Wired to the auth.login mutation by the vertical's composition root. */
  onLogin: (email: string, password: string) => Promise<{ ok: boolean; error?: string }>;
}

/**
 * Presentational login page. The tRPC wiring lives in the vertical so the
 * control-to-procedure edge is visible in the derived graph.
 */
export function LoginPage(props: LoginPageProps): JSX.Element {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const result = await props.onLogin(email, password);
    setBusy(false);
    if (!result.ok) setError(result.error ?? "Sign-in failed");
  }

  return (
    <main style={{ maxWidth: 360, margin: "10vh auto", fontFamily: "system-ui, sans-serif" }}>
      <h1 style={{ fontSize: "1.4rem" }}>{props.appName}</h1>
      <form onSubmit={handleSubmit} aria-label="Sign in">
        <label style={{ display: "block", marginTop: 12 }}>
          Email
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoComplete="username"
            style={{ display: "block", width: "100%", padding: 8, marginTop: 4 }}
          />
        </label>
        <label style={{ display: "block", marginTop: 12 }}>
          Password
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            autoComplete="current-password"
            style={{ display: "block", width: "100%", padding: 8, marginTop: 4 }}
          />
        </label>
        {error ? (
          <p role="alert" style={{ color: "#b00020", marginTop: 12 }}>
            {error}
          </p>
        ) : null}
        <button
          type="submit"
          disabled={busy}
          style={{ marginTop: 16, padding: "10px 20px", cursor: "pointer" }}
        >
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </main>
  );
}
