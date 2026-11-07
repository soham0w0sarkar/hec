import { describe, expect, test } from "bun:test";
import { createExtractionModel, extractionModelName, extractionProvider } from "./model";

describe("extraction provider", () => {
  test("defaults to sarvam, and local is chosen by EXTRACTION_PROVIDER", () => {
    expect(extractionProvider({})).toBe("sarvam");
    expect(extractionProvider({ EXTRACTION_PROVIDER: " Local " })).toBe("local");
  });

  test("an unknown provider is a mistake, not a silent default", () => {
    expect(() => extractionProvider({ EXTRACTION_PROVIDER: "openai" })).toThrow(/EXTRACTION_PROVIDER/);
  });

  test("the recorded model name comes from the chosen provider's setting", () => {
    expect(extractionModelName({ EXTRACTION_PROVIDER: "local", LOCAL_LLM_MODEL: "qwen2.5:7b-instruct", SARVAM_MODEL: "sarvam-105b" })).toBe("qwen2.5:7b-instruct");
    expect(extractionModelName({ SARVAM_MODEL: "sarvam-105b" })).toBe("sarvam-105b");
  });

  test("a missing setting for the chosen provider throws, naming that setting", () => {
    expect(() => extractionModelName({ EXTRACTION_PROVIDER: "local" })).toThrow("LOCAL_LLM_MODEL is not set");
    expect(() => extractionModelName({ SARVAM_API_KEY: "k" })).toThrow("SARVAM_MODEL is not set");
  });

  test("local needs no Sarvam key", () => {
    const model = createExtractionModel({ EXTRACTION_PROVIDER: "local", LOCAL_LLM_MODEL: "qwen2.5:7b-instruct" });
    expect(model.model).toBe("qwen2.5:7b-instruct");
  });

  test("bedrock records BEDROCK_MODEL_ID and needs no Sarvam key", () => {
    expect(extractionProvider({ EXTRACTION_PROVIDER: "Bedrock" })).toBe("bedrock");
    expect(extractionModelName({ EXTRACTION_PROVIDER: "bedrock", BEDROCK_MODEL_ID: "qwen.qwen3-32b-v1:0" })).toBe("qwen.qwen3-32b-v1:0");
    const model = createExtractionModel({ EXTRACTION_PROVIDER: "bedrock", BEDROCK_MODEL_ID: "qwen.qwen3-32b-v1:0" });
    expect(model.model).toBe("qwen.qwen3-32b-v1:0");
  });
});
