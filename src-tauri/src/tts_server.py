"""Warm edge-tts helper for Grok Companion (v1.2).

One JSON request per stdin line: {"id": "...", "text": "...", "voice": "...", "out": "path.mp3"}
Replies (stdout, one line each): OK <id>   |   ERR <id> <message>
Requests run concurrently, so the app can synthesise the next sentence while
the current one plays. Voice is passed through untouched (no rate / pitch).
"""
import asyncio, json, sys, threading

try:
    import edge_tts
except Exception as e:  # app falls back to the per-call edge-tts CLI
    print(f"edge_tts unavailable: {e}", file=sys.stderr, flush=True)
    sys.exit(3)


def say(line):
    sys.stdout.write(line + "\n")
    sys.stdout.flush()


async def synth(req):
    rid = req.get("id", "?")
    try:
        await edge_tts.Communicate(req["text"], req["voice"]).save(req["out"])
        say(f"OK {rid}")
    except Exception as e:
        say(f"ERR {rid} {str(e)[:200]}".replace("\n", " "))


def main():
    loop = asyncio.new_event_loop()

    def reader():
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                req = json.loads(line)
            except Exception:
                continue
            asyncio.run_coroutine_threadsafe(synth(req), loop)
        loop.call_soon_threadsafe(loop.stop)

    threading.Thread(target=reader, daemon=True).start()
    say("LOADED")
    loop.run_forever()


if __name__ == "__main__":
    main()
