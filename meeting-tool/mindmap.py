"""
マインドマップ生成モジュール（Gemini API使用）

グルーピング閾値:
  - アイデア数 10 以下 → グルーピングなし（フラット表示）
  - アイデア数 11 以上 → グルーピングあり
"""
import asyncio
import json
import os
import re

import google.generativeai as genai

# アイデア数がこれを超えたらグルーピングを実施
GROUPING_THRESHOLD = 10

# ==================== プロンプト ====================
_IDEAS_PROMPT = """あなたは会議支援AIです。以下の会議テキストから、議論されたアイデア・論点・決定事項を抽出してください。

## ルール
- アイデアは簡潔な一文で（30文字以内）
- 重複は除く
- 最重要なものを優先して抽出（最大20個）
- 出力は必ずJSON形式のみ（コードブロック不要）: {{"center": "会議のテーマ（20文字以内）", "ideas": ["アイデア1", "アイデア2", ...]}}

## 会議テキスト
{text}

JSON:"""

_GROUP_PROMPT = """以下のアイデアリストを意味的に近いものでグループ化してください。

## ルール
- グループ数は3〜6個
- 各グループには短いラベルをつける（10文字以内）
- 全てのアイデアをいずれかのグループに入れる
- 出力は必ずJSON形式のみ（コードブロック不要）: {{"groups": [{{"label": "グループ名", "ideas": ["アイデア1", ...]}}]}}

## アイデアリスト
{ideas}

JSON:"""


class MindmapGenerator:
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
                "max_output_tokens": 1024,
                "temperature": 0.2,
                "top_p": 0.9,
            },
        )
        print(f"[MindmapGenerator] モデル: {model_name}")

    def _parse_json(self, text: str) -> dict:
        """テキストからJSONを抽出してパース"""
        # コードブロックを除去
        text = re.sub(r"```(?:json)?\s*", "", text)
        text = re.sub(r"```\s*", "", text)
        text = text.strip()
        return json.loads(text)

    async def generate(self, text: str) -> dict:
        """マインドマップデータを生成する

        Returns:
            グルーピングなしの場合:
                {"grouped": False, "center": str, "ideas": [str, ...]}
            グルーピングありの場合:
                {"grouped": True, "center": str,
                 "groups": [{"label": str, "ideas": [str, ...]}, ...]}
        """
        if not text.strip():
            return {"grouped": False, "center": "会議", "ideas": []}

        # Step 1: アイデア抽出
        ideas_prompt = _IDEAS_PROMPT.format(text=text.strip())
        response = await asyncio.to_thread(self.model.generate_content, ideas_prompt)
        ideas_data = self._parse_json(response.text)

        center = ideas_data.get("center", "会議")
        ideas: list[str] = ideas_data.get("ideas", [])

        # Step 2: アイデア数に応じてグルーピング判定
        if len(ideas) <= GROUPING_THRESHOLD:
            # 10個以下 → グルーピングなし
            return {
                "grouped": False,
                "center": center,
                "ideas": ideas,
            }
        else:
            # 11個以上 → グルーピングあり
            ideas_text = "\n".join(f"- {idea}" for idea in ideas)
            group_prompt = _GROUP_PROMPT.format(ideas=ideas_text)
            group_response = await asyncio.to_thread(
                self.model.generate_content, group_prompt
            )
            group_data = self._parse_json(group_response.text)

            return {
                "grouped": True,
                "center": center,
                "groups": group_data.get("groups", []),
            }
