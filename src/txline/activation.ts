export function parseActivationToken(body: string): string {
  const trimmed = body.trim();
  if (!trimmed) throw new Error("TxLINE activation returned an empty token");

  let token = trimmed;
  if (trimmed.startsWith("{") || trimmed.startsWith('"')) {
    const parsed = JSON.parse(trimmed) as { token?: unknown } | string;
    token = typeof parsed === "string" ? parsed : String(parsed.token ?? "");
  }

  if (!/^txoracle_api_[A-Za-z0-9_-]+$/.test(token)) {
    throw new Error("TxLINE activation returned an unrecognized token format");
  }
  return token;
}
