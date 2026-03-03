"""
ZONIST – 音声文字起こし + アイデアマップ統合ツール
"""
import asyncio
import json
import os
import re
import tempfile
from pathlib import Path

from fastapi import FastAPI, File, HTTPException, Request, UploadFile, Depends
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.sessions import SessionMiddleware
from dotenv import load_dotenv
from google import genai
from sqlalchemy.orm import Session

load_dotenv()

# ===================== Gemini 設定 =====================
_api_key    = os.getenv("GEMINI_API_KEY", "")
_model_name = os.getenv("GEMINI_MODEL", "gemini-2.5-flash")

if _api_key:
    _client = genai.Client(api_key=_api_key)
    print(f"[Gemini] モデル: {_model_name}")
else:
    _client = None
    print("\n[WARNING] GEMINI_API_KEY が未設定です。.env ファイルを確認してください。\n")

# ===================== DB 初期化 =====================
from database import engine, get_db
from models import Base, User, RecordingSession
Base.metadata.create_all(bind=engine)

# ===================== FastAPI =====================
app = FastAPI(title="ZONIST")

# セッションミドルウェア（OAuth state 管理に必要）
app.add_middleware(
    SessionMiddleware,
    secret_key=os.getenv("JWT_SECRET", "change_me_in_production_32chars!!"),
)

app.mount("/static", StaticFiles(directory="static"), name="static")

# ===================== 認証 / Stripe ルーター =====================
from auth import router as auth_router, get_current_user
from stripe_routes import router as stripe_router

app.include_router(auth_router)
app.include_router(stripe_router)

# ===================== ページルート =====================
@app.get("/")
async def lp():
    return FileResponse("static/lp.html")


@app.get("/login")
async def login_page():
    return FileResponse("static/login.html")


@app.get("/app")
async def app_page():
    return FileResponse("static/index.html")


# ===================== セッション管理 =====================
FREE_SESSION_LIMIT = 3


@app.post("/session/start")
async def session_start(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """録音開始前に呼ぶ。無料上限チェック + セッションカウント"""
    if current_user.plan == "free" and current_user.sessions_used >= FREE_SESSION_LIMIT:
        raise HTTPException(
            status_code=402,
            detail="無料セッションを使い切りました",
        )
    current_user.sessions_used += 1
    new_session = RecordingSession(user_id=current_user.id)
    db.add(new_session)
    db.commit()
    db.refresh(current_user)

    remaining = (
        max(0, FREE_SESSION_LIMIT - current_user.sessions_used)
        if current_user.plan == "free"
        else None
    )
    return {
        "sessions_used":      current_user.sessions_used,
        "sessions_remaining": remaining,
    }


# ===================== JSON パーサー（堅牢版） =====================
def _parse_ideas_json(text: str) -> list:
    text = re.sub(r'```json\s*', '', text, flags=re.IGNORECASE)
    text = re.sub(r'```\s*', '', text)
    start = text.find('[')
    if start == -1:
        return []
    depth, in_str, esc = 0, False, False
    for i in range(start, len(text)):
        ch = text[i]
        if esc:            esc = False; continue
        if ch == '\\' and in_str: esc = True; continue
        if ch == '"':         in_str = not in_str; continue
        if in_str:            continue
        if ch in '[{':        depth += 1
        elif ch in ']}':
            depth -= 1
            if depth == 0:
                raw = text[start:i + 1]
                for attempt in [
                    raw,
                    re.sub(r',(\s*[}\]])', r'\1',
                           re.sub(r'[\x00-\x08\x0b\x0c\x0e-\x1f]', ' ', raw))
                ]:
                    try:
                        return json.loads(attempt)
                    except Exception:
                        pass
    return []


# ===================== 音声文字起こし =====================
@app.post("/transcribe")
async def transcribe(
    audio: UploadFile = File(...),
    current_user: User = Depends(get_current_user),
):
    if not _api_key or _client is None:
        raise HTTPException(status_code=500, detail="GEMINI_API_KEY が設定されていません")

    audio_data = await audio.read()
    if not audio_data:
        raise HTTPException(status_code=400, detail="音声データが空です")

    mime_type = audio.content_type or "audio/webm"
    suffix = (
        ".wav"  if "wav"  in mime_type else
        ".m4a"  if ("mp4" in mime_type or "m4a" in mime_type) else
        ".ogg"  if "ogg"  in mime_type else
        ".webm"
    )

    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(audio_data)
        tmp_path = tmp.name

    uploaded = None
    try:
        uploaded = await asyncio.to_thread(
            _client.files.upload,
            file=Path(tmp_path),
            config={"mime_type": mime_type},
        )
        for _ in range(30):
            if uploaded.state.name != "PROCESSING":
                break
            await asyncio.sleep(1)
            uploaded = await asyncio.to_thread(_client.files.get, name=uploaded.name)

        if uploaded.state.name != "ACTIVE":
            raise RuntimeError(f"ファイルの処理に失敗しました: {uploaded.state.name}")

        prompt = (
            "この音声を日本語で文字起こししてください。"
            "話し言葉をそのまま書き起こし、句読点を適切に含めてください。"
            "音声がない・聞き取れない場合は「（音声なし）」と返してください。"
            "文字起こし結果のみを出力してください。前置きや説明は不要です。"
        )
        response = await asyncio.to_thread(
            _client.models.generate_content,
            model=_model_name,
            contents=[uploaded, prompt],
        )
        text = response.text.strip() if response.text else "（文字起こし結果なし）"
        return JSONResponse({"text": text, "size_bytes": len(audio_data)})

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"文字起こしエラー: {str(e)}")
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        if uploaded:
            try:
                await asyncio.to_thread(_client.files.delete, name=uploaded.name)
            except Exception:
                pass


