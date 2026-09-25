'use strict';

/* ====================================================================
   المداقش — نشرة الحكم  (v7)
   - نسبة مئوية من مبلغ الفوز لتحديد اللون + خلفيات مصوّرة مخصصة
   - رصيد سالب → خلفية "السالب" + نص أحمر ساطع
   - إدخال الرصيد تراكمي (يُضاف/يُخصم على الرصيد الحالي) + زر − للخصم
   - إدخال مضمّن بدون نوافذ منبثقة
   - ترتيب تلقائي حي: الأعلى رصيداً فوق، الحقول بلا اسم رمادية بالأسفل
   - تراجع/تقدم عام (زران حول حقل مبلغ الفوز) لآخر تعديلات الرصيد
   - شاشة فوز بنظام الإقرار + زر "الفائز" اليدوي
   ==================================================================== */

const APP_VERSION    = 13;             // يجب أن يطابق version.json و ?v= في index.html
const PLAYERS_COUNT  = 10;
const STORAGE_KEY    = 'madagish.v1';
const REFRESH_MS     = 3000;
const ACTION_LOG_MAX = 200;
const UPDATE_CHECK_MS = 60000;         // فحص التحديثات كل دقيقة

/* عدّاد المتصلين — رابط قاعدة Firebase Realtime Database (BLUEPRINT §12) */
const PRESENCE_DB_URL   = 'https://madagish509-default-rtdb.firebaseio.com';
const PRESENCE_BEAT_MS  = 10000;       // نبضة "أنا متصل" + قراءة العدد كل 10 ثوان
const PRESENCE_FRESH_MS = 25000;       // يُعد متصلاً من نبض خلال آخر 25 ثانية

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
  return { name: null, balance: null };
}

const state = {
  winnerAmount: null,
  players: Array.from({ length: PLAYERS_COUNT }, newPlayer),
  actionLog: [],                   // سجل تعديلات الرصيد: {type:'balance',idx,from,to,logRef?} أو {type:'capital',changes:[...]}
  actionIndex: -1,                 // مؤشر آخر تعديل مُطبَّق
  capitalSet: false,               // هل أُدخل رأس المال؟ (يتحكم بظهور حقول الرصيد)
  roundsLog: [],                   // دفتر الجولات التوثيقي: {id, idx, name, amount, mark:null|'undo'|'redo'}
  roundsSeq: 0,                    // عدّاد معرفات أسطر الدفتر
  winnerShown: false,
  currentWinnerIdx: null,
  acknowledgedWinners: new Set()
};

/* ============ عناصر DOM ============ */
const el = {
  listScreen:          document.getElementById('listScreen'),
  winnerScreen:        document.getElementById('winnerScreen'),
  devScreen:           document.getElementById('devScreen'),
  roundsScreen:        document.getElementById('roundsScreen'),
  roundsTable:         document.getElementById('roundsTable'),
  devInfoBtn:          document.getElementById('devInfoBtn'),
  roundsBtn:           document.getElementById('roundsBtn'),
  devBackBtn:          document.getElementById('devBackBtn'),
  roundsBackBtn:       document.getElementById('roundsBackBtn'),
  winnerAmountInput:   document.getElementById('winnerAmountInput'),
  playersList:         document.getElementById('playersList'),
  resetBtn:            document.getElementById('resetBtn'),
  capitalBtn:          document.getElementById('capitalBtn'),
  showWinnerBtn:       document.getElementById('showWinnerBtn'),
  globalUndoBtn:       document.getElementById('globalUndoBtn'),
  globalRedoBtn:       document.getElementById('globalRedoBtn'),
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
  const isNeg = /^-/.test(trimmed);
  const digits = trimmed.replace(/\D/g, '');
  if (digits === '') return null;
  const n = parseInt(digits, 10);
  if (Number.isNaN(n)) return null;
  return isNeg ? -n : n;
}

function playerBalance(p) {
  if (!p) return null;
  return p.balance;
}

function playerLabel(idx) {
  return state.players[idx].name || `اللاعب ${idx + 1}`;
}

