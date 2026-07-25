/**
 * Data-access layer barrel. Every table-backed repository lives here and follows
 * the same shape: `new XRepo(env.DB)`, async methods, all invariants pushed into
 * SQL (FK / CHECK / UNIQUE) so bad states are unrepresentable. Import from
 * `../storage/d1` rather than reaching into individual files.
 */
export { D1Repo } from "./d1-repo";
export { SocialRepo } from "./social-repo";
export { PlatformRepo } from "./platform-repo";
export { GraphRepo } from "./graph-repo";
export { IntegrationsRepo, type Provider } from "./integrations-repo";
export { MediaRepo } from "./media-repo";
export { NotesRepo, type Note } from "./notes-repo";
export { NewsRepo, slugify, type Story, type Comment as StoryComment, type StorySourceRef } from "./news-repo";
