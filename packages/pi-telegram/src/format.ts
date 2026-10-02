import { Lexer, type Token, type Tokens } from "marked";
import { splitText } from "./config.ts";

/** Telegram offsets and lengths are UTF-16 code units, like JavaScript string.length. */
export interface Entity { type: string; offset: number; length: number; url?: string; language?: string }
export interface FormattedText { text: string; entities: Entity[] }

class Writer {
  text = "";
  entities: Entity[] = [];
  append(text: string): void { this.text += text; }
  mark(type: string, render: () => void, extra: Partial<Entity> = {}): void {
    const offset = this.text.length;
    render();
    const length = this.text.length - offset;
    if (length) this.entities.push({ type, offset, length, ...extra });
  }
  inline(tokens: Token[]): void {
    for (const token of tokens) {
      switch (token.type) {
        case "strong": this.mark("bold", () => this.inline((token as Tokens.Strong).tokens)); break;
        case "em": this.mark("italic", () => this.inline((token as Tokens.Em).tokens)); break;
        case "del": this.mark("strikethrough", () => this.inline((token as Tokens.Del).tokens)); break;
        case "codespan": this.mark("code", () => this.append((token as Tokens.Codespan).text)); break;
        case "br": this.append("\n"); break;
        case "link": {
          const link = token as Tokens.Link;
          const safe = /^(https?:|mailto:|tel:|tg:)/i.test(link.href);
          if (safe) this.mark("text_link", () => this.inline(link.tokens), { url: link.href });
          else this.inline(link.tokens);
          break;
        }
        case "image": {
          const image = token as Tokens.Image;
          this.append(image.text || "Image");
          if (/^https?:/i.test(image.href)) this.append(` (${image.href})`);
          break;
        }
        default: {
          const part = token as Tokens.Text;
          if (part.tokens) this.inline(part.tokens);
          else this.append("text" in token && typeof token.text === "string" ? token.text : token.raw);
        }
      }
    }
  }
  blocks(tokens: Token[], tight = false): void {
    let first = true;
    for (const token of tokens) {
      if (token.type === "space" || token.type === "def") continue;
      if (!first) this.append(tight ? "\n" : "\n\n");
      first = false;
      switch (token.type) {
        case "heading": this.mark("bold", () => this.inline((token as Tokens.Heading).tokens)); break;
        case "paragraph": this.inline((token as Tokens.Paragraph).tokens); break;
        case "text": {
          const text = token as Tokens.Text;
          text.tokens ? this.inline(text.tokens) : this.append(text.text);
          break;
        }
        case "code": {
          const code = token as Tokens.Code;
          this.mark("pre", () => this.append(code.text), code.lang ? { language: code.lang.split(/\s/)[0] } : {});
          break;
        }
        case "blockquote": {
          // Native blockquotes cannot contain pre/code entities. Render a readable quote prefix instead.
          const quote = new Writer();
          quote.blocks((token as Tokens.Blockquote).tokens);
          for (const [index, line] of quote.text.split("\n").entries()) {
            if (index) this.append("\n");
            this.append(`› ${line}`);
          }
          break;
        }
        case "list": {
          const list = token as Tokens.List;
          for (const [index, item] of list.items.entries()) {
            if (index) this.append("\n");
            this.append(list.ordered ? `${Number(list.start) + index}. ` : "• ");
            if (item.task) this.append(item.checked ? "☑ " : "☐ ");
            this.blocks(item.tokens, true);
          }
          break;
        }
        case "table": {
          const table = token as Tokens.Table;
          const labels = table.header.map(cell => { const w = new Writer(); w.inline(cell.tokens); return w.text; });
          if (!table.rows.length) this.append(labels.join(" | "));
          for (const [rowIndex, row] of table.rows.entries()) {
            if (rowIndex) this.append("\n\n");
            for (const [column, cell] of row.entries()) {
              if (column) this.append("\n");
              this.mark("bold", () => this.append(`${labels[column] || `Column ${column + 1}`}: `));
              this.inline(cell.tokens);
            }
          }
          break;
        }
        case "hr": this.append("────────"); break;
        default: this.append(token.raw);
      }
    }
  }
}

/** Parse Markdown, then use native entities. No HTML/Markdown parse_mode or unsafe escaping. */
export function telegramFormat(markdown: string): FormattedText {
  const writer = new Writer();
  writer.blocks(Lexer.lex(markdown, { gfm: true }));
  // Telegram forbids any entity overlapping code/pre, even valid Markdown like **`code`**.
  const protectedRanges = writer.entities.filter(entity => ["code", "pre"].includes(entity.type));
  writer.entities = writer.entities.flatMap(entity => {
    if (["code", "pre"].includes(entity.type)) return [entity];
    let segments = [entity];
    for (const range of protectedRanges) segments = segments.flatMap(segment => {
      const end = segment.offset + segment.length;
      const stop = range.offset + range.length;
      if (stop <= segment.offset || range.offset >= end) return [segment];
      const parts: Entity[] = [];
      if (range.offset > segment.offset) parts.push({ ...segment, length: range.offset - segment.offset });
      if (stop < end) parts.push({ ...segment, offset: stop, length: end - stop });
      return parts;
    });
    return segments;
  });
  writer.entities.sort((a, b) => a.offset - b.offset || b.length - a.length);
  return { text: writer.text, entities: writer.entities };
}

export function formattedChunks(value: FormattedText, limit = 4096): FormattedText[] {
  let offset = 0;
  return splitText(value.text, limit).map(text => {
    const end = offset + text.length;
    const entities = value.entities.flatMap(entity => {
      const start = Math.max(offset, entity.offset);
      const stop = Math.min(end, entity.offset + entity.length);
      return stop > start ? [{ ...entity, offset: start - offset, length: stop - start }] : [];
    });
    offset = end;
    // Telegram limits entity density. Dropping excess styling never drops message text.
    return { text, entities: entities.slice(0, 100) };
  });
}
