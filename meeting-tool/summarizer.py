"""
差分要約生成モジュール（Gemini API使用）
S_prev + T_new → S_next（3〜5行の詳細ライブ要約）
"""
import asyncio
import os

import google.generativeai as genai

# ==================== プロンプト ====================
_PROMPT_TEMPLATE = """あなたは会議支援AIです。以下の情報を使って「ライブ要約」を更新してください。

## ルール
- **3〜5行・合計250文字以内**で出力してください
- 必ず以下の要素を含めてください：
  1. **現在の論点・テーマ**（いま何について話しているか）
  2. **議論の方向性・現状**（どの案が有力か、何が決まりつつあるか、何が未決か）
  3. **具体的なキーワード**（人名・数字・固有名詞・日時・金額など出てきたものは積極的に盛り込む）
- 合意が取れていない事項は断定せず「〜案」「〜候補」「検討中」「調整中」などを使う
- 「誰が言ったか」より「何が議論されているか」「どう進んでいるか」を重視する
- 出力は**更新後の要約文のみ**（見出し・前置き・番号・記号は不要）

## 現在表示中の要約
{s_prev}

## 直近の確定テキスト（新規発言）
{t_new}

更新後の要約:"""


class Summarizer:
    def __init__(self):
        api_key = os.getenv("GEMINI_API_KEY", "")
        if not api_key:
            raise RuntimeError(
                "GEMINI_API_KEY が設定されていません。.env ファイルを確認してください。"
            )
        genai.configure(api_key=api_key)

        model_name = os.getenv("GEMINI_MODEL", "gemini-2.0-flash")
        self.model = genai.GenerativeModel(
            model_name=model_name,
            generation_config={
                "max_output_tokens": 512,   # 詳細な要約のため増加
                "temperature": 0.2,
                "top_p": 0.9,
            },
        )
        print(f"[Summarizer] モデル: {model_name}")

    async def summarize(self, s_prev: str, t_new: str) -> str:
        """差分要約を生成する（非同期）"""
        prompt = _PROMPT_TEMPLATE.format(
            s_prev=s_prev.strip() if s_prev.strip() else "（まだ要約はありません）",
            t_new=t_new.strip(),
        )

        response = await asyncio.to_thread(self.model.generate_content, prompt)
        text = response.text.strip()

        # 5行超えは先頭5行に切り詰め（UIが崩れないよう）
        lines = [ln for ln in text.split("\n") if ln.strip()]
        if len(lines) > 5:
            text = "\n".join(lines[:5])

        if not text:
            return s_prev if s_prev else "（要約を生成できませんでした）"

        return text
