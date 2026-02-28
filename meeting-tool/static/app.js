/**
 * 会議支援ツール v3.1 - フロントエンド
 *
 * ASR 方式: MediaRecorder(WebM) → AudioWorklet(Float32 PCM) に変更
 *
 * 旧方式の問題:
 *   MediaRecorder の timeslice チャンクは先頭以外が WebM ヘッダーを持たない
 *   不完全データになり、faster-whisper で "Invalid data" エラーが発生していた。
 *
 * 新方式:
 *   - AudioWorklet でブラウザネイティブレートの PCM をキャプチャ
 *   - 16kHz にダウンサンプル（audio-processor.js）
 *   - 3 秒分の Float32Array を ArrayBuffer としてバイナリ WebSocket 送信
 *   - バックエンドで stdlib wave モジュールにより WAV 化 → faster-whisper
 */

'use strict';

// ============================================================
// 設定
// ============================================================
const CFG = {
  WS_URL:             `ws://${location.host}/ws`,
  SILENCE_MS:         1200,   // 無音判定時間 (ms)
  SILENCE_LEVEL:      0.010,  // 無音とみなす RMS レベル
  VOICE_LEVEL:        0.018,  // 発話とみなす RMS レベル
  MIN_CHARS_TRIGGER:  25,     // サマリートリガー最低文字数
  COOLDOWN_MS:        1500,   // トリガー連続発火抑止 (ms)
  IDLE_TIMEOUT_MS:    3000,   // 保留自動解除 (ms)
  LOG_MAX:            60,
  WS_RECONNECT_MS:    3000,
  AT_BOTTOM_MARGIN:   60,
  MIN_PCM_SAMPLES:    8000,   // これ以下のサンプル数は送信しない（0.5秒未満）
};

// ============================================================
// 状態
// ============================================================
const S = {
  isRunning:          false,
  asrReady:           false,
  isHeld:             false,
  idleTimer:          null,
  pendingScrollCount: 0,
  summaryCount:       0,
  localBufChars:      0,
  silenceStart:       null,
  lastTriggerTime:    0,
  wsReconnecting:     false,
  chunkHasAudio:      false,   // 直近チャンクに発話があったか
  partialClearTimer:  null,
  logOpen:            true,
  fullTranscript:     '',      // マインドマップ生成用：確定テキストの蓄積
};

// ============================================================
// 音声キャプチャ関連
// ============================================================
let mediaStream  = null;
let workletNode  = null;
let vuAudioCtx   = null;
let vuAnalyser   = null;
let vuAnimFrame  = null;

// ============================================================
// DOM 参照
// ============================================================
const el = {
  recIndicator:     document.getElementById('recording-indicator'),
  wsStatus:         document.getElementById('ws-status'),
  asrStatus:        document.getElementById('asr-status'),
  vuCanvas:         document.getElementById('vu-canvas'),
  btnStart:         document.getElementById('btn-start'),
  btnStop:          document.getElementById('btn-stop'),
  btnManual:        document.getElementById('btn-manual'),
  btnReset:         document.getElementById('btn-reset'),
  bufferFill:       document.getElementById('buffer-fill'),
  bufferText:       document.getElementById('buffer-text'),
  summaryStatus:    document.getElementById('summary-status'),
  whiteboard:       document.getElementById('whiteboard'),
  wbEntries:        document.getElementById('wb-entries'),
  scrollNotify:     document.getElementById('scroll-notify'),
  scrollNotifyText: document.getElementById('scroll-notify-text'),
  btnScrollNew:     document.getElementById('btn-scroll-new'),
  partialIcon:      document.querySelector('.partial-icon'),
  partialText:      document.getElementById('partial-text'),
  partialStrip:     document.querySelector('.partial-strip'),
  logArea:          document.getElementById('log-area'),
  btnClearLog:      document.getElementById('btn-clear-log'),
  btnLogToggle:     document.getElementById('btn-log-toggle'),
  toastCont:        document.getElementById('toast-container'),
  btnMindmap:       document.getElementById('btn-mindmap'),
  mmStatus:         document.getElementById('mm-status'),
  mmPlaceholder:    document.getElementById('mm-placeholder'),
  mmSvg:            document.getElementById('mm-svg'),
};

// ============================================================
// トースト
// ============================================================
function toast(msg, type = 'info', ms = 3500) {
  const div = document.createElement('div');
  div.className = `toast t-${type}`;
  div.textContent = msg;
  el.toastCont.appendChild(div);
  setTimeout(() => {
    div.style.opacity = '0';
    setTimeout(() => div.remove(), 350);
  }, ms);
}

