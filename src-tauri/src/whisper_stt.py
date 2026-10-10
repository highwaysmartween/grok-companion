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


WAKE_ALIASES = {"hey", "hay", "heyy", "hei", "heya", "hey,", "a", "ah", "and", "an", "okay", "ok", "hi"}
# How Whisper tends to hear "Nova" on a quiet laptop mic.
NAME_ALIASES = {"nova", "noah", "nover", "novah", "nava", "noba", "novo", "nora", "knova", "innova", "anova"}


def match_wake(words, name):
    """Remaining words if the utterance STARTS with the wake phrase, else None.
    Requiring it at the very start keeps movie/TV dialogue from waking her."""
    if not words:
        return None
    names = set(NAME_ALIASES)
    if name:
        names.add(name[0])
    w = words[:]
    if w[0] in ("anova", "annova"):  # "a nova" glued together
        return w[1:]
    if w[0] not in WAKE_ALIASES:
        return None
    w = w[1:]
    if w and w[0] in ("there", "hey"):
        w = w[1:]
    if not w or w[0] not in names:
        return None
    return w[1:]


def spectral_gate(audio, noise):
    """Light noise suppression: subtract the room's noise spectrum (from the
    pre-speech blocks) and gate bins that stay under it."""
    if noise is None or len(noise) < 1024 or len(audio) < 1024:
        return audio
    n, hop = 512, 256
    win = np.hanning(n).astype(np.float32)

    def stft(x):
        frames = 1 + (len(x) - n) // hop
        idx = np.arange(n)[None, :] + hop * np.arange(frames)[:, None]
        return np.fft.rfft(x[idx] * win, axis=1)

    noise_mag = np.abs(stft(noise)).mean(axis=0)
    spec = stft(audio)
    mag = np.abs(spec)
    gain = np.clip((mag - 1.5 * noise_mag) / (mag + 1e-9), 0.0, 1.0)
    gain = np.maximum(gain, 0.12)  # keep a little floor: no "underwater" artefacts
    frames = np.fft.irfft(spec * gain, n=n, axis=1) * win
    outp = np.zeros(hop * (len(frames) - 1) + n, dtype=np.float32)
    norm_w = np.zeros_like(outp)
    for i, f in enumerate(frames):
        outp[i * hop:i * hop + n] += f
        norm_w[i * hop:i * hop + n] += win * win
    outp /= np.maximum(norm_w, 1e-3)
    return outp[: len(audio)].astype(np.float32)


def agc(audio):
    """Automatic gain: bring speech to a steady level whatever the mic gain is
    (the internal Conexant mic has no hardware gain dial)."""
    loud = np.sort(np.abs(audio))[int(len(audio) * 0.995)] if len(audio) else 0.0
    if loud <= 1e-5:
        return audio
    g = min(0.5 / loud, 40.0)
    return np.clip(audio * g, -1.0, 1.0)
# Whisper's stock hallucinations on breath / noise.
JUNK = {"", "you", "thank you", "thanks for watching", "bye", "thank you for watching", "so", "uh", "um", "hmm"}


class Mic:
    def __init__(self):
        self.q = queue.Queue()
        self.stream = sd.InputStream(samplerate=RATE, channels=1, dtype="float32", blocksize=BLOCK,
                                     callback=lambda d, f, t, s: self.q.put(d[:, 0].copy()))
        self.stream.start()
        self.floor = 0.004
        self.noise = []  # recent quiet blocks (noise profile for the gate)
        self.last_noise = None

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
            # More sensitive than before: 2.5x the floor, absolute minimum lowered
            # for the quiet internal mic.
            thr = max(self.floor * 2.5, 0.0025)
            if not started:
                # Track the room's noise floor while nobody talks.
                self.floor = 0.97 * self.floor + 0.03 * min(rms, 0.05)
                if rms <= thr:
                    self.noise.append(b)
                    self.noise = self.noise[-40:]
                pre.append(b)
                pre = pre[-12:]  # keep ~360 ms before onset
                if rms > thr:
                    started = True
                    speech = pre[:]
                    silent = 0.0
                    self.last_noise = np.concatenate(self.noise) if len(self.noise) >= 8 else None
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


def transcribe(model, audio, noise=None):
    if os.environ.get("GC_STT_NO_DSP") != "1":
        audio = agc(spectral_gate(audio, noise))
    else:
        peak = float(np.max(np.abs(audio))) or 1.0
        audio = audio * min(0.9 / peak, 30.0)
    segs, _ = model.transcribe(audio, language="en", beam_size=1, vad_filter=False,
                               condition_on_previous_text=False,
                               initial_prompt="Hey Nova, it's Frank. Hey Nova, what's the time?")
    parts = [s.text for s in segs if s.no_speech_prob < 0.7 and s.avg_logprob > -1.2]
    return " ".join(p.strip() for p in parts).strip()


def wake_job(mic, model, secs, command_secs, name, cancelled):
    """Returns exit-style code: 0 = woke (TEXT printed), 1 = timeout/cancel."""
    deadline = time.time() + secs
    while time.time() < deadline and not cancelled():
        # VAD end-of-speech: 0.65 s of quiet closes "hey nova, <command>".
        seg = mic.utterance(deadline, end_silence=0.6, cancelled=cancelled)
        if seg is None:
            break
        t0 = time.time()
        text = transcribe(model, seg, mic.last_noise)
        words = norm(text)
        if os.environ.get("GC_STT_DEBUG"):
            print(f"heard: {text!r} ({(time.time()-t0)*1000:.0f} ms)", file=sys.stderr, flush=True)
        rest = match_wake(words, name)
        if rest is None:
            continue
        out("WAKE")
        if rest:
            out("TEXT:" + text)
            return 0
        seg = mic.utterance(time.time() + command_secs, initial_silence=6.0, end_silence=0.9, cancelled=cancelled)
        cmd = transcribe(model, seg, mic.last_noise) if seg is not None else ""
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


def bench(model_name, files):
    """Offline check: run 16 kHz mono WAVs through the same DSP + wake match."""
    import wave
    model = WhisperModel(model_name, device="cpu", compute_type="int8", cpu_threads=4)
    for f in files:
        with wave.open(f) as w:
            a = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768
        noise = a[:4800] if len(a) > 9600 else None  # first 0.3 s is room tone
        t0 = time.time()
        text = transcribe(model, a, noise)
        hit = match_wake(norm(text), ["nova"]) is not None
        out(f"{'HIT ' if hit else 'MISS'} {(time.time()-t0)*1000:5.0f}ms {os.path.basename(f)}: {text}")
    return 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("mode", choices=["wake", "listen", "serve", "bench"])
    ap.add_argument("files", nargs="*")
    ap.add_argument("--secs", type=float, default=12)
    ap.add_argument("--command-secs", type=float, default=10)
    ap.add_argument("--name", default="")
    ap.add_argument("--model", default=os.environ.get("GC_WHISPER_MODEL", "base.en"))
    a = ap.parse_args()
    if a.mode == "serve":
        return serve(a.model)
    if a.mode == "bench":
        return bench(a.model, a.files)
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
        rest = match_wake(words, name)
        if rest is None:
            continue
        out("WAKE")
        if rest:
            out("TEXT:" + text)
            return 0
        seg = mic.utterance(time.time() + a.command_secs, initial_silence=6.0, end_silence=1.1)
        cmd = transcribe(model, seg, mic.last_noise) if seg is not None else ""
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