/* ============ ضبط عرض كبسولة الاسم على مقاس النص ============ */
let nameMeasurer = null;
function ensureNameMeasurer() {
  if (nameMeasurer) return nameMeasurer;
  nameMeasurer = document.createElement('span');
  nameMeasurer.style.cssText =
    'position:absolute;visibility:hidden;white-space:pre;top:-9999px;left:-9999px;pointer-events:none;';
  document.body.appendChild(nameMeasurer);
  return nameMeasurer;
}

function fitNameInput(input) {
  const m = ensureNameMeasurer();
  const cs = getComputedStyle(input);
  const usingPlaceholder = !input.value;
  m.style.fontFamily = cs.fontFamily;
  m.style.fontSize   = usingPlaceholder ? '13px' : cs.fontSize;
  m.style.fontWeight = usingPlaceholder ? '500'  : cs.fontWeight;
  m.textContent = input.value || input.placeholder || '';
  const w = m.offsetWidth + 28;   // padding الكبسولة + هامش صغير
  input.style.width = w + 'px';
}

function fitAllNameInputs() {
  document.querySelectorAll('.name-input').forEach(inp => fitNameInput(inp));
}

/* ============ التخزين + الترحيل ============ */
function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      winnerAmount: state.winnerAmount,
      players: state.players,
      actionLog: state.actionLog,
      actionIndex: state.actionIndex,
      capitalSet: state.capitalSet,
      roundsLog: state.roundsLog,
      roundsSeq: state.roundsSeq,
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
    if (Array.isArray(data.actionLog) && typeof data.actionIndex === 'number') {
      state.actionLog = data.actionLog.filter(a => a && typeof a === 'object');
      state.actionIndex = Math.min(Math.max(-1, data.actionIndex), state.actionLog.length - 1);
    }
    if (Array.isArray(data.roundsLog)) {
      state.roundsLog = data.roundsLog.filter(l => l && typeof l === 'object' && typeof l.amount === 'number');
    }
    if (typeof data.roundsSeq === 'number') state.roundsSeq = data.roundsSeq;
    if (typeof data.capitalSet === 'boolean') {
      state.capitalSet = data.capitalSet;
    }
    if (Array.isArray(data.players)) {
      for (let i = 0; i < PLAYERS_COUNT; i++) {
        const p = data.players[i];
        if (!p || typeof p !== 'object') continue;
        state.players[i].name = (typeof p.name === 'string' && p.name.trim()) ? p.name : null;

        // النموذج الجديد: balance مباشرة
        if (typeof p.balance === 'number' && !Number.isNaN(p.balance)) {
          state.players[i].balance = p.balance;
          continue;
        }
        // ترحيل من نموذج history القديم
        if (Array.isArray(p.history) && typeof p.historyIndex === 'number' &&
            p.historyIndex >= 0 && p.historyIndex < p.history.length) {
          const b = p.history[p.historyIndex];
          if (typeof b === 'number' && !Number.isNaN(b)) state.players[i].balance = b;
        }
      }
    }
    // ترحيل: نسخة قديمة بدون capitalSet — من عنده أرصدة محفوظة نعتبر رأس المال مُدخلاً
    // (حتى لا تختفي حقول الرصيد عن اللاعبين في منتصف اللعب)
    if (typeof data.capitalSet !== 'boolean') {
      state.capitalSet = state.players.some(p => p.balance !== null);
    }
  } catch (_) { /* تجاهل */ }
}

/* ============ دفتر جولات اللاعبين (توثيقي — لا يُحذف منه شيء) ============ */
const ROUNDS_LOG_MAX = 800;

function playerHasColumn(idx) {
  return state.roundsLog.some(l => l.idx === idx);
}

function lastLoggedName(idx) {
  for (let i = state.roundsLog.length - 1; i >= 0; i--) {
    if (state.roundsLog[i].idx === idx) return state.roundsLog[i].name;
  }
  return null;
}

