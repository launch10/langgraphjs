/* eslint-disable import/no-extraneous-dependencies, no-plusplus */
import {
  Annotation,
  LangGraphRunnableConfig,
  MessagesAnnotation,
  StateGraph,
  START,
  END,
} from "@langchain/langgraph";
import { ChatAnthropic } from "@langchain/anthropic";
import { AIMessage } from "@langchain/core/messages";
import { toStructuredMessage } from "@langchain/langgraph-api/utils";

export interface StructuredOutput {
  intro: string;
  bulletPoints: string[];
  conclusion: string;
}

export const SampleGraphAnnotation = Annotation.Root({
  ...MessagesAnnotation.spec,
  projectName: Annotation<string | undefined>({
    reducer: (_, next) => next,
    default: () => undefined,
  }),
});

export type SampleGraphState = typeof SampleGraphAnnotation.State;

const SYSTEM_PROMPT = `You are a helpful assistant that provides structured responses.

When answering questions, always include a JSON block with this structure:

\`\`\`json
{
  "intro": "A brief introduction",
  "bulletPoints": ["Point 1", "Point 2", "Point 3"],
  "conclusion": "A summary conclusion"
}
\`\`\`

If the user mentions creating a project, extract the project name and include it in your response.
Be concise but informative.`;

const model = new ChatAnthropic({
  model: "claude-sonnet-4-20250514",
  temperature: 0.7,
}).withConfig({ tags: ["notify"] });

async function sampleAgentNode(
  state: SampleGraphState,
  config: LangGraphRunnableConfig
): Promise<Partial<SampleGraphState>> {
  const response = await model.invoke(
    [{ role: "system", content: SYSTEM_PROMPT }, ...state.messages],
    config
  );

  const lastMessage = response as AIMessage;
  const [message, parsed] = await toStructuredMessage<
    StructuredOutput & { projectName?: string }
  >(lastMessage, "messages");

  const updates: Partial<SampleGraphState> = {
    messages: [message],
  };

  const content =
    typeof lastMessage.content === "string" ? lastMessage.content : "";
  const projectMatch = content.match(/project[:\s]+["']?([^"'\n,]+)["']?/i);
  if (projectMatch) {
    updates.projectName = projectMatch[1].trim();
  } else if (parsed?.projectName) {
    updates.projectName = parsed.projectName;
  }

  return updates;
}

export const sampleGraph = new StateGraph(SampleGraphAnnotation)
  .addNode("agent", sampleAgentNode)
  .addEdge(START, "agent")
  .addEdge("agent", END);
