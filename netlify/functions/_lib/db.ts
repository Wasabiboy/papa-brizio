import { env } from "./env";

export async function sqlClient() {
  const databaseUrl = env("DATABASE_URL");
  if (!databaseUrl) return null;
  const { neon } = await import("@neondatabase/serverless");
  return neon(databaseUrl);
}

type SqlClient = NonNullable<Awaited<ReturnType<typeof sqlClient>>>;

let venueSettingsSchemaReady: Promise<void> | undefined;

export function ensureVenueSettingsSchema(sql: SqlClient) {
  if (!venueSettingsSchemaReady) {
    venueSettingsSchemaReady = (async () => {
      await sql`
        ALTER TABLE venue_settings
        ADD COLUMN IF NOT EXISTS blocked_times jsonb NOT NULL DEFAULT '[]'::jsonb
      `;
    })().catch((error) => {
      venueSettingsSchemaReady = undefined;
      throw error;
    });
  }
  return venueSettingsSchemaReady;
}
