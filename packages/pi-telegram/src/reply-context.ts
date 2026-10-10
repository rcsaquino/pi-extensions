import type { TgFile, TgMessage, TgUser } from "./api.ts";
import { type Config, redact } from "./config.ts";

// Limits count UTF-16 units, including XML text escaping. Telegram text/captions
// normally contain at most 4096/1024 characters. Quotes have a separate 1024 budget.
export const REPLY_CONTEXT_LIMIT = 8192;
export const REPLY_TEXT_LIMIT = 4096;
export const REPLY_CAPTION_LIMIT = 1024;
export const REPLY_QUOTE_LIMIT = 1024;
const HEADER = "<telegram_reply_context>\n";
const FOOTER = "\n</telegram_reply_context>";
interface Bounded { text: string; truncated?: true; original_utf16_units?: number }
interface Sender { role: string; id?: number; is_bot?: boolean; first_name?: Bounded; last_name?: Bounded; username?: Bounded }
interface Media { type: string; file_name?: Bounded; mime_type?: Bounded; file_size?: number; content: string }
interface Reference {
  for_message_id?: number; message_id?: number; status: string; reason?: string; quote?: string;
  sender?: Sender; text?: Bounded; caption?: Bounded; media?: Media; content?: string;
  selected_quote?: Partial<Bounded> & { position_utf16?: number; is_manual: boolean };
}
// XML 1.0 text, not markup. Replace illegal controls/noncharacters/lone surrogates;
// preserve valid multiline text, including CR via a character reference.
function xmlText(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("\r", "&#13;");
}
function serialize(value: Reference): string {
  const fields: string[] = [];
  const field = (tag: string, text: string) => fields.push(`  <${tag}>${xmlText(text)}</${tag}>`);
  const boundedField = (tag: string, value?: Partial<Bounded>, attributes = "") => {
    if (value?.text === undefined) return;
    fields.push(`  <${tag}${attributes}>${xmlText(value.text)}</${tag}>`);
    if (value.truncated) fields.push(`  <truncation field="${tag}" original_utf16_units="${value.original_utf16_units}" />`);
  };
  if (value.status !== "same_chat_reply") field("status", value.status);
  if (value.reason) field("status", value.reason);
  if (value.quote) field("status", `quote_${value.quote}`);
  if (value.sender) {
    const from = value.sender;
    const name = [from.first_name?.text, from.last_name?.text].filter(Boolean).join(" ") || (from.username?.text ? `@${from.username.text}` : "");
    const label = from.role === "assistant_bot" ? "" : from.role === "other_bot" ? "other bot"
      : from.role === "authorized_user" ? "user" : "unknown sender";
    if (name) field("sender", label ? `${name} (${label})` : name);
    else field("status", `sender_unavailable; ${from.role}`);
    for (const key of ["first_name", "last_name", "username"] as const) {
      if (from[key]?.truncated) fields.push(`  <truncation field="${key}" original_utf16_units="${from[key]!.original_utf16_units}" />`);
    }
  }
  boundedField("body", value.text || value.caption);
  if (value.text && value.caption) boundedField("caption", value.caption);
  if (value.content) field("status", value.content);
  const quote = value.selected_quote;
  if (quote) {
    boundedField("quote", quote, `${quote.position_utf16 !== undefined ? ` position_utf16="${quote.position_utf16}"` : ""} is_manual="${quote.is_manual}"`);
    if (quote.text === undefined) field("status", "quote_text_unavailable");
  }
  if (value.media) {
    const file = value.media;
    fields.push("  <media>");
    field("type", file.type);
    boundedField("file_name", file.file_name); boundedField("mime_type", file.mime_type);
    if (file.file_size !== undefined) field("file_size", String(file.file_size));
    field("content", "metadata only; not downloaded, viewed or transcribed; not voice permission");
    fields.push("  </media>");
  }
  return HEADER + fields.join("\n") + FOOTER;
}
function id(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}
function nonnegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
function bounded(value: unknown, limit: number, config: Config): Bounded | undefined {
  if (typeof value !== "string" || !value) return;
  const safe = redact(value, config).replace(/[^\u0009\u000A\u000D\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/gu, "�");
  let text = "";
  let units = 0;
  for (const character of safe) {
    const cost = xmlText(character).length;
    if (units + cost > limit) break;
    text += character;
    units += cost;
  }
  return text.length === safe.length ? { text } : { text, truncated: true, original_utf16_units: safe.length };
}
function sender(target: TgMessage, config: Config, botId?: number): Sender {
  // Telegram may put a fake 'from' on messages sent on behalf of a chat.
  if (target.sender_chat) return { role: "chat_sender" };
  const from = target.from;
  const senderId = id(from?.id);
  const role = senderId && senderId === botId && from?.is_bot === true ? "assistant_bot"
    : senderId === target.chat.id && from?.is_bot !== true && config.allowed.has(String(senderId)) ? "authorized_user"
    : from?.is_bot === true ? "other_bot" : "unknown_sender";
  return { role, id: senderId, is_bot: from?.is_bot,
    first_name: bounded(from?.first_name, 96, config), last_name: bounded(from?.last_name, 96, config),
    username: bounded(from?.username, 96, config) };
}
function media(target: TgMessage, config: Config): Media | undefined {
  // Do not copy file IDs, paths, URLs, thumbnail bytes or nested reply chains.
  const choices: [string, TgFile | undefined][] = [["voice", target.voice], ["audio", target.audio],
    ["video_note", target.video_note], ["animation", target.animation], ["video", target.video],
    ["photo", target.photo?.[0]], ["sticker", target.sticker], ["document", target.document]];
  const selected = choices.find(([, file]) => file);
  if (!selected) return;
  const [type, file] = selected;
  return { type, file_name: bounded(file!.file_name, 120, config), mime_type: bounded(file!.mime_type, 96, config),
    file_size: nonnegative(file!.file_size), content: "not_read" };
}
function reference(message: TgMessage, config: Config, botId?: number): Reference | undefined {
  if (!message.reply_to_message && !message.external_reply && !message.quote) return;
  const base = { for_message_id: id(message.message_id) };
  if (message.external_reply) return { ...base, status: "external_reply_omitted", reason: "outside_verified_same_chat_context" };
  const target = message.reply_to_message;
  if (!target) return { ...base, status: "reply_target_unavailable", quote: "omitted_origin_unverified" };
  if (message.business_connection_id || message.guest_query_id || target.business_connection_id || target.guest_query_id ||
    target.chat?.id !== message.chat.id || target.chat?.type !== "private") {
    return { ...base, status: "reply_target_omitted", reason: "outside_verified_same_chat_context" };
  }
  const selectedQuote = message.quote ? { ...bounded(message.quote.text, REPLY_QUOTE_LIMIT, config),
    position_utf16: nonnegative(message.quote.position), is_manual: message.quote.is_manual === true } : undefined;
  // reply_to_message officially contains Message, not MaybeInaccessibleMessage. Be
  // defensive about date=0/missing dates without pretending deleted content exists.
  if (!id(target.date)) return { ...base, message_id: id(target.message_id), status: "reply_target_unavailable", selected_quote: selectedQuote };
  return { ...base, message_id: id(target.message_id), status: "same_chat_reply", sender: sender(target, config, botId),
    text: bounded(target.text, REPLY_TEXT_LIMIT, config), caption: bounded(target.caption, REPLY_CAPTION_LIMIT, config),
    media: media(target, config), selected_quote: selectedQuote,
    ...(!target.text && !target.caption ? { content: "text_unavailable; media_or_service_content_not_read" } : {}) };
}

/** Call only after inbound authentication. Also fail closed if used independently.
 * Records are attached to the ordinary prepared user text, so FIFO/steering/retries
 * use the existing submission path, with no second message or recipient capability.
 */
export function formatReplyContext(messages: TgMessage[], config: Config, botId?: TgUser["id"]): string {
  const records: string[] = [];
  const seen = new Set<string>();
  let size = 0;
  let omitted = 0;
  for (const message of messages) {
    if (message.chat.type !== "private" || message.from?.is_bot || message.chat.id !== message.from?.id ||
      !config.allowed.has(String(message.from?.id))) continue;
    const value = reference(message, config, botId);
    if (!value) continue;
    // Repeated album fragments commonly carry the same target and selected quote.
    const key = JSON.stringify({ ...value, for_message_id: undefined });
    if (seen.has(key)) continue;
    seen.add(key);
    const line = serialize(value);
    if (size + line.length + (records.length ? 1 : 0) > REPLY_CONTEXT_LIMIT - 256) { omitted++; continue; }
    size += line.length + (records.length ? 1 : 0);
    records.push(line);
  }
  // Reserve space for a complete omission record, never slice tags or entities.
  if (omitted) records.push(HEADER + `  <status>additional_reply_context_omitted</status>\n  <omitted_count>${omitted}</omitted_count>\n  <status>8192_utf16_budget</status>` + FOOTER);
  return records.join("\n");
}
