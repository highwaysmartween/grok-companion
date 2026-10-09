"""Offline speech for Grok Companion: mic -> energy VAD -> faster-whisper.

Same stdout protocol as the System.Speech PowerShell scripts:
  wake mode:   READY, then WAKE, then TEXT:<what was said>   (exit 0)
               exit 1 = timed out with no wake word
  listen mode: READY, then TEXT:<what was said>               (exit 0)
Exit 2 = runtime error (stderr), exit 3 = engine unavailable (caller falls back).

serve mode (v1.2): ONE long-lived process keeps the mic stream and the model
warm. Jobs arrive on stdin, one per line:
  wake <secs> <command_secs> <name...>   |  listen <secs>   |  cancel
and each job prints ARMED, then WAKE / TEXT:... as above, then END <code>.
"""
import argparse, os, queue, re, sys, threading, time

try:
    import numpy as np
    import sounddevice as sd
    from faster_whisper import WhisperModel
except Exception as e:  # missing packages -> let the app use System.Speech
    print(f"whisper unavailable: {e}", file=sys.stderr)
    sys.exit(3)

RATE = 16000
BLOCK = 480  # 30 ms


def out(line):
    sys.stdout.write(line + "\n")
    sys.stdout.flush()


def norm(t):
    return re.sub(r"[^a-z' ]+", " ", t.lower()).split()


WAKE_ALIASES = {"hey", "hay", "heyy", "hei", "heya", "hey,"}
# Whisper's stock hallucinations on breath / noise.
JUNK = {"", "you", "thank you", "thanks for watching", "bye", "thank you for watching", "so", "uh", "um", "hmm"}


class Mic:
    def __init__(self):
        self.q = queue.Queue()
        self.stream = sd.InputStream(samplerate=RATE, channels=1, dtype="float32", blocksize=BLOCK,
                                     callback=lambda d, f, t, s: self.q.put(d[:, 0].copy()))
        self.stream.start()
        self.floor = 0.004

    def flush(self):
        """Drop audio captured while nobody was listening (e.g. her own voice)."""
        try:
            while True:
                self.q.get_nowait()
        except queue.Empty:
            pass

    def utterance(self, deadline, initial_silence=None, end_silence=0.7, max_len=14.0, cancelled=None):
        """Next speech segment (np array) or None at deadline / initial-silence timeout / cancel."""
        start_wait = time.time()
        pre, speech, silent, started = [], [], 0.0, False
        while time.time() < deadline:
            if cancelled is not None and cancelled():
                return None
            try:
                b = self.q.get(timeout=0.1)
            except queue.Empty:
                continue
            rms = float(np.sqrt(np.mean(b * b)) + 1e-9)
            thr = max(self.floor * 3.0, 0.006)
            if not started:
                # Track the room's noise floor while nobody talks.
                self.floor = 0.97 * self.floor + 0.03 * min(rms, 0.05)
                pre.append(b)
                pre = pre[-12:]  # keep ~360 ms before onset
                if rms > thr:
                    started = True
                    speech = pre[:]
                    silent = 0.0
                elif initial_silence and time.time() - start_wait > initial_silence:
                    return None
                continue
            speech.append(b)
            silent = silent + 0.03 if rms < thr * 0.8 else 0.0
            dur = len(speech) * 0.03
            if silent >= end_silence or dur >= max_len:
                if dur - silent < 0.25:  # a click, not speech
                    started, speech, pre = False, [], []
                    continue
                return np.concatenate(speech)
        return None


def transcribe(model, audio):
    peak = float(np.max(np.abs(audio))) or 1.0
    audio = audio * min(0.9 / peak, 30.0)  # normalise quiet laptop mics
    segs, _ = model.transcribe(audio, language="en", beam_size=1, vad_filter=False,
                               condition_on_previous_text=False, initial_prompt="Hey Nova.")
    parts = [s.text for s in segs if s.no_speech_prob < 0.7 and s.avg_logprob > -1.2]
    return " ".join(p.strip() for p in parts).strip()


