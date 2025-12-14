/* eslint-disable import/no-extraneous-dependencies, no-plusplus */
import {
  Annotation,
  LangGraphRunnableConfig,
  MessagesAnnotation,
  StateGraph,
  START,
  END,
} from "@langchain/langgraph";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { ChatAnthropic } from "@langchain/anthropic";
import { tool } from "@langchain/core/tools";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import { z } from "zod";
import { toStructuredMessage } from "@langchain/langgraph-api/utils";

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
  ...MessagesAnnotation.spec,
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

interface ParsedAdsOutput {
  headlines?: Array<{
    id: string;
    text: string;
    status?: string;
  }>;
  descriptions?: Array<{
    id: string;
    text: string;
  }>;
}

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

const adsFaqTool = tool(
  async ({ query }) => {
    return `FAQ for "${query}": Our premium organic coffee beans are sourced from sustainable farms. We offer free shipping on orders over $50.`;
  },
  {
    name: "ads_faq",
    description: "Look up frequently asked questions about ads and products",
    schema: z.object({
      query: z.string().describe("The FAQ query to look up"),
    }),
  }
);

function getLastAIMessage(messages: BaseMessage[]): AIMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]._getType() === "ai") {
      return messages[i] as AIMessage;
    }
  }
  return undefined;
}

const model = new ChatAnthropic({
  model: "claude-sonnet-4-20250514",
  temperature: 0.7,
}).withConfig({ tags: ["notify"] });

async function adsAgentNode(
  state: AdsState,
  config: LangGraphRunnableConfig
): Promise<Partial<AdsState>> {
  const agent = createReactAgent({
    llm: model,
    tools: [adsFaqTool],
    prompt: SYSTEM_PROMPT,
  });

  const result = await agent.invoke({ messages: state.messages }, config);

  const lastMessage = getLastAIMessage(result.messages);
  if (!lastMessage) {
    throw new Error("Agent did not return an AI message");
  }

  const [message, parsed] =
    await toStructuredMessage<ParsedAdsOutput>(lastMessage, "state");

  const updates: Partial<AdsState> = {};

  if (parsed?.headlines) {
    updates.headlines = parsed.headlines.map((h) => ({
      id: h.id,
      text: h.text,
      locked: false,
      rejected: h.status === "rejected",
    }));
  }

  if (parsed?.descriptions) {
    updates.descriptions = parsed.descriptions.map((d) => ({
      id: d.id,
      text: d.text,
    }));
  }

  const allMessages = result.messages.slice(0, -1).concat([message]);

  return {
    ...updates,
    messages: allMessages,
  };
}

export const adsGraph = new StateGraph(AdsAnnotation)
  .addNode("adsAgent", adsAgentNode)
  .addEdge(START, "adsAgent")
  .addEdge("adsAgent", END);