# ===================== アイデア抽出 =====================
@app.post("/extract-ideas")
async def extract_ideas(
    req: Request,
    current_user: User = Depends(get_current_user),
):
    if not _api_key or _client is None:
        raise HTTPException(status_code=500, detail="GEMINI_API_KEY が設定されていません")

    body  = await req.json()
    text  = body.get("text", "").strip()
    title = body.get("title", "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="テキストが空です")

    title_context = f"会議タイトル：{title}\n\n" if title else ""
    prompt = (
        "以下の会議情報から重要なアイデア・提案・意見・課題・決定事項・アクションアイテムをすべて抽出し、"
        "JSON配列のみ返してください。前後の説明文は一切不要です。\n\n"
        "ルール：\n"
        "- できるだけ多く個別カードとして抽出\n"
        "- titleは15字以内、bodyは40字以内\n"
        "- categoryは以下の3つのいずれかを必ず使用する：\n"
        "  アイデア / リスク / 意見\n"
        "  （新機能・改善案・提案→アイデア、懸念・障壁・課題→リスク、感想・意見・提言・決定・その他→意見）\n"
        "- tagsは2〜3個\n\n"
        "出力形式（この形式のJSONのみ、他は何も出力しない）：\n"
        '[{"title":"...","body":"...","category":"...","tags":["...","..."]}]\n\n'
        f"{title_context}会議内容：{text}"
    )

    try:
        response = await asyncio.to_thread(
            _client.models.generate_content,
            model=_model_name,
            contents=[prompt],
        )
        ideas = _parse_ideas_json(response.text.strip())
        for i, idea in enumerate(ideas):
            idea["id"] = f"idea_{i}_{id(idea)}"
            if "status" not in idea:
                idea["status"] = "todo"
        return JSONResponse({"ideas": ideas})
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"アイデア抽出エラー: {str(e)}")


# ===================== 起動エントリ =====================
if __name__ == "__main__":
    import uvicorn

    if not _api_key:
        print("\n[ERROR] GEMINI_API_KEY が設定されていません。")
        print("  .env ファイルに GEMINI_API_KEY=your_key を設定してください。\n")
        exit(1)

    print("\nZONIST を起動します…")
    print("ブラウザで http://localhost:8001 を開いてください\n")
    uvicorn.run("main:app", host="0.0.0.0", port=8001, reload=False)