def wake_job(mic, model, secs, command_secs, name, cancelled):
    """Returns exit-style code: 0 = woke (TEXT printed), 1 = timeout/cancel."""
    deadline = time.time() + secs
    while time.time() < deadline and not cancelled():
        # VAD end-of-speech: 0.65 s of quiet closes "hey nova, <command>".
        seg = mic.utterance(deadline, end_silence=0.65, cancelled=cancelled)
        if seg is None:
            break
        t0 = time.time()
        text = transcribe(model, seg)
        words = norm(text)
        if os.environ.get("GC_STT_DEBUG"):
            print(f"heard: {text!r} ({(time.time()-t0)*1000:.0f} ms)", file=sys.stderr, flush=True)
        if not words or words[0] not in WAKE_ALIASES:
            continue
        out("WAKE")
        rest = words[1:]
        if name and rest[: len(name)] == name:
            rest = rest[len(name):]
        if rest:
            out("TEXT:" + text)
            return 0
        seg = mic.utterance(time.time() + command_secs, initial_silence=6.0, end_silence=0.9, cancelled=cancelled)
        cmd = transcribe(model, seg) if seg is not None else ""
        out("TEXT:" + ("" if cmd.lower().strip(" .!?") in JUNK else cmd))
        return 0
    return 1


def serve(model_name):
    try:
        mic = Mic()
        model = WhisperModel(model_name, device="cpu", compute_type="int8", cpu_threads=4)
        # Warm-up so the first real transcription isn't slow.
        transcribe(model, np.zeros(RATE // 2, dtype="float32") + 1e-4)
    except Exception as e:
        print(f"whisper start failed: {e}", file=sys.stderr)
        return 3
    jobs = queue.Queue()
    cancel = threading.Event()

    def reader():
        for line in sys.stdin:
            line = line.strip()
            if line == "cancel":
                cancel.set()
            elif line:
                jobs.put(line)
        jobs.put("quit")
        cancel.set()

    threading.Thread(target=reader, daemon=True).start()
    out("LOADED")
    while True:
        job = jobs.get()
        if job == "quit":
            return 0
        cancel.clear()
        parts = job.split(" ")
        mic.flush()
        out("ARMED")
        out("READY")
        code = 1
        try:
            if parts[0] == "wake":
                secs = float(parts[1]); csecs = float(parts[2]); name = norm(" ".join(parts[3:]))
                code = wake_job(mic, model, secs, csecs, name, cancel.is_set)
            elif parts[0] == "listen":
                secs = float(parts[1])
                seg = mic.utterance(time.time() + secs, initial_silence=7.0, end_silence=0.9, cancelled=cancel.is_set)
                text = transcribe(model, seg) if seg is not None else ""
                out("TEXT:" + ("" if text.lower().strip(" .!?") in JUNK else text))
                code = 0
        except Exception as e:
            print(f"job error: {e}", file=sys.stderr, flush=True)
            code = 2
        out(f"END {code}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("mode", choices=["wake", "listen", "serve"])
    ap.add_argument("--secs", type=float, default=12)
    ap.add_argument("--command-secs", type=float, default=10)
    ap.add_argument("--name", default="")
    ap.add_argument("--model", default=os.environ.get("GC_WHISPER_MODEL", "base.en"))
    a = ap.parse_args()
    if a.mode == "serve":
        return serve(a.model)
    try:
        mic = Mic()  # start capturing first so nothing said during model load is lost
        model = WhisperModel(a.model, device="cpu", compute_type="int8", cpu_threads=4)
    except Exception as e:
        print(f"whisper start failed: {e}", file=sys.stderr)
        sys.exit(3)
    out("READY")
    name = norm(a.name)
    if a.mode == "listen":
        seg = mic.utterance(time.time() + a.secs, initial_silence=7.0, end_silence=1.1)
        text = transcribe(model, seg) if seg is not None else ""
        out("TEXT:" + ("" if text.lower().strip(" .!?") in JUNK else text))
        return 0
    deadline = time.time() + a.secs
    while time.time() < deadline:
        seg = mic.utterance(deadline)
        if seg is None:
            break
        text = transcribe(model, seg)
        words = norm(text)
        if os.environ.get("GC_STT_DEBUG"):
            print(f"heard: {text!r}", file=sys.stderr, flush=True)
        if not words or words[0] not in WAKE_ALIASES:
            continue
        out("WAKE")
        rest = words[1:]
        if name and rest[: len(name)] == name:
            rest = rest[len(name):]
        if rest:
            out("TEXT:" + text)
            return 0
        seg = mic.utterance(time.time() + a.command_secs, initial_silence=6.0, end_silence=1.1)
        cmd = transcribe(model, seg) if seg is not None else ""
        out("TEXT:" + ("" if cmd.lower().strip(" .!?") in JUNK else cmd))
        return 0
    return 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(1)
    except Exception as e:
        print(str(e), file=sys.stderr)
        sys.exit(2)
