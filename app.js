'use strict';

/* ====================================================================
   المداقش — نشرة الحكم  (v4)
   - نسبة مئوية من مبلغ الفوز لتحديد اللون
   - إدخال الرصيد تراكمي (إضافة على الرصيد الحالي)
   - سجل لكل لاعب مع أزرار تراجع/تقدم + تأكيد
   - زر رأس المال يوزّع على الكل ويبدأ سجلاً جديداً
   - زر مسح القائمة يمحو كل شيء
   ==================================================================== */

const PLAYERS_COUNT = 10;
const STORAGE_KEY   = 'madagish.v1';
const REFRESH_MS    = 3000;

/* عتبات الألوان بالنسبة المئوية من مبلغ الفوز */
const COLOR_THRESHOLDS = [
  { min: 70, color: 'green'  },  // ≥ 70%  قريب جداً من الفوز
  { min: 50, color: 'olive'  },  // 50-69% قريب
  { min: 35, color: 'yellow' },  // 35-49% بدأ يصعد
  { min: 20, color: 'black'  },  // 20-34% Safe Zone
  { min: 10, color: 'orange' },  // 10-19% منخفض
  { min: 0,  color: 'red'    }   // 0-9%   خطر
];

/* ============ الحالة ============ */
function newPlayer() {
  return { name: null, history: [], historyIndex: -1 };
}

const state = {
  winnerAmount: null,
  players: Array.from({ length: PLAYERS_COUNT }, newPlayer),
  winnerShown: false
};

/* ============ عناصر DOM ============ */
const el = {
  listScreen:        document.getElementById('listScreen'),
  winnerScreen:      document.getElementById('winnerScreen'),
  winnerAmountBtn:   document.getElementById('winnerAmountBtn'),
  playersList:       document.getElementById('playersList'),
  resetBtn:          document.getElementById('resetBtn'),
  capitalBtn:        document.getElementById('capitalBtn'),
  confirmOverlay:    document.getElementById('confirmOverlay'),
  confirmTitle:      document.getElementById('confirmTitle'),
  confirmText:       document.querySelector('#confirmOverlay .confirm-text'),
  confirmYes:        document.getElementById('confirmYes'),
  confirmCancel:     document.getElementById('confirmCancel'),
  winnerName:        document.getElementById('winnerName'),
  winnerAmountDisplay: document.getElementById('winnerAmountDisplay'),
  backBtn:           document.getElementById('backBtn')
};

/* ============ أدوات ============ */
function formatAmount(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '';
  return `$${n}k`;
}

function safeParseInt(str) {
  if (typeof str !== 'string') return null;
  const clean = str.replace(/[^\d-]/g, '');
  if (clean === '' || clean === '-') return null;
  const n = parseInt(clean, 10);
  if (Number.isNaN(n)) return null;
  return n;
}

function playerBalance(p) {
  if (!p) return null;
  if (p.historyIndex < 0) return null;
  return p.history[p.historyIndex];
}

/* ============ التخزين + الترحيل ============ */
function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      winnerAmount: state.winnerAmount,
      players: state.players
    }));
  } catch (_) { /* تجاهل */ }
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    if (typeof data !== 'object' || data === null) return;
    if (typeof data.winnerAmount === 'number') state.winnerAmount = data.winnerAmount;
    if (Array.isArray(data.players)) {
      for (let i = 0; i < PLAYERS_COUNT; i++) {
        const p = data.players[i];
        if (!p || typeof p !== 'object') continue;
        state.players[i].name = (typeof p.name === 'string' && p.name.trim()) ? p.name : null;

        // النسخة الجديدة (history + historyIndex)
        if (Array.isArray(p.history) && typeof p.historyIndex === 'number') {
          const clean = p.history.filter(v => typeof v === 'number' && !Number.isNaN(v));
          state.players[i].history = clean;
          state.players[i].historyIndex = clean.length === 0
            ? -1
            : Math.min(Math.max(0, p.historyIndex), clean.length - 1);
          continue;
        }

        // ترحيل من النسخة القديمة (balance فقط)
        if (typeof p.balance === 'number') {
          state.players[i].history = [p.balance];
          state.players[i].historyIndex = 0;
        }
      }
    }
  } catch (_) { /* تجاهل */ }
}

/* ============ منطق الألوان ============ */
function pickColorFromPercent(percent) {
  for (const t of COLOR_THRESHOLDS) {
    if (percent >= t.min) return t.color;
  }
  return 'red';
}

function computeColors() {
  const colors = new Array(PLAYERS_COUNT).fill('gray');
  const w = state.winnerAmount;
  if (w === null || w === undefined || Number.isNaN(w) || w <= 0) return colors;

  for (let i = 0; i < PLAYERS_COUNT; i++) {
    const b = playerBalance(state.players[i]);
    if (b === null) { colors[i] = 'gray'; continue; }
    let percent = (b / w) * 100;
    if (percent < 0) percent = 0;
    if (percent > 100) percent = 100;
    colors[i] = pickColorFromPercent(percent);
  }
  return colors;
}

