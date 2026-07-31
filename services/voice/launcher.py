"""Start the speech pipeline with three upstream defects patched out.

One is about the voice, one about recognition, one about the socket the whole
thing is served on. All three are described below, and all three are installed
the same way - by wrapping something the library does rather than editing it,
so the fixes live in this repository and survive reinstalling speech_to_speech.

Cloning a voice needs two things that belong together: a reference clip, and
the exact words spoken in it. Switching character at runtime goes through the
OpenAI Realtime protocol, whose session object carries a single `voice` field -
it was designed for picking one of a few preset voices and has nowhere to put a
transcript. speech_to_speech honours that field by setting `ref_audio` and
leaving `ref_text` at whatever the launch flags said, so every character except
the one the service started with was cloned from one person's audio and another
person's words.

The pairing is not lost, only absent from the protocol: config/voices.json
holds both halves, so the transcript can be recovered from the clip path alone.
This wraps the handler's override to do exactly that.

The second is that Whisper runs twice on every utterance. The handler reads the
detected language out of a fixed position in the generated token ids; with this
version of transformers the forced decoder prompt is stripped before the ids
come back, so that position holds a word, not a language tag. The read never
matches a known language, and the handler responds by generating the whole
transcription again - doubling the wait between you finishing a sentence and
her starting to answer. See install_single_pass_stt().

The third is that the service is served on Windows' proactor event loop, which
cannot survive a failed accept: it closes the listening socket and the port is
gone while the process keeps running. See install_selector_event_loop().

Why wrappers instead of edits to the library: the patches then live in this
repository, where they are version-controlled. The cost is that they name
private details, so each asserts that what it relies on is still there rather
than risking a silent no-op.
"""

import asyncio
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
VOICES_PATH = os.path.join(ROOT, "config", "voices.json")
CHARACTERS_PATH = os.path.join(ROOT, "config", "characters.json")

REF_AUDIO_FLAG = "--qwen3_tts_ref_audio"
REF_TEXT_FLAG = "--qwen3_tts_ref_text"
PATCHED_METHOD = "_apply_session_voice_override"
STT_PATCHED_METHOD = "process"
STT_REQUIRED_ATTR = "prepare_model_inputs"


def _key(path):
    """Compare clip paths the way the filesystem does, not the way they are typed.

    The panel writes absolute paths with forward slashes, the launch flags use
    backslashes, and Windows ignores case. All three name the same file.
    """
    if not path:
        return ""
    return os.path.normcase(os.path.normpath(os.path.abspath(str(path))))


class Transcripts:
    """The clip -> transcript table, reloaded when voices.json changes.

    Re-read rather than cached for the life of the process: a voice recorded
    while the app is running should work on the next reply, not after a
    restart. The file is a few kilobytes and this runs once per voice switch.
    """

    def __init__(self, path):
        self.path = path
        self.stamp = None
        self.table = {}

    def _reload(self):
        try:
            stamp = os.path.getmtime(self.path)
        except OSError:
            self.table = {}
            self.stamp = None
            return
        if stamp == self.stamp:
            return
        table = {}
        try:
            with open(self.path, "r", encoding="utf-8") as handle:
                data = json.load(handle)
            for pack in (data.get("voices") or {}).values():
                clip = pack.get("file", "")
                text = pack.get("ref_text", "")
                if clip and text:
                    table[_key(clip)] = text
        except (OSError, ValueError, AttributeError) as exc:
            # Keep whatever was loaded last rather than dropping every
            # transcript because the file was caught mid-write.
            print("voice launcher: could not read %s: %s" % (self.path, exc), flush=True)
            return
        self.table = table
        self.stamp = stamp

    def get(self, clip_path):
        """The words spoken in that clip, or None if we do not know them."""
        self._reload()
        return self.table.get(_key(clip_path))


def default_character_clip():
    """The clip the default character is supposed to sound like.

    Everything the service says before the panel's first session update comes
    from the launch flags, and those named one fixed file. That file is the
    English sample the library shipped with, spoken by a man - so a reply in
    that window came out in a man's voice with no indication why. Whoever the
    app opens as is the right voice to start loaded with.
    """
    try:
        with open(CHARACTERS_PATH, "r", encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, ValueError):
        return None
    characters = data.get("characters") or {}
    character = characters.get(data.get("default")) or {}
    clip = character.get("voice")
    return clip if clip and os.path.exists(clip) else None


def align_launch_args(argv, transcripts):
    """Start on the default character's voice, with the transcript that matches it.

    Two corrections to the launch flags, both for the window before the panel
    has said anything: the clip should be whoever the app opens as, and the
    transcript has to be the one recorded against that clip. Editing the
    transcript in the voice library would otherwise leave services.json
    holding a stale copy of it.

    A clip the library has no transcript for leaves both flags alone: falling
    back to the configured pair is worse than a matching one, but better than
    starting with no text at all, which ICL mode rejects outright.
    """
    argv = list(argv)
    try:
        index = argv.index(REF_AUDIO_FLAG) + 1
        audio = argv[index]
    except (ValueError, IndexError):
        return argv

    preferred = default_character_clip()
    if preferred is not None and transcripts.get(preferred) is not None:
        audio = preferred
        argv[index] = preferred

    text = transcripts.get(audio)
    if text is None:
        return argv

    try:
        argv[argv.index(REF_TEXT_FLAG) + 1] = text
    except ValueError:
        argv += [REF_TEXT_FLAG, text]
    except IndexError:
        argv.append(text)
    return argv


