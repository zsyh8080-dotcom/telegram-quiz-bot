export type KeyAttempt<T> = (apiKey: string, index: number) => Promise<T>;

export function splitProviderKeys(
  ...values: Array<string | null | undefined>
): string[] {
  const keys = values.flatMap((value) =>
    String(value ?? "")
      .split(/[\r\n,;]+/)
      .map((key) => key.trim())
      .filter(Boolean),
  );
  return [...new Set(keys)];
}

export function isKeyRotationError(error: unknown): boolean {
  return /\[(?:C|G|M|O|B)-(?:AUTH|QUOTA)\]|(?:^|\D)(?:401|402|403|429)(?:\D|$)|rate.?limit|quota|insufficient balance/i.test(
    error instanceof Error ? error.message : String(error),
  );
}

export class ProviderKeyRotator {
  readonly keys: string[];

  constructor(keys: Array<string | null | undefined>) {
    this.keys = splitProviderKeys(...keys);
  }

  async run<T>(attempt: KeyAttempt<T>): Promise<T> {
    if (!this.keys.length)
      throw new Error("Provider has no API keys [C-CONFIG]");
    let lastError: unknown;
    for (let index = 0; index < this.keys.length; index++) {
      try {
        return await attempt(this.keys[index], index);
      } catch (error) {
        lastError = error;
        if (!isKeyRotationError(error) || index === this.keys.length - 1)
          throw error;
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error("Provider key rotation failed");
  }
}