// ============================================================
// WebSocket
// ============================================================
let ws = null;

function connectWS() {
  if (ws && ws.readyState <= WebSocket.OPEN) return;
  ws = new WebSocket(CFG.WS_URL);

  ws.onopen = () => {
    S.wsReconnecting = false;
    setWSBadge('接続済み', 'green');
    if (S.isRunning) toast('サーバーに再接続しました', 'success');
  };
  ws.onclose = () => {
    setWSBadge('切断', 'red');
    if (S.isRunning && !S.wsReconnecting) {
      S.wsReconnecting = true;
      toast('サーバー接続が切断されました。再接続中…', 'error');
      setTimeout(connectWS, CFG.WS_RECONNECT_MS);
    }
  };
  ws.onerror = () => setWSBadge('エラー', 'red');
  ws.onmessage = (ev) => {
    try { handleMsg(JSON.parse(ev.data)); }
    catch (e) { console.error('[WS]', e); }
  };
}

function wsSend(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

// ============================================================
// サーバーメッセージ処理
// ============================================================
function handleMsg(msg) {
  switch (msg.type) {

    case 'asr_loading':
      S.asrReady = false;
      el.btnStart.disabled = true;
      setASRBadge('モデル読み込み中…', 'yellow');
      break;

    case 'asr_ready':
      S.asrReady = true;
      if (!S.isRunning) {
        el.btnStart.disabled = false;
        setASRBadge('待機中', 'gray');
        toast('ASR 準備完了。「開始」ボタンで録音を始めてください。', 'success', 3000);
      }
      break;

    case 'transcribing':
      setASRBadge('処理中…', 'yellow');
      setPartialState('processing', '⚡', '文字起こし処理中…');
      break;

    case 'transcribing_done':
      setASRBadge('録音中', 'green');
      clearPartial();
      break;

    case 'transcript':
      setASRBadge('録音中', 'green');
      S.localBufChars = msg.buffer_size ?? (S.localBufChars + msg.text.length);
      updateBufferUI(S.localBufChars);
      addLog(msg.text);
      setPartialState('result', '🎤', msg.text);
      clearTimeout(S.partialClearTimer);
      S.partialClearTimer = setTimeout(clearPartial, 3000);
      S.silenceStart = null;  // 発話確認 → 沈黙クロックをリセット
      S.fullTranscript += msg.text + ' ';
      if (S.summaryCount > 0) el.btnMindmap.disabled = false;
      break;

    case 'summary_update':
      setASRBadge(S.isRunning ? '録音中' : '停止', S.isRunning ? 'green' : 'gray');
      appendSummaryCard(msg.summary, msg.update_id);
      el.btnMindmap.disabled = false;
      break;

    case 'summarizing':
      setSummaryStatus('要約生成中…', 'st-updating');
      break;

    case 'buffer_update':
      S.localBufChars = msg.buffer_size;
      updateBufferUI(msg.buffer_size);
      break;

    case 'trigger_ignored':
      setSummaryStatus(
        S.summaryCount > 0 ? '更新済み ✓' : '待機中',
        S.summaryCount > 0 ? 'st-done'   : ''
      );
      if (msg.reason === 'not_enough_content') toast('発言量不足のためスキップしました', 'info');
      break;

    case 'error':
      setSummaryStatus('エラー', 'st-error');
      toast(msg.message, 'error', 6000);
      break;

    case 'reset_ack':
      doReset();
      break;
  }
}

// ============================================================
// AudioWorklet による音声キャプチャ
// ============================================================
async function startAudioCapture() {
  // マイクのパーミッション取得
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl:  true,
        channelCount:     1,
      },
    });
  } catch (e) {
    const msg = e.name === 'NotAllowedError'
      ? 'マイクへのアクセスが拒否されました。ブラウザの設定を確認してください。'
      : `マイクエラー: ${e.message}`;
    toast(msg, 'error', 8000);
    throw e;
  }

  // AudioContext（ネイティブレートで作成・ダウンサンプルは Worklet が担当）
  vuAudioCtx = new AudioContext();
  console.log(`[Audio] ネイティブレート: ${vuAudioCtx.sampleRate} Hz`);

  // VU メーター用 Analyser
  vuAnalyser = vuAudioCtx.createAnalyser();
  vuAnalyser.fftSize = 512;

  const source = vuAudioCtx.createMediaStreamSource(mediaStream);
  source.connect(vuAnalyser);

  // AudioWorklet プロセッサをロード・接続
  await vuAudioCtx.audioWorklet.addModule('/static/audio-processor.js');
  workletNode = new AudioWorkletNode(
    vuAudioCtx,
    'meeting-audio-processor',
    { processorOptions: {} }  // nativeSampleRate は sampleRate グローバルで取得
  );

  workletNode.port.onmessage = (ev) => {
    // ev.data = Float32Array.buffer (16kHz, mono, 3 秒 = 48000 samples)
    if (!S.isRunning) return;

    const samples = ev.data.byteLength / 4;  // Float32 = 4 bytes/sample
    if (samples < CFG.MIN_PCM_SAMPLES) return;  // 短すぎるチャンクは無視

    if (!S.chunkHasAudio) return;  // 無音チャンクは送信しない
    S.chunkHasAudio = false;

    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(ev.data);   // ArrayBuffer をバイナリ送信
    }
  };

  source.connect(workletNode);
  // workletNode は destination に接続しない（自分の声を聞かない）

  drawVU();  // VU メーター + 沈黙検出ループ開始
}

