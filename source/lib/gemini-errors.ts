export type GeminiFailureCode =
  | "AUTH"
  | "QUOTA"
  | "MODEL"
  | "SCHEMA"
  | "CONFIG"
  | "BACKGROUND"
  | "FORMAT"
  | "REQUEST"
  | "PROVIDER";

export function classifyGeminiFailure(
  status: number,
  detail: string,
): GeminiFailureCode {
  if (
    /API[_ ]?KEY|UNAUTHENTICATED|credential/i.test(detail) ||
    status === 401
  ) {
    return "AUTH";
  }
  if (/RESOURCE_EXHAUSTED|quota|rate.?limit/i.test(detail) || status === 429) {
    return "QUOTA";
  }
  if (
    /\bmodel\b.{0,160}\b(?:not found|unsupported|not supported|unavailable|not available|does not exist|access|permission)/i.test(
      detail,
    ) ||
    /(?:not found|unsupported|not supported|permission|access).{0,160}\bmodel\b/i.test(
      detail,
    )
  )
    return "MODEL";
  if (
    /response[_ ]format|response schema|json schema|\bschema\b/i.test(detail)
  ) {
    return "SCHEMA";
  }
  if (
    /generation[_ ]config|max[_ ]output[_ ]tokens|thinking[_ ]level|temperature/i.test(
      detail,
    )
  ) {
    return "CONFIG";
  }
  if (/background|\bstore\b/i.test(detail)) return "BACKGROUND";
  if (
    /invalid json payload|unknown (?:name|field)|cannot find field|malformed json/i.test(
      detail,
    )
  ) {
    return "FORMAT";
  }
  if (status === 400 || /INVALID_ARGUMENT/i.test(detail)) return "REQUEST";
  if (status === 403) return "AUTH";
  return "PROVIDER";
}
