'use strict';

/* ====================================================================
   المداقش — نشرة الحكم  (v5)
   - نسبة مئوية من مبلغ الفوز لتحديد اللون
   - إدخال الرصيد تراكمي (يُضاف على الرصيد الحالي)
   - إدخال مضمّن (Inline): بدون نوافذ منبثقة
     • الاسم ومبلغ الفوز: عند اللمس يُحدَّد النص كاملاً — الكتابة تستبدله
     • الرصيد: عند اللمس يفرغ الحقل ويعرض placeholder — الكتابة تُدخِل المبلغ المُضاف
     • الحفظ يتم عند فقد التركيز (لمس أي مكان خارجي) أو زر "تم" في الكيبورد
   - سجل لكل لاعب مع أزرار تراجع/تقدم + تأكيد
   ==================================================================== */

const PLAYERS_COUNT = 10;
const STORAGE_KEY   = 'madagish.v1';
const REFRESH_MS    = 3000;

const COLOR_THRESHOLDS = [
  { min: 70, color: 'green'  },
  { min: 50, color: 'olive'  },
  { min: 35, color: 'yellow' },
  { min: 20, color: 'black'  },
  { min: 10, color: 'orange' },
  { min: 0,  color: 'red'    }
];

/* ============ الحالة ============ */
function newPlayer() {
  return { name: null, history: [], historyIndex: -1 };
}

const state = {
  winnerAmount: null,
  players: Array.from({ length: PLAYERS_COUNT }, newPlayer),
  winnerShown: false,
  currentWinnerIdx: null,          // من هو الفائز المعروض حالياً في شاشة الفوز
  acknowledgedWinners: new Set()   // لاعبون أقرّ الحكم بفوزهم — لا نعيد الإظهار تلقائياً
};

/* ============ عناصر DOM ============ */
const el = {
  listScreen:          document.getElementById('listScreen'),
  winnerScreen:        document.getElementById('winnerScreen'),
  winnerAmountInput:   document.getElementById('winnerAmountInput'),
  playersList:         document.getElementById('playersList'),
  resetBtn:            document.getElementById('resetBtn'),
  capitalBtn:          document.getElementById('capitalBtn'),
  showWinnerBtn:       document.getElementById('showWinnerBtn'),
  confirmOverlay:      document.getElementById('confirmOverlay'),
  confirmTitle:        document.getElementById('confirmTitle'),
  confirmText:         document.querySelector('#confirmOverlay .confirm-text'),
  confirmYes:          document.getElementById('confirmYes'),
  confirmCancel:       document.getElementById('confirmCancel'),
  winnerName:          document.getElementById('winnerName'),
  winnerAmountDisplay: document.getElementById('winnerAmountDisplay'),
  backBtn:             document.getElementById('backBtn')
};

/* ============ أدوات ============ */
function formatAmount(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '';
  return `$${n}k`;
}

function parseNonNegativeInt(str) {
  if (typeof str !== 'string') return null;
  const clean = str.replace(/\D/g, '');
  if (clean === '') return null;
  const n = parseInt(clean, 10);
  if (Number.isNaN(n)) return null;
  return n;
}

