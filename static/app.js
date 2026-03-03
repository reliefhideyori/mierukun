'use strict';

// ============================================================
// 定数
// ============================================================

// 会議で使う固定カテゴリ 6種（バックエンドのプロンプトと完全一致させること）
const MEETING_CATS = [
  { key: 'アイデア',           icon: '💡', color: '#4f7eff', light: 'rgba(79,126,255,.13)' },
  { key: 'リスク',             icon: '⚠️', color: '#ff6b6b', light: 'rgba(255,107,107,.13)' },
  { key: '検討すべきこと',     icon: '🤔', color: '#ffc233', light: 'rgba(255,194,51,.15)'  },
  { key: '決定事項',           icon: '✅', color: '#38d9a9', light: 'rgba(56,217,169,.13)'  },
  { key: 'アクションアイテム', icon: '📋', color: '#a97dff', light: 'rgba(169,125,255,.13)' },
  { key: '意見・フィードバック', icon: '💬', color: '#ff9a3c', light: 'rgba(255,154,60,.13)'  },
];

const STATUS_LABELS = { todo:'To Do', doing:'Doing', blocked:'Blocked', done:'Done' };
const STATUS_COLORS = { todo:'#4f7eff', doing:'#38d9a9', blocked:'#ff6b6b', done:'#ffc233' };

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
let activeMainTab  = 'log';
let activeIdeaTab  = 'cards';
let filterCat      = 'all';
let searchQ        = '';
let dragCardId     = null;

// ============================================================
// DOM
// ============================================================
const elTimer      = document.getElementById('timer');
const elRecBtn     = document.getElementById('rec-btn');
const elBtnIcon    = document.getElementById('btn-icon');
const elStatus     = document.getElementById('status-text');
const elApiSt      = document.getElementById('api-status');
const elProcBadge  = document.getElementById('proc-badge');
const elLogBody    = document.getElementById('log-body');
const elLogCount   = document.getElementById('log-count');
const elBtnClear   = document.getElementById('btn-clear');
const elBtnExtract = document.getElementById('btn-extract');
const elExtractSt  = document.getElementById('extract-status');
const elIdeaStats  = document.getElementById('idea-stats');
const elTitleInput = document.getElementById('meeting-title');

