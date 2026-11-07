import { createBedrockChat, createLocalChat, createSarvamChat, type ChatModel } from "@hec/llm";

export type ExtractionProvider = "sarvam" | "local" | "bedrock";

/**
 * Which backend runs extraction, from EXTRACTION_PROVIDER: `sarvam` (default), `local`
 * (an Ollama server on this machine), or `bedrock` (Amazon Bedrock, billed to the AWS account).
 * Anything else is a mistake, so it throws.
 */
export function extractionProvider(env: Record<string, string | undefined> = process.env): ExtractionProvider {
  const value = (env.EXTRACTION_PROVIDER ?? "").trim().toLowerCase() || "sarvam";
  if (value === "sarvam" || value === "local" || value === "bedrock") return value;
  throw new Error(`EXTRACTION_PROVIDER must be "sarvam", "local" or "bedrock", not "${value}"`);
}

/** The model name a run records. Each provider reads its own setting. */
export function extractionModelName(env: Record<string, string | undefined> = process.env): string {
  const provider = extractionProvider(env);
  const name =
    provider === "local"
      ? env.LOCAL_LLM_MODEL?.trim()
      : provider === "bedrock"
        ? env.BEDROCK_MODEL_ID?.trim()
        : env.SARVAM_MODEL?.trim();
  if (name) return name;
  const setting = provider === "local" ? "LOCAL_LLM_MODEL" : provider === "bedrock" ? "BEDROCK_MODEL_ID" : "SARVAM_MODEL";
  throw new Error(`${setting} is not set`);
}

/** The extraction model from env. Throws if the chosen provider's settings are missing. */
export function createExtractionModel(env: Record<string, string | undefined> = process.env): ChatModel {
  const model = extractionModelName(env);
  if (extractionProvider(env) === "local") {
    return createLocalChat({ model, baseUrl: env.LOCAL_LLM_URL?.trim() || undefined });
  }
  if (extractionProvider(env) === "bedrock") {
    return createBedrockChat({ modelId: model, region: env.BEDROCK_REGION?.trim() || undefined });
  }
  return createSarvamChat({ apiKey: env.SARVAM_API_KEY ?? "", model });
}
