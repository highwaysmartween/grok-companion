import type { ConnectionKind, PetMood } from "../../types";
import "./StatusBar.css";

interface Props {
  connection: ConnectionKind;
  connectionMessage: string;
  mood: PetMood;
  listening: boolean;
  speaking: boolean;
  busy: boolean;
  wakeArmed?: boolean;
  interim?: string;
}

function connectionLabel(kind: ConnectionKind) {
  switch (kind) {
    case "online":
      return "xAI online";
    case "nokey":
      return "No API key";
    case "offline":
      return "Offline";
    case "error":
      return "xAI error";
    default:
      return "Checking…";
  }
}

export function StatusBar({
  connection,
  connectionMessage,
  mood,
  listening,
  speaking,
  busy,
  wakeArmed,
  interim,
}: Props) {
  const activity = listening
    ? interim || "Listening"
    : wakeArmed
      ? interim || "Say hey…"
      : busy
        ? "Thinking"
        : speaking
          ? "Speaking"
          : mood === "happy"
            ? "Happy"
            : "Idle";

  return (
    <div className="status-bar" title={connectionMessage}>
      <span className={`pill conn ${connection}`}>
        <i />
        {connectionLabel(connection)}
      </span>
      <span
        className={`pill act ${
          listening ? "listen" : wakeArmed ? "wake" : busy ? "think" : speaking ? "speak" : "idle"
        }`}
      >
        {activity}
      </span>
    </div>
  );
}