/* يسجل سطر جولة جديداً ويعيد معرّفه — أو null إذا الحقل "فضولي" (لم يُسجل فيه اسم قط) */
function addRoundLine(idx, amount) {
  const currentName = state.players[idx].name;
  if (!currentName && !playerHasColumn(idx)) return null;   // حركة استكشافية — لا تُسجل
  const name = currentName || lastLoggedName(idx) || `اللاعب ${idx + 1}`;
  state.roundsSeq += 1;
  const line = { id: state.roundsSeq, idx, name, amount, mark: null };
  state.roundsLog.push(line);
  if (state.roundsLog.length > ROUNDS_LOG_MAX) {
    state.roundsLog = state.roundsLog.slice(state.roundsLog.length - ROUNDS_LOG_MAX);
  }
  return line.id;
}

function setRoundMark(lineId, mark) {
  if (!lineId) return;
  const line = state.roundsLog.find(l => l.id === lineId);
  if (line) line.mark = mark;
}

/* ============ سجل التعديلات العام (تراجع/تقدم) ============ */
function recordAction(action) {
  state.actionLog = state.actionLog.slice(0, state.actionIndex + 1);
  state.actionLog.push(action);
  if (state.actionLog.length > ACTION_LOG_MAX) {
    state.actionLog = state.actionLog.slice(state.actionLog.length - ACTION_LOG_MAX);
  }
  state.actionIndex = state.actionLog.length - 1;
}

function applyActionValues(action, useFrom) {
  if (action.type === 'balance') {
    state.players[action.idx].balance = useFrom ? action.from : action.to;
  } else if (action.type === 'capital') {
    for (const c of action.changes) {
      state.players[c.idx].balance = useFrom ? c.from : c.to;
    }
  }
}

function describeAction(action, useFrom) {
  if (action.type === 'balance') {
    const target = useFrom ? action.from : action.to;
    const t = target === null ? 'فارغ' : formatAmount(target);
    return `رصيد "${playerLabel(action.idx)}" إلى ${t}`;
  }
  if (action.type === 'capital') {
    return useFrom ? 'إلغاء توزيع رأس المال (يرجع الجميع لما قبله)' : 'إعادة توزيع رأس المال على الجميع';
  }
  return '';
}

function globalUndo() {
  if (state.actionIndex < 0) return;
  const action = state.actionLog[state.actionIndex];
  showConfirm({
    title: 'تأكيد التراجع',
    body:  `هل تريد إرجاع ${describeAction(action, true)}؟`,
    okText: 'نعم، تراجع',
    danger: false,
    onOk: () => {
      applyActionValues(action, true);
      state.actionIndex -= 1;
      // دفتر الجولات: علّم سطر الجولة المُلغاة بـ "تراجع" (لا يُحسب جولة)
      if (action.type === 'balance') setRoundMark(action.logRef, 'undo');
      state.winnerShown = false;
      saveState();
      refreshAfterBalanceChange();
      renderRoundsIfOpen();
    }
  });
}

function globalRedo() {
  if (state.actionIndex >= state.actionLog.length - 1) return;
  const action = state.actionLog[state.actionIndex + 1];
  showConfirm({
    title: 'تأكيد التقدم',
    body:  `هل تريد تقديم ${describeAction(action, false)}؟`,
    okText: 'نعم، تقدم',
    danger: false,
    onOk: () => {
      applyActionValues(action, false);
      state.actionIndex += 1;
      // دفتر الجولات: العلامة تتقلب على نفس السطر إلى "تقدم" (يُحسب جولة صحيحة)
      if (action.type === 'balance') setRoundMark(action.logRef, 'redo');
      state.winnerShown = false;
      saveState();
      refreshAfterBalanceChange();
      renderRoundsIfOpen();
    }
  });
}

function updateGlobalHistoryButtons() {
  if (el.globalUndoBtn) el.globalUndoBtn.disabled = state.actionIndex < 0;
  if (el.globalRedoBtn) el.globalRedoBtn.disabled = state.actionIndex >= state.actionLog.length - 1;
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
    const p = state.players[i];
    // حقل بدون اسم = غير نشط — لا يُلوَّن حتى لو كان فيه رصيد
    if (!p.name) { colors[i] = 'gray'; continue; }
    const b = playerBalance(p);
    if (b === null) { colors[i] = 'gray'; continue; }
    // رصيد سالب = خلفية "السالب" الخاصة + نص أحمر ساطع
    if (b < 0) { colors[i] = 'negative'; continue; }
    let percent = (b / w) * 100;
    if (percent > 100) percent = 100;
    colors[i] = pickColorFromPercent(percent);
  }
  return colors;
}

