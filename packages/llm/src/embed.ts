/** B4 — Semantic RAG embeddings.
 *  Spec: ORACLE_v2026_8_0.jsx (B4 section).
 *  Model: gemini-embedding-001 (Gemini Embedding API).
 *  Falls back to null when no key — RAGSystem keeps its own 12-dim hash as fallback. */
import { GoogleGenAI } from '@google/genai';
import type { LLMCallContext } from './types.js';

const EMBEDDING_MODEL = 'gemini-embedding-001';

/** Generate a semantic embedding vector for a text passage.
 *  Returns null when the key is absent or the call fails — caller uses hash-based fallback. */
export async function embedText(
  text: string,
  ctx: LLMCallContext,
): Promise<number[] | null> {
  if (!ctx.config.geminiApiKey) return null;
  try {
    const ai = new GoogleGenAI({ apiKey: ctx.config.geminiApiKey });
    const result = await ai.models.embedContent({
      model: EMBEDDING_MODEL,
      contents: text,
    });
    const values = result.embeddings?.[0]?.values;
    return Array.isArray(values) ? (values as number[]) : null;
  } catch {
    return null;
  }
}

/** Embedder function type — can be injected into RAGSystem. */
export type EmbedderFn = (text: string) => Promise<number[] | null>;

/** Build an embedder bound to the given LLM context. */
export function makeEmbedder(ctx: LLMCallContext): EmbedderFn {
  return (text: string) => embedText(text, ctx);
}
