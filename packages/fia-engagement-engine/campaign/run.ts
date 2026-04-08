/**
 * Campaign runner — Waitlist Outreach
 *
 * Lee waitlist.json y envía cada mensaje a su hora programada.
 * Corre en el VPS: npx ts-node campaign/run.ts
 *
 * Requiere variables de entorno:
 *   ENGINE_URL        — URL del engine (ej: http://localhost:3000)
 *   ADMIN_API_TOKEN   — token de auth del engine
 *   START_DATE        — fecha de inicio de la campaña (YYYY-MM-DD, ej: 2026-03-24)
 */
import * as fs from "fs";
import * as path from "path";

interface CampaignSend {
  day: number;
  scheduledTime: string; // "HH:MM"
  phone: string;
  name: string;
  message: string;
  skipSend?: boolean;
}

interface CampaignData {
  campaign: string;
  timezone: string;
  sends: CampaignSend[];
}

const ENGINE_URL = process.env["ENGINE_URL"] ?? "http://localhost:3000";
const ADMIN_TOKEN = process.env["ADMIN_API_TOKEN"] ?? "admin-secret";
const START_DATE = process.env["START_DATE"] ?? new Date().toISOString().slice(0, 10);

function getScheduledDate(startDate: string, day: number, time: string, timezone: string): Date {
  // Parse start date + offset days
  const [year, month, dayOfMonth] = startDate.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);

  // Build a date in the target timezone using Intl
  const targetDay = new Date(Date.UTC(year, month - 1, dayOfMonth + (day - 1)));

  // Get the UTC offset for the target timezone at that date
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  // Build the local date string in the target timezone
  const parts = formatter.formatToParts(targetDay);
  const get = (type: string) => parseInt(parts.find((p) => p.type === type)?.value ?? "0", 10);
  const localYear = get("year");
  const localMonth = get("month");
  const localDay = get("day");

  // Create a Date from local time in timezone
  const localStr = `${localYear}-${String(localMonth).padStart(2, "0")}-${String(localDay).padStart(2, "0")}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00`;
  const localDate = new Date(localStr);

  // Compute timezone offset by comparing what the formatter says for midnight UTC
  const utcMidnight = new Date(Date.UTC(localYear, localMonth - 1, localDay, hour, minute, 0));
  const tzParts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(utcMidnight);
  const tzHour = parseInt(tzParts.find((p) => p.type === "hour")?.value ?? "0", 10);
  const tzMinute = parseInt(tzParts.find((p) => p.type === "minute")?.value ?? "0", 10);

  const offsetMs = (hour - tzHour) * 60 * 60 * 1000 + (minute - tzMinute) * 60 * 1000;
  return new Date(utcMidnight.getTime() + offsetMs);
}

async function sendMessage(send: CampaignSend): Promise<void> {
  console.log(`\n[${new Date().toISOString()}] Sending to ${send.name} (${send.phone})...`);

  try {
    const resp = await fetch(`${ENGINE_URL}/api/campaign/send`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ADMIN_TOKEN}`,
      },
      body: JSON.stringify({
        phone: send.phone,
        message: send.message,
        journeyName: "waitlist_outreach",
        name: send.name,
      }),
    });

    const data = await resp.json() as { success?: boolean; error?: string };

    if (resp.ok && data.success) {
      console.log(`✓ Sent to ${send.name}`);
    } else {
      console.error(`✗ Failed for ${send.name}: ${data.error ?? resp.status}`);
    }
  } catch (err) {
    console.error(`✗ Error for ${send.name}:`, err);
  }
}

async function main(): Promise<void> {
  const campaignPath = path.join(__dirname, "waitlist.json");
  const data: CampaignData = JSON.parse(fs.readFileSync(campaignPath, "utf8"));

  console.log(`\n=== Campaign: ${data.campaign} ===`);
  console.log(`Start date: ${START_DATE}`);
  console.log(`Engine: ${ENGINE_URL}`);
  console.log(`Timezone: ${data.timezone}\n`);

  const now = Date.now();
  let scheduled = 0;
  let skipped = 0;
  let manual = 0;

  for (const send of data.sends) {
    if (send.skipSend) {
      console.log(`[MANUAL] Day ${send.day} ${send.scheduledTime} — ${send.name}: ${send.message}`);
      manual++;
      continue;
    }

    const scheduledAt = getScheduledDate(START_DATE, send.day, send.scheduledTime, data.timezone);
    const msUntil = scheduledAt.getTime() - now;

    if (msUntil < -60_000) {
      // More than 1 min in the past — skip to avoid accidental re-sends
      console.log(`[SKIP] Day ${send.day} ${send.scheduledTime} — ${send.name} (already past: ${scheduledAt.toISOString()})`);
      skipped++;
      continue;
    }

    const displayMs = Math.max(0, msUntil);
    const displayMin = Math.round(displayMs / 60_000);
    console.log(`[SCHEDULED] Day ${send.day} ${send.scheduledTime} — ${send.name} (in ${displayMin} min, at ${scheduledAt.toISOString()})`);

    setTimeout(() => {
      sendMessage(send).catch(console.error);
    }, Math.max(0, msUntil));

    scheduled++;
  }

  console.log(`\nSummary: ${scheduled} scheduled, ${skipped} skipped (past), ${manual} manual`);

  if (scheduled === 0) {
    console.log("No sends scheduled — exiting.");
    process.exit(0);
  }

  // Keep process alive until all sends fire
  const maxDay = Math.max(...data.sends.filter((s) => !s.skipSend).map((s) => s.day));
  const lastSendTime = getScheduledDate(
    START_DATE,
    maxDay,
    data.sends.filter((s) => !s.skipSend && s.day === maxDay).slice(-1)[0]?.scheduledTime ?? "17:00",
    data.timezone,
  );
  const keepAliveMs = lastSendTime.getTime() - now + 60_000; // 1 min buffer

  console.log(`\nKeeping process alive until ${lastSendTime.toISOString()} (+1min buffer)`);
  setTimeout(() => {
    console.log("\nAll sends completed. Exiting.");
    process.exit(0);
  }, Math.max(0, keepAliveMs));
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
