import { mouseKeyboardService } from "./mouseKeyboard";
import { modelRouter } from "../../../../agent/modelRouter";

export interface ElementCoordinates {
  x: number;
  y: number;
}

export class VisionControlService {
  /**
   * Take a screenshot and ask Gemini to find the coordinates of a specific element.
   */
  async findElementOnScreen(elementDescription: string): Promise<ElementCoordinates> {
    const base64Image = await mouseKeyboardService.takeScreenshot();

    const systemPrompt = `
You are a highly precise UI vision assistant. Your job is to locate the center coordinates of the UI element described by the user in the provided screenshot.
The image is a full screen capture of a Windows desktop environment.

Reply ONLY with a JSON object containing the exact center (x, y) pixel coordinates of the target element. 
If there are multiple matches, pick the most likely one based on standard UI conventions.
If you cannot find the element, return x: -1, y: -1.

Example output:
{
  "x": 450,
  "y": 1024
}
`;

    const userPrompt = [
      { text: `Find the center coordinates of: ${elementDescription}` },
      {
        inlineData: {
          data: base64Image,
          mimeType: "image/jpeg",
        },
      },
    ];

    const result = await modelRouter.generateStructured<ElementCoordinates>({
      tier: "vision",
      systemPrompt,
      userPrompt,
      outputSchema: {
        type: "object",
        properties: {
          x: { type: "integer", description: "X pixel coordinate of the element center" },
          y: { type: "integer", description: "Y pixel coordinate of the element center" },
        },
        required: ["x", "y"],
      },
    });

    return result;
  }

  /**
   * Take a screenshot and analyze it based on a query.
   */
  async analyzeScreen(query: string): Promise<string> {
    const base64Image = await mouseKeyboardService.takeScreenshot();

    const systemPrompt = `
You are a highly capable vision assistant. Analyze the provided screenshot of a desktop screen to answer the user's query.
Be concise and descriptive. If asked to read text, extract it accurately.
`;

    const userPrompt = [
      { text: query },
      {
        inlineData: {
          data: base64Image,
          mimeType: "image/jpeg",
        },
      },
    ];

    const result = await modelRouter.generate({
      tier: "vision",
      systemPrompt,
      userPrompt,
    });

    return result.text;
  }
}

export const visionControlService = new VisionControlService();