/* ============ الرسم ============ */
function renderWinnerAmount() {
  const btn = el.winnerAmountBtn;
  if (state.winnerAmount === null) {
    btn.textContent = 'ادخل مبلغ الفوز';
    btn.classList.add('placeholder');
  } else {
    btn.textContent = formatAmount(state.winnerAmount);
    btn.classList.remove('placeholder');
  }
}

function renderPlayers() {
  const colors = computeColors();
  const list = el.playersList;
  list.innerHTML = '';

  for (let i = 0; i < PLAYERS_COUNT; i++) {
    const p = state.players[i];
    const balance = playerBalance(p);

    const li = document.createElement('li');
    li.className = 'player-row';
    li.setAttribute('data-color', colors[i]);
    li.setAttribute('data-idx', String(i));

    // 1) زر الاسم (يمين في RTL)
    const nameBtn = document.createElement('button');
    nameBtn.type = 'button';
    nameBtn.className = 'player-btn name-btn';
    if (!p.name) {
      nameBtn.textContent = 'ادخل اسم اللاعب هنا';
      nameBtn.classList.add('placeholder');
    } else {
      nameBtn.textContent = p.name;
    }
    nameBtn.addEventListener('click', () => promptName(i));

    // 2) زر الرصيد
    const balanceBtn = document.createElement('button');
    balanceBtn.type = 'button';
    balanceBtn.className = 'player-btn balance-btn';
    if (balance === null) {
      balanceBtn.textContent = 'الرصيد';
      balanceBtn.classList.add('placeholder');
    } else {
      balanceBtn.textContent = formatAmount(balance);
    }
    balanceBtn.addEventListener('click', () => promptBalanceAdd(i));

    // 3) زر التراجع (للخلف)
    const undoBtn = document.createElement('button');
    undoBtn.type = 'button';
    undoBtn.className = 'player-btn history-btn undo-btn';
    undoBtn.textContent = '↶';
    undoBtn.setAttribute('aria-label', 'تراجع');
    const canUndo = p.historyIndex > 0;
    if (!canUndo) undoBtn.disabled = true;
    undoBtn.addEventListener('click', () => onUndoClick(i));

    // 4) زر التقدم (للأمام)
    const redoBtn = document.createElement('button');
    redoBtn.type = 'button';
    redoBtn.className = 'player-btn history-btn redo-btn';
    redoBtn.textContent = '↷';
    redoBtn.setAttribute('aria-label', 'تقدم');
    const canRedo = p.historyIndex >= 0 && p.historyIndex < p.history.length - 1;
    if (!canRedo) redoBtn.disabled = true;
    redoBtn.addEventListener('click', () => onRedoClick(i));

    li.appendChild(nameBtn);
    li.appendChild(balanceBtn);
    li.appendChild(undoBtn);
    li.appendChild(redoBtn);
    list.appendChild(li);
  }
}

function render() {
  renderWinnerAmount();
  renderPlayers();
  checkWinner();
}

/* ============ إدخال البيانات ============ */
function promptWinnerAmount() {
  const current = state.winnerAmount === null ? '' : String(state.winnerAmount);
  const val = window.prompt('أدخل مبلغ الفوز (رقم فقط، بالآلاف):', current);
  if (val === null) return;
  const parsed = safeParseInt(val);
  state.winnerAmount = parsed;
  saveState();
  render();
}

function promptName(idx) {
  const cur = state.players[idx].name || '';
  const val = window.prompt('اسم اللاعب:', cur);
  if (val === null) return;
  const trimmed = val.trim();
  state.players[idx].name = trimmed === '' ? null : trimmed;
  saveState();
  render();
}

/* إدخال الرصيد بالإضافة على الرصيد الحالي */
function promptBalanceAdd(idx) {
  const p = state.players[idx];
  const current = playerBalance(p);
  const hint = current === null
    ? 'أدخل الرصيد الابتدائي (رقم فقط، بالآلاف):'
    : `الرصيد الحالي ${formatAmount(current)} — أدخل المبلغ ليضاف إليه:`;

  const val = window.prompt(hint, '');
  if (val === null) return;                 // إلغاء
  const delta = safeParseInt(val);
  if (delta === null) return;               // لا رقم
  if (delta === 0 && current !== null) return; // لا تغيير

  const newBalance = (current === null ? 0 : current) + delta;

  // اقطع أي مستقبل (redo entries)، ثم أضف النقطة الجديدة
  p.history = p.history.slice(0, p.historyIndex + 1);
  p.history.push(newBalance);
  p.historyIndex = p.history.length - 1;

  state.winnerShown = false;                 // نسمح بظهور شاشة الفائز من جديد
  saveState();
  render();
}

/* ============ التراجع / التقدم ============ */
function onUndoClick(idx) {
  const p = state.players[idx];
  if (p.historyIndex <= 0) return;
  const targetBalance = p.history[p.historyIndex - 1];
  const name = p.name || `اللاعب ${idx + 1}`;
  showConfirm({
    title: 'تأكيد التراجع',
    body:  `هل تريد إرجاع رصيد "${name}" إلى ${formatAmount(targetBalance)}؟`,
    okText: 'نعم، تراجع',
    danger: false,
    onOk: () => {
      p.historyIndex -= 1;
      state.winnerShown = false;
      saveState();
      render();
    }
  });
}