// ============================================================
// セッション開始 / 停止 / リセット
// ============================================================
async function startSession() {
  if (!S.asrReady) {
    toast('ASR モデルを読み込み中です。しばらくお待ちください…', 'info', 5000);
    return;
  }
  try {
    await startAudioCapture();
  } catch (_) {
    return;  // エラーはすでにトーストで表示済み
  }

  S.isRunning = true;
  setButtonsRunning(true);
  el.recIndicator.classList.remove('hidden');
  setASRBadge('録音中', 'green');
  setSummaryStatus('録音中…');
  setPartialState('idle', '🎤', '発話を待機中…');
}

function stopSession() {
  S.isRunning    = false;
  S.silenceStart = null;
  clearTimeout(S.idleTimer);
  clearTimeout(S.partialClearTimer);

  if (workletNode) {
    workletNode.port.onmessage = null;
    workletNode.disconnect();
    workletNode = null;
  }
  if (mediaStream) {
    mediaStream.getTracks().forEach((t) => t.stop());
    mediaStream = null;
  }
  if (vuAudioCtx) {
    cancelAnimationFrame(vuAnimFrame);
    vuAudioCtx.close().catch(() => {});
    vuAudioCtx = null;
    vuAnalyser  = null;
  }
  if (ws) ws.close();

  setButtonsRunning(false);
  el.recIndicator.classList.add('hidden');
  clearPartial();
  setWSBadge('切断', 'gray');
  setASRBadge('停止', 'gray');
  setSummaryStatus('停止中');

  // VU キャンバスをリセット
  const ctx = el.vuCanvas.getContext('2d');
  ctx.clearRect(0, 0, el.vuCanvas.width, el.vuCanvas.height);
  ctx.fillStyle = '#1a1e2e';
  ctx.fillRect(0, 0, el.vuCanvas.width, el.vuCanvas.height);
}

function doReset() {
  S.summaryCount = S.pendingScrollCount = S.localBufChars = S.lastTriggerTime = 0;
  S.isHeld = false;
  S.fullTranscript = '';
  el.btnMindmap.disabled = true;
  mmReset();

  el.wbEntries.innerHTML = `
    <div class="wb-placeholder" id="wb-placeholder">
      <div class="wb-placeholder-icon">📋</div>
      <p class="wb-placeholder-text">「開始」ボタンを押すと</p>
      <p class="wb-placeholder-sub">文字起こしとライブ要約が始まります</p>
    </div>`;

  clearPartial();
  hideScrollNotify();
  updateBufferUI(0);
  setSummaryStatus('待機中');
  clearLog();
  toast('リセットしました', 'success');
}

