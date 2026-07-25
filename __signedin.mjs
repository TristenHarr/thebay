// Reproduce the user's exact situation: a real session cookie on thebay.news.
const email = `signedin-${Date.now()}@example.com`;
let r = await fetch("https://thebay.events/auth/password/register", {
  method: "POST", headers: { "content-type": "application/json" }, redirect: "manual",
  body: JSON.stringify({ email, password: "Correct-Horse-9times!", name: "Signed In" }),
});
const evCookie = (r.headers.getSetCookie?.() ?? [])[0]?.split(";")[0];

r = await fetch("https://thebay.events/auth/handoff/start?next=%2F", { headers: { cookie: evCookie }, redirect: "manual" });
const to = r.headers.get("location");
r = await fetch(to, { headers: { "sec-fetch-dest": "document", "sec-fetch-mode": "navigate" }, redirect: "manual" });
const newsCookie = (r.headers.getSetCookie?.() ?? [])[0]?.split(";")[0];
console.log("  got a thebay.news session:", newsCookie ? "yes" : "NO");

for (const path of ["/", "/?src=all", "/newest", "/?src=hn", "/?src=all&sort=new"]) {
  const res = await fetch("https://thebay.news" + path, { headers: { cookie: newsCookie } });
  console.log(`  SIGNED IN  ${path.padEnd(22)} -> ${res.status}${res.status === 200 ? " ✓" : " ✗"}`);
}
for (const path of ["/", "/?src=all"]) {
  const res = await fetch("https://thebay.news" + path);
  console.log(`  anonymous  ${path.padEnd(22)} -> ${res.status}`);
}
