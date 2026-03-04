'use strict';

// ============================================================
// 定数
// ============================================================
const MEETING_CATS = [
  { key: 'アイデア', color: '#5b8fff', light: 'rgba(91,143,255,.1)'  },
  { key: 'リスク',   color: '#ff5f5f', light: 'rgba(255,95,95,.1)'   },
  { key: '意見',     color: '#ff9040', light: 'rgba(255,144,64,.1)'  },
];
const CHUNK_INTERVAL_MS  = 60_000;
const FREE_SESSION_LIMIT = 3;
const FREE_LIMIT_SEC     = 1800; // 30分

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
let draggedIdx        = null;
let groupNames        = {};   // groupId → カスタム名
let activeAddSection  = null; // 手動追加フォームが開いているカテゴリ

// 選択モード（モバイル長押しグルーピング）
let selectMode        = false;
let selectedIdxs      = new Set();
let longPressTimer    = null;

// アンドゥ（カード削除取り消し）
let undoStack  = null; // { idea, idx }
let undoTimer  = null;

// マイク選択
let selectedMicId = null;

// ドラッグ挿入モード（'before' | 'after' | 'group' | null）
let dragInsertMode = null;

// 認証 / セッション
let currentUser        = null; // /auth/me のレスポンス
let sessionTimerInterval = null;
let sessionStartTime     = null;

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
const elUndoToast = document.getElementById('undo-toast');
const elUndoBtn   = document.getElementById('undo-btn');
const elBtnExport = document.getElementById('btn-export');
const elMicBtn    = document.getElementById('mic-btn');
const elMicDropdown = document.getElementById('mic-dropdown');
const elMicList   = document.getElementById('mic-list');

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
// アンドゥ（カード削除取り消し）
// ============================================================
function showUndoToast() {
  clearTimeout(undoTimer);
  elUndoToast.classList.add('show');
  undoTimer = setTimeout(() => {
    elUndoToast.classList.remove('show');
    undoStack = null;
  }, 5000);
}

elUndoBtn.addEventListener('click', () => {
  if (!undoStack) return;
  clearTimeout(undoTimer);
  const { idea, idx } = undoStack;
  allIdeas.splice(Math.min(idx, allIdeas.length), 0, idea);
  undoStack = null;
  elUndoToast.classList.remove('show');
  renderWhiteboard();
});

// ============================================================
// JSONエクスポート
// ============================================================
elBtnExport.addEventListener('click', () => {
  if (!allIdeas.length && !allTranscripts) return;
  const data = {
    exportedAt: new Date().toISOString(),
    whiteboard: allIdeas,
    transcript: allTranscripts,
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  const ts   = new Date().toISOString().slice(0, 16).replace('T', '_').replace(':', '-');
  a.href     = url;
  a.download = `zonist-${ts}.json`;
  a.click();
  URL.revokeObjectURL(url);
});

// ============================================================
// マイク選択
// ============================================================
async function loadMicList() {
  elMicList.innerHTML = '<div style="padding:6px 12px;font-size:.75rem;color:var(--muted)">取得中…</div>';
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const mics    = devices.filter(d => d.kind === 'audioinput');
    elMicList.innerHTML = '';
    if (!mics.length) {
      elMicList.innerHTML = '<div style="padding:6px 12px;font-size:.75rem;color:var(--muted)">マイクが見つかりません</div>';
      return;
    }
    mics.forEach(mic => {
      const btn = document.createElement('button');
      btn.className   = 'mic-option' + (mic.deviceId === (selectedMicId || 'default') ? ' active' : '');
      btn.textContent = mic.label || `マイク (${mic.deviceId.slice(0, 8)}…)`;
      btn.title       = btn.textContent;
      btn.dataset.deviceId = mic.deviceId;
      btn.addEventListener('click', () => {
        selectedMicId = mic.deviceId;
        elMicBtn.classList.add('has-selection');
        elMicDropdown.classList.remove('open');
        loadMicList();
      });
      elMicList.appendChild(btn);
    });
  } catch {
    elMicList.innerHTML = '<div style="padding:6px 12px;font-size:.75rem;color:var(--muted)">取得できません</div>';
  }
}