/* ============ الترتيب التلقائي (الأعلى رصيداً فوق) ============ */
function isEditingInsideList() {
  const a = document.activeElement;
  return a && a instanceof HTMLInputElement && a.closest && a.closest('#playersList');
}

function applyRowOrder() {
  const entries = [];
  for (let i = 0; i < PLAYERS_COUNT; i++) {
    const p = state.players[i];
    entries.push({ idx: i, named: !!p.name, b: playerBalance(p) });
  }
  const active = entries.filter(e => e.named).sort((a, b) => {
    const av = a.b === null ? -Infinity : a.b;
    const bv = b.b === null ? -Infinity : b.b;
    if (bv !== av) return bv - av;
    return a.idx - b.idx;
  });
  const order = new Array(PLAYERS_COUNT).fill(0);
  active.forEach((e, rank) => { order[e.idx] = rank; });
  entries.filter(e => !e.named).forEach(e => { order[e.idx] = 100 + e.idx; });

  document.querySelectorAll('.player-row').forEach(row => {
    const i = parseInt(row.dataset.idx, 10);
    if (!Number.isNaN(i)) row.style.order = String(order[i]);
  });
}

function applyColorsToRows() {
  const colors = computeColors();
  document.querySelectorAll('.player-row').forEach((row) => {
    const i = parseInt(row.dataset.idx, 10);
    if (!Number.isNaN(i)) row.setAttribute('data-color', colors[i]);
  });
  // إعادة الترتيب فقط عندما لا يكتب المستخدم داخل القائمة
  if (!isEditingInsideList()) applyRowOrder();
}

function refreshBalanceDisplays() {
  document.querySelectorAll('.balance-input').forEach(input => {
    if (input === document.activeElement) return;
    const i = parseInt(input.dataset.idx, 10);
    if (Number.isNaN(i)) return;
    const b = playerBalance(state.players[i]);
    input.value = b === null ? '' : formatAmount(b);
    input.placeholder = b === null ? 'الرصيد' : '';
  });
}

function refreshAfterBalanceChange() {
  refreshBalanceDisplays();
  applyColorsToRows();
  updateGlobalHistoryButtons();
  updateManualWinnerBtnState();
  checkWinner();
}

/* ============ حقل مبلغ الفوز (Inline) ============ */
function displayWinnerAmount() {
  const input = el.winnerAmountInput;
  if (input === document.activeElement) return;
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

    // 1) حقل الاسم (يمين)
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

    // 2) حقل الرصيد (أقصى اليسار مع زر الخصم)
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

    // 3) زر الخصم (−) — أقصى اليسار
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

    li.appendChild(nameInput);
    // حقول الرصيد وزر − تظهر فقط بعد إدخال رأس المال
    if (state.capitalSet) {
      li.appendChild(balanceInput);
      li.appendChild(subBtn);
    }
    list.appendChild(li);
  }

  applyRowOrder();
  fitAllNameInputs();
}

