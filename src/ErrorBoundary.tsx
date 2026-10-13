import { Component, type ErrorInfo, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";

/** Append a line to latency.log so silent crashes leave a trace on his PC. */
export function logCrash(where: string, err: unknown): void {
  const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  const line = `${new Date().toISOString()} ERR ${where}: ${msg.slice(0, 400)}`;
  console.error("[crash]", line);
  void invoke("log_latency", { line }).catch(() => undefined);
}

interface Props {
  where: string;
  children: ReactNode;
  /** Rendered while broken (default: nothing). */
  fallback?: ReactNode;
  /** Try rendering the children again after this long (ms). 0 = never. */
  retryMs?: number;
  onError?: (err: unknown) => void;
}

/**
 * A render error used to unmount the whole React tree, leaving a transparent
 * window with nothing in it (she "vanished"). This catches it, logs it, and
 * remounts the children after a pause.
 */
export class ErrorBoundary extends Component<Props, { broken: boolean; gen: number }> {
  state = { broken: false, gen: 0 };
  private timer = 0;
  private recent: number[] = [];

  static getDerivedStateFromError() {
    return { broken: true };
  }

  componentDidCatch(err: unknown, info: ErrorInfo) {
    logCrash(this.props.where, err);
    if (info.componentStack) console.error(info.componentStack);
    this.props.onError?.(err);
    const now = Date.now();
    this.recent = this.recent.filter((t) => now - t < 60_000).concat(now);
    const retry = this.props.retryMs ?? 1500;
    // Give up auto-retrying if it keeps failing (avoid a crash loop).
    if (retry > 0 && this.recent.length <= 5) {
      window.clearTimeout(this.timer);
      this.timer = window.setTimeout(() => this.setState((s) => ({ broken: false, gen: s.gen + 1 })), retry);
    }
  }

  componentWillUnmount() {
    window.clearTimeout(this.timer);
  }

  render() {
    if (this.state.broken) return this.props.fallback ?? null;
    return <Component_ key={this.state.gen}>{this.props.children}</Component_>;
  }
}

/** Keyed wrapper so a retry fully remounts the subtree. */
function Component_({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
