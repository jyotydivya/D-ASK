import OpenAI from "openai";

const EMBEDDING_MODEL = "text-embedding-3-small";

class EmbeddingService {
  private client: OpenAI | null = null;

  private getClient(): OpenAI {
    if (!this.client) {
      const apiKey = process.env.OPENROUTER_API_KEY;
      if (!apiKey) {
        throw new Error("OPENROUTER_API_KEY is not set in environment");
      }
      this.client = new OpenAI({
        apiKey,
        baseURL: "https://openrouter.ai/api/v1",
        defaultHeaders: {
          "HTTP-Referer": "http://localhost:3000",
          "X-Title": "D-ASK Jarvis",
        }
      });
    }
    return this.client;
  }

  /**
   * Converts a string into a dense vector (array of numbers)
   */
  async generateEmbedding(text: string): Promise<number[]> {
    const response = await this.getClient().embeddings.create({
      model: EMBEDDING_MODEL,
      input: text,
    });
    return response.data[0].embedding;
  }
}

export const embeddingService = new EmbeddingService();