function bindNameInput(input, idx) {
  input.addEventListener('focus', () => {
    setTimeout(() => {
      try { input.select(); }
      catch (_) { try { input.setSelectionRange(0, input.value.length); } catch (__) {} }
    }, 30);
  });
  // الكبسولة تتمدد مع الكتابة حرفاً بحرف
  input.addEventListener('input', () => fitNameInput(input));
  input.addEventListener('blur', () => {
    const v = input.value.trim();
    state.players[idx].name = v === '' ? null : v;
    saveState();
    fitNameInput(input);
    applyColorsToRows();
    updateManualWinnerBtnState();
    checkWinner();
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
    delete input.dataset.mode;

    if (delta === null) {
      input.value = cur === null ? '' : formatAmount(cur);
      input.placeholder = cur === null ? 'الرصيد' : '';
      return;
    }

    let newBalance;
    if (delta === 0) {
      // قانون اللعبة: لا وجود للصفر — إدخال 0 يعني أن اللاعب صار سالب 1
      newBalance = -1;
    } else {
      if (isSub && delta > 0) delta = -delta;
      newBalance = (cur === null ? 0 : cur) + delta;
    }
    p.balance = newBalance;
    const action = { type: 'balance', idx, from: cur, to: newBalance };
    recordAction(action);
    action.logRef = addRoundLine(idx, newBalance);   // سطر في دفتر الجولات (أو null لحقل بلا اسم قط)

    state.winnerShown = false;
    saveState();

    // تحديث في المكان بدون إعادة رسم كامل
    input.value = formatAmount(newBalance);
    input.placeholder = '';
    applyColorsToRows();
    updateGlobalHistoryButtons();
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
  updateGlobalHistoryButtons();
  updateManualWinnerBtnState();
  checkWinner();
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
      const changes = [];
      for (let i = 0; i < PLAYERS_COUNT; i++) {
        changes.push({ idx: i, from: state.players[i].balance, to: parsed });
        state.players[i].balance = parsed;
      }
      recordAction({ type: 'capital', changes });
      // رأس المال لا يُسجَّل في دفتر الجولات ولا يُحسب جولة
      state.capitalSet = true;
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
    const p = state.players[i];
    if (!p.name) continue;                 // حقل بدون اسم = غير نشط، لا يفوز
    const b = playerBalance(p);
    if (b === null) continue;
    if (b >= w) {
      if (!state.acknowledgedWinners.has(i)) {
        showWinner(i);
        return;
      }
    } else {
      if (state.acknowledgedWinners.has(i)) {
        state.acknowledgedWinners.delete(i);
        saveState();
      }
    }
  }
}

function showAnyWinnerManually() {
  const w = state.winnerAmount;
  if (w === null) return false;
  for (let i = 0; i < PLAYERS_COUNT; i++) {
    const p = state.players[i];
    if (!p.name) continue;
    const b = playerBalance(p);
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
      const p = state.players[i];
      if (!p.name) continue;
      const b = playerBalance(p);
      if (b !== null && b >= w) { candidate = true; break; }
    }
  }
  el.showWinnerBtn.disabled = !candidate;
}

function showWinner(idx) {
  const p = state.players[idx];
  el.winnerName.textContent = p.name || 'لاعب بدون اسم';
  el.winnerAmountDisplay.textContent = formatAmount(playerBalance(p));
  closeSubScreens();
  el.listScreen.classList.add('hidden');
  el.winnerScreen.classList.remove('hidden');
  el.winnerScreen.setAttribute('aria-hidden', 'false');
  state.winnerShown = true;
  state.currentWinnerIdx = idx;
}

/* ============ الصفحات الفرعية (معلومات المطور / سجل الجولات) ============ */
function closeSubScreens() {
  el.devScreen.classList.add('hidden');
  el.devScreen.setAttribute('aria-hidden', 'true');
  el.roundsScreen.classList.add('hidden');
  el.roundsScreen.setAttribute('aria-hidden', 'true');
}

function openDevScreen() {
  if (state.winnerShown) return;   // شاشة الفوز لها الأولوية
  closeSubScreens();
  el.listScreen.classList.add('hidden');
  el.devScreen.classList.remove('hidden');
  el.devScreen.setAttribute('aria-hidden', 'false');
}

function openRoundsScreen() {
  if (state.winnerShown) return;
  closeSubScreens();
  renderRoundsTable();
  el.listScreen.classList.add('hidden');
  el.roundsScreen.classList.remove('hidden');
  el.roundsScreen.setAttribute('aria-hidden', 'false');
}

function backToList() {
  closeSubScreens();
  el.listScreen.classList.remove('hidden');
}

function renderRoundsIfOpen() {
  if (!el.roundsScreen.classList.contains('hidden')) renderRoundsTable();
}