// يقبل الأرقام السالبة والموجبة — للاستخدام في حقل الرصيد
function parseSignedInt(str) {
  if (typeof str !== 'string') return null;
  const trimmed = str.trim();
  if (trimmed === '') return null;
  // نبقي على أول علامة ناقص إن وُجدت في البداية
  const isNeg = /^-/.test(trimmed);
  const digits = trimmed.replace(/\D/g, '');
  if (digits === '') return null;
  const n = parseInt(digits, 10);
  if (Number.isNaN(n)) return null;
  return isNeg ? -n : n;
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
      players: state.players,
      acknowledgedWinners: Array.from(state.acknowledgedWinners)
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
    if (Array.isArray(data.acknowledgedWinners)) {
      state.acknowledgedWinners = new Set(
        data.acknowledgedWinners.filter(n => typeof n === 'number' && n >= 0 && n < PLAYERS_COUNT)
      );
    }
    if (Array.isArray(data.players)) {
      for (let i = 0; i < PLAYERS_COUNT; i++) {
        const p = data.players[i];
        if (!p || typeof p !== 'object') continue;
        state.players[i].name = (typeof p.name === 'string' && p.name.trim()) ? p.name : null;

        if (Array.isArray(p.history) && typeof p.historyIndex === 'number') {
          const clean = p.history.filter(v => typeof v === 'number' && !Number.isNaN(v));
          state.players[i].history = clean;
          state.players[i].historyIndex = clean.length === 0
            ? -1
            : Math.min(Math.max(0, p.historyIndex), clean.length - 1);
          continue;
        }
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

/* ============ حقل مبلغ الفوز (Inline) ============ */
function displayWinnerAmount() {
  const input = el.winnerAmountInput;
  if (input === document.activeElement) return; // لا تلمسه أثناء الكتابة
  input.value = state.winnerAmount === null ? '' : formatAmount(state.winnerAmount);
}

function bindWinnerAmountInput() {
  const input = el.winnerAmountInput;

  input.addEventListener('focus', () => {
    input.value = state.winnerAmount === null ? '' : String(state.winnerAmount);
    setTimeout(() => {
      try { input.select(); }
      catch (_) { try { input.setSelectionRange(0, input.value.length); } catch (__) {} }
    }, 30);
  });

  input.addEventListener('blur', () => {
    const val = parseNonNegativeInt(input.value);
    const oldAmount = state.winnerAmount;
    if (val !== null && val > 0) {
      state.winnerAmount = val;
    }
    // إذا تغيّر مبلغ الفوز → مرجع جديد، ألغِ كل الإقرارات
    if (state.winnerAmount !== oldAmount) {
      state.acknowledgedWinners.clear();
      state.winnerShown = false;
    }
    saveState();
    displayWinnerAmount();
    applyColorsToRows();
    updateManualWinnerBtnState();
    checkWinner();
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
  });
}

/* ============ صفوف اللاعبين (Inline) ============ */
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

    // 1) حقل الاسم
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'player-input name-input';
    nameInput.placeholder = 'ادخل اسم اللاعب هنا';
    nameInput.setAttribute('enterkeyhint', 'done');
    nameInput.setAttribute('autocomplete', 'off');
    nameInput.dataset.idx = String(i);
    nameInput.dataset.kind = 'name';
    nameInput.value = p.name || '';
    bindNameInput(nameInput, i);

    // 2) حقل الرصيد
    const balanceInput = document.createElement('input');
    balanceInput.type = 'tel';
    balanceInput.className = 'player-input balance-input';
    balanceInput.setAttribute('inputmode', 'numeric');
    balanceInput.setAttribute('pattern', '[0-9]*');
    balanceInput.setAttribute('enterkeyhint', 'done');
    balanceInput.setAttribute('autocomplete', 'off');
    balanceInput.placeholder = balance === null ? 'الرصيد' : '';
    balanceInput.dataset.idx = String(i);
    balanceInput.dataset.kind = 'balance';
    balanceInput.value = balance === null ? '' : formatAmount(balance);
    bindBalanceInput(balanceInput, i);

    // 3) زر الخصم (−) — يفتح حقل الرصيد في وضع الخصم
    const subBtn = document.createElement('button');
    subBtn.type = 'button';
    subBtn.className = 'history-btn subtract-btn';
    subBtn.textContent = '−';
    subBtn.setAttribute('aria-label', 'خصم من الرصيد');
    subBtn.addEventListener('click', (e) => {
      e.preventDefault();
      balanceInput.dataset.mode = 'subtract';
      balanceInput.focus();
    });

    // 4) زر التراجع
    const undoBtn = document.createElement('button');
    undoBtn.type = 'button';
    undoBtn.className = 'history-btn undo-btn';
    undoBtn.textContent = '↶';
    undoBtn.setAttribute('aria-label', 'تراجع');
    const canUndo = p.historyIndex > 0;
    if (!canUndo) undoBtn.disabled = true;
    undoBtn.addEventListener('click', () => onUndoClick(i));

    // 5) زر التقدم
    const redoBtn = document.createElement('button');
    redoBtn.type = 'button';
    redoBtn.className = 'history-btn redo-btn';
    redoBtn.textContent = '↷';
    redoBtn.setAttribute('aria-label', 'تقدم');
    const canRedo = p.historyIndex >= 0 && p.historyIndex < p.history.length - 1;
    if (!canRedo) redoBtn.disabled = true;
    redoBtn.addEventListener('click', () => onRedoClick(i));

    li.appendChild(nameInput);
    li.appendChild(balanceInput);
    li.appendChild(subBtn);
    li.appendChild(undoBtn);
    li.appendChild(redoBtn);
    list.appendChild(li);
  }
}

function applyColorsToRows() {
  const colors = computeColors();
  document.querySelectorAll('.player-row').forEach((row, i) => {
    row.setAttribute('data-color', colors[i]);
  });
}

function updateHistoryButtons(idx) {
  const p = state.players[idx];
  const row = document.querySelector(`.player-row[data-idx="${idx}"]`);
  if (!row) return;
  const undo = row.querySelector('.undo-btn');
  const redo = row.querySelector('.redo-btn');
  if (undo) undo.disabled = !(p.historyIndex > 0);
  if (redo) redo.disabled = !(p.historyIndex >= 0 && p.historyIndex < p.history.length - 1);
}

function bindNameInput(input, idx) {
  input.addEventListener('focus', () => {
    setTimeout(() => {
      try { input.select(); }
      catch (_) { try { input.setSelectionRange(0, input.value.length); } catch (__) {} }
    }, 30);
  });
  input.addEventListener('blur', () => {
    const v = input.value.trim();
    state.players[idx].name = v === '' ? null : v;
    saveState();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
  });
}

function bindBalanceInput(input, idx) {
  input.addEventListener('focus', () => {
    const p = state.players[idx];
    input.value = '';
    const cur = playerBalance(p);
    const isSub = input.dataset.mode === 'subtract';
    if (cur === null) {
      input.placeholder = 'أدخل الرصيد';
    } else if (isSub) {
      input.placeholder = `− من ${formatAmount(cur)} — اكتب المخصوم`;
    } else {
      input.placeholder = `+ ${formatAmount(cur)} — اكتب المضاف`;
    }
    setTimeout(() => {
      try { input.setSelectionRange(0, 0); } catch (_) {}
    }, 30);
  });

  input.addEventListener('blur', () => {
    const p = state.players[idx];
    const raw = input.value.trim();
    let delta = parseSignedInt(raw);
    const cur = playerBalance(p);
    const isSub = input.dataset.mode === 'subtract';
    delete input.dataset.mode;   // إعادة تعيين الوضع بعد كل إدخال

    if (delta === null || delta === 0) {
      input.value = cur === null ? '' : formatAmount(cur);
      input.placeholder = cur === null ? 'الرصيد' : '';
      return;
    }

    // إذا كان زر "−" مضغوطاً والمستخدم كتب رقماً موجباً → طبّق الخصم
    if (isSub && delta > 0) delta = -delta;

    const newBalance = (cur === null ? 0 : cur) + delta;
    p.history = p.history.slice(0, p.historyIndex + 1);
    p.history.push(newBalance);
    p.historyIndex = p.history.length - 1;

    state.winnerShown = false;
    saveState();

    // إذا كان اللاعب مقرَّاً به سابقاً ثم تجاوز مجدداً — checkWinner يعالج الحالة
    // (لأن هذا الرصيد الجديد قد يكون أعلى، لكن لا يزال مُقَرّاً به)
    // لا نلغي الإقرار هنا لأنه فوق العتبة أصلاً — checkWinner لا يمسحه إلا إذا نزل تحتها

    // تحديث في المكان بدون إعادة رسم كامل (يحفظ التركيز إذا انتقل المستخدم لحقل آخر)
    input.value = formatAmount(newBalance);
    input.placeholder = '';
    applyColorsToRows();
    updateHistoryButtons(idx);
    updateManualWinnerBtnState();
    checkWinner();
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
  });
}

function render() {
  displayWinnerAmount();
  renderPlayers();
  updateManualWinnerBtnState();
  checkWinner();
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
  showPromptModal({
    title: 'رأس المال',
    body:  'سيوزّع على كل اللاعبين العشرة. اكتب المبلغ بالآلاف:',
    okText: 'تطبيق',
    inputType: 'tel',
    placeholder: 'مثال: 20',
    onOk: (val) => {
      const parsed = parseNonNegativeInt(val);
      if (parsed === null) return;
      for (let i = 0; i < PLAYERS_COUNT; i++) {
        state.players[i].history = [parsed];
        state.players[i].historyIndex = 0;
      }
      state.acknowledgedWinners.clear();
      state.winnerShown = false;
      saveState();
      render();
    }
  });
}

/* ============ الفائز ============ */
function checkWinner() {
  const w = state.winnerAmount;
  if (w === null) return;
  if (state.winnerShown) return;

  for (let i = 0; i < PLAYERS_COUNT; i++) {
    const b = playerBalance(state.players[i]);
    if (b === null) continue;
    if (b >= w) {
      // فوق العتبة: اعرض الشاشة إذا لم يُقَرَّ به بعد
      if (!state.acknowledgedWinners.has(i)) {
        showWinner(i);
        return;
      }
    } else {
      // تحت العتبة: إذا كان مُقَرّاً به سابقاً، ألغِ الإقرار
      // بحيث لو صعد فوق العتبة مجدداً تظهر الشاشة تلقائياً
      if (state.acknowledgedWinners.has(i)) {
        state.acknowledgedWinners.delete(i);
        saveState();
      }
    }
  }
}

// إظهار يدوي: يبحث عن أي لاعب فوق العتبة (يتجاهل الإقرار) ويفتح شاشته
function showAnyWinnerManually() {
  const w = state.winnerAmount;
  if (w === null) return false;
  for (let i = 0; i < PLAYERS_COUNT; i++) {
    const b = playerBalance(state.players[i]);
    if (b !== null && b >= w) {
      showWinner(i);
      return true;
    }
  }
  return false;
}

function updateManualWinnerBtnState() {
  if (!el.showWinnerBtn) return;
  const w = state.winnerAmount;
  let candidate = false;
  if (w !== null) {
    for (let i = 0; i < PLAYERS_COUNT; i++) {
      const b = playerBalance(state.players[i]);
      if (b !== null && b >= w) { candidate = true; break; }
    }
  }
  el.showWinnerBtn.disabled = !candidate;
}

function showWinner(idx) {
  const p = state.players[idx];
  el.winnerName.textContent = p.name || 'لاعب بدون اسم';
  el.winnerAmountDisplay.textContent = formatAmount(playerBalance(p));
  el.listScreen.classList.add('hidden');
  el.winnerScreen.classList.remove('hidden');
  el.winnerScreen.setAttribute('aria-hidden', 'false');
  state.winnerShown = true;
  state.currentWinnerIdx = idx;
}

function hideWinner() {
  // أقرَّ الحكم برؤية هذا الفائز — لا نعيد إظهاره تلقائياً
  if (state.currentWinnerIdx !== null && state.currentWinnerIdx >= 0) {
    state.acknowledgedWinners.add(state.currentWinnerIdx);
    saveState();
  }
  el.winnerScreen.classList.add('hidden');
  el.winnerScreen.setAttribute('aria-hidden', 'true');
  el.listScreen.classList.remove('hidden');
  state.winnerShown = false;
  state.currentWinnerIdx = null;
  updateManualWinnerBtnState();
}

/* ============ صندوق التأكيد + Prompt المضمّن ============ */
let pendingConfirmAction = null;

function showConfirm(opts) {
  el.confirmTitle.textContent = opts.title || 'تأكيد';
  el.confirmText.textContent  = opts.body  || '';
  el.confirmYes.textContent   = opts.okText || 'نعم';
  el.confirmYes.className = opts.danger ? 'btn-danger' : 'btn-primary';
  pendingConfirmAction = typeof opts.onOk === 'function' ? opts.onOk : null;
  const existingInput = document.getElementById('confirmInlineInput');
  if (existingInput) existingInput.remove();
  el.confirmOverlay.classList.remove('hidden');
  el.confirmOverlay.setAttribute('aria-hidden', 'false');
}

function showPromptModal(opts) {
  el.confirmTitle.textContent = opts.title || 'إدخال';
  el.confirmText.textContent  = opts.body  || '';
  el.confirmYes.textContent   = opts.okText || 'موافق';
  el.confirmYes.className = 'btn-primary';

  let inp = document.getElementById('confirmInlineInput');
  if (!inp) {
    inp = document.createElement('input');
    inp.id = 'confirmInlineInput';
    inp.style.cssText = 'width:100%;padding:12px;font-size:18px;border:2px solid #d1d5db;border-radius:8px;margin:12px 0 16px;text-align:center;font-weight:700;font-family:inherit;outline:none;box-sizing:border-box;';
    el.confirmText.insertAdjacentElement('afterend', inp);
  }
  inp.type = opts.inputType || 'text';
  if (opts.inputType === 'tel') {
    inp.setAttribute('inputmode', 'numeric');
    inp.setAttribute('pattern', '[0-9]*');
  }
  inp.value = opts.initial || '';
  inp.placeholder = opts.placeholder || '';

  pendingConfirmAction = () => {
    const v = inp.value;
    if (typeof opts.onOk === 'function') opts.onOk(v);
  };

  el.confirmOverlay.classList.remove('hidden');
  el.confirmOverlay.setAttribute('aria-hidden', 'false');
  setTimeout(() => { try { inp.focus(); inp.select(); } catch (_) {} }, 100);
}

function closeConfirm() {
  pendingConfirmAction = null;
  el.confirmOverlay.classList.add('hidden');
  el.confirmOverlay.setAttribute('aria-hidden', 'true');
  const inp = document.getElementById('confirmInlineInput');
  if (inp) inp.remove();
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
  state.acknowledgedWinners.clear();
  state.winnerShown = false;
  state.currentWinnerIdx = null;
  saveState();
  // إغلاق شاشة الفوز إذا كانت مفتوحة، بدون إقرار (كل شيء مُمسَح)
  el.winnerScreen.classList.add('hidden');
  el.winnerScreen.setAttribute('aria-hidden', 'true');
  el.listScreen.classList.remove('hidden');
  render();
}

/* ============ اللمس خارج الحقل لإغلاق الكيبورد ============ */
function bindOutsideTapDismiss() {
  document.addEventListener('pointerdown', (e) => {
    const active = document.activeElement;
    if (!active || !(active instanceof HTMLInputElement)) return;
    if (e.target === active) return;
    if (e.target instanceof HTMLInputElement) return;   // انتقال بين حقول
    if (e.target instanceof HTMLButtonElement) return;  // زر undo/redo/reset/capital يقوم بالباقي
    active.blur();
  });
}

/* ============ الأحداث ============ */
function bindEvents() {
  bindWinnerAmountInput();
  el.resetBtn.addEventListener('click', askReset);
  el.capitalBtn.addEventListener('click', promptCapital);
  el.showWinnerBtn.addEventListener('click', () => { showAnyWinnerManually(); });

  el.confirmCancel.addEventListener('click', closeConfirm);
  el.confirmYes.addEventListener('click', runConfirmAction);
  el.confirmOverlay.addEventListener('click', (e) => {
    if (e.target === el.confirmOverlay) closeConfirm();
  });
  el.backBtn.addEventListener('click', hideWinner);

  bindOutsideTapDismiss();

  // إعادة تقييم الألوان دورياً بدون تدمير التركيز
  setInterval(() => {
    applyColorsToRows();
    updateManualWinnerBtnState();
    checkWinner();
  }, REFRESH_MS);
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
