'use strict';

// ============================================================
// 定数
// ============================================================

// 会議で使う固定カテゴリ 3種（バックエンドのプロンプトと完全一致させること）
const MEETING_CATS = [
  { key: 'アイデア', icon: '💡', color: '#4f7eff', light: 'rgba(79,126,255,.13)' },
  { key: 'リスク',   icon: '⚠️', color: '#ff6b6b', light: 'rgba(255,107,107,.13)' },
  { key: '意見',     icon: '💬', color: '#ff9a3c', light: 'rgba(255,154,60,.13)'  },
];

// ローリング録音: 1分ごとに音声チャンクをGeminiへ送信（録音は継続）
const CHUNK_INTERVAL_MS = 60_000;

// ============================================================
// 状態
// ============================================================
let mediaRecorder  = null;
let audioChunks    = [];
let timerInterval  = null;
let chunkTimer     = null;
let activeStream   = null;
let chunkCount     = 0;
let startTime      = null;
let isRecording    = false;
let logCount       = 0;

let processingJobs = 0;

let allIdeas       = [];
let allTranscripts = '';

// ============================================================
// DOM
// ============================================================
const elTimer     = document.getElementById('timer');
const elRecBtn    = document.getElementById('rec-btn');
const elBtnIcon   = document.getElementById('btn-icon');
const elStatus    = document.getElementById('status-text');
const elApiSt     = document.getElementById('api-status');
const elProcBadge = document.getElementById('proc-badge');
const elLogBody   = document.getElementById('log-body');
const elLogCount  = document.getElementById('log-count');
const elBtnClear  = document.getElementById('btn-clear');

// ============================================================
// ホワイトボードカード削除（イベント委譲）
// ============================================================
document.getElementById('mindmap-main-inner').addEventListener('click', e => {
  const btn = e.target.closest('.wb-card-delete');
  if (!btn) return;
  const idx = parseInt(btn.dataset.idx, 10);
  if (!isNaN(idx)) {
    allIdeas.splice(idx, 1);
    renderWhiteboard();
  }
});

// ============================================================
// 処理ジョブ管理
// ============================================================
function incProc() { processingJobs++; updateProcBadge(); }
function decProc() { processingJobs = Math.max(0, processingJobs - 1); updateProcBadge(); }
function updateProcBadge() {
  if (processingJobs > 0) {
    elProcBadge.textContent = `⚙ 処理中 ${processingJobs}件`;
    elProcBadge.style.display = '';
    setApiStatus(`処理中 ${processingJobs}件`, 'yellow');
  } else {
    elProcBadge.style.display = 'none';
    if (!isRecording) setApiStatus('待機中', 'gray');
  }
}

// ============================================================
// 録音開始（ローリング録音）
// ============================================================
async function startRecording() {
  if (isRecording) return;

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    setStatus(e.name === 'NotAllowedError'
      ? 'マイクへのアクセスが拒否されました' : `マイクエラー: ${e.message}`, true);
    return;
  }

  activeStream = stream;
  startTime    = Date.now();
  isRecording  = true;
  chunkCount   = 0;

  setRecordingUI(true);
  startTimerUI();
  setStatus('🔴 録音中… 1分ごとに自動で文字起こしされます');
  setApiStatus('録音中', 'green');

  startChunk();

  chunkTimer = setInterval(() => {
    if (isRecording) rollChunk();
  }, CHUNK_INTERVAL_MS);
}

// ============================================================
// チャンク録音（ストリームを引き継いで新しい MediaRecorder を作成）
// ============================================================
function startChunk() {
  audioChunks = [];
  const mimeType = ['audio/webm;codecs=opus','audio/webm','audio/ogg;codecs=opus','audio/mp4']
    .find(t => MediaRecorder.isTypeSupported(t)) ?? '';
  mediaRecorder = new MediaRecorder(activeStream, mimeType ? { mimeType } : {});

  mediaRecorder.ondataavailable = e => { if (e.data.size > 0) audioChunks.push(e.data); };
  mediaRecorder.onstop = () => {
    const blob = new Blob(audioChunks, { type: mediaRecorder.mimeType || 'audio/webm' });
    sendAudio(blob);

    if (isRecording) {
      startChunk();
    } else {
      if (activeStream) {
        activeStream.getTracks().forEach(t => t.stop());
        activeStream = null;
      }
    }
  };

  mediaRecorder.start(1000);
}

function rollChunk() {
  chunkCount++;
  setStatus(`🔄 第${chunkCount}チャンクを文字起こし中… 録音は継続中`);
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  }
}

// ============================================================
// 録音停止
// ============================================================
function stopRecording() {
  if (!isRecording) return;
  isRecording = false;

  clearInterval(timerInterval);
  clearInterval(chunkTimer);
  timerInterval = null;
  chunkTimer    = null;

  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  } else if (activeStream) {
    activeStream.getTracks().forEach(t => t.stop());
    activeStream = null;
  }

  setRecordingUI(false);
  setStatus('⏹ 録音停止 ✓ 最終チャンクを処理中…');
}