function renderRoundsTable() {
  const table = el.roundsTable;
  table.innerHTML = '';

  // جمع الأعمدة: لاعب لديه أسطر مسجلة = عمود
  const columns = [];
  for (let i = 0; i < PLAYERS_COUNT; i++) {
    const lines = state.roundsLog.filter(l => l.idx === i);
    if (lines.length === 0) continue;
    const currentName = state.players[i].name;
    const displayName = currentName || lines[lines.length - 1].name;
    const count = lines.filter(l => l.mark !== 'undo').length;
    columns.push({ idx: i, displayName, count, lines, exited: !currentName });
  }

  if (columns.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'rounds-empty';
    empty.textContent = 'لا توجد جولات مسجلة بعد.';
    table.appendChild(empty);
    return;
  }

  for (const col of columns) {
    const colEl = document.createElement('div');
    colEl.className = 'round-col';

    const header = document.createElement('div');
    header.className = 'round-col-header';
    header.textContent = `${col.displayName} + ${col.count} جولات`;
    colEl.appendChild(header);

    for (const line of col.lines) {
      const lineEl = document.createElement('div');
      lineEl.className = 'round-line';

      const amountEl = document.createElement('span');
      amountEl.className = 'round-amount';
      amountEl.textContent = formatAmount(line.amount);
      lineEl.appendChild(amountEl);

      if (line.mark === 'undo') {
        const m = document.createElement('span');
        m.className = 'round-mark';
        m.textContent = 'تراجع';
        lineEl.appendChild(m);
      } else if (line.mark === 'redo') {
        const m = document.createElement('span');
        m.className = 'round-mark';
        m.textContent = 'تقدم';
        lineEl.appendChild(m);
      }
      colEl.appendChild(lineEl);
    }

    if (col.exited) {
      const exitEl = document.createElement('div');
      exitEl.className = 'round-exit';
      exitEl.textContent = 'خسر وخرج !';
      colEl.appendChild(exitEl);
    }

    table.appendChild(colEl);
  }
}

function hideWinner() {
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
    state.players[i].balance = null;
  }
  state.actionLog = [];
  state.actionIndex = -1;
  state.capitalSet = false;        // تختفي حقول الرصيد حتى يُدخل رأس مال جديد
  state.roundsLog = [];
  state.roundsSeq = 0;
  state.acknowledgedWinners.clear();
  state.winnerShown = false;
  state.currentWinnerIdx = null;
  saveState();
  closeSubScreens();
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
    if (e.target instanceof HTMLInputElement) return;
    if (e.target instanceof HTMLButtonElement) return;
    active.blur();
  });
}

/* ============ الأحداث ============ */
function bindEvents() {
  bindWinnerAmountInput();
  el.resetBtn.addEventListener('click', askReset);
  el.capitalBtn.addEventListener('click', promptCapital);
  el.showWinnerBtn.addEventListener('click', () => { showAnyWinnerManually(); });
  el.globalUndoBtn.addEventListener('click', globalUndo);
  el.globalRedoBtn.addEventListener('click', globalRedo);

  el.confirmCancel.addEventListener('click', closeConfirm);
  el.confirmYes.addEventListener('click', runConfirmAction);
  el.confirmOverlay.addEventListener('click', (e) => {
    if (e.target === el.confirmOverlay) closeConfirm();
  });
  el.backBtn.addEventListener('click', hideWinner);

  // الشريط السفلي والصفحات الفرعية
  el.devInfoBtn.addEventListener('click', openDevScreen);
  el.roundsBtn.addEventListener('click', openRoundsScreen);
  el.devBackBtn.addEventListener('click', backToList);
  el.roundsBackBtn.addEventListener('click', backToList);

  bindOutsideTapDismiss();

  setInterval(() => {
    applyColorsToRows();
    updateManualWinnerBtnState();
    checkWinner();
  }, REFRESH_MS);
}

