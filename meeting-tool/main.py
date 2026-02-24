"""
会議支援ツール - FastAPI + WebSocket バックエンド v2

変更点:
 - ASR を Web Speech API → faster-whisper（ローカル）に変更
 - WebSocket でバイナリ音声を受信し、サーバー側で文字起こし
 - モデルロードを非同期バックグラウンドで実行
"""
import asyncio
import json
import os
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from dotenv import load_dotenv

from asr_engine import WhisperASR
from summarizer import Summarizer

load_dotenv()

# ==================== ASR グローバル状態 ====================
_asr: WhisperASR | None = None
_asr_ready = asyncio.Event()


async def _load_asr_model() -> None:
    """起動時にバックグラウンドでモデルをロード"""
    global _asr
    try:
        _asr = await asyncio.to_thread(WhisperASR)
        _asr_ready.set()
    except Exception as exc:
        print(f"\n[ERROR] ASR モデルのロードに失敗しました: {exc}")
        print("  → requirements.txt の依存関係が正しくインストールされているか確認してください。\n")


@asynccontextmanager
async def lifespan(app: FastAPI):
    asyncio.create_task(_load_asr_model())
    yield


# ==================== FastAPI アプリ ====================
app = FastAPI(title="会議支援ツール", lifespan=lifespan)
app.mount("/static", StaticFiles(directory="static"), name="static")


@app.get("/")
async def index():
    return FileResponse("static/index.html")


# ==================== 設定値 ====================
COOLDOWN_MS = int(os.getenv("COOLDOWN_MS", "1500"))
MIN_CHARS   = int(os.getenv("MIN_CHARS_FOR_UPDATE", "25"))


# ==================== セッション管理 ====================
class MeetingSession:
    def __init__(self):
        self.t_new_buffer: str  = ""
        self.s_prev:       str  = ""
        self.last_trigger: float = 0.0
        self.update_id:    int  = 0
        self.summarizer         = Summarizer()

    def _can_trigger(self) -> tuple[bool, str]:
        now_ms  = time.time() * 1000
        elapsed = now_ms - self.last_trigger
        if elapsed < COOLDOWN_MS:
            return False, "cooldown"
        if len(self.t_new_buffer.strip()) < MIN_CHARS:
            return False, "not_enough_content"
        return True, "ok"

    async def generate_summary(self, trigger_type: str) -> dict:
        can, reason = self._can_trigger()
        if not can:
            return {"type": "trigger_ignored", "reason": reason, "trigger": trigger_type}

        self.last_trigger = time.time() * 1000
        t_new = self.t_new_buffer
        self.t_new_buffer = ""

        try:
            s_next = await self.summarizer.summarize(self.s_prev, t_new)
            self.s_prev   = s_next
            self.update_id += 1
            return {
                "type":      "summary_update",
                "summary":   s_next,
                "update_id": self.update_id,
                "trigger":   trigger_type,
            }
        except Exception as exc:
            self.t_new_buffer = t_new + self.t_new_buffer  # バッファ復元
            return {"type": "error", "message": f"要約の生成に失敗しました: {exc}"}


# ==================== WebSocket エンドポイント ====================
@app.websocket("/ws")
async def ws_endpoint(websocket: WebSocket):
    await websocket.accept()
    session = MeetingSession()

    async def send(obj: dict) -> None:
        await websocket.send_text(json.dumps(obj, ensure_ascii=False))

    # ── ASR モデルの準備状態をクライアントに通知 ──
    if not _asr_ready.is_set():
        await send({"type": "asr_loading"})
        await _asr_ready.wait()
    await send({"type": "asr_ready"})

    try:
        while True:
            raw = await websocket.receive()

            # ── バイナリ: 音声チャンク（WebM/Opus）──
            if raw.get("bytes"):
                audio_bytes = raw["bytes"]
                if len(audio_bytes) < 500:
                    continue  # 短すぎるチャンクは無視

                await send({"type": "transcribing"})
                try:
                    text = await _asr.transcribe(audio_bytes)
                except Exception as exc:
                    await send({"type": "error", "message": f"文字起こしエラー: {exc}"})
                    continue

                if text.strip():
                    session.t_new_buffer += text + " "
                    await send({
                        "type":        "transcript",
                        "text":        text,
                        "is_final":    True,
                        "buffer_size": len(session.t_new_buffer),
                    })
                else:
                    await send({"type": "transcribing_done"})

            # ── テキスト: JSON 制御メッセージ ──
            elif raw.get("text"):
                msg      = json.loads(raw["text"])
                msg_type = msg.get("type", "")

                if msg_type in ("silence_trigger", "manual_trigger"):
                    await send({"type": "summarizing"})
                    result = await session.generate_summary(msg_type)
                    await send(result)

                elif msg_type == "reset":
                    session.t_new_buffer = ""
                    session.s_prev       = ""
                    session.update_id    = 0
                    await send({"type": "reset_ack"})

    except WebSocketDisconnect:
        pass
    except Exception as exc:
        try:
            await websocket.send_text(
                json.dumps({"type": "error", "message": str(exc)}, ensure_ascii=False)
            )
        except Exception:
            pass


# ==================== 起動エントリポイント ====================
if __name__ == "__main__":
    import uvicorn

    if not os.getenv("GEMINI_API_KEY"):
        print("\n[ERROR] GEMINI_API_KEY が設定されていません。")
        print("  .env ファイルに GEMINI_API_KEY=your_key を設定してください。\n")
        exit(1)

    print("\n会議支援ツールを起動します…")
    print("ブラウザで http://localhost:8000 を開いてください")
    print("※初回起動時はWhisperモデルのダウンロードがあります（medium: 約1.5GB）\n")
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=False)
