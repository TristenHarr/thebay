import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useHostMutation } from "../../api";
import { Button, Card, PageHeader, input, Field } from "../../ui/kit";

export function Host() {
  const [host, { isLoading }] = useHostMutation();
  const nav = useNavigate();
  const [f, setF] = useState<any>({ title: "", startUtc: "", venueName: "", description: "", url: "" });
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value });

  return (
    <div data-testid="host">
      <PageHeader title="Host an event" sub="Publish to The Bay — attendees can RSVP, check in, and review." />
      <Card className="p-5">
        <form
          className="flex flex-col gap-3"
          onSubmit={async (e) => {
            e.preventDefault();
            const payload: any = { ...f, startUtc: new Date(f.startUtc).toISOString() };
            if (!payload.url) delete payload.url;
            const r: any = await host(payload);
            if (r.data?.id) nav(`/event/${r.data.id}`);
            else alert("Could not create event");
          }}
        >
          <Field label="Title"><input className={input} value={f.title} onChange={set("title")} required /></Field>
          <Field label="Date & time"><input className={input} type="datetime-local" value={f.startUtc} onChange={set("startUtc")} required /></Field>
          <Field label="Venue"><input className={input} value={f.venueName} onChange={set("venueName")} /></Field>
          <Field label="Link (RSVP page, optional)"><input className={input} type="url" value={f.url} onChange={set("url")} /></Field>
          <Field label="Description"><textarea className={input} rows={4} value={f.description} onChange={set("description")} /></Field>
          <Button disabled={isLoading} type="submit">Publish event</Button>
        </form>
      </Card>
    </div>
  );
}
