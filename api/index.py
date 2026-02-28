import sys
import os

# meeting-tool ディレクトリをパスに追加
root_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
meeting_tool_dir = os.path.join(root_dir, "meeting-tool")
sys.path.insert(0, meeting_tool_dir)

# 静的ファイルの相対パスが正しく解決されるよう作業ディレクトリを変更
os.chdir(meeting_tool_dir)

from main import app
