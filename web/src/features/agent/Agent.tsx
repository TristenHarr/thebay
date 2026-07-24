import { Link } from "react-router-dom";
import { useGetAgentQuery, useSetAgentMutation, useGetAgentSuggestionsQuery, useCreateIntroMutation, useRequestFriendMutation } from "../../api";
import { Button, Card, Spinner, PageHeader, EmptyState, Badge, Avatar, input } from "../../ui/kit";
import { useEffect, useState } from "react";
import { pushSupported, pushEnabled, subscribeToPush } from "../../push";

export function Agent() {
  const { data: settings, isLoading } = useGetAgentQuery();
  const [setAgent] = useSetAgentMutation();
  const { data: sug, isLoading: sugLoading } = useGetAgentSuggestionsQuery(undefined, { skip: !settings?.enabled });
  const [createIntro] = useCreateIntroMutation();
  const [reqFriend] = useRequestFriendMutation();
  const [done, setDone] = useState<Record<string, string>>({});
  const [aiKey, setAiKey] = useState("");
  const [aiModel, setAiModel] = useState("");
  const [aiSaved, setAiSaved] = useState("");
  const [pushState, setPushState] = useState<string>("");
  const [pushAvail, setPushAvail] = useState(false);
  useEffect(() => { if (pushSupported()) pushEnabled().then(setPushAvail); }, []);
  // hydrate the saved model so re-saving a key doesn't silently wipe it
  useEffect(() => { if (settings?.aiModel) setAiModel(settings.aiModel); }, [settings?.aiModel]);

  if (isLoading) return <Spinner />;
  const enabled = !!settings?.enabled;
  const mode = settings?.mode || "approve";

  async function act(s: any) {
    if (s.action === "intro") await createIntro({ targetDesc: s.displayName, targetUserId: s.targetId });
    else await reqFriend(s.targetId);
    setDone((d) => ({ ...d, [s.targetId]: s.action === "intro" ? "Intro requested" : "Request sent" }));
  }

  return (
    <div data-testid="agent">
      <PageHeader title="Networking agent" sub="Let an agent scout the rooms you're in and line up the right introductions." />

      <Card className="mb-4 flex flex-col gap-3 p-4">
        <label className="flex items-center justify-between">
          <div>
            <div className="font-semibold">Agent networking</div>
            <div className="text-sm text-muted">Scans your upcoming events for people worth meeting.</div>
          </div>
          <button
            role="switch"
            aria-checked={enabled}
            onClick={() => setAgent({ enabled: !enabled })}
            className={`relative h-6 w-11 rounded-full transition ${enabled ? "bg-accent" : "bg-border"}`}
          >
            <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition ${enabled ? "left-[22px]" : "left-0.5"}`} />
          </button>
        </label>

        {enabled && (
          <div className="flex items-center gap-2 border-t border-border pt-3">
            <span className="text-sm text-muted">Mode</span>
            {(["approve", "auto"] as const).map((m) => (
              <button key={m} onClick={() => setAgent({ mode: m })} className={`rounded-full px-3 py-1 text-sm font-semibold ${mode === m ? "bg-accent text-accent-ink" : "border border-border text-muted"}`}>
                {m === "approve" ? "Approve each" : "Autopilot"}
              </button>
            ))}
            <Badge>{mode === "approve" ? "you confirm every intro" : "acts within guardrails"}</Badge>
          </div>
        )}
      </Card>

      {/* bring-your-own AI key (OpenRouter) — powers richer research + agent prose */}
      <Card className="mb-4 flex flex-col gap-2 p-4">
        <div className="flex items-center gap-2">
          <span className="font-semibold">Your AI (OpenRouter)</span>
          {settings?.hasAiKey && <Badge>connected</Badge>}
        </div>
        <p className="text-sm text-muted">Bring your own OpenRouter key to power AI research &amp; agent write-ups with the model you choose. Stored securely; never shown again.</p>
        <div className="flex flex-col gap-2 sm:flex-row">
          <input className={input} type="password" placeholder={settings?.hasAiKey ? "•••••••• (set — paste to replace)" : "sk-or-…"} value={aiKey} onChange={(e) => setAiKey(e.target.value)} autoComplete="off" />
          <input className={`${input} sm:max-w-[220px]`} placeholder="model (e.g. openai/gpt-4o-mini)" value={aiModel} onChange={(e) => setAiModel(e.target.value)} />
          <Button variant="ghost" onClick={async () => { await setAgent({ openrouterKey: aiKey, openrouterModel: aiModel || undefined }); setAiKey(""); setAiSaved(aiKey ? "Saved" : "Cleared"); }}>{aiKey ? "Save" : "Clear"}</Button>
        </div>
        {aiSaved && <span className="text-xs text-accent">{aiSaved}</span>}
        <a href="https://openrouter.ai/keys" target="_blank" rel="noopener" className="text-xs text-muted hover:text-accent">Get an OpenRouter key ↗</a>
      </Card>

      {pushAvail && (
        <Card className="mb-4 flex items-center justify-between gap-2 p-3 text-sm">
          <span>🔔 Get notified when someone accepts an intro or checks in.</span>
          {pushState ? <span className="text-xs text-accent">{pushState}</span> : <Button variant="ghost" onClick={async () => setPushState(await subscribeToPush())}>Enable</Button>}
        </Card>
      )}

      {!enabled ? (
        <EmptyState title="Agent is off" hint="Turn it on to get a ranked list of who to meet at your next events." />
      ) : sugLoading ? (
        <Spinner />
      ) : (sug?.suggestions?.length ?? 0) === 0 ? (
        <EmptyState title="No suggestions yet" hint="RSVP to a few upcoming events and the agent will find overlaps." />
      ) : (
        <div className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold">Proposed introductions</h3>
          {sug!.suggestions.map((s: any) => (
            <Card key={s.targetId} className="flex items-center gap-3 p-3">
              <Avatar user={{ displayName: s.displayName }} size={36} />
              <div className="min-w-0 flex-1">
                <Link to={`/u/${s.handle}`} className="font-semibold hover:text-accent">{s.displayName}</Link>
                <div className="truncate text-xs text-muted">{s.reason || "worth meeting"}</div>
              </div>
              <Badge>{s.action === "intro" ? "warm intro" : "connect"}</Badge>
              {done[s.targetId] ? (
                <span className="text-xs text-ok">✓ {done[s.targetId]}</span>
              ) : (
                <Button variant="ghost" onClick={() => act(s)}>{s.action === "intro" ? "Request intro" : "Connect"}</Button>
              )}
            </Card>
          ))}
          {mode === "auto" && <p className="text-center text-xs text-muted">Autopilot still shows you everything it does — nothing happens silently.</p>}
        </div>
      )}
    </div>
  );
}