// ============================================================
// VU メーター + 沈黙検出（一体化ループ）
// ============================================================
function drawVU() {
  const canvas = el.vuCanvas;
  const ctx    = canvas.getContext('2d');
  const buf    = new Uint8Array(vuAnalyser.frequencyBinCount);

  function frame() {
    vuAnimFrame = requestAnimationFrame(frame);
    vuAnalyser.getByteFrequencyData(buf);

    // RMS レベル計算
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    const level = Math.min(Math.sqrt(sum / buf.length) / 90, 1.0);

    // ── VU バー描画 ──
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#1a1e2e';
    ctx.fillRect(0, 0, W, H);

    if (level > 0.005) {
      const grad = ctx.createLinearGradient(0, 0, W, 0);
      grad.addColorStop(0.0,  '#38c98a');
      grad.addColorStop(0.55, '#f5c140');
      grad.addColorStop(1.0,  '#f05252');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 1, W * level, H - 2);
    }
    if (S.isRunning && level < 0.003) {
      ctx.fillStyle = 'rgba(240,82,82,0.18)';
      ctx.fillRect(0, 0, W, H);
    }

    // ── 発話フラグ更新（チャンク送信可否の判定に使う） ──
    if (level > CFG.VOICE_LEVEL) S.chunkHasAudio = true;

    // ── 沈黙検出 → サマリートリガー ──
    if (S.isRunning) {
      if (level < CFG.SILENCE_LEVEL) {
        if (S.silenceStart === null) {
          S.silenceStart = Date.now();
        } else if (Date.now() - S.silenceStart >= CFG.SILENCE_MS) {
          maybeSilenceTrigger();
          S.silenceStart = Date.now();  // 連続発火防止
        }
      } else {
        S.silenceStart = null;
      }
    }
  }

  frame();
}

function maybeSilenceTrigger() {
  const now = Date.now();
  if (S.localBufChars >= CFG.MIN_CHARS_TRIGGER && now - S.lastTriggerTime >= CFG.COOLDOWN_MS) {
    S.lastTriggerTime = now;
    wsSend({ type: 'silence_trigger' });
  }
}

// ============================================================
// ホワイトボード: 要約カード追記
// ============================================================
function appendSummaryCard(summary, updateId) {
  document.getElementById('wb-placeholder')?.remove();

  el.wbEntries.querySelectorAll('.s-card.is-latest').forEach((c) => {
    c.classList.replace('is-latest', 'is-old');
    c.querySelector('.s-now')?.remove();
  });
  el.wbEntries.querySelectorAll('.s-card.is-old').forEach((c, i, arr) => {
    if (i < arr.length - 2) c.classList.add('is-older');
  });

  const now = new Date();
  const ts  = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;

  const card = document.createElement('div');
  card.className  = 's-card is-latest';
  card.dataset.id = updateId;
  card.innerHTML  = `
    <div class="s-meta">
      <span class="s-time">${ts}</span>
      <span class="s-sep">───</span>
      <span class="s-num">#${updateId}</span>
      <span class="s-now">● NOW</span>
    </div>
    <div class="s-body">${escHtml(summary)}</div>
  `;
  el.wbEntries.appendChild(card);
  S.summaryCount++;
  updateBufferUI(0);
  S.localBufChars = 0;
  addLog(`[要約 #${updateId}] ${summary}`, true);

  if (S.isHeld) {
    S.pendingScrollCount++;
    showScrollNotify(S.pendingScrollCount);
    setSummaryStatus(`更新あり ↓${S.pendingScrollCount}件`, 'st-held');
  } else {
    scrollToLatest();
    setSummaryStatus('更新済み ✓', 'st-done');
  }
}

function scrollToLatest() {
  el.whiteboard.scrollTo({ top: el.whiteboard.scrollHeight, behavior: 'smooth' });
  S.pendingScrollCount = 0;
  hideScrollNotify();
}

// ============================================================
// スクロール保留制御
// ============================================================
function startHold() {
  if (S.isHeld) { resetIdleTimer(); return; }
  S.isHeld = true;
  setSummaryStatus('保留中（スクロール中）', 'st-held');
  resetIdleTimer();
}
function resetIdleTimer() {
  clearTimeout(S.idleTimer);
  S.idleTimer = setTimeout(releaseHold, CFG.IDLE_TIMEOUT_MS);
}
function releaseHold() {
  S.isHeld = false;
  clearTimeout(S.idleTimer);
  if (S.pendingScrollCount > 0) scrollToLatest();
  setSummaryStatus(S.summaryCount > 0 ? '更新済み ✓' : '待機中',
                   S.summaryCount > 0 ? 'st-done'   : '');
}

el.whiteboard.addEventListener('scroll', () => {
  if (!S.isRunning) return;
  const { scrollTop, scrollHeight, clientHeight } = el.whiteboard;
  scrollTop + clientHeight >= scrollHeight - CFG.AT_BOTTOM_MARGIN
    ? (S.isHeld && releaseHold())
    : startHold();
});

