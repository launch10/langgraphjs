import {
  StateGraph,
  Annotation,
  END,
  START,
  LangGraphRunnableConfig,
} from "@langchain/langgraph";
import { streamStructuredOutput } from "@langchain/langgraph/streaming";
import { FakeListChatModel } from "@langchain/core/utils/testing";
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

function buildLLMResponse(userInput: string): string {
  const jsonContent = JSON.stringify(
    {
      headlines: [
        { id: "h1", text: `Premium ${userInput} Services`, status: "pending" },
        { id: "h2", text: `Best ${userInput} in Town`, status: "pending" },
        {
          id: "h3",
          text: `${userInput} - Quality Guaranteed`,
          status: "pending",
        },
      ],
      descriptions: [
        {
          id: "d1",
          text: `Experience the finest ${userInput}. Visit us today and see the difference quality makes.`,
        },
        {
          id: "d2",
          text: `Looking for reliable ${userInput}? We've got you covered with expert service.`,
        },
      ],
    },
    null,
    2
  );

  return (
    `Great! I'll create some Google Ads headlines and descriptions for your business: "${userInput}". Here are my suggestions:\n\n` +
    "```json\n" +
    jsonContent +
    "\n```" +
    `\n\nFeel free to lock any headlines you want to keep, then ask for more variations!`
  );
}

const adsAgentNode = async (
  state: AdsState,
  config: LangGraphRunnableConfig
): Promise<Partial<AdsState>> => {
  const lastMessage = state.messages[state.messages.length - 1];
  const userInput = lastMessage?.content || "coffee shop";

  const model = new FakeListChatModel({
    responses: [buildLLMResponse(userInput)],
  });

  const { message, parsed } = await streamStructuredOutput(
    model,
    state.messages,
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
