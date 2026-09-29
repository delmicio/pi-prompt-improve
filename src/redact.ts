const SECRET_KEY =
  /(authorization|cookie|api[-_]?key|token|access[-_]?token|client[-_]?secret|password|signature)/i;

export function redactError(error: unknown): string {
  const source = stringify(error);
  return source
    .replace(
      /(authorization\s*[:=]\s*)(?:bearer|basic)\s+[^\s,;]+/gi,
      "$1[REDACTED]",
    )
    .replace(/(bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[REDACTED]")
    .replace(
      /((?:api[-_]?key|token|access[-_]?token|client[-_]?secret|password|signature)\s*[=:]\s*)[^\s&,;]+/gi,
      "$1[REDACTED]",
    )
    .replace(
      /([?&](?:api[-_]?key|token|access[-_]?token|client[-_]?secret|password|signature)=)[^&#\s]+/gi,
      "$1[REDACTED]",
    );
}

function stringify(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return (
      JSON.stringify(error, (key, value) =>
        SECRET_KEY.test(key) ? "[REDACTED]" : value,
      ) ?? "Unknown provider error"
    );
  } catch {
    return "Unknown provider error";
  }
}
