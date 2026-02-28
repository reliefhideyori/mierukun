"""
ASR エンジン（Gemini API）

受信データ形式: Float32 PCM (16kHz, mono)
  ← AudioWorklet が 16kHz にダウンサンプルして送信
  → WAV に変換して Gemini API で文字起こし
"""
import asyncio
import base64
import io
import os
import wave

import numpy as np
import google.generativeai as genai

PCM_SAMPLE_RATE = 16000
PCM_CHANNELS    = 1
PCM_DTYPE       = np.float32


class WhisperASR:
    """Gemini API を使った ASR エンジン"""

    def __init__(self) -> None:
        api_key = os.getenv("GEMINI_API_KEY", "")
        if not api_key:
            raise RuntimeError("GEMINI_API_KEY が設定されていません。")
        genai.configure(api_key=api_key)

        model_name = os.getenv("GEMINI_MODEL", "gemini-2.0-flash")
        self.model = genai.GenerativeModel(model_name)
        print(f"[ASR] Gemini '{model_name}' で文字起こしします\n")

    async def transcribe(self, pcm_bytes: bytes) -> str:
        """Float32 PCM バイト列 → 日本語テキスト（非同期）"""
        return await asyncio.to_thread(self._run, pcm_bytes)

    def _run(self, pcm_bytes: bytes) -> str:
        """同期実行（別スレッドで呼ばれる）"""
        samples = np.frombuffer(pcm_bytes, dtype=PCM_DTYPE)
        if samples.size == 0:
            return ""

        # Float32 [-1, 1] → int16 WAV
        samples_i16 = (np.clip(samples, -1.0, 1.0) * 32767).astype(np.int16)
        wav_buf = io.BytesIO()
        with wave.open(wav_buf, "wb") as wf:
            wf.setnchannels(PCM_CHANNELS)
            wf.setsampwidth(2)
            wf.setframerate(PCM_SAMPLE_RATE)
            wf.writeframes(samples_i16.tobytes())
        wav_bytes = wav_buf.getvalue()

        response = self.model.generate_content([
            {
                "inline_data": {
                    "mime_type": "audio/wav",
                    "data": base64.b64encode(wav_bytes).decode("utf-8"),
                }
            },
            (
                "この音声を日本語テキストに書き起こしてください。"
                "会議の録音です。発言内容のみを出力してください。"
                "音声がない・聞き取れない場合は空文字を返してください。"
            ),
        ])
        return response.text.strip() if response.text else ""