elMicBtn.addEventListener('click', async e => {
  e.stopPropagation();
  const isOpen = elMicDropdown.classList.contains('open');
  elMicDropdown.classList.toggle('open', !isOpen);
  if (!isOpen) await loadMicList();
});

document.addEventListener('click', e => {
  if (!e.target.closest('#mic-select-wrap')) {
    elMicDropdown.classList.remove('open');
  }
});

// ============================================================
// ホワイトボード: クリック委譲（削除 / グループ解除）
// ============================================================
elMainInner.addEventListener('click', e => {
  // + ボタン → 追加フォームのトグル
  const addBtn = e.target.closest('.wb-add-btn');
  if (addBtn) {
    const cat = addBtn.dataset.cat;
    activeAddSection = activeAddSection === cat ? null : cat;
    renderWhiteboard();
    if (activeAddSection) {
      const inp = elMainInner.querySelector('.wb-add-title');
      if (inp) inp.focus();
    }
    return;
  }

  // フォーム: キャンセル
  const cancelBtn = e.target.closest('.wb-add-cancel');
  if (cancelBtn) {
    activeAddSection = null;
    renderWhiteboard();
    return;
  }

  // フォーム: 追加実行
  const submitBtn = e.target.closest('.wb-add-submit');
  if (submitBtn) {
    const cat    = submitBtn.dataset.cat;
    const form   = submitBtn.closest('.wb-add-form');
    const titleEl = form ? form.querySelector('.wb-add-title') : null;
    const bodyEl  = form ? form.querySelector('.wb-add-body')  : null;
    const title   = titleEl ? titleEl.value.trim() : '';
    if (!title) { if (titleEl) { titleEl.focus(); titleEl.style.borderColor = 'var(--red)'; } return; }
    const body = bodyEl ? bodyEl.value.trim() : '';
    allIdeas.push({
      id:       `idea_manual_${Date.now()}`,
      title,
      body,
      category: cat,
      tags:     [],
      status:   'todo',
    });
    activeAddSection = null;
    renderWhiteboard();
    return;
  }

  // カード削除（アンドゥ対応）
  const deleteBtn = e.target.closest('.wb-card-delete');
  if (deleteBtn) {
    const idx = parseInt(deleteBtn.dataset.idx, 10);
    if (!isNaN(idx) && allIdeas[idx]) {
      undoStack = { idea: { ...allIdeas[idx] }, idx };
      allIdeas.splice(idx, 1);
      cleanupSingletonGroups();
      renderWhiteboard();
      showUndoToast();
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
    return;
  }

  // カード本体タップ → starred トグル（長押し直後・選択モード・編集中は除外）
  if (selectMode) return;
  const card = e.target.closest('.wb-card');
  if (card && !card.classList.contains('editing') && !justEnteredSelectMode) {
    const idx = parseInt(card.dataset.idx, 10);
    if (!isNaN(idx) && allIdeas[idx]) {
      allIdeas[idx].starred = !allIdeas[idx].starred;
      // 再描画せず in-place 更新（チラつき防止）
      card.classList.toggle('starred', allIdeas[idx].starred);
      const titleEl = card.querySelector('.wb-card-title');
      if (titleEl) titleEl.style.color = allIdeas[idx].starred ? '#fde68a' : '';
    }
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
// ホワイトボード: 追加フォーム キーボード操作
// ============================================================
elMainInner.addEventListener('keydown', e => {
  const titleInput = e.target.closest('.wb-add-title');
  if (titleInput) {
    if (e.key === 'Enter') {
      e.preventDefault();
      const bodyInp = titleInput.closest('.wb-add-form')?.querySelector('.wb-add-body');
      if (bodyInp) bodyInp.focus();
    }
    if (e.key === 'Escape') { activeAddSection = null; renderWhiteboard(); }
    return;
  }
  const bodyInput = e.target.closest('.wb-add-body');
  if (bodyInput) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      bodyInput.closest('.wb-add-form')?.querySelector('.wb-add-submit')?.click();
    }
    if (e.key === 'Escape') { activeAddSection = null; renderWhiteboard(); }
  }
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
  draggedIdx     = null;
  dragInsertMode = null;
  elMainInner.querySelectorAll('.dragging, .drag-over, .drag-over-section, .insert-before, .insert-after')
    .forEach(el => el.classList.remove('dragging', 'drag-over', 'drag-over-section', 'insert-before', 'insert-after'));
});

elMainInner.addEventListener('dragover', e => {
  e.preventDefault();
  // 全インジケータをリセット
  elMainInner.querySelectorAll('.drag-over, .drag-over-section, .insert-before, .insert-after')
    .forEach(el => el.classList.remove('drag-over', 'drag-over-section', 'insert-before', 'insert-after'));

  const card = e.target.closest('.wb-card:not(.dragging)');
  if (card && parseInt(card.dataset.idx, 10) !== draggedIdx) {
    const rect  = card.getBoundingClientRect();
    const relY  = e.clientY - rect.top;
    const third = rect.height / 3;
    if (relY < third) {
      card.classList.add('insert-before');
      dragInsertMode = 'before';
    } else if (relY > third * 2) {
      card.classList.add('insert-after');
      dragInsertMode = 'after';
    } else {
      card.classList.add('drag-over');
      dragInsertMode = 'group';
    }
    e.dataTransfer.dropEffect = 'move';
    return;
  }
  const sectionBody = e.target.closest('.wb-section-body');
  if (sectionBody) {
    sectionBody.classList.add('drag-over-section');
    dragInsertMode = null;
    e.dataTransfer.dropEffect = 'move';
  }
});

elMainInner.addEventListener('drop', e => {
  e.preventDefault();
  elMainInner.querySelectorAll('.drag-over, .drag-over-section, .insert-before, .insert-after')
    .forEach(el => el.classList.remove('drag-over', 'drag-over-section', 'insert-before', 'insert-after'));

  if (draggedIdx === null || isNaN(draggedIdx)) return;
  const draggedIdea = allIdeas[draggedIdx];
  if (!draggedIdea) return;

  // ── カードにドロップ ──
  const targetCard = e.target.closest('.wb-card:not(.dragging)');
  if (targetCard) {
    const targetIdx = parseInt(targetCard.dataset.idx, 10);
    if (isNaN(targetIdx) || targetIdx === draggedIdx) { dragInsertMode = null; return; }
    const targetIdea = allIdeas[targetIdx];

    if (dragInsertMode === 'group') {
      // ── 中央ドロップ → グループ化（同カテゴリのみ。異カテゴリは移動＋グループ） ──
      draggedIdea.category = targetIdea.category;
      if (targetIdea.groupId) {
        draggedIdea.groupId = targetIdea.groupId;
      } else {
        const gid = 'g_' + Date.now();
        draggedIdea.groupId = gid;
        targetIdea.groupId  = gid;
      }
      cleanupSingletonGroups();
      renderWhiteboard();
    } else {
      // ── 上/下ドロップ → 並べ替え（同カテゴリ）or カテゴリ移動（異カテゴリ） ──
      if (draggedIdea.category === targetIdea.category) {
        const movedIdea = allIdeas.splice(draggedIdx, 1)[0];
        const newTargetIdx = allIdeas.indexOf(targetIdea);
        const insertIdx = dragInsertMode === 'after' ? newTargetIdx + 1 : newTargetIdx;
        allIdeas.splice(insertIdx, 0, movedIdea);
      } else {
        draggedIdea.category = targetIdea.category;
        delete draggedIdea.groupId;
      }
      cleanupSingletonGroups();
      renderWhiteboard();
    }
    dragInsertMode = null;
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

  // セッション開始チェック（Free: 上限 / Paid: スキップ）
  const ok = await callSessionStart();
  if (!ok) return;

  let stream;
  try {
    const audioConstraints = selectedMicId
      ? { deviceId: { exact: selectedMicId } }
      : true;
    stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
    // 権限取得後にラベル付きでリストを更新
    loadMicList().catch(() => {});
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
  startFreeSessionTimer(); // Free: 30分タイマー
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
  stopFreeSessionTimer(); // 30分タイマーも停止
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
  // 1枚のカードを HTML 文字列に変換（タップで starred トグル）
  const cardHtml = (idea, idx, color) => `
    <div class="wb-card${idea.starred ? ' starred' : ''}" draggable="true" data-idx="${idx}" style="border-left-color:${color}">
      <div class="wb-card-title">${escHtml(idea.title)}</div>
      ${idea.body ? `<div class="wb-card-body">${escHtml(idea.body)}</div>` : ''}
      <button class="wb-card-delete" data-idx="${idx}" title="削除">✕</button>
    </div>`;

  const sections = MEETING_CATS.map(cat => {
    const ideas    = allIdeas.filter(i => i.category === cat.key);
    const isAdding = activeAddSection === cat.key;

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

    // 追加フォーム（isAdding のときのみ）
    const addForm = isAdding ? `
      <div class="wb-add-form">
        <input class="wb-add-title" placeholder="タイトル（15字以内）" maxlength="30" />
        <textarea class="wb-add-body" placeholder="詳細（省略可）" rows="2" maxlength="100"></textarea>
        <div class="wb-add-actions">
          <button class="wb-add-cancel">キャンセル</button>
          <button class="wb-add-submit" data-cat="${escAttr(cat.key)}">追加</button>
        </div>
      </div>` : '';

    return `
      <div class="wb-section">
        <div class="wb-section-header" style="background:${cat.light}">
          <span class="wb-section-title" style="color:${cat.color}">${escHtml(cat.key)}</span>
          <button class="wb-add-btn" data-cat="${escAttr(cat.key)}" title="${isAdding ? 'キャンセル' : 'カードを追加'}">${isAdding ? '✕' : '+'}</button>
        </div>
        <div class="wb-section-body" data-cat="${escAttr(cat.key)}">
          ${addForm}${bodyContent || (!isAdding ? '<div class="wb-empty">—</div>' : '')}
        </div>
      </div>`;
  }).join('');

  elMainInner.innerHTML = `<div class="whiteboard">${sections}</div>`;
  // エクスポートボタン：カードがあれば有効化
  if (elBtnExport) elBtnExport.disabled = allIdeas.length === 0;
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

// ============================================================
// 認証・ユーザー管理
// ============================================================
async function initAuth() {
  try {
    const res = await fetch('/auth/me');
    if (res.status === 401) {
      location.href = '/login';
      return;
    }
    currentUser = await res.json();
    renderUserMenu();
    checkUpgradedParam();
    renderWhiteboard(); // ログイン後にホワイトボードを描画
  } catch (e) {
    console.error('認証チェックエラー:', e);
    location.href = '/login';
  }
}

function renderUserMenu() {
  if (!currentUser) return;
  const dropdown = document.getElementById('user-dropdown');
  const avatar   = document.getElementById('user-avatar');
  const nameEl   = document.getElementById('user-name');
  const badge    = document.getElementById('session-badge');
  const btnUpgrade = document.getElementById('btn-upgrade-menu');

  // ── ZONIST / ZONIST Pro タイトル切り替え ──
  const h1 = document.querySelector('h1');
  if (h1) {
    if (currentUser.plan === 'paid') {
      h1.innerHTML = 'ZONIST <span style="font-size:.6em;background:linear-gradient(135deg,#a78bfa,#818cf8);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;font-weight:900;">Pro</span>';
    } else {
      h1.textContent = 'ZONIST';
    }
  }

  dropdown.style.display = '';
  avatar.src = currentUser.avatar_url || '';
  avatar.alt = currentUser.name || currentUser.email;
  nameEl.textContent = currentUser.name || currentUser.email;

  const quickBtn = document.getElementById('upgrade-quick-btn');
  if (currentUser.plan === 'free') {
    const rem = currentUser.sessions_remaining ?? 0;
    badge.textContent = `残り ${rem} 回`;
    badge.className   = `session-badge${rem <= 1 ? ' warn' : ''}`;
    badge.style.display = '';
    if (btnUpgrade) btnUpgrade.style.display = '';
    if (quickBtn)   quickBtn.style.display   = '';
  } else {
    badge.style.display = 'none';
    if (btnUpgrade) btnUpgrade.style.display = 'none';
    if (quickBtn)   quickBtn.style.display   = 'none';
  }

  // ドロップダウン開閉
  document.getElementById('user-menu-trigger').addEventListener('click', () => {
    document.getElementById('user-dropdown-menu').classList.toggle('open');
  });
  document.addEventListener('click', e => {
    if (!document.getElementById('user-dropdown').contains(e.target)) {
      document.getElementById('user-dropdown-menu').classList.remove('open');
    }
  });

  // ログアウト
  document.getElementById('btn-logout').addEventListener('click', async () => {
    await fetch('/auth/logout', { method: 'POST' });
    location.href = '/login';
  });

  // アップグレードメニュー
  if (btnUpgrade) {
    btnUpgrade.addEventListener('click', () => {
      document.getElementById('user-dropdown-menu').classList.remove('open');
      goToStripe();
    });
  }
}

// ============================================================
// セッション開始（録音開始前に呼ぶ）
// ============================================================
async function callSessionStart() {
  try {
    const res = await fetch('/session/start', { method: 'POST' });
    if (res.status === 402) {
      showUpgradeModal('sessions');
      return false;
    }
    if (!res.ok) return false;
    const data = await res.json();
    // ユーザー情報を更新
    if (currentUser) {
      currentUser.sessions_used     = data.sessions_used;
      currentUser.sessions_remaining = data.sessions_remaining;
      renderUserMenu();
    }
    return true;
  } catch (e) {
    console.error('セッション開始エラー:', e);
    return false;
  }
}

// ============================================================
// 30分タイマー（Free ユーザーのみ）
// ============================================================
function startFreeSessionTimer() {
  if (currentUser?.plan === 'paid') return; // 有料ユーザーはスキップ
  sessionStartTime = Date.now();
  sessionTimerInterval = setInterval(() => {
    const elapsed = (Date.now() - sessionStartTime) / 1000;
    if (elapsed >= FREE_LIMIT_SEC) {
      clearInterval(sessionTimerInterval);
      sessionTimerInterval = null;
      stopRecording();
      showUpgradeModal('time');
    }
  }, 1000);
}

function stopFreeSessionTimer() {
  if (sessionTimerInterval) {
    clearInterval(sessionTimerInterval);
    sessionTimerInterval = null;
  }
}

// ============================================================
// アップグレードモーダル
// ============================================================
function showUpgradeModal(reason) {
  const modal = document.getElementById('upgrade-modal');
  const icon  = document.getElementById('modal-icon');
  const title = document.getElementById('modal-title');
  const body  = document.getElementById('modal-body');

  if (reason === 'sessions') {
    icon.textContent  = '🎯';
    title.textContent = `${FREE_SESSION_LIMIT}回の無料セッションを使い切りました`;
    body.innerHTML    = '¥1,000/月 の有料プランで<strong>録音回数・時間が無制限</strong>になります。<br>いつでも解約できます。';
  } else {
    icon.textContent  = '⏱';
    title.textContent = '30分のセッション上限に達しました';
    body.innerHTML    = '有料プランなら<strong>時間制限なし</strong>で録音を続けられます。<br>¥1,000/月・いつでも解約可能。';
  }
  modal.style.display = 'flex';
}

function closeUpgradeModal() {
  document.getElementById('upgrade-modal').style.display = 'none';
}

async function goToStripe() {
  try {
    const res = await fetch('/stripe/checkout', { method: 'POST' });
    if (!res.ok) {
      if (res.status === 401) { location.href = '/login'; return; }
      throw new Error('Checkout 作成失敗');
    }
    const { url } = await res.json();
    location.href = url;
  } catch (e) {
    alert('決済ページへの遷移に失敗しました。もう一度お試しください。');
  }
}

// アップグレード成功バナー表示
async function checkUpgradedParam() {
  if (!location.search.includes('upgraded=1')) return;
  history.replaceState({}, '', '/app');

  const banner = document.createElement('div');
  banner.className   = 'upgrade-banner';
  banner.textContent = '✓ 有料プランへのアップグレードが完了しました！';
  document.body.appendChild(banner);
  setTimeout(() => banner.remove(), 6000);

  // Webhook が DB を更新するまで最大10秒ポーリング
  for (let i = 0; i < 5; i++) {
    await new Promise(r => setTimeout(r, 2000));
    try {
      const res = await fetch('/auth/me');
      if (!res.ok) break;
      const data = await res.json();
      if (data.plan === 'paid') {
        currentUser = data;
        renderUserMenu();
        break;
      }
    } catch (_) { break; }
  }
}

// ============================================================
// 選択モード（モバイル長押しグルーピング）
// ============================================================
const elSelectBar      = document.getElementById('select-group-bar');
const elSelectLabel    = document.getElementById('select-count-label');
const elBtnDoGroup     = document.getElementById('btn-do-group');
const elBtnCancelSelect = document.getElementById('btn-cancel-select');

function enterSelectMode(firstIdx) {
  selectMode = true;
  selectedIdxs = new Set([firstIdx]);
  renderWhiteboard();
  updateSelectBar();
  // カードをselectable/selectedに
  elMainInner.querySelectorAll('.wb-card').forEach(card => {
    const idx = parseInt(card.dataset.idx, 10);
    card.classList.add('selectable');
    if (idx === firstIdx) card.classList.add('selected');
  });
}

function exitSelectMode() {
  selectMode = false;
  selectedIdxs.clear();
  elSelectBar.classList.remove('show');
  renderWhiteboard();
}

function updateSelectBar() {
  const n = selectedIdxs.size;
  elSelectLabel.textContent = `${n}件 選択中`;
  elBtnDoGroup.disabled = n < 2;
  elBtnDoGroup.style.opacity = n < 2 ? '.5' : '1';
  elSelectBar.classList.toggle('show', n > 0);
}

// contextmenu（長押し時のテキスト選択メニュー）を抑制
elMainInner.addEventListener('contextmenu', e => {
  if (e.target.closest('.wb-card')) e.preventDefault();
});

// 長押し後の click 誤発火を防ぐフラグ
let justEnteredSelectMode = false;

// 長押し検知（touchstart/touchend）
elMainInner.addEventListener('touchstart', e => {
  const card = e.target.closest('.wb-card');
  if (!card) return;
  if (e.target.closest('.wb-card-delete')) return;
  if (selectMode) return;

  const idx = parseInt(card.dataset.idx, 10);
  if (isNaN(idx)) return;

  longPressTimer = setTimeout(() => {
    longPressTimer = null;
    if (navigator.vibrate) navigator.vibrate(40);
    justEnteredSelectMode = true;
    enterSelectMode(idx);
    // 少し後にフラグをリセット（click イベントの後）
    setTimeout(() => { justEnteredSelectMode = false; }, 300);
  }, 450);
}, { passive: true });

elMainInner.addEventListener('touchend', () => {
  if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
}, { passive: true });

elMainInner.addEventListener('touchmove', () => {
  if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
}, { passive: true });

// 選択モード中のタップ: カード選択 / 解除
elMainInner.addEventListener('click', e => {
  if (!selectMode) return;
  const card = e.target.closest('.wb-card');
  if (!card) return;
  if (e.target.closest('.wb-card-delete')) return;
  e.stopPropagation();
  const idx = parseInt(card.dataset.idx, 10);
  if (isNaN(idx)) return;
  if (selectedIdxs.has(idx)) { selectedIdxs.delete(idx); card.classList.remove('selected'); }
  else { selectedIdxs.add(idx); card.classList.add('selected'); }
  updateSelectBar();
}, true);

// グループ化実行
elBtnDoGroup.addEventListener('click', () => {
  if (selectedIdxs.size < 2) return;
  const idxArr = [...selectedIdxs];
  const firstCat = allIdeas[idxArr[0]]?.category;
  // 同じカテゴリのみグループ化可能
  const allSameCat = idxArr.every(i => allIdeas[i]?.category === firstCat);
  if (!allSameCat) {
    alert('同じカテゴリのカードのみグループにできます');
    return;
  }
  const gid = 'g_' + Date.now();
  idxArr.forEach(i => { if (allIdeas[i]) allIdeas[i].groupId = gid; });
  exitSelectMode();
});

// キャンセル
elBtnCancelSelect.addEventListener('click', exitSelectMode);

// ============================================================
// 起動
// ============================================================
initAuth();
