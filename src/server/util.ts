const B36 = "0123456789abcdefghijklmnopqrstuvwxyz";

function randomBase36(len: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  let out = "";
  for (const b of bytes) out += B36[b % 36];
  return out;
}

export function slugify(s: string, max = 40): string {
  const slug = s
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/g, "");
  return slug || "task";
}

export function newTicketId(now = new Date()): string {
  const d = now.toISOString().slice(0, 10).replace(/-/g, "");
  return `t_${d}_${randomBase36(4)}`;
}

export function newId(): string {
  return randomBase36(8);
}

export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

/**
 * A ⭐ typed at the start of a title marks the ticket ⭐ Important (Claude and users write it that way); the title
 * keeps the rest. important is false when there is no star.
 */
export function starredTitle(title: string): { title: string; important: boolean } {
  const m = /^\s*(?:⭐️?\s*)+/u.exec(title);
  return m ? { title: title.slice(m[0].length), important: true } : { title, important: false };
}
