"""
Stripe Checkout + Webhook
"""
import os
import stripe
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse
from sqlalchemy.orm import Session

from database import get_db
from models import User
from auth import get_current_user

router = APIRouter()

stripe.api_key            = os.getenv("STRIPE_SECRET_KEY", "")
STRIPE_WEBHOOK_SECRET     = os.getenv("STRIPE_WEBHOOK_SECRET", "")
STRIPE_PRICE_ID           = os.getenv("STRIPE_PRICE_ID", "")
APP_BASE_URL              = os.getenv("APP_BASE_URL", "http://localhost:8001")


@router.post("/stripe/checkout")
async def create_checkout(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Stripe Checkout Session を作成して URL を返す"""
    if current_user.plan == "paid":
        raise HTTPException(400, "すでに有料プランです")

    # Stripe 顧客を初回に作成
    if not current_user.stripe_customer_id:
        customer = stripe.Customer.create(
            email=current_user.email,
            name=current_user.name,
            metadata={"user_id": str(current_user.id)},
        )
        current_user.stripe_customer_id = customer.id
        db.commit()

    session = stripe.checkout.Session.create(
        customer=current_user.stripe_customer_id,
        mode="subscription",
        line_items=[{"price": STRIPE_PRICE_ID, "quantity": 1}],
        success_url=f"{APP_BASE_URL}/app?upgraded=1",
        cancel_url=f"{APP_BASE_URL}/app",
        locale="ja",
    )
    return {"url": session.url}


@router.post("/stripe/webhook")
async def stripe_webhook(request: Request, db: Session = Depends(get_db)):
    """Stripe からのイベントを受け取って plan を更新"""
    payload    = await request.body()
    sig_header = request.headers.get("stripe-signature", "")

    try:
        event = stripe.Webhook.construct_event(
            payload, sig_header, STRIPE_WEBHOOK_SECRET
        )
    except (ValueError, stripe.error.SignatureVerificationError):
        raise HTTPException(400, "Invalid webhook signature")

    event_type = event["type"]
    obj        = event["data"]["object"]

    if event_type == "checkout.session.completed":
        customer_id = obj.get("customer")
        if customer_id:
            user = db.query(User).filter(
                User.stripe_customer_id == customer_id
            ).first()
            if user:
                user.plan = "paid"
                db.commit()

    elif event_type in (
        "customer.subscription.deleted",
        "customer.subscription.paused",
    ):
        customer_id = obj.get("customer")
        if customer_id:
            user = db.query(User).filter(
                User.stripe_customer_id == customer_id
            ).first()
            if user:
                user.plan = "free"
                db.commit()

    return {"status": "ok"}
