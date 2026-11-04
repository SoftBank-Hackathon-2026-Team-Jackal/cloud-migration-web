"""Render the fixed Korean demo lines with the free local Supertonic 3 model.

Usage: python scripts/generate_voice.py /path/to/supertonic-3-assets
Requires the `supertonic` Python package and ffmpeg. The model is downloaded
separately and is not needed by the running web app.
"""

import json
import subprocess
import sys
import tempfile
from pathlib import Path

from supertonic import TTS


ROOT = Path(__file__).resolve().parents[1]
CLIPS = json.loads((ROOT / "src/lib/voiceClips.json").read_text())
OUT = ROOT / "public/voice"


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("Usage: python scripts/generate_voice.py MODEL_DIR")
    model_dir = Path(sys.argv[1]).expanduser().resolve()
    tts = TTS(model_dir=model_dir, auto_download=False)
    style = tts.get_voice_style("M1")
    OUT.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory() as scratch:
        for clip_id, line in CLIPS.items():
            wav, _ = tts.synthesize(line, voice_style=style, lang="ko", speed=1.0)
            source = Path(scratch) / f"{clip_id}.wav"
            tts.save_audio(wav, str(source))
            target = OUT / f"{clip_id}.mp3"
            subprocess.run(
                ["ffmpeg", "-y", "-loglevel", "error", "-i", str(source),
                 "-codec:a", "libmp3lame", "-q:a", "3", str(target)],
                check=True,
            )
            print(f"{clip_id}: {target.stat().st_size} bytes")


if __name__ == "__main__":
    main()
