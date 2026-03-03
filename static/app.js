'use strict';

// ============================================================
// 定数
// ============================================================
const MEETING_CATS = [
  { key: 'アイデア', color: '#5b8fff', light: 'rgba(91,143,255,.1)'  },
  { key: 'リスク',   color: '#ff5f5f', light: 'rgba(255,95,95,.1)'   },
  { key: '意見',     color: '#ff9040', light: 'rgba(255,144,64,.1)'  },
];
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
let draggedIdx     = null;
let groupNames     = {};   // groupId → カスタム名

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
const elMainInner = document.getElementById('mindmap-main-inner');

// ============================================================
// ユーティリティ
// ============================================================
function escHtml(s) {
  return (s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\n/g,'<br>');
}
function escAttr(s) {
  return (s || '').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// グループが1枚になったら自動解除
function cleanupSingletonGroups() {
  const counts = {};
  allIdeas.forEach(i => { if (i.groupId) counts[i.groupId] = (counts[i.groupId] || 0) + 1; });
  Object.entries(counts).forEach(([gid, n]) => {
    if (n <= 1) {
      allIdeas.forEach(i => { if (i.groupId === gid) delete i.groupId; });
      delete groupNames[gid];
    }
  });
}

// ============================================================
// ホワイトボード: クリック委譲（削除 / グループ解除）
// ============================================================
elMainInner.addEventListener('click', e => {
  // カード削除
  const deleteBtn = e.target.closest('.wb-card-delete');
  if (deleteBtn) {
    const idx = parseInt(deleteBtn.dataset.idx, 10);
    if (!isNaN(idx)) {
      allIdeas.splice(idx, 1);
      cleanupSingletonGroups();
      renderWhiteboard();
    }
    return;
  }
  // グループ解除
  const ungroupBtn = e.target.closest('.wb-group-ungroup');
  if (ungroupBtn) {
    const gid = ungroupBtn.dataset.gid;
    allIdeas.forEach(i => { if (i.groupId === gid) delete i.groupId; });
    delete groupNames[gid];
    renderWhiteboard();
  }
});

// ============================================================
// ホワイトボード: ダブルクリック → インライン編集
// ============================================================
elMainInner.addEventListener('dblclick', e => {
  // ── グループ名インライン編集 ──
  const groupLabel = e.target.closest('.wb-group-label');
  if (groupLabel) {
    const gid = groupLabel.dataset.gid;
    if (!gid) return;
    const currentName = groupNames[gid] || '';
    groupLabel.innerHTML =
      `<input class="wb-group-name-input" value="${escAttr(currentName)}" placeholder="グループ名" maxlength="20" />`;
    const inp = groupLabel.querySelector('input');
    inp.focus(); inp.select();
    function saveGroupName() {
      const v = inp.value.trim();
      if (v) groupNames[gid] = v; else delete groupNames[gid];
      renderWhiteboard();
    }
    inp.addEventListener('keydown', ev => {
      if (ev.key === 'Enter')  { ev.preventDefault(); saveGroupName(); }
      if (ev.key === 'Escape') renderWhiteboard();
    });
    inp.addEventListener('blur', () => setTimeout(saveGroupName, 100));
    return;
  }

  // ── カードインライン編集 ──
  const card = e.target.closest('.wb-card');
  if (!card || e.target.closest('.wb-card-delete') || card.classList.contains('editing')) return;

  const idx = parseInt(card.dataset.idx, 10);
  if (isNaN(idx)) return;
  const idea = allIdeas[idx];
  if (!idea) return;

  const catMeta = MEETING_CATS.find(c => c.key === idea.category) || MEETING_CATS[0];

  card.classList.add('editing');
  card.setAttribute('draggable', 'false');
  card.innerHTML = `
    <input  class="wb-edit-title" value="${escAttr(idea.title)}" maxlength="30"
            style="border-color:${catMeta.color}" />
    <textarea class="wb-edit-body" rows="2" maxlength="100">${escHtml(idea.body || '')}</textarea>
    <div class="wb-edit-hint">Enter: 確定 &nbsp;|&nbsp; Esc: キャンセル</div>`;

  const titleInput = card.querySelector('.wb-edit-title');
  const bodyInput  = card.querySelector('.wb-edit-body');
  titleInput.focus();
  titleInput.select();

  function save() {
    const newTitle = titleInput.value.trim();
    const newBody  = bodyInput.value.trim();
    if (newTitle) {
      allIdeas[idx].title = newTitle;
      allIdeas[idx].body  = newBody;
    }
    renderWhiteboard();
  }

  titleInput.addEventListener('keydown', ev => {
    if (ev.key === 'Enter')  { ev.preventDefault(); bodyInput.focus(); }
    if (ev.key === 'Escape') renderWhiteboard();
  });
  bodyInput.addEventListener('keydown', ev => {
    if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); save(); }
    if (ev.key === 'Escape') renderWhiteboard();
  });

  let blurTimer = null;
  [titleInput, bodyInput].forEach(el => {
    el.addEventListener('blur',  () => { blurTimer = setTimeout(save, 150); });
    el.addEventListener('focus', () => { clearTimeout(blurTimer); blurTimer = null; });
  });
});

