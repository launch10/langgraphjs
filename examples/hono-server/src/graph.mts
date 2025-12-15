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
import { adsBridge, type Headline, type Description } from "./transforms.js";

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

export type AdsGraphState = typeof AdsAnnotation.State;

const SYSTEM_PROMPT = `You are an expert Google Ads copywriter. When given a business description, generate compelling ad copy.

Always respond with some friendly text explaining what you're creating, then include a JSON block with this exact structure:

\`\`\`json
{
  "headlines": [
    "Headline 1 text",
    "Headline 2 text",
    "Headline 3 text"
  ],
  "descriptions": [
    "Description 1 text",
    "Description 2 text"
  ]
}
\`\`\`

Headlines should be max 30 characters. Descriptions should be max 90 characters.`;

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
  state: AdsGraphState,
  config: LangGraphRunnableConfig
): Promise<Partial<AdsGraphState>> {
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

  const [message, parsed] = await adsBridge.toStructuredMessage(lastMessage);

  const allMessages = result.messages.slice(0, -1).concat([message]);

  return {
    headlines: parsed?.headlines,
    descriptions: parsed?.descriptions,
    messages: allMessages,
  };
}

export const adsGraph = new StateGraph(AdsAnnotation)
  .addNode("adsAgent", adsAgentNode)
  .addEdge(START, "adsAgent")
  .addEdge("adsAgent", END);

export { adsBridge };
