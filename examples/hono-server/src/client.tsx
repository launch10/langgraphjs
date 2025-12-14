import { StrictMode, useState, useCallback, useRef, useEffect } from "react";
import { createRoot } from "react-dom/client";
import {
  useStreamUI,
  MergeStrategies,
  type MessageWithBlocks,
  type MessageBlock,
} from "@langchain/langgraph-sdk/react";

interface Headline {
  id: string;
  text: string;
  locked: boolean;
  rejected: boolean;
}

interface Description {
  id: string;
  text: string;
}

type AdsState = {
  messages: { role: string; content: string }[];
  headlines: Headline[];
  descriptions: Description[];
} & Record<string, unknown>;

function HeadlinesPanel({
  headlines,
  onToggleLock,
  isLoading,
}: {
  headlines: Headline[];
  onToggleLock: (id: string) => void;
  isLoading: boolean;
}) {
  const visibleHeadlines = headlines.filter((h) => !h.rejected);

  return (
    <div style={{ marginBottom: 16 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginBottom: 8,
        }}
      >
        <span style={{ fontSize: 12, color: "#9ca3af" }}>
          Headlines ({visibleHeadlines.length}):
        </span>
        {isLoading && (
          <span style={{ fontSize: 11, color: "#facc15" }}>streaming...</span>
        )}
      </div>
      <p style={{ fontSize: 11, color: "#6b7280", marginBottom: 8 }}>
        Click lock to keep headlines when generating more
      </p>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {visibleHeadlines.map((h) => (
          <div
            key={h.id}
            style={{ display: "flex", alignItems: "center", gap: 8 }}
          >
            <button
              onClick={() => onToggleLock(h.id)}
              style={{
                background: "none",
                border: "none",
                cursor: "pointer",
                fontSize: 16,
                opacity: h.locked ? 1 : 0.4,
              }}
              title={h.locked ? "Unlock headline" : "Lock headline"}
            >
              {h.locked ? "🔒" : "🔓"}
            </button>
            <span
              style={{
                color: h.locked ? "#4ade80" : "#22c55e",
                fontWeight: h.locked ? 600 : 400,
              }}
            >
              {h.text}
            </span>
          </div>
        ))}
        {visibleHeadlines.length === 0 && (
          <div style={{ fontSize: 12, color: "#6b7280", fontStyle: "italic" }}>
            No headlines yet
          </div>
        )}
      </div>
    </div>
  );
}

function DescriptionsPanel({
  descriptions,
  isLoading,
}: {
  descriptions: Description[];
  isLoading: boolean;
}) {
  return (
    <div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginBottom: 8,
        }}
      >
        <span style={{ fontSize: 12, color: "#9ca3af" }}>
          Descriptions ({descriptions.length}):
        </span>
        {isLoading && (
          <span style={{ fontSize: 11, color: "#facc15" }}>streaming...</span>
        )}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {descriptions.map((d) => (
          <div key={d.id} style={{ color: "#60a5fa", fontSize: 14 }}>
            {d.text}
          </div>
        ))}
        {descriptions.length === 0 && (
          <div style={{ fontSize: 12, color: "#6b7280", fontStyle: "italic" }}>
            No descriptions yet
          </div>
        )}
      </div>
    </div>
  );
}

function BlockRenderer({ block }: { block: MessageBlock }) {
  switch (block.type) {
    case "text":
      if (!block.text.trim()) return null;
      return <div style={{ whiteSpace: "pre-wrap" }}>{block.text}</div>;

    case "structured": {
      const data = block.data as {
        headlines?: { id: string; text: string; status: string }[];
        descriptions?: { id: string; text: string }[];
      };
      if (!data || Object.keys(data).length === 0) return null;

      return (
        <div
          style={{
            background: "#374151",
            borderRadius: 4,
            padding: 8,
            marginTop: 8,
          }}
        >
          <div style={{ fontSize: 11, color: "#9ca3af", marginBottom: 4 }}>
            Generated Content:
          </div>
          {data.headlines && (
            <div style={{ marginBottom: 8 }}>
              <div style={{ fontSize: 10, color: "#6b7280" }}>Headlines:</div>
              {data.headlines.map((h) => (
                <div key={h.id} style={{ color: "#22c55e", fontSize: 13 }}>
                  • {h.text}
                </div>
              ))}
            </div>
          )}
          {data.descriptions && (
            <div>
              <div style={{ fontSize: 10, color: "#6b7280" }}>
                Descriptions:
              </div>
              {data.descriptions.map((d) => (
                <div key={d.id} style={{ color: "#60a5fa", fontSize: 13 }}>
                  • {d.text}
                </div>
              ))}
            </div>
          )}
        </div>
      );
    }

    case "reasoning":
      return (
        <div
          style={{
            background: "#1e3a5f",
            borderRadius: 4,
            padding: 8,
            fontSize: 12,
            fontStyle: "italic",
            color: "#93c5fd",
          }}
        >
          💭 {block.text}
        </div>
      );

    case "tool_call":
      return (
        <div
          style={{
            background: "#374151",
            borderRadius: 4,
            padding: 8,
            fontSize: 12,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: "50%",
                background:
                  block.state === "complete"
                    ? "#22c55e"
                    : block.state === "error"
                    ? "#ef4444"
                    : "#facc15",
              }}
            />
            <span>🔧 {block.toolName}</span>
            <span style={{ color: "#6b7280" }}>({block.state})</span>
          </div>
          {block.output != null && (
            <pre style={{ marginTop: 8, color: "#22c55e", fontSize: 11 }}>
              {JSON.stringify(block.output as object, null, 2)}
            </pre>
          )}
        </div>
      );

    default:
      return null;
  }
}

