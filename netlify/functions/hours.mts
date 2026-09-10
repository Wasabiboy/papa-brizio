import type { Config } from "@netlify/functions";
import { sqlClient } from "./_lib/db";
import { DEFAULT_SETTINGS, settingsFromRow } from "./_lib/venue";

function json(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export default async (req: Request) => {
  if (req.method !== "GET") {
    return json(405, { error: "Use GET." });
  }
  const sql = await sqlClient();
  if (!sql) {
    return json(200, DEFAULT_SETTINGS);
  }
  try {
    const rows = await sql`SELECT timezone, slot_minutes, hours, closed_dates FROM venue_settings WHERE id = 'default' LIMIT 1`;
    return json(200, settingsFromRow(rows[0] as Record<string, unknown> | undefined));
  } catch (error) {
    console.error("hours load failed", error);
    return json(200, DEFAULT_SETTINGS);
  }
};

export const config: Config = {
  path: "/api/hours",
};
