"""
DB モデル定義
"""
from datetime import datetime
from sqlalchemy import Column, Integer, String, DateTime, ForeignKey
from sqlalchemy.orm import relationship
from database import Base


class User(Base):
    __tablename__ = "users"

    id                = Column(Integer, primary_key=True, index=True)
    google_id         = Column(String, unique=True, index=True, nullable=False)
    email             = Column(String, unique=True, index=True, nullable=False)
    name              = Column(String, nullable=False, default="")
    avatar_url        = Column(String, nullable=True)
    plan              = Column(String, nullable=False, default="free")  # "free" | "paid"
    sessions_used     = Column(Integer, nullable=False, default=0)
    stripe_customer_id = Column(String, nullable=True)
    created_at        = Column(DateTime, default=datetime.utcnow)

    sessions = relationship("RecordingSession", back_populates="user")


class RecordingSession(Base):
    __tablename__ = "recording_sessions"

    id           = Column(Integer, primary_key=True, index=True)
    user_id      = Column(Integer, ForeignKey("users.id"), nullable=False)
    started_at   = Column(DateTime, default=datetime.utcnow)
    duration_sec = Column(Integer, nullable=True)

    user = relationship("User", back_populates="sessions")