function Message({
  message,
  isLoading,
}: {
  message: MessageWithBlocks;
  isLoading: boolean;
}) {
  const hasNoBlocks = message.blocks.length === 0;
  const showLoading = isLoading && hasNoBlocks && message.role === "assistant";

  return (
    <div
      style={{
        display: "flex",
        justifyContent: message.role === "user" ? "flex-end" : "flex-start",
        marginBottom: 16,
      }}
    >
      <div
        style={{
          maxWidth: "80%",
          borderRadius: 8,
          padding: 12,
          background: message.role === "user" ? "#1e40af" : "#4b5563",
          color: "white",
        }}
      >
        {showLoading ? (
          <div style={{ display: "flex", gap: 4 }}>
            <span style={{ animation: "bounce 1s infinite" }}>•</span>
            <span style={{ animation: "bounce 1s infinite 0.15s" }}>•</span>
            <span style={{ animation: "bounce 1s infinite 0.3s" }}>•</span>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {message.blocks.map((block) => (
              <BlockRenderer key={block.id} block={block} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function App() {
  const [input, setInput] = useState("premium organic coffee beans");
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const { state, uiMessages, submit, isLoading, error } =
    useStreamUI<AdsState>({
      apiUrl: "http://localhost:8080/api",
      assistantId: "ads",
      merge: {
        headlines: MergeStrategies.appendUnique<Headline, "id">("id"),
        descriptions: MergeStrategies.replace<Description[]>(),
      } as Record<string, (incoming: unknown, current: unknown) => unknown>,
      onStateUpdate: (key, value) => {
        console.log(`State update: ${String(key)}`, value);
      },
      onStructuredBlock: (block) => {
        console.log("Structured block:", block);
      },
    });

  const headlines = (state.headlines as Headline[]) ?? [];
  const descriptions = (state.descriptions as Description[]) ?? [];

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      if (!input.trim()) return;

      submit({
        messages: [{ role: "user", content: input }],
      });
      setInput("");
    },
    [input, submit]
  );

  const handleToggleLock = useCallback((id: string) => {
    console.log("Toggle lock for:", id);
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [uiMessages]);

  return (
    <div
      style={{
        maxWidth: 700,
        margin: "0 auto",
        padding: 20,
        fontFamily: "system-ui, sans-serif",
      }}
    >
      <h1 style={{ marginBottom: 8 }}>LangGraph AI SDK Demo</h1>
      <p style={{ color: "#9ca3af", marginBottom: 20, fontSize: 14 }}>
        Streaming text + JSON blocks with useStreamUI and MessageWithBlocks
      </p>

      <div style={{ marginBottom: 10, fontSize: 12, color: "#9ca3af" }}>
        Status: {isLoading ? "streaming..." : "ready"}
        {error ? (
          <span style={{ color: "#ef4444" }}> Error: {String(error)}</span>
        ) : null}
      </div>

      <div
        style={{
          marginBottom: 16,
          padding: 16,
          background: "#1f2937",
          borderRadius: 8,
          border: "1px solid #374151",
        }}
      >
        <div
          style={{
            fontSize: 14,
            fontWeight: 600,
            color: "#d1d5db",
            marginBottom: 12,
          }}
        >
          Streaming State Demo
        </div>
        <p style={{ fontSize: 11, color: "#6b7280", marginBottom: 16 }}>
          State updates stream in real-time as the LLM generates structured
          output.
        </p>
        <HeadlinesPanel
          headlines={headlines}
          onToggleLock={handleToggleLock}
          isLoading={isLoading}
        />
        <DescriptionsPanel descriptions={descriptions} isLoading={isLoading} />
      </div>

      <div
        style={{
          border: "1px solid #374151",
          borderRadius: 8,
          padding: 16,
          minHeight: 300,
          maxHeight: 400,
          overflowY: "auto",
          marginBottom: 16,
          background: "#111827",
        }}
      >
        {uiMessages.length === 0 && (
          <div style={{ color: "#6b7280" }}>No messages yet. Send one!</div>
        )}
        {uiMessages.map((msg) => (
          <Message key={msg.id} message={msg} isLoading={isLoading} />
        ))}
        <div ref={messagesEndRef} />
      </div>

      <form onSubmit={handleSubmit} style={{ display: "flex", gap: 8 }}>
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Describe your business..."
          disabled={isLoading}
          style={{
            flex: 1,
            padding: 12,
            borderRadius: 8,
            border: "1px solid #374151",
            background: "#1f2937",
            color: "white",
          }}
        />
        <button
          type="submit"
          disabled={isLoading || !input.trim()}
          style={{
            padding: "12px 24px",
            borderRadius: 8,
            border: "none",
            background: isLoading ? "#4b5563" : "#2563eb",
            color: "white",
            cursor: isLoading ? "not-allowed" : "pointer",
            fontWeight: 600,
          }}
        >
          {isLoading ? "..." : "Send"}
        </button>
      </form>

      <style>{`
        @keyframes bounce {
          0%, 80%, 100% { transform: translateY(0); }
          40% { transform: translateY(-4px); }
        }
      `}</style>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
