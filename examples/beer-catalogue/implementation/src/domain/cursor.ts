/** Where a page of the catalogue ended: the last beer's place in name order, and its id. */
export type PageEnd = { order: string; id: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The opaque next_cursor handed to clients. */
export function encodeCursor(end: PageEnd): string {
  return Buffer.from(JSON.stringify([end.order, end.id]), "utf8").toString("base64url");
}

/** Undefined unless the cursor is one encodeCursor could have produced. */
export function decodeCursor(cursor: string): PageEnd | undefined {
  try {
    const decoded: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (!Array.isArray(decoded) || decoded.length !== 2) return undefined;
    const [order, id] = decoded as unknown[];
    if (typeof order !== "string" || order === "" || order.length > 400) return undefined;
    if (typeof id !== "string" || !UUID.test(id)) return undefined;
    return { order, id };
  } catch {
    return undefined;
  }
}