// ============================================================
// メインタブ切替
// ============================================================
document.querySelectorAll('.main-tab').forEach(btn => {
  btn.addEventListener('click', () => {
    activeMainTab = btn.dataset.tab;
    document.querySelectorAll('.main-tab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('panel-log').style.display     = activeMainTab === 'log'     ? '' : 'none';
    document.getElementById('panel-ideamap').style.display = activeMainTab === 'ideamap' ? '' : 'none';
  });
});

document.querySelectorAll('.idea-tab').forEach(btn => {
  btn.addEventListener('click', () => {
    activeIdeaTab = btn.dataset.view;
    document.querySelectorAll('.idea-tab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('.idea-panel').forEach(p => p.classList.remove('active'));
    document.getElementById(`view-${activeIdeaTab}`).classList.add('active');
    renderCurrentIdeaView();
  });
});

elTitleInput.addEventListener('input', () => {
  if (allIdeas.length > 0) renderWhiteboard();
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
    elBtnExtract.disabled = false;
    extractIdeas(data.text, getMeetingTitle());

    if (isRecording) setStatus('🔴 録音中… 1分ごとに自動で文字起こしされます');

  } catch (e) {
    addLogEntry(`[エラー] ${e.message}`, blob.size, true);
    setApiStatus('エラー', 'red');
  } finally {
    decProc();
  }
}

// ============================================================
// アイデア抽出（タイトル + 文字起こし）
// ============================================================
async function extractIdeas(text, title = '') {
  if (!text || !text.trim()) return;

  incProc();
  elBtnExtract.disabled = true;
  elExtractSt.textContent = 'Gemini がアイデアを抽出中…';

  try {
    const res = await fetch('/extract-ideas', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, title }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: 'エラー' }));
      throw new Error(err.detail);
    }
    const data = await res.json();
    if (data.ideas && data.ideas.length > 0) {
      // タイトルベースで重複排除（IDはリクエストごとに変わるため使わない）
      const existingTitles = new Set(allIdeas.map(i => i.title.trim()));
      const newIdeas = data.ideas.filter(i => !existingTitles.has((i.title || '').trim()));
      allIdeas = [...allIdeas, ...newIdeas];

      updateIdeaStats();
      renderWhiteboard();
      renderCurrentIdeaView();
      elExtractSt.textContent = `✓ ${newIdeas.length} 件追加（合計 ${allIdeas.length} 件）`;

      const ideaTabBtn = document.querySelector('[data-tab="ideamap"]');
      if (activeMainTab !== 'ideamap') {
        ideaTabBtn.textContent = '🧠 アイデアマップ ✨';
        setTimeout(() => { ideaTabBtn.textContent = '🧠 アイデアマップ'; }, 4000);
      }
    } else {
      elExtractSt.textContent = '（アイデア未検出）';
    }
  } catch (e) {
    elExtractSt.textContent = `抽出エラー: ${e.message}`;
  } finally {
    decProc();
    elBtnExtract.disabled = false;
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
function updateIdeaStats() {
  const nonEmpty = MEETING_CATS.filter(c => allIdeas.some(i => i.category === c.key));
  elIdeaStats.textContent = `${allIdeas.length} 件 / ${nonEmpty.length} カテゴリ`;
}
function getMeetingTitle() {
  return elTitleInput.value.trim() || '会議メモ';
}

// ============================================================
// カテゴリ色（固定カテゴリ優先、その他はフォールバック）
// ============================================================
const CAT_COLORS_FB = ['#4f7eff','#ff6b6b','#38d9a9','#ffc233','#a97dff','#ff9a3c'];
const CAT_LIGHT_FB  = [
  'rgba(79,126,255,.14)','rgba(255,107,107,.14)','rgba(56,217,169,.14)',
  'rgba(255,194,51,.17)','rgba(169,125,255,.14)','rgba(255,154,60,.14)',
];
function getCats() { return [...new Set(allIdeas.map(i => i.category))]; }
function catColor(cat) {
  const mc = MEETING_CATS.find(c => c.key === cat);
  if (mc) return mc.color;
  return CAT_COLORS_FB[getCats().indexOf(cat) % 6];
}
function catColorLight(cat) {
  const mc = MEETING_CATS.find(c => c.key === cat);
  if (mc) return mc.light;
  return CAT_LIGHT_FB[getCats().indexOf(cat) % 6];
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
// アイデアビュー切替
// ============================================================
function renderCurrentIdeaView() {
  switch (activeIdeaTab) {
    case 'cards':   renderCards();   break;
    case 'tree':    renderTree();    break;
    case 'compare': renderCompare(); break;
    case 'kanban':  renderKanban();  break;
    case 'roadmap': renderRoadmap(); break;
  }
}

// ============================================================
// ホワイトボード（6固定カテゴリ × エリア表示）
// ============================================================
function renderWhiteboard() {
  const container = document.getElementById('mindmap-main-inner');

  if (allIdeas.length === 0) {
    container.innerHTML = '<div class="empty-hint">録音・アイデア抽出後にホワイトボードが表示されます</div>';
    return;
  }

  const sections = MEETING_CATS.map(cat => {
    const ideas = allIdeas.filter(i => i.category === cat.key);

    const cards = ideas.map(idea => `
      <div class="wb-card" style="border-left-color:${cat.color}">
        <div class="wb-card-title" style="color:${cat.color}">${escHtml(idea.title)}</div>
        ${idea.body ? `<div class="wb-card-body">${escHtml(idea.body)}</div>` : ''}
      </div>`).join('');

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
// ① カードグリッド
// ============================================================
function renderCards() {
  const el   = document.getElementById('view-cards');
  const cats = getCats();

  let filterBar = `<div class="filter-bar">
    <button class="filter-btn${filterCat==='all'?' active':''}" data-cat="all">すべて</button>`;
  cats.forEach(c => {
    filterBar += `<button class="filter-btn${filterCat===c?' active':''}" data-cat="${escHtml(c)}"
      style="border-left:3px solid ${catColor(c)}">${escHtml(c)}</button>`;
  });
  filterBar += `<input class="search-input" id="card-search" placeholder="🔍 検索…" value="${escHtml(searchQ)}"></div>`;

  const visible = allIdeas.filter(idea => {
    const matchCat = filterCat === 'all' || idea.category === filterCat;
    const matchQ   = !searchQ || idea.title.includes(searchQ) || (idea.body||'').includes(searchQ);
    return matchCat && matchQ;
  });

  if (visible.length === 0) {
    el.innerHTML = filterBar + '<div class="empty-hint">該当するアイデアがありません</div>';
  } else {
    const cards = visible.map(idea => `
      <div class="idea-card" style="border-color:${catColor(idea.category)};background:${catColorLight(idea.category)}">
        <span class="ic-cat" style="background:${catColor(idea.category)}22;color:${catColor(idea.category)}">${escHtml(idea.category)}</span>
        <div class="ic-title">${escHtml(idea.title)}</div>
        <div class="ic-body">${escHtml(idea.body||'')}</div>
        <div class="ic-tags">${(idea.tags||[]).map(t=>`<span class="ic-tag">#${escHtml(t)}</span>`).join('')}</div>
        <span class="ic-status" style="border:1px solid ${STATUS_COLORS[idea.status]||'#666'};color:${STATUS_COLORS[idea.status]||'#666'}">${STATUS_LABELS[idea.status]||idea.status}</span>
      </div>`).join('');
    el.innerHTML = filterBar + `<div class="card-grid">${cards}</div>`;
  }

  el.querySelectorAll('.filter-btn').forEach(btn => {
    btn.addEventListener('click', () => { filterCat = btn.dataset.cat; renderCards(); });
  });
  const si = el.querySelector('#card-search');
  if (si) si.addEventListener('input', e => { searchQ = e.target.value; renderCards(); });
}

// ============================================================
// ② 課題ツリー
// ============================================================
function renderTree() {
  const el    = document.getElementById('view-tree');
  const cats  = getCats();
  const title = getMeetingTitle();
  if (allIdeas.length === 0) { el.innerHTML = '<div class="empty-hint">アイデアがありません</div>'; return; }

  let html = `<div class="tree-wrap"><div class="tree-root">
    <div class="tree-node root-node"><span class="tree-dot" style="background:#6c63ff"></span>${escHtml(title)}（${allIdeas.length}件）</div>
    <div class="tree-children">`;
  cats.forEach(cat => {
    const color    = catColor(cat);
    const catIdeas = allIdeas.filter(i => i.category===cat);
    html += `<div class="tree-node cat-node" style="color:${color}">
      <span class="tree-dot" style="background:${color}"></span>${escHtml(cat)}（${catIdeas.length}）</div>
      <div class="tree-children">`;
    catIdeas.forEach(idea => {
      html += `<div class="tree-node leaf-node">
        <span class="tree-dot" style="background:${color};opacity:.5"></span>
        <span style="font-weight:600;color:#e2e8f0">${escHtml(idea.title)}</span>
        ${idea.body ? `<span style="color:#94a3b8;font-size:.73rem"> — ${escHtml(idea.body)}</span>` : ''}
      </div>`;
    });
    html += `</div>`;
  });
  html += `</div></div></div>`;
  el.innerHTML = html;
}

// ============================================================
// ③ 比較表
// ============================================================
function renderCompare() {
  const el    = document.getElementById('view-compare');
  const cats  = getCats();
  const title = getMeetingTitle();
  if (allIdeas.length === 0) { el.innerHTML = '<div class="empty-hint">アイデアがありません</div>'; return; }

  const maxCount = Math.max(...cats.map(c => allIdeas.filter(i=>i.category===c).length));
  const rows = cats.map(cat => {
    const color     = catColor(cat);
    const catIdeas  = allIdeas.filter(i => i.category===cat);
    const richness  = Math.round((catIdeas.length / Math.max(maxCount,1)) * 5);
    const diversity = Math.min(new Set(catIdeas.flatMap(i=>i.tags||[])).size, 5);
    const overall   = Math.round((richness + diversity) / 2);
    const dots  = n => '●'.repeat(n) + '○'.repeat(5-n);
    const stars = n => '★'.repeat(n) + '☆'.repeat(5-n);
    return `<tr>
      <td><span class="cat-badge" style="background:${color}22;color:${color}">${escHtml(cat)}</span></td>
      <td><b>${catIdeas.length}</b></td>
      <td><span class="dots">${dots(richness)}</span></td>
      <td><span class="dots">${dots(diversity)}</span></td>
      <td><span class="stars">${stars(overall)}</span></td>
    </tr>`;
  }).join('');

  el.innerHTML = `<div style="font-size:.8rem;color:var(--muted);margin-bottom:8px">📋 ${escHtml(title)}</div>
    <div class="compare-wrap">
      <table class="compare-table">
        <thead><tr><th>カテゴリ</th><th>件数</th><th>充実度</th><th>多様性</th><th>総合評価</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

// ============================================================
// ④ かんばん
// ============================================================
function renderKanban() {
  const el = document.getElementById('view-kanban');
  if (allIdeas.length === 0) { el.innerHTML = '<div class="empty-hint">アイデアがありません</div>'; return; }

  const cols    = ['todo','doing','blocked','done'];
  const html    = cols.map(status => {
    const color     = STATUS_COLORS[status];
    const cards     = allIdeas.filter(i => (i.status||'todo') === status);
    const cardsHtml = cards.map(idea => `
      <div class="kcard" draggable="true" data-id="${idea.id}">
        <div class="kcard-title">${escHtml(idea.title)}</div>
        <div style="font-size:.73rem;color:#94a3b8;margin-top:2px">${escHtml(idea.body||'')}</div>
        <span class="kcard-cat" style="background:${catColor(idea.category)}22;color:${catColor(idea.category)}">${escHtml(idea.category)}</span>
      </div>`).join('');
    return `<div class="kanban-col" data-status="${status}">
      <div class="kanban-col-title" style="border-color:${color};color:${color}">${STATUS_LABELS[status]}（${cards.length}）</div>
      ${cardsHtml}
    </div>`;
  }).join('');

  el.innerHTML = `<div class="kanban-wrap">${html}</div>`;

  el.querySelectorAll('.kcard').forEach(card => {
    card.addEventListener('dragstart', () => {
      dragCardId = card.dataset.id;
      setTimeout(() => card.style.opacity='0.4', 0);
    });
    card.addEventListener('dragend', () => { card.style.opacity='1'; dragCardId=null; });
  });
  el.querySelectorAll('.kanban-col').forEach(col => {
    col.addEventListener('dragover', e => { e.preventDefault(); col.classList.add('drag-target'); });
    col.addEventListener('dragleave', () => col.classList.remove('drag-target'));
    col.addEventListener('drop', e => {
      e.preventDefault();
      col.classList.remove('drag-target');
      if (!dragCardId) return;
      const idea = allIdeas.find(i => i.id===dragCardId);
      if (idea) { idea.status = col.dataset.status; renderKanban(); }
    });
  });
}

// ============================================================
// ⑤ ロードマップ
// ============================================================
function renderRoadmap() {
  const el    = document.getElementById('view-roadmap');
  const cats  = getCats();
  const title = getMeetingTitle();
  if (allIdeas.length === 0) { el.innerHTML = '<div class="empty-hint">アイデアがありません</div>'; return; }

  const n      = cats.length;
  const phases = [
    { label:'🌱 成長', color:'#38d9a9', cats: cats.slice(0, Math.ceil(n/3)) },
    { label:'🚀 拡大', color:'#ffc233', cats: cats.slice(Math.ceil(n/3), Math.ceil(n*2/3)) },
    { label:'🏆 成功', color:'#ff9a3c', cats: cats.slice(Math.ceil(n*2/3)) },
  ].filter(p => p.cats.length > 0);

  const phasesHtml = phases.map(phase => {
    const items = phase.cats.map(cat => {
      const catIdeas = allIdeas.filter(i => i.category===cat);
      return `<div class="phase-item">
        <div class="phase-item-title" style="color:${catColor(cat)}">${escHtml(cat)}</div>
        <div class="phase-item-ideas">${catIdeas.map(i=>escHtml(i.title)).join('、')}</div>
      </div>`;
    }).join('');
    return `<div class="phase">
      <div class="phase-label" style="background:${phase.color}">${phase.label}</div>
      <div class="phase-items">${items}</div>
    </div>`;
  }).join('');

  el.innerHTML = `<div style="font-size:.8rem;color:var(--muted);margin-bottom:10px">🗺 ${escHtml(title)}</div>
    <div class="roadmap-wrap">${phasesHtml}</div>`;
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

elBtnExtract.addEventListener('click', () => {
  if (allTranscripts.trim()) extractIdeas(allTranscripts, getMeetingTitle());
});
