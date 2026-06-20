/**
 * Audio transcription via OpenAI (Whisper). Turns WhatsApp voice notes into text so Sofía can
 * read/answer them and the conversation log keeps a record. Uses a dedicated key
 * (OPENAI_WHISPER_API_KEY) to isolate cost. Best-effort — returns null on any failure.
 */
import { config } from "../config";
import { logger } from "../logger";

/** Maps a WhatsApp/Evolution audio mimetype to a filename extension Whisper accepts. */
function extFor(mimetype: string): string {
  const m = mimetype.toLowerCase();
  if (m.includes("mp4") || m.includes("m4a")) return "m4a";
  if (m.includes("mpeg") || m.includes("mp3")) return "mp3";
  if (m.includes("wav")) return "wav";
  if (m.includes("webm")) return "webm";
  return "ogg"; // WhatsApp voice notes are audio/ogg; codecs=opus
}

/**
 * Transcribes base64-encoded audio to text (Spanish). Returns the transcript, or null if
 * transcription is unavailable/failed (caller then logs the audio without text).
 */
export async function transcribeAudio(base64: string, mimetype: string): Promise<string | null> {
  if (!config.openai.transcribeApiKey || !base64) return null;
  try {
    const buffer = Buffer.from(base64, "base64");
    if (buffer.length === 0) return null;
    const cleanMime = mimetype.split(";")[0] || "audio/ogg";
    const file = new Blob([buffer], { type: cleanMime });
    const form = new FormData();
    form.append("file", file, `audio.${extFor(mimetype)}`);
    form.append("model", config.openai.transcribeModel);
    form.append("language", "es");

    const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${config.openai.transcribeApiKey}` },
      body: form,
    });
    if (!res.ok) {
      logger.warn({ status: res.status, body: (await res.text()).slice(0, 200) }, "Whisper transcription failed");
      return null;
    }
    const data = (await res.json()) as { text?: string };
    const text = (data.text ?? "").trim();
    return text || null;
  } catch (error) {
    logger.warn({ error: (error as Error).message }, "transcribeAudio error");
    return null;
  }
}
