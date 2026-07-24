import { createRepository } from "../storage";
import { tagPending } from "../pipeline/pipeline";

export async function tagCommand(): Promise<void> {
  const repo = createRepository();
  try {
    const n = await tagPending({ repo });
    console.log(`Tagged ${n} event(s).`);
  } finally {
    repo.close();
  }
}
