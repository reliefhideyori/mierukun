"""
Google OAuth 2.0 + JWT cookie 認証
"""
import os
from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import RedirectResponse
from authlib.integrations.starlette_client import OAuth, OAuthError
from jose import JWTError, jwt
from sqlalchemy.orm import Session

from database import get_db
from models import User

router = APIRouter()

# ── 設定 ───────────────────────────────────────────────────────
GOOGLE_CLIENT_ID     = os.getenv("GOOGLE_CLIENT_ID", "")
GOOGLE_CLIENT_SECRET = os.getenv("GOOGLE_CLIENT_SECRET", "")
JWT_SECRET           = os.getenv("JWT_SECRET", "change_me_in_production_32chars!!")
JWT_ALGORITHM        = "HS256"
JWT_EXPIRE_DAYS      = 30
APP_BASE_URL         = os.getenv("APP_BASE_URL", "http://localhost:8001")
FREE_SESSION_LIMIT   = 3

# ── Google OAuth 登録 ─────────────────────────────────────────
oauth = OAuth()
oauth.register(
    name="google",
    client_id=GOOGLE_CLIENT_ID,
    client_secret=GOOGLE_CLIENT_SECRET,
    server_metadata_url="https://accounts.google.com/.well-known/openid-configuration",
    client_kwargs={"scope": "openid email profile"},
)


# ── JWT ──────────────────────────────────────────────────────
def create_jwt(user_id: int) -> str:
    expire  = datetime.utcnow() + timedelta(days=JWT_EXPIRE_DAYS)
    payload = {"sub": str(user_id), "exp": expire}
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)


def get_current_user(request: Request, db: Session = Depends(get_db)) -> User:
    """Cookie から JWT を検証してユーザーを返す"""
    token = request.cookies.get("zonist_token")
    if not token:
        raise HTTPException(status_code=401, detail="Not authenticated")
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
        user_id = int(payload["sub"])
    except (JWTError, ValueError, KeyError):
        raise HTTPException(status_code=401, detail="Invalid token")
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=401, detail="User not found")
    return user


# ── エンドポイント ──────────────────────────────────────────
@router.get("/auth/google")
async def auth_google(request: Request):
    """Google OAuth 認証ページへリダイレクト"""
    redirect_uri = f"{APP_BASE_URL}/auth/google/callback"
    return await oauth.google.authorize_redirect(request, redirect_uri)


@router.get("/auth/google/callback")
async def auth_google_callback(request: Request, db: Session = Depends(get_db)):
    """Google から戻ってきてユーザー作成 / JWT 発行"""
    try:
        token = await oauth.google.authorize_access_token(request)
    except OAuthError as e:
        raise HTTPException(400, f"OAuth エラー: {e}")

    user_info  = token.get("userinfo")
    if not user_info:
        user_info = await oauth.google.userinfo(token=token)

    google_id  = user_info["sub"]
    email      = user_info.get("email", "")
    name       = user_info.get("name", "")
    avatar_url = user_info.get("picture")

    # Upsert
    user = db.query(User).filter(User.google_id == google_id).first()
    if not user:
        user = User(
            google_id=google_id,
            email=email,
            name=name,
            avatar_url=avatar_url,
            plan="free",
            sessions_used=0,
        )
        db.add(user)
        db.commit()
        db.refresh(user)
    else:
        user.name       = name
        user.avatar_url = avatar_url
        db.commit()

    jwt_token = create_jwt(user.id)
    response  = RedirectResponse(url="/app")
    is_https  = APP_BASE_URL.startswith("https://")
    response.set_cookie(
        key="zonist_token",
        value=jwt_token,
        max_age=60 * 60 * 24 * 30,
        httponly=True,
        samesite="lax",
        secure=is_https,          # 本番HTTPS環境では必須
    )
    return response


@router.get("/auth/me")
async def auth_me(current_user: User = Depends(get_current_user)):
    """現在のユーザー情報を返す（JS から呼ぶ）"""
    remaining = (
        max(0, FREE_SESSION_LIMIT - current_user.sessions_used)
        if current_user.plan == "free"
        else None
    )
    return {
        "id":                current_user.id,
        "email":             current_user.email,
        "name":              current_user.name,
        "avatar_url":        current_user.avatar_url,
        "plan":              current_user.plan,
        "sessions_used":     current_user.sessions_used,
        "sessions_remaining": remaining,
    }


@router.post("/auth/logout")
async def auth_logout():
    response = RedirectResponse(url="/login", status_code=302)
    response.delete_cookie("zonist_token")
    return response