// ============================================================
// ホワイトボード: ドラッグ & ドロップ → グループ化 / カテゴリ移動
// ============================================================
elMainInner.addEventListener('dragstart', e => {
  const card = e.target.closest('.wb-card');
  if (!card || card.classList.contains('editing')) return;
  draggedIdx = parseInt(card.dataset.idx, 10);
  setTimeout(() => card.classList.add('dragging'), 0);
  e.dataTransfer.effectAllowed = 'move';
});

elMainInner.addEventListener('dragend', () => {
  draggedIdx = null;
  elMainInner.querySelectorAll('.dragging, .drag-over, .drag-over-section')
    .forEach(el => el.classList.remove('dragging', 'drag-over', 'drag-over-section'));
});

elMainInner.addEventListener('dragover', e => {
  e.preventDefault();
  elMainInner.querySelectorAll('.drag-over, .drag-over-section')
    .forEach(el => el.classList.remove('drag-over', 'drag-over-section'));

  const card = e.target.closest('.wb-card:not(.dragging)');
  if (card && parseInt(card.dataset.idx, 10) !== draggedIdx) {
    card.classList.add('drag-over');
    e.dataTransfer.dropEffect = 'move';
    return;
  }
  const sectionBody = e.target.closest('.wb-section-body');
  if (sectionBody) {
    sectionBody.classList.add('drag-over-section');
    e.dataTransfer.dropEffect = 'move';
  }
});

elMainInner.addEventListener('drop', e => {
  e.preventDefault();
  elMainInner.querySelectorAll('.drag-over, .drag-over-section')
    .forEach(el => el.classList.remove('drag-over', 'drag-over-section'));

  if (draggedIdx === null || isNaN(draggedIdx)) return;
  const draggedIdea = allIdeas[draggedIdx];
  if (!draggedIdea) return;

  // ── カードにドロップ → グループ化 ──
  const targetCard = e.target.closest('.wb-card:not(.dragging)');
  if (targetCard) {
    const targetIdx = parseInt(targetCard.dataset.idx, 10);
    if (isNaN(targetIdx) || targetIdx === draggedIdx) return;
    const targetIdea = allIdeas[targetIdx];

    // ドラッグ元のカテゴリをターゲットに揃える
    draggedIdea.category = targetIdea.category;

    // グループID を統合
    if (targetIdea.groupId) {
      draggedIdea.groupId = targetIdea.groupId;
    } else if (draggedIdea.groupId) {
      targetIdea.groupId = draggedIdea.groupId;
    } else {
      const gid = 'g_' + Date.now();
      draggedIdea.groupId = gid;
      targetIdea.groupId  = gid;
    }
    renderWhiteboard();
    return;
  }

  // ── セクション空白にドロップ → カテゴリ移動（グループ解除） ──
  const sectionBody = e.target.closest('.wb-section-body');
  if (sectionBody) {
    const cat = sectionBody.dataset.cat;
    if (cat) {
      draggedIdea.category = cat;
      delete draggedIdea.groupId;
      cleanupSingletonGroups();
      renderWhiteboard();
    }
  }
  draggedIdx = null;
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
  chunkTimer = setInterval(() => { if (isRecording) rollChunk(); }, CHUNK_INTERVAL_MS);
}

// ============================================================
// チャンク録音
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
      if (activeStream) { activeStream.getTracks().forEach(t => t.stop()); activeStream = null; }
    }
  };
  mediaRecorder.start(1000);
}

