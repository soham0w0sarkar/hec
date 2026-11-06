/** Instagram exports store UTF-8 bytes as Latin-1 characters. */
export function repairInstagramText(value: string): string {
  for (let i = 0; i < value.length; i++) {
    if (value.charCodeAt(i) > 0xff) return value;
  }

  const bytes = Uint8Array.from(value, (char) => char.charCodeAt(0));
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return value;
  }
}
