import assert from "node:assert/strict";

// Parse only the formatter's deliberately small XML vocabulary, validating balanced
// tags/entities as well as decoded text. No parser dependency or provider call.
export function references(input: string) {
  return [...input.matchAll(/<telegram_reply_context>\n([\s\S]*?)\n<\/telegram_reply_context>/g)].map(match => {
    const xml = match[0];
    const stack: string[] = [];
    for (const token of xml.split(/(<[^>]*>)/).filter(Boolean)) {
      if (!token.startsWith("<")) {
        assert.ok(!/[<>]|&(?!amp;|lt;|gt;|#13;)/.test(token), "escaped XML text only");
        assert.ok(!/[^\u0009\u000A\u000D\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/u.test(token), "valid XML characters only");
      } else {
        const tag = token.match(/^<(\/?)([a-z_]+)((?: [a-z_0-9]+="(?:[a-z_]+|\d+)")*)\s*(\/?)>$/);
        assert.ok(tag, `unexpected XML tag: ${token}`);
        if (tag[1]) assert.equal(stack.pop(), tag[2], "balanced XML");
        else if (!tag[4]) stack.push(tag[2]);
      }
    }
    assert.deepEqual(stack, []);
    const decode = (text: string) => text.replace(/&(amp|lt|gt|#13);/g, (_, entity) => ({ amp: "&", lt: "<", gt: ">", "#13": "\r" })[entity as "amp"]!);
    const field = (tag: string) => {
      const found = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
      return found ? decode(found[1]) : undefined;
    };
    const quote = xml.match(/<quote(?: position_utf16="(\d+)")? is_manual="(true|false)">([\s\S]*?)<\/quote>/);
    const truncations = Object.fromEntries([...xml.matchAll(/<truncation field="([a-z_]+)" original_utf16_units="(\d+)" \/>/g)].map(item => [item[1], Number(item[2])]));
    return { xml, sender: field("sender"), body: field("body"), caption: field("caption"),
      quote: quote ? { text: decode(quote[3]), position_utf16: quote[1] ? Number(quote[1]) : undefined, is_manual: quote[2] === "true" } : undefined,
      media: xml.includes("<media>") ? { type: field("type"), file_name: field("file_name"), mime_type: field("mime_type"), file_size: field("file_size"), content: field("content") } : undefined,
      statuses: [...xml.matchAll(/<status>([^<]*)<\/status>/g)].map(item => decode(item[1])), truncations };
  });
}