function rollChunk() {
  chunkCount++;
  setStatus(`🔄 第${chunkCount}チャンクを文字起こし中… 録音は継続中`);
  if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
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
// 文字起こし送信
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
    const m = Math.floor(sec / 60), s = sec % 60;
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

// ============================================================
// ホワイトボード描画（グループ対応）
// ============================================================
function renderWhiteboard() {
  if (allIdeas.length === 0) {
    elMainInner.innerHTML = '<div class="empty-hint">録音・アイデア抽出後にホワイトボードが表示されます</div>';
    return;
  }

  // 1枚のカードを HTML 文字列に変換（タイトルは白固定 – カテゴリ色は左ボーダーのみ）
  const cardHtml = (idea, idx, color) => `
    <div class="wb-card" draggable="true" data-idx="${idx}" style="border-left-color:${color}">
      <div class="wb-card-title">${escHtml(idea.title)}</div>
      ${idea.body ? `<div class="wb-card-body">${escHtml(idea.body)}</div>` : ''}
      <button class="wb-card-delete" data-idx="${idx}" title="削除">✕</button>
    </div>`;

  const sections = MEETING_CATS.map(cat => {
    const ideas = allIdeas.filter(i => i.category === cat.key);

    // ungrouped / grouped に整理
    const groupsMap = {};
    const items = [];
    ideas.forEach(idea => {
      const idx = allIdeas.indexOf(idea);
      if (!idea.groupId) {
        items.push({ type: 'card', idea, idx });
      } else {
        if (!groupsMap[idea.groupId]) {
          groupsMap[idea.groupId] = [];
          items.push({ type: 'group', gid: idea.groupId, cards: groupsMap[idea.groupId] });
        }
        groupsMap[idea.groupId].push({ idea, idx });
      }
    });

    const bodyContent = items.map(item => {
      if (item.type === 'card') return cardHtml(item.idea, item.idx, cat.color);
      // グループ（明確な色付きヘッダーバー + 枠線でグルーピングを可視化）
      const inner = item.cards.map(c => cardHtml(c.idea, c.idx, cat.color)).join('');
      return `
        <div class="wb-group" style="border-color:${cat.color}50; background:${cat.color}08">
          <div class="wb-group-header" style="background:${cat.color}1a; border-bottom:1px solid ${cat.color}30">
            <span class="wb-group-label" data-gid="${escAttr(item.gid)}" title="ダブルクリックで名前を編集" style="color:${cat.color}cc">${escHtml(groupNames[item.gid] || 'グループ')} &nbsp;${item.cards.length}</span>
            <button class="wb-group-ungroup" data-gid="${escAttr(item.gid)}">解除</button>
          </div>
          <div class="wb-group-cards">${inner}</div>
        </div>`;
    }).join('');

    return `
      <div class="wb-section">
        <div class="wb-section-header" style="background:${cat.light}">
          <span class="wb-section-title" style="color:${cat.color}">${escHtml(cat.key)}</span>
          ${ideas.length > 0 ? `<span class="wb-count">${ideas.length}</span>` : ''}
        </div>
        <div class="wb-section-body" data-cat="${escAttr(cat.key)}">
          ${bodyContent || '<div class="wb-empty">—</div>'}
        </div>
      </div>`;
  }).join('');

  elMainInner.innerHTML = `<div class="whiteboard">${sections}</div>`;
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