function onRedoClick(idx) {
  const p = state.players[idx];
  if (p.historyIndex < 0 || p.historyIndex >= p.history.length - 1) return;
  const targetBalance = p.history[p.historyIndex + 1];
  const name = p.name || `اللاعب ${idx + 1}`;
  showConfirm({
    title: 'تأكيد التقدم',
    body:  `هل تريد تقديم رصيد "${name}" إلى ${formatAmount(targetBalance)}؟`,
    okText: 'نعم، تقدم',
    danger: false,
    onOk: () => {
      p.historyIndex += 1;
      saveState();
      render();
    }
  });
}

/* ============ رأس المال ============ */
function promptCapital() {
  const val = window.prompt('رأس المال — سيوزّع على كل اللاعبين العشرة (رقم فقط، بالآلاف):', '');
  if (val === null) return;
  const parsed = safeParseInt(val);
  if (parsed === null) return;
  // ابدأ سجلاً جديداً لكل لاعب برأس المال المدخل
  for (let i = 0; i < PLAYERS_COUNT; i++) {
    state.players[i].history = [parsed];
    state.players[i].historyIndex = 0;
  }
  state.winnerShown = false;
  saveState();
  render();
}

/* ============ الفائز ============ */
function checkWinner() {
  if (state.winnerAmount === null) return;
  if (state.winnerShown) return;
  for (let i = 0; i < PLAYERS_COUNT; i++) {
    const b = playerBalance(state.players[i]);
    if (b !== null && b >= state.winnerAmount) {
      showWinner(i);
      return;
    }
  }
}

function showWinner(idx) {
  const p = state.players[idx];
  el.winnerName.textContent = p.name || 'لاعب بدون اسم';
  el.winnerAmountDisplay.textContent = formatAmount(playerBalance(p));
  el.listScreen.classList.add('hidden');
  el.winnerScreen.classList.remove('hidden');
  el.winnerScreen.setAttribute('aria-hidden', 'false');
  state.winnerShown = true;
}

function hideWinner() {
  el.winnerScreen.classList.add('hidden');
  el.winnerScreen.setAttribute('aria-hidden', 'true');
  el.listScreen.classList.remove('hidden');
  state.winnerShown = false;
}

/* ============ صندوق التأكيد العام ============ */
let pendingConfirmAction = null;

function showConfirm(opts) {
  el.confirmTitle.textContent = opts.title || 'تأكيد';
  el.confirmText.textContent  = opts.body  || '';
  el.confirmYes.textContent   = opts.okText || 'نعم';
  el.confirmYes.className = opts.danger ? 'btn-danger' : 'btn-primary';
  pendingConfirmAction = typeof opts.onOk === 'function' ? opts.onOk : null;
  el.confirmOverlay.classList.remove('hidden');
  el.confirmOverlay.setAttribute('aria-hidden', 'false');
}

function closeConfirm() {
  pendingConfirmAction = null;
  el.confirmOverlay.classList.add('hidden');
  el.confirmOverlay.setAttribute('aria-hidden', 'true');
}

function runConfirmAction() {
  const fn = pendingConfirmAction;
  pendingConfirmAction = null;
  closeConfirm();
  if (typeof fn === 'function') fn();
}

/* ============ مسح القائمة ============ */
function askReset() {
  showConfirm({
    title: 'تأكيد المسح',
    body:  'هل أنت متأكد أنك تريد مسح كل الأسماء والأرصدة؟',
    okText: 'نعم، امسح',
    danger: true,
    onOk: resetAll
  });
}

function resetAll() {
  state.winnerAmount = null;
  for (let i = 0; i < PLAYERS_COUNT; i++) {
    state.players[i].name = null;
    state.players[i].history = [];
    state.players[i].historyIndex = -1;
  }
  state.winnerShown = false;
  saveState();
  hideWinner();
  render();
}

/* ============ الأحداث ============ */
function bindEvents() {
  el.winnerAmountBtn.addEventListener('click', promptWinnerAmount);
  el.resetBtn.addEventListener('click', askReset);
  el.capitalBtn.addEventListener('click', promptCapital);

  el.confirmCancel.addEventListener('click', closeConfirm);
  el.confirmYes.addEventListener('click', runConfirmAction);
  el.confirmOverlay.addEventListener('click', (e) => {
    if (e.target === el.confirmOverlay) closeConfirm();
  });
  el.backBtn.addEventListener('click', hideWinner);

  setInterval(() => {
    renderPlayers();
    checkWinner();
  }, REFRESH_MS);

  // منع Double-tap zoom على iOS
  let lastTouch = 0;
  document.addEventListener('touchend', (e) => {
    const now = Date.now();
    if (now - lastTouch <= 300) e.preventDefault();
    lastTouch = now;
  }, { passive: false });
}

/* ============ الإقلاع ============ */
function init() {
  loadState();
  bindEvents();
  render();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
