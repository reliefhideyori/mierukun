"""
ローカル ASR エンジン（faster-whisper）

受信データ形式: Float32 PCM (16kHz, mono)
  ← AudioWorklet が 16kHz にダウンサンプルして送信
  → Python 標準ライブラリ wave モジュールで WAV 化
  → faster-whisper に渡す

旧方式（WebM チャンク）を廃止した理由:
  MediaRecorder の timeslice チャンクは先頭以外が
  WebM ヘッダーを持たない不完全データになるため、
  ffmpeg/PyAV が "Invalid data found when processing input" を返す。
"""
import asyncio
import io
import os
import tempfile
import wave

import numpy as np
from faster_whisper import WhisperModel

# Whisper が出力しやすい幻覚テキストを除外
_HALLUCINATIONS: frozenset[str] = frozenset({
    "ご視聴ありがとうございました",
    "字幕翻訳",
    "ご覧いただきありがとうございました",
    "ありがとうございました。",
    "[音楽]", "[拍手]", "[笑]", "[笑い]",
    "Thank you for watching",
    "Subtitles by",
    "翻訳",
    "。。。",
})

# AudioWorklet が送信する PCM のパラメータ
PCM_SAMPLE_RATE = 16000
PCM_CHANNELS    = 1
PCM_DTYPE       = np.float32


class WhisperASR:
    """faster-whisper をラップした非同期 ASR エンジン"""

    def __init__(self) -> None:
        model_size   = os.getenv("WHISPER_MODEL", "medium")
        device       = os.getenv("WHISPER_DEVICE", "cpu")
        compute_type = "int8" if device == "cpu" else "float16"

        print(f"\n[ASR] Whisper '{model_size}' モデルを読み込み中…")
        print(f"      ※初回起動時はモデルを自動ダウンロードします（medium: 約1.5GB）")

        self.model = WhisperModel(
            model_size,
            device=device,
            compute_type=compute_type,
        )
        print(f"[ASR] 準備完了（{model_size} / {device} / {compute_type}）\n")

    async def transcribe(self, pcm_bytes: bytes) -> str:
        """Float32 PCM バイト列 → 日本語テキスト（非同期）"""
        return await asyncio.to_thread(self._run, pcm_bytes)

    def _run(self, pcm_bytes: bytes) -> str:
        """同期実行（別スレッドで呼ばれる）"""

        # ── Float32 PCM → int16 WAV ──
        try:
            samples = np.frombuffer(pcm_bytes, dtype=PCM_DTYPE)
        except Exception as exc:
            raise ValueError(f"PCM データ変換エラー: {exc}")

        if samples.size == 0:
            return ""

        # [-1, 1] にクリップして int16 に変換
        samples_i16 = (np.clip(samples, -1.0, 1.0) * 32767).astype(np.int16)

        # WAV を一時ファイルに書き出す（stdlib wave モジュール使用、追加依存なし）
        wav_buf = io.BytesIO()
        with wave.open(wav_buf, "wb") as wf:
            wf.setnchannels(PCM_CHANNELS)
            wf.setsampwidth(2)           # 16-bit
            wf.setframerate(PCM_SAMPLE_RATE)
            wf.writeframes(samples_i16.tobytes())
        wav_bytes = wav_buf.getvalue()

        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
            tmp.write(wav_bytes)
            tmp_path = tmp.name

        try:
            segments, _ = self.model.transcribe(
                tmp_path,
                language="ja",
                beam_size=5,
                best_of=5,
                # ── 内蔵 Silero VAD で無音・雑音区間を自動除去 ──
                vad_filter=True,
                vad_parameters={
                    "min_silence_duration_ms": 400,
                    "speech_pad_ms": 300,
                    "threshold": 0.35,
                },
                # ── 会議音声であることをヒントとして与える ──
                initial_prompt=(
                    "これは日本語のビジネス会議の録音です。"
                    "複数の参加者が議論しています。"
                    "専門用語や固有名詞が含まれる場合があります。"
                ),
                # ── 繰り返し・ループ防止 ──
                no_speech_threshold=0.6,
                compression_ratio_threshold=2.4,
                condition_on_previous_text=True,
            )

            results: list[str] = []
            for seg in segments:
                text = seg.text.strip()
                if text and not self._is_hallucination(text):
                    results.append(text)

            return "".join(results)

        finally:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass

    def _is_hallucination(self, text: str) -> bool:
        if len(text) <= 1:
            return True
        return any(h in text for h in _HALLUCINATIONS)