def install(transcripts):
    """Make the handler's voice override carry the transcript as well."""
    from speech_to_speech.TTS.qwen3_tts_handler import Qwen3TTSHandler

    original = getattr(Qwen3TTSHandler, PATCHED_METHOD, None)
    if original is None:
        # Loud on purpose. Skipping the patch would start a service that works
        # in every visible way while cloning each voice from the wrong words,
        # which is a far worse outcome than not starting.
        raise SystemExit(
            "voice launcher: Qwen3TTSHandler.%s no longer exists. speech_to_speech has "
            "changed shape; update services/voice/launcher.py to match it. Refusing to "
            "start, because without this patch every character speaks with the wrong "
            "reference transcript." % PATCHED_METHOD
        )

    def apply_with_transcript(self, model_type, runtime_config=None, response=None):
        original(self, model_type, runtime_config, response)
        # Run after the original, never instead of it: it owns the decision,
        # including rejecting a voice it does not accept and clearing ref_audio
        # for the preset-speaker path. Whatever it settled on is what the
        # transcript has to match, so read the attribute back rather than
        # trying to work out what it did.
        clip = getattr(self, "ref_audio", None)
        text = transcripts.get(clip) if clip else None
        if text is not None and text != getattr(self, "ref_text", None):
            self.ref_text = text
            print("voice launcher: reference transcript now matches %s" % clip, flush=True)

    setattr(Qwen3TTSHandler, PATCHED_METHOD, apply_with_transcript)


def install_single_pass_stt():
    """Transcribe each utterance once instead of twice.

    The handler asks which language was spoken by decoding token 1 of the
    generated ids, expecting the "<|zh|>" tag Whisper used to emit there. This
    version of transformers removes the forced decoder prompt from the returned
    sequence, so token 1 is the second word of the transcription; the four-
    character slice of it is never a language code, the check fails, and the
    handler generates everything a second time. Measured on every single turn:
    the log line is "Whisper detected unsupported language: " with nothing after
    the colon. The rerun differs only in passing the language we already pinned,
    so it produces the same text - it is pure latency.

    We only take over when the language is pinned, which is when the answer is
    known without asking. With --language auto there is a real question here and
    the original keeps it, broken or not: guessing at a fix for a path this app
    never uses would be worse than leaving it alone.
    """
    from speech_to_speech.STT import whisper_stt_handler
    from speech_to_speech.pipeline.messages import Transcription

    handler = whisper_stt_handler.WhisperSTTHandler
    original = getattr(handler, STT_PATCHED_METHOD, None)
    if original is None or not hasattr(handler, STT_REQUIRED_ATTR):
        # Quieter than the transcript patch on purpose: this one costs speed,
        # not correctness, so a shape change should be reported and stepped
        # around rather than allowed to stop the app from starting.
        print(
            "voice launcher: WhisperSTTHandler no longer has %s/%s; leaving recognition "
            "as the library ships it. Expect every utterance to be transcribed twice."
            % (STT_PATCHED_METHOD, STT_REQUIRED_ATTR),
            flush=True,
        )
        return

    def transcribe_once(self, vad_audio):
        language = self.gen_kwargs.get("language")
        if not language:
            yield from original(self, vad_audio)
            return

        pred_ids = self.model.generate(self.prepare_model_inputs(vad_audio.audio), **self.gen_kwargs)
        text = self.processor.batch_decode(pred_ids, skip_special_tokens=True, decode_with_timestamps=False)[0]
        # The library prints the user's words here rather than logging them,
        # and that print is what shows up in var/logs/voice.log. Keep it.
        whisper_stt_handler.console.print("[yellow]USER: %s" % text)
        yield Transcription(
            text=text,
            language_code=language,
            turn_id=vad_audio.turn_id,
            turn_revision=vad_audio.turn_revision,
            speech_stopped_at_s=vad_audio.created_at_s,
        )

    setattr(handler, STT_PATCHED_METHOD, transcribe_once)


def install_selector_event_loop():
    """Serve on a selector event loop so a bad accept cannot take the port away.

    Windows defaults to asyncio's proactor loop. Its accept path, in
    proactor_events.py, closes the *listening* socket whenever a pending
    AcceptEx fails - and one fails whenever a client connects and drops before
    the completion is collected. WinError 64 in the log, and afterwards the
    process is still up, the models are still in VRAM, and nothing can reach
    the port: every probe times out and startup never finishes. The lip-sync
    service died this way on 2026-07-30, and this service showed the same
    signature earlier.

    Collecting the completion late is what makes it likely, so the danger is
    highest while the loop is busy - which is also when everything is probing
    it. The selector loop treats a dropped connection as nothing to do and
    leaves the listener open.

    Patched at Config.get_loop_factory rather than around Server.run: it is
    uvicorn's own seam for this decision, so the rest of the library's server
    setup - signal handlers, the stop-event watcher - is untouched. Nothing in
    the pipeline needs what the proactor loop exists for (asyncio subprocesses,
    pipes); checked, there are no uses.
    """
    from uvicorn import Config

    if not hasattr(Config, "get_loop_factory"):
        # Speed and resilience, not correctness, so say so and carry on. Losing
        # the port is rare and obvious; refusing to start would be neither.
        print(
            "voice launcher: uvicorn.Config.get_loop_factory is gone, so the server keeps "
            "Windows' proactor loop. If startup ever hangs at 'starting' with WinError 64 "
            "in the log, that is why.",
            flush=True,
        )
        return

    Config.get_loop_factory = lambda self: asyncio.SelectorEventLoop


def main():
    transcripts = Transcripts(VOICES_PATH)
    sys.argv = align_launch_args(sys.argv, transcripts)
    install(transcripts)
    install_single_pass_stt()
    install_selector_event_loop()

    from speech_to_speech import s2s_pipeline

    s2s_pipeline.main()


if __name__ == "__main__":
    main()