/* ============ التحديث التلقائي (كسر كاش الجوال) ============ */
function startUpdateChecker() {
  function isUserBusy() {
    const a = document.activeElement;
    if (a && a instanceof HTMLInputElement) return true;                     // يكتب الآن
    if (!el.confirmOverlay.classList.contains('hidden')) return true;        // نافذة تأكيد مفتوحة
    return false;
  }

  async function check() {
    try {
      // cache: no-store + طابع زمني = يتجاوز كل أنواع الكاش حتى على iOS
      const res = await fetch('version.json?t=' + Date.now(), { cache: 'no-store' });
      if (!res.ok) return;
      const data = await res.json();
      if (!data || typeof data.v !== 'number') return;
      if (data.v === APP_VERSION) return;

      // منع حلقة تحديث لا نهائية لو تأخر انتشار الملفات
      const tag = 'madagish.reloadedFor.' + data.v;
      try { if (sessionStorage.getItem(tag)) return; } catch (_) {}

      if (isUserBusy()) { setTimeout(check, 20000); return; }               // أجّل حتى يفرغ الحكم

      try { sessionStorage.setItem(tag, '1'); } catch (_) {}
      location.reload();                                                     // البيانات آمنة في localStorage
    } catch (_) { /* أوفلاين أو خطأ شبكة — تجاهل بصمت */ }
  }

  check();
  setInterval(check, UPDATE_CHECK_MS);
  // أهم لحظة على الجوال: عودة المستخدم للتبويب/التطبيق من الخلفية
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') check();
  });
}

/* ============ عدّاد المتصلين الآن (Firebase REST — بدون مكتبات) ============ */
function startPresence() {
  if (!PRESENCE_DB_URL) return;   // الميزة معطلة حتى يُضبط الرابط
  const counterEl = document.getElementById('onlineCounter');
  const textEl    = document.getElementById('onlineCountText');
  if (!counterEl || !textEl) return;
  counterEl.classList.remove('hidden');

  // معرّف فريد لهذا التبويب
  let myId = null;
  try {
    myId = sessionStorage.getItem('madagish.presenceId');
    if (!myId) {
      myId = 'p' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
      sessionStorage.setItem('madagish.presenceId', myId);
    }
  } catch (_) {
    myId = 'p' + Math.random().toString(36).slice(2, 10);
  }

  const base   = PRESENCE_DB_URL.replace(/\/+$/, '');
  const myUrl  = `${base}/presence/${myId}.json`;
  const allUrl = `${base}/presence.json`;

  async function beatAndCount() {
    try {
      // 1) نبضة: سجّل نفسي بختم وقت السيرفر (لا نعتمد على ساعة الجهاز)
      await fetch(myUrl, {
        method: 'PUT',
        body: JSON.stringify({ ts: { '.sv': 'timestamp' } })
      });
      // 2) اقرأ الجميع واحسب من نبض حديثاً
      const res = await fetch(allUrl, { cache: 'no-store' });
      if (!res.ok) return;
      const data = await res.json();
      if (!data || typeof data !== 'object') {
        textEl.textContent = 'المتصلون الآن: 1';
        return;
      }
      let maxTs = 0;
      const entries = [];
      for (const k of Object.keys(data)) {
        const ts = (data[k] && typeof data[k].ts === 'number') ? data[k].ts : 0;
        entries.push({ k, ts });
        if (ts > maxTs) maxTs = ts;
      }
      // المقارنة نسبية لأحدث نبضة (ختم سيرفر) — مستقلة عن ساعات الأجهزة
      let count = 0;
      const stale = [];
      for (const e of entries) {
        if (maxTs - e.ts < PRESENCE_FRESH_MS) count++;
        else if (maxTs - e.ts > 120000) stale.push(e.k);
      }
      textEl.textContent = 'المتصلون الآن: ' + Math.max(1, count);
      // تنظيف عرضي للسجلات الميتة (من أغلق دون تسجيل خروج)
      if (stale.length && Math.random() < 0.25) {
        for (const k of stale.slice(0, 10)) {
          fetch(`${base}/presence/${k}.json`, { method: 'DELETE' }).catch(() => {});
        }
      }
    } catch (_) { /* أوفلاين — اترك آخر قيمة معروضة */ }
  }

  beatAndCount();
  setInterval(beatAndCount, PRESENCE_BEAT_MS);

  // عند إغلاق الصفحة: احذف سجلي (أفضل جهد)
  window.addEventListener('pagehide', () => {
    try { fetch(myUrl, { method: 'DELETE', keepalive: true }); } catch (_) {}
  });
}

/* ============ الإقلاع ============ */
function init() {
  loadState();
  bindEvents();
  render();
  startUpdateChecker();
  startPresence();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
