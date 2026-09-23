import { FormEvent, useEffect, useRef } from "react";
import type { ChatMessage } from "../../types";
import "./ChatPanel.css";

interface Props {
  messages: ChatMessage[];
  busy: boolean;
  listening: boolean;
  interim: string;
  input: string;
  onInput: (v: string) => void;
  onSend: () => void;
  onMic: () => void;
  onStopSpeak: () => void;
  speaking: boolean;
  sttAvailable: boolean;
  companionName: string;
}

export function ChatPanel({
  messages,
  busy,
  listening,
  interim,
  input,
  onInput,
  onSend,
  onMic,
  onStopSpeak,
  speaking,
  sttAvailable,
  companionName,
}: Props) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, interim, busy]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    onSend();
  };

  return (
    <div className="chat">
      <div className="transcript" aria-live="polite">
        {messages.length === 0 && (
          <div className="empty">
            <p>
              Hi, I'm {companionName}. Talk with the mic or type below.
            </p>
            <p className="hint">Try “remember that I like late-night coding.”</p>
          </div>
        )}
        {messages.map((m) => (
          <div
            key={m.id}
            className={`bubble ${m.role} ${m.error ? "err" : ""} ${m.local ? "local" : ""}`}
          >
            <div className="meta">{m.role === "user" ? "You" : companionName}</div>
            <div className="body">{m.content || (m.pending ? "…" : "")}</div>
          </div>
        ))}
        {listening && interim && (
          <div className="bubble user interim">
            <div className="meta">You (listening)</div>
            <div className="body">{interim}</div>
          </div>
        )}
        <div ref={endRef} />
      </div>

      <form className="composer" onSubmit={submit}>
        <button
          type="button"
          className={`icon-btn mic ${listening ? "hot" : ""}`}
          onClick={onMic}
          disabled={!sttAvailable}
          title={sttAvailable ? (listening ? "Stop listening" : "Speak") : "Speech recognition unavailable"}
          aria-pressed={listening}
        >
          {listening ? "■" : "🎤"}
        </button>
        <input
          value={input}
          onChange={(e) => onInput(e.target.value)}
          placeholder={listening ? "Listening…" : `Message ${companionName}…`}
          disabled={busy}
          aria-label="Message"
        />
        {speaking ? (
          <button type="button" className="icon-btn stop" onClick={onStopSpeak} title="Stop speaking">
            ⏹
          </button>
        ) : (
          <button type="submit" className="icon-btn send" disabled={busy || !input.trim()} title="Send">
            ➤
          </button>
        )}
      </form>
    </div>
  );
}
