import { env } from "./env";

export async function sqlClient() {
  const databaseUrl = env("DATABASE_URL");
  if (!databaseUrl) return null;
  const { neon } = await import("@neondatabase/serverless");
  return neon(databaseUrl);
}