// ============================================================
// 文字起こし送信（バックグラウンド・非ブロッキング）
// ============================================================
async function sendAudio(blob) {
  if (blob.size < 1000) return;

  incProc();
  const formData = new FormData();
  formData.append('audio', blob, 'recording.webm');

  try {
    const res = await fetch('/transcribe', { method: 'POST', body: formData });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: `HTTP ${res.status}` }));
      throw new Error(err.detail ?? `HTTP ${res.status}`);
    }
    const data = await res.json();
    addLogEntry(data.text, data.size_bytes ?? blob.size);

    allTranscripts += (allTranscripts ? '\n\n' : '') + data.text;
    extractIdeas(data.text);

    if (isRecording) setStatus('🔴 録音中… 1分ごとに自動で文字起こしされます');

  } catch (e) {
    addLogEntry(`[エラー] ${e.message}`, blob.size, true);
    setApiStatus('エラー', 'red');
  } finally {
    decProc();
  }
}

// ============================================================
// アイデア抽出
// ============================================================
async function extractIdeas(text) {
  if (!text || !text.trim()) return;

  incProc();

  try {
    const res = await fetch('/extract-ideas', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: 'エラー' }));
      throw new Error(err.detail);
    }
    const data = await res.json();
    if (data.ideas && data.ideas.length > 0) {
      // タイトルベースで重複排除
      const existingTitles = new Set(allIdeas.map(i => i.title.trim()));
      const newIdeas = data.ideas.filter(i => !existingTitles.has((i.title || '').trim()));
      allIdeas = [...allIdeas, ...newIdeas];
      renderWhiteboard();
    }
  } catch (e) {
    console.error('アイデア抽出エラー:', e.message);
  } finally {
    decProc();
  }
}

// ============================================================
// タイマーUI
// ============================================================
function startTimerUI() {
  timerInterval = setInterval(() => {
    const elapsed = Date.now() - startTime;
    const sec = Math.floor(elapsed / 1000);
    const m   = Math.floor(sec / 60), s = sec % 60;
    elTimer.textContent = `${m}:${String(s).padStart(2,'0')}`;
  }, 200);
}

// ============================================================
// UI ヘルパー
// ============================================================
function setRecordingUI(on) {
  elTimer.classList.toggle('rec', on);
  elRecBtn.classList.toggle('rec', on);
  elBtnIcon.textContent = on ? '■' : '🎤';
  elRecBtn.title        = on ? '録音停止' : '録音開始';
  if (!on) elTimer.textContent = '0:00';
}
function setStatus(txt, isErr = false) {
  elStatus.textContent = txt;
  elStatus.classList.toggle('err', isErr);
}
function setApiStatus(txt, color) {
  elApiSt.textContent = txt;
  elApiSt.className   = `badge badge-${color}`;
}

// ============================================================
// ログ
// ============================================================
function addLogEntry(text, size, isErr = false) {
  document.getElementById('log-placeholder')?.remove();
  const now = new Date();
  const ts  = [now.getHours(),now.getMinutes(),now.getSeconds()].map(v=>String(v).padStart(2,'0')).join(':');
  const sz  = size ? `${(size/1024).toFixed(1)} KB` : '';
  logCount++;
  elLogCount.textContent = `${logCount} 件`;
  const entry = document.createElement('div');
  entry.className = 'log-entry hi';
  entry.innerHTML = `
    <div class="log-meta">
      <span class="log-time">${ts}</span>
      ${sz ? `<span class="log-sz">${sz}</span>` : ''}
    </div>
    <div class="log-txt${isErr?' err':''}">${escHtml(text)}</div>`;
  elLogBody.appendChild(entry);
  elLogBody.scrollTop = elLogBody.scrollHeight;
  setTimeout(() => entry.classList.remove('hi'), 3000);
}

function escHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\n/g,'<br>');
}

// ============================================================
// ホワイトボード（3固定カテゴリ × エリア表示）
// ============================================================
function renderWhiteboard() {
  const container = document.getElementById('mindmap-main-inner');

  if (allIdeas.length === 0) {
    container.innerHTML = '<div class="empty-hint">録音・アイデア抽出後にホワイトボードが表示されます</div>';
    return;
  }

  const sections = MEETING_CATS.map(cat => {
    const ideas = allIdeas.filter(i => i.category === cat.key);

    const cards = ideas.map(idea => {
      const idx = allIdeas.indexOf(idea);
      return `
        <div class="wb-card" style="border-left-color:${cat.color}">
          <div class="wb-card-title" style="color:${cat.color}">${escHtml(idea.title)}</div>
          ${idea.body ? `<div class="wb-card-body">${escHtml(idea.body)}</div>` : ''}
          <button class="wb-card-delete" data-idx="${idx}" title="削除">✕</button>
        </div>`;
    }).join('');

    return `
      <div class="wb-section">
        <div class="wb-section-header" style="color:${cat.color}; border-bottom-color:${cat.color}; background:${cat.light}">
          <span>${cat.icon}</span>
          <span>${escHtml(cat.key)}</span>
          ${ideas.length > 0 ? `<span class="wb-count" style="background:${cat.color}30">${ideas.length}</span>` : ''}
        </div>
        <div class="wb-section-body">
          ${cards || '<div class="wb-empty">—</div>'}
        </div>
      </div>`;
  }).join('');

  container.innerHTML = `<div class="whiteboard">${sections}</div>`;
}

// ============================================================
// イベント
// ============================================================
elRecBtn.addEventListener('click', () => {
  isRecording ? stopRecording() : startRecording();
});

elBtnClear.addEventListener('click', () => {
  logCount = 0;
  elLogCount.textContent = '0 件';
  elLogBody.innerHTML = '<div class="log-placeholder" id="log-placeholder">録音が完了すると、ここに文字起こし結果が表示されます</div>';
});
