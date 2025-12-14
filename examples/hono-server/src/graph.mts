import {
  StateGraph,
  Annotation,
  END,
  START,
  LangGraphRunnableConfig,
} from "@langchain/langgraph";
import { streamStructuredOutput } from "@langchain/langgraph/streaming";
import { ChatAnthropic } from "@langchain/anthropic";
import { z } from "zod";

export interface Headline {
  id: string;
  text: string;
  locked: boolean;
  rejected: boolean;
}

export interface Description {
  id: string;
  text: string;
}

export const AdsAnnotation = Annotation.Root({
  messages: Annotation<{ role: string; content: string }[]>({
    reducer: (prev, next) => [...prev, ...next],
    default: () => [],
  }),
  headlines: Annotation<Headline[]>({
    reducer: (prev, next) => {
      const locked = prev.filter((h) => h.locked);
      const newHeadlines = next.filter(
        (h) => !locked.some((l) => l.id === h.id)
      );
      return [...locked, ...newHeadlines];
    },
    default: () => [],
  }),
  descriptions: Annotation<Description[]>({
    reducer: (_, next) => next,
    default: () => [],
  }),
});

export type AdsState = typeof AdsAnnotation.State;

const AdsSchema = z.object({
  headlines: z.array(
    z.object({
      id: z.string(),
      text: z.string(),
      status: z.enum(["pending", "approved", "rejected"]),
    })
  ),
  descriptions: z.array(
    z.object({
      id: z.string(),
      text: z.string(),
    })
  ),
});

const SYSTEM_PROMPT = `You are an expert Google Ads copywriter. When given a business description, generate compelling ad copy.

Always respond with some friendly text explaining what you're creating, then include a JSON block with this exact structure:

\`\`\`json
{
  "headlines": [
    {"id": "h1", "text": "Headline 1 text", "status": "pending"},
    {"id": "h2", "text": "Headline 2 text", "status": "pending"},
    {"id": "h3", "text": "Headline 3 text", "status": "pending"}
  ],
  "descriptions": [
    {"id": "d1", "text": "Description 1 text"},
    {"id": "d2", "text": "Description 2 text"}
  ]
}
\`\`\`

Headlines should be max 30 characters. Descriptions should be max 90 characters.
Generate unique IDs for each item (h1, h2, etc for headlines, d1, d2 for descriptions).`;

const adsAgentNode = async (
  state: AdsState,
  config: LangGraphRunnableConfig
): Promise<Partial<AdsState>> => {
  console.log("[adsAgent] config.writer exists:", !!config.writer);
  console.log("[adsAgent] state.messages:", state.messages);

  const model = new ChatAnthropic({
    model: "claude-sonnet-4-20250514",
    temperature: 0.7,
  });

  const messagesWithSystem = [
    { role: "system", content: SYSTEM_PROMPT },
    ...state.messages,
  ];

  const { message, parsed } = await streamStructuredOutput(
    model,
    messagesWithSystem,
    {
      schema: AdsSchema,
      target: "state",
      transforms: {
        headlines: (items: unknown) =>
          (items as z.infer<typeof AdsSchema>["headlines"]).map((h) => ({
            id: h.id,
            text: h.text,
            locked: false,
            rejected: h.status === "rejected",
          })),
        descriptions: (items: unknown) =>
          (items as z.infer<typeof AdsSchema>["descriptions"]).map((d) => ({
            id: d.id,
            text: d.text,
          })),
      },
      config,
    }
  );

  return {
    messages: [{ role: "assistant", content: message.content as string }],
    headlines: parsed?.headlines as Headline[] | undefined,
    descriptions: parsed?.descriptions as Description[] | undefined,
  };
};

export const adsGraph = new StateGraph(AdsAnnotation)
  .addNode("adsAgent", adsAgentNode)
  .addEdge(START, "adsAgent")
  .addEdge("adsAgent", END);