function showScrollNotify(n) {
  el.scrollNotifyText.textContent = `↓ 新しい要約 ${n}件`;
  el.scrollNotify.classList.remove('hidden');
}
function hideScrollNotify() { el.scrollNotify.classList.add('hidden'); }
el.btnScrollNew.addEventListener('click', () => { releaseHold(); scrollToLatest(); });

// ============================================================
// ログ
// ============================================================
function addLog(text, isSummary = false) {
  el.logArea.querySelector('.log-placeholder')?.remove();
  const now = new Date();
  const ts  = [now.getHours(), now.getMinutes(), now.getSeconds()]
    .map((v) => String(v).padStart(2,'0')).join(':');
  const div = document.createElement('div');
  div.className = 'log-entry' + (isSummary ? ' is-summary' : '');
  div.innerHTML = `<span class="log-time">${ts}</span>${escHtml(text)}`;
  el.logArea.appendChild(div);
  el.logArea.scrollTop = el.logArea.scrollHeight;
  const entries = el.logArea.querySelectorAll('.log-entry');
  if (entries.length > CFG.LOG_MAX) entries[0].remove();
}
function clearLog() {
  el.logArea.innerHTML = '<p class="log-placeholder">確定した発言がここに流れます。</p>';
}
function escHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\n/g,'<br>');
}

// ============================================================
// UI ヘルパー
// ============================================================
function setWSBadge(text, color) {
  el.wsStatus.textContent = text;
  el.wsStatus.className   = `badge badge-${color}`;
}
function setASRBadge(text, color) {
  el.asrStatus.textContent = text;
  el.asrStatus.className   = `badge badge-${color}`;
}
function setSummaryStatus(text, cls = '') {
  el.summaryStatus.textContent = text;
  el.summaryStatus.className   = `wb-status ${cls}`;
}
function updateBufferUI(size) {
  const pct = Math.min((size / CFG.MIN_CHARS_TRIGGER) * 100, 100);
  el.bufferFill.style.width = `${pct}%`;
  el.bufferFill.classList.toggle('is-ready', pct >= 100);
  el.bufferText.textContent = `${size} / ${CFG.MIN_CHARS_TRIGGER} 文字`;
}
function setButtonsRunning(on) {
  el.btnStart.disabled  =  on;
  el.btnStop.disabled   = !on;
  el.btnManual.disabled = !on;
  el.btnReset.disabled  = !on;
}
function setPartialState(mode, icon, text) {
  if (el.partialIcon)  el.partialIcon.textContent = icon;
  el.partialText.textContent = text;
  if (el.partialStrip) {
    el.partialStrip.classList.toggle('is-processing', mode === 'processing');
  }
}
function clearPartial() {
  setPartialState('idle', '🎤', '');
}

// ============================================================
// ボタンイベント
// ============================================================
el.btnStart.addEventListener('click', startSession);
el.btnStop.addEventListener('click', stopSession);
el.btnManual.addEventListener('click', () => {
  wsSend({ type: 'manual_trigger' });
  toast('手動確定を送信しました', 'info');
});
el.btnReset.addEventListener('click', () => {
  if (confirm('会議データ（要約履歴・ログ・バッファ）をすべてリセットしますか？')) {
    wsSend({ type: 'reset' });
  }
});
el.btnClearLog.addEventListener('click', clearLog);
el.btnLogToggle.addEventListener('click', () => {
  S.logOpen = !S.logOpen;
  el.logArea.classList.toggle('is-collapsed', !S.logOpen);
  el.btnLogToggle.textContent = S.logOpen ? '▲ 閉じる' : '▼ 開く';
});

// ============================================================
// マインドマップ
// ============================================================

function mmReset() {
  el.mmSvg.classList.add('hidden');
  el.mmPlaceholder.classList.remove('hidden');
  el.mmSvg.innerHTML = '';
  el.mmStatus.textContent = '';
}

