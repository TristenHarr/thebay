import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useRegisterPasswordMutation, useLoginPasswordMutation, useDevLoginMutation } from "../../api";
import { Button, Card, input } from "../../ui/kit";

/** Sign-in. Self-contained email + password (works with zero external setup);
 *  a dev quick-login is offered on localhost only. */
export function SignIn() {
  const dev = /localhost|127\.0\.0\.1/.test(location.host);
  const [register] = useRegisterPasswordMutation();
  const [login] = useLoginPasswordMutation();
  const [devLogin] = useDevLoginMutation();
  const nav = useNavigate();

  const [mode, setMode] = useState<"login" | "register">("login");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    const r: any = mode === "register" ? await register({ email, password, name }) : await login({ email, password });
    setBusy(false);
    if (r.error) { setErr(r.error?.data?.error || "Something went wrong"); return; }
    nav("/"); // "Me" is invalidated → app re-renders logged in
  }

  return (
    <div className="mx-auto max-w-sm py-10" data-testid="signin">
      <Card className="p-6">
        <div className="text-center">
          <div className="text-3xl">📡</div>
          <h1 className="mt-2 text-xl font-bold">{mode === "register" ? "Create your account" : "Sign in to The Bay"}</h1>
          <p className="mt-1 text-sm text-muted">Show up with intent. Turn attendance into introductions.</p>
        </div>

        <form className="mt-5 flex flex-col gap-2" onSubmit={submit}>
          {mode === "register" && <input className={input} placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />}
          <input className={input} type="email" placeholder="you@email.com" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required />
          <input className={input} type="password" placeholder="Password (min 8 characters)" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={mode === "register" ? "new-password" : "current-password"} required />
          {err && <div className="text-sm text-crit">{err}</div>}
          <Button className="mt-1 w-full" disabled={busy}>{busy ? "…" : mode === "register" ? "Create account" : "Sign in"}</Button>
        </form>

        <button
          className="mt-3 w-full text-center text-xs text-muted hover:text-text"
          onClick={() => { setErr(null); setMode(mode === "register" ? "login" : "register"); }}
        >
          {mode === "register" ? "Already have an account? Sign in" : "New here? Create an account"}
        </button>

        {dev && (
          <div className="mt-5 border-t border-dashed border-border pt-4 text-center">
            <button className="text-xs text-muted hover:text-text" onClick={async () => { await devLogin({ email: "dev@test.com", name: "Dev" }); nav("/"); }}>
              Dev quick-login
            </button>
          </div>
        )}
      </Card>
    </div>
  );
}