el.btnMindmap.addEventListener('click', async () => {
  const text = S.fullTranscript.trim();
  if (!text) {
    toast('まだ文字起こしがありません', 'info');
    return;
  }

  el.btnMindmap.disabled = true;
  el.mmStatus.textContent = '生成中…';

  try {
    const res = await fetch('/mindmap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    const data = await res.json();
    mmRender(data);
    el.mmStatus.textContent = data.grouped
      ? `グルーピングあり（アイデア ${mmCountIdeas(data)}個）`
      : `フラット（アイデア ${data.ideas.length}個）`;
  } catch (e) {
    el.mmStatus.textContent = 'エラー';
    toast(`マインドマップ生成エラー: ${e.message}`, 'error', 6000);
  } finally {
    el.btnMindmap.disabled = false;
  }
});

function mmCountIdeas(data) {
  if (!data.grouped) return data.ideas.length;
  return (data.groups || []).reduce((n, g) => n + g.ideas.length, 0);
}

/**
 * マインドマップを SVG でレンダリングする
 * grouped=false → センター → アイデア（円形配置）
 * grouped=true  → センター → グループ → アイデア（2段円形配置）
 */
function mmRender(data) {
  const svg = el.mmSvg;
  svg.innerHTML = '';

  const W = svg.clientWidth  || 800;
  const H = svg.clientHeight || 420;
  const cx = W / 2;
  const cy = H / 2;

  // ─ ヘルパー ─
  function el2(tag, attrs = {}) {
    const e = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    return e;
  }

  function addLine(x1, y1, x2, y2, cls) {
    svg.appendChild(el2('line', { x1, y1, x2, y2, class: cls }));
  }

  function addNode(x, y, text, cls) {
    const g   = el2('g', { class: `mm-node ${cls}`, transform: `translate(${x},${y})` });
    const rx  = cls === 'mm-center' ? 54 : cls === 'mm-group' ? 42 : 36;
    const ry  = cls === 'mm-center' ? 22 : cls === 'mm-group' ? 18 : 15;
    g.appendChild(el2('ellipse', { cx: 0, cy: 0, rx, ry }));

    // テキストは 8 文字で折り返し
    const words  = splitText(text, 8);
    const lh     = 13;
    const startY = -((words.length - 1) * lh) / 2;
    words.forEach((w, i) => {
      const t = el2('text', { x: 0, y: startY + i * lh, 'text-anchor': 'middle', 'dominant-baseline': 'middle' });
      t.textContent = w;
      g.appendChild(t);
    });
    svg.appendChild(g);
  }

  function splitText(t, maxLen) {
    if (t.length <= maxLen) return [t];
    const lines = [];
    for (let i = 0; i < t.length; i += maxLen) lines.push(t.slice(i, i + maxLen));
    return lines;
  }

  function polar(r, angleDeg) {
    const rad = (angleDeg - 90) * Math.PI / 180;
    return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
  }

  if (!data.grouped) {
    // ── グルーピングなし（10個以下） ──
    const ideas = data.ideas || [];
    const r = Math.min(W, H) * 0.38;
    ideas.forEach((idea, i) => {
      const angle = (360 / ideas.length) * i;
      const { x, y } = polar(r, angle);
      addLine(cx, cy, x, y, 'mm-edge');
      addNode(x, y, idea, 'mm-idea');
    });
    addNode(cx, cy, data.center, 'mm-center');

  } else {
    // ── グルーピングあり（11個以上） ──
    const groups = data.groups || [];
    const r1 = Math.min(W, H) * 0.28;   // センター → グループ
    const r2 = Math.min(W, H) * 0.44;   // グループ → アイデア

    groups.forEach((grp, gi) => {
      const gAngle = (360 / groups.length) * gi;
      const gPos   = polar(r1, gAngle);

      addLine(cx, cy, gPos.x, gPos.y, 'mm-edge mm-edge-group');
      addNode(gPos.x, gPos.y, grp.label, 'mm-group');

      const ideas = grp.ideas || [];
      const spread = Math.min(60, 120 / Math.max(ideas.length, 1));
      const startA = gAngle - spread * (ideas.length - 1) / 2;

      ideas.forEach((idea, ii) => {
        const iAngle = startA + spread * ii;
        const iPos   = polar(r2, iAngle);
        addLine(gPos.x, gPos.y, iPos.x, iPos.y, 'mm-edge');
        addNode(iPos.x, iPos.y, idea, 'mm-idea');
      });
    });
    addNode(cx, cy, data.center, 'mm-center');
  }

  el.mmPlaceholder.classList.add('hidden');
  svg.classList.remove('hidden');
}

// ============================================================
// 初期化
// ============================================================
el.btnStart.disabled = true;   // ASR 準備完了まで無効
setWSBadge('未接続', 'gray');
setASRBadge('モデル読み込み中…', 'yellow');
setSummaryStatus('待機中');
updateBufferUI(0);
connectWS();
