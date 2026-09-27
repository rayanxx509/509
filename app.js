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

const APP_VERSION    = 30;             // يجب أن يطابق version.json و ?v= في index.html
const PLAYERS_COUNT  = 10;
const STORAGE_KEY    = 'madagish.v1';
const REFRESH_MS     = 3000;
const ACTION_LOG_MAX = 200;
const UPDATE_CHECK_MS = 60000;         // فحص التحديثات كل دقيقة

/* عدّاد المتصلين — رابط قاعدة Firebase Realtime Database (BLUEPRINT §12) */
const PRESENCE_DB_URL   = 'https://madagish509-default-rtdb.firebaseio.com';
const PRESENCE_BEAT_MS  = 10000;       // نبضة "أنا متصل" + قراءة العدد كل 10 ثوان
const PRESENCE_FRESH_MS = 25000;       // يُعد متصلاً من نبض خلال آخر 25 ثانية

/* مشاركة النشرة (بث مباشر للمشاهدين) */
const SHARE_POLL_MS       = 2500;      // المشاهد يفحص رقم المراجعة كل 2.5 ثانية
const SHARE_VIEWERS_MS    = 10000;     // نبضة المشاهد + تحديث عدد المشاهدين كل 10 ثوان
const SHARE_PUSH_DEBOUNCE = 500;       // الحكم يدفع الحالة بعد نصف ثانية من آخر تعديل

/* وضع المشاهدة: يتحدد من الرابط ?view=ID قبل أي شيء */
const VIEW_PARAMS  = new URLSearchParams(location.search);
const VIEWER_MODE  = VIEW_PARAMS.has('view');
const VIEW_SHARE_ID = VIEWER_MODE ? String(VIEW_PARAMS.get('view')).replace(/[^A-Za-z0-9_-]/g, '') : null;

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
  shareId: null,                   // معرّف المشاركة النشطة (عند الحكم)
  shareRev: 0,                     // رقم مراجعة يتزايد مع كل دفعة (للمشاهدين)
  winnerEvent: 0,                  // يتزايد مع كل ظهور لشاشة الفوز (مزامنة انبثاقها عند المشاهدين)
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
  winnerVideo:         document.getElementById('winnerVideo'),
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

/* تنقية صامتة: إزالة أي روابط من النص (حماية خلفية بدون إشعار المستخدم) */
function stripLinks(s) {
  if (typeof s !== 'string') return s;
  return s
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/www\.\S+/gi, '')
    .replace(/\S+\.(com|net|org|io|co|me|xyz|info|link|site|online|shop|tv|cc|app|dev|gg)(\/\S*)?/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/* ============ إشعار عابر (Toast) ============ */
let toastTimer = null;
function showToast(text) {
  let t = document.getElementById('appToast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'appToast';
    t.className = 'app-toast';
    document.body.appendChild(t);
  }
  t.textContent = text;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2400);
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
  if (VIEWER_MODE) return;   // المشاهد لا يكتب شيئاً — عزل تام عن تخزينة جهازه
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      winnerAmount: state.winnerAmount,
      players: state.players,
      actionLog: state.actionLog,
      actionIndex: state.actionIndex,
      capitalSet: state.capitalSet,
      roundsLog: state.roundsLog,
      roundsSeq: state.roundsSeq,
      shareId: state.shareId,
      winnerEvent: state.winnerEvent,
      acknowledgedWinners: Array.from(state.acknowledgedWinners)
    }));
  } catch (_) { /* تجاهل */ }
  schedulePushBoard();       // إن كانت المشاركة نشطة، ادفع الحالة للمشاهدين
}

function loadState() {
  if (VIEWER_MODE) return;   // المشاهد يستمد حالته من المشاركة، لا من تخزينة جهازه
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
    if (typeof data.shareId === 'string' && data.shareId) state.shareId = data.shareId;
    if (typeof data.winnerEvent === 'number') state.winnerEvent = data.winnerEvent;
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
    if (VIEWER_MODE) nameInput.setAttribute('readonly', '');
    else bindNameInput(nameInput, i);

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
    if (VIEWER_MODE) balanceInput.setAttribute('readonly', '');
    else bindBalanceInput(balanceInput, i);

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
    const v = stripLinks(input.value.trim());   // حماية خلفية: لا روابط في أسماء اللاعبين
    input.value = v;
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

    // إشعار عابر يوضح للحكم ماذا حدث بالضبط (يكشف الأخطاء فوراً)
    if (delta === 0) {
      showToast(`القانون: 0 = الرصيد ${formatAmount(-1)}`);
    } else if (delta > 0) {
      showToast(`أُضيف ${delta} — الرصيد ${formatAmount(newBalance)}`);
    } else {
      showToast(`خُصم ${-delta} — الرصيد ${formatAmount(newBalance)}`);
    }

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
  if (VIEWER_MODE) return;   // عند المشاهد: شاشة الفوز تُقاد من بث الحكم فقط
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

/* ملء الشاشة الحقيقي حيثما يدعمه المتصفح (أندرويد/كمبيوتر) — يفشل بصمت على iOS Safari */
function tryEnterFullscreen(target) {
  try {
    if (target.requestFullscreen) {
      const p = target.requestFullscreen();
      if (p && p.catch) p.catch(() => {});
    } else if (target.webkitRequestFullscreen) {
      target.webkitRequestFullscreen();
    }
  } catch (_) {}
}

function tryExitFullscreen() {
  try {
    if (document.fullscreenElement && document.exitFullscreen) {
      const p = document.exitFullscreen();
      if (p && p.catch) p.catch(() => {});
    } else if (document.webkitFullscreenElement && document.webkitExitFullscreen) {
      document.webkitExitFullscreen();
    }
  } catch (_) {}
}

function setBottomBarVisible(visible) {
  const bar = document.getElementById('bottomBar');
  if (!bar) return;
  bar.classList.toggle('hidden', !visible);
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
  // حدث فوز جديد — يُبثّ للمشاهدين لينبثق عندهم بالتزامن (جهة الحكم فقط)
  if (!VIEWER_MODE) {
    state.winnerEvent += 1;
    saveState();
  }
  // غمر كامل: إخفاء الشريط السفلي + محاولة ملء الشاشة
  setBottomBarVisible(false);
  tryEnterFullscreen(el.winnerScreen);
  // تشغيل فيديو الاحتفال من البداية (مكتوم + لوب)
  try {
    el.winnerVideo.currentTime = 0;
    const pr = el.winnerVideo.play();
    if (pr && pr.catch) pr.catch(() => {});
  } catch (_) {}
}

/* ============ الصفحات الفرعية (معلومات المطور / سجل الجولات) ============ */
function closeSubScreens() {
  el.devScreen.classList.add('hidden');
  el.devScreen.setAttribute('aria-hidden', 'true');
  el.roundsScreen.classList.add('hidden');
  el.roundsScreen.setAttribute('aria-hidden', 'true');
  const ps = document.getElementById('profileScreen');
  if (ps) ps.classList.add('hidden');
  const os = document.getElementById('ownerScreen');
  if (os) os.classList.add('hidden');
}

function openDevScreen() {
  if (state.winnerShown) return;   // شاشة الفوز لها الأولوية
  closeSubScreens();
  el.listScreen.classList.add('hidden');
  el.devScreen.classList.remove('hidden');
  el.devScreen.setAttribute('aria-hidden', 'false');
  refreshStatsDisplay();
  fetchMonthlyVisits();
  fetchYearlyUsers();
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
  if (typeof ensureChatAlive === 'function') ensureChatAlive();
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
  try { el.winnerVideo.pause(); } catch (_) {}
  tryExitFullscreen();
  setBottomBarVisible(true);
  el.winnerScreen.classList.add('hidden');
  el.winnerScreen.setAttribute('aria-hidden', 'true');
  el.listScreen.classList.remove('hidden');
  state.winnerShown = false;
  state.currentWinnerIdx = null;
  updateManualWinnerBtnState();
}

/* ============ صندوق التأكيد + Prompt المضمّن ============ */
let pendingConfirmAction = null;
let confirmMandatory = false;   // نافذة إجبارية: لا إلغاء ولا إغلاق بالضغط خارجها

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
  } else {
    inp.removeAttribute('inputmode');
    inp.removeAttribute('pattern');
  }
  if (opts.readonly) { inp.setAttribute('readonly', ''); inp.style.direction = 'ltr'; inp.style.fontSize = '13px'; }
  else { inp.removeAttribute('readonly'); inp.style.direction = ''; inp.style.fontSize = '18px'; }
  inp.value = opts.initial || '';
  inp.placeholder = opts.placeholder || '';

  confirmMandatory = !!opts.mandatory;
  el.confirmCancel.classList.toggle('hidden', confirmMandatory);

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
  confirmMandatory = false;
  el.confirmCancel.classList.remove('hidden');
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
  try { el.winnerVideo.pause(); } catch (_) {}
  tryExitFullscreen();
  setBottomBarVisible(true);
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
    if (e.target === el.confirmOverlay && !confirmMandatory) closeConfirm();
  });
  el.backBtn.addEventListener('click', hideWinner);

  // الشريط السفلي والصفحات الفرعية
  document.getElementById('homeBtn').addEventListener('click', backToList);
  el.devInfoBtn.addEventListener('click', openDevScreen);
  el.roundsBtn.addEventListener('click', openRoundsScreen);
  el.devBackBtn.addEventListener('click', backToList);
  el.roundsBackBtn.addEventListener('click', backToList);
  document.getElementById('shareBtn').addEventListener('click', onShareBtnClick);
  bindChatEvents();
  bindChatLayout();
  bindProfileEvents();

  bindOutsideTapDismiss();

  setInterval(() => {
    // مزامنة مؤجلة من تبويب آخر (كانت الكتابة جارية وقت وصولها)
    if (pendingStorageSync && !(document.activeElement instanceof HTMLInputElement)) {
      pendingStorageSync = false;
      reloadFromStorage();
      return;
    }
    applyColorsToRows();
    updateManualWinnerBtnState();
    checkWinner();
    ensureChatAlive();   // ضمان صارم: الدردشة لا تختفي أبداً أثناء مشاركة نشطة
  }, REFRESH_MS);
}

/* ============ مزامنة التبويبات على نفس الجهاز ============
   لو الحكم فتح الرابط في تبويبين، أي كتابة من تبويب تُحدِّث الآخر فوراً
   — يمنع تضارب الحالات (فوز خاطئ من مبلغ قديم، قفزات أرصدة). */
let pendingStorageSync = false;

function reloadFromStorage() {
  state.winnerAmount = null;
  state.players = Array.from({ length: PLAYERS_COUNT }, newPlayer);
  state.actionLog = [];
  state.actionIndex = -1;
  state.capitalSet = false;
  state.roundsLog = [];
  state.roundsSeq = 0;
  state.acknowledgedWinners = new Set();
  loadState();
  render();
  renderRoundsIfOpen();
}

function bindCrossTabSync() {
  window.addEventListener('storage', (e) => {
    if (e.key !== STORAGE_KEY) return;
    // لا نقاطع الحكم وهو يكتب — نؤجل للمزامنة عند أول فرصة
    if (document.activeElement instanceof HTMLInputElement) {
      pendingStorageSync = true;
      return;
    }
    reloadFromStorage();
  });
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

/* ====================================================================
   مشاركة النشرة — بث مباشر للمشاهدين (Firebase REST)
   الحكم يدفع الحالة مع كل تعديل؛ المشاهد يقرأها فقط (قراءة نقية).
   ==================================================================== */
const DB_BASE = PRESENCE_DB_URL.replace(/\/+$/, '');

function boardUrl(id, path) {
  return `${DB_BASE}/boards/${id}/${path}.json`;
}

function makeShareId() {
  let s = '';
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
  for (let i = 0; i < 10; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

function shareLink(id) {
  return `${location.origin}${location.pathname}?view=${id}`;
}

function buildSnapshot() {
  return {
    rev: state.shareRev,
    ended: false,
    winnerEvent: state.winnerEvent,
    winnerShown: state.winnerShown,
    winnerIdx: state.currentWinnerIdx,
    data: {
      winnerAmount: state.winnerAmount,
      players: state.players,
      capitalSet: state.capitalSet,
      roundsLog: state.roundsLog
    }
  };
}

/* --- جهة الحكم: دفع الحالة --- */
let pushTimer = null;
function schedulePushBoard() {
  if (VIEWER_MODE || !state.shareId) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(pushBoard, SHARE_PUSH_DEBOUNCE);
}

async function pushBoard() {
  if (VIEWER_MODE || !state.shareId) return;
  try {
    state.shareRev += 1;
    await fetch(boardUrl(state.shareId, 'state'), {
      method: 'PUT',
      body: JSON.stringify(buildSnapshot())
    });
    // فهرس النشرات الحية — للوحة المالك
    fetch(`${DB_BASE}/live/${state.shareId}.json`, {
      method: 'PUT',
      body: JSON.stringify({ ts: { '.sv': 'timestamp' }, n: getNick() || 'حكم' })
    }).catch(() => {});
  } catch (_) { /* أوفلاين — سيُدفع مع التعديل التالي */ }
}

function startSharing() {
  state.shareId = makeShareId();
  state.shareRev = 0;
  saveState();               // يحفظ + يدفع أول نسخة
  updateShareBtn();
  startShareViewersLoop();
  startChat(state.shareId, true);
  openShareDialog();
}

function stopSharing() {
  const id = state.shareId;
  state.shareId = null;
  saveState();
  updateShareBtn();
  stopChat();
  if (id) {
    // شاهد التوقف: صفحة إجبارية عند المشاهدين، والرابط يموت للأبد
    fetch(boardUrl(id, 'state'), {
      method: 'PUT',
      body: JSON.stringify({ ended: true, rev: state.shareRev + 1 })
    }).catch(() => {});
    // تنظيف الدردشة والنبضات وقائمة الكتم (توفير مساحة القاعدة)
    fetch(`${DB_BASE}/boards/${id}/chat.json`,    { method: 'DELETE' }).catch(() => {});
    fetch(`${DB_BASE}/boards/${id}/viewers.json`, { method: 'DELETE' }).catch(() => {});
    fetch(`${DB_BASE}/boards/${id}/muted.json`,   { method: 'DELETE' }).catch(() => {});
    fetch(`${DB_BASE}/live/${id}.json`,           { method: 'DELETE' }).catch(() => {});
  }
}

function onShareBtnClick() {
  if (VIEWER_MODE) {
    // المشاهد: نفس رابط الحكم دائماً، بلا إيقاف
    openShareDialog(shareLink(VIEW_SHARE_ID));
    return;
  }
  if (state.shareId) {
    showConfirm({
      title: 'إيقاف المشاركة',
      body:  'هل تريد إنهاء المشاركة؟ ستظهر للمشاهدين صفحة انتهاء المشاركة فوراً.',
      okText: 'نعم، أوقف',
      danger: true,
      onOk: stopSharing
    });
  } else {
    startSharing();
  }
}

function openShareDialog(link) {
  const url = link || shareLink(state.shareId);
  showPromptModal({
    title: 'مشاركة النشرة',
    body:  'انسخ الرابط وأرسله لمن تريد أن يشاهد النشرة مباشرة:',
    okText: 'نسخ الرابط',
    inputType: 'text',
    initial: url,
    readonly: true,
    onOk: async () => {
      let ok = false;
      try { await navigator.clipboard.writeText(url); ok = true; } catch (_) {}
      showToast(ok ? 'تم نسخ الرابط ✓' : url);
    }
  });
}

function updateShareBtn() {
  const label = document.getElementById('shareBtnLabel');
  const sub   = document.getElementById('shareViewersCount');
  if (!label || !sub) return;
  if (VIEWER_MODE) {
    label.textContent = 'مشاركة النشرة';
    sub.classList.remove('hidden');
  } else if (state.shareId) {
    label.textContent = 'إيقاف المشاركة';
    sub.classList.remove('hidden');
  } else {
    label.textContent = 'مشاركة النشرة';
    sub.classList.add('hidden');
  }
}

/* --- عدّاد المشاهدين (حكم + مشاهد) --- */
let shareViewersTimer = null;
function activeShareIdForViewers() {
  return VIEWER_MODE ? VIEW_SHARE_ID : state.shareId;
}

async function refreshShareViewersCount() {
  const id = activeShareIdForViewers();
  if (!id) return;
  try {
    const res = await fetch(`${DB_BASE}/boards/${id}/viewers.json?t=` + Date.now(), { cache: 'no-store' });
    if (!res.ok) return;
    const data = await res.json();
    let count = 0;
    if (data && typeof data === 'object') {
      let maxTs = 0;
      const entries = Object.keys(data).map(k => (data[k] && typeof data[k].ts === 'number') ? data[k].ts : 0);
      for (const ts of entries) if (ts > maxTs) maxTs = ts;
      for (const ts of entries) if (maxTs - ts < PRESENCE_FRESH_MS) count++;
    }
    const sub = document.getElementById('shareViewersCount');
    if (sub) sub.textContent = `👁 ${count}`;
  } catch (_) {}
}

function startShareViewersLoop() {
  clearInterval(shareViewersTimer);
  shareViewersTimer = setInterval(refreshShareViewersCount, SHARE_VIEWERS_MS);
  refreshShareViewersCount();
}

/* --- جهة المشاهد: السحب والمزامنة --- */
let viewerLastRev = -1;
let viewerLastEvent = null;
let viewerPollTimer = null;
let viewerEnded = false;
let viewerId = null;

function showEndedScreen() {
  viewerEnded = true;
  clearInterval(viewerPollTimer);
  clearInterval(shareViewersTimer);
  stopChat();
  document.getElementById('endedScreen').classList.remove('hidden');
  setBottomBarVisible(false);
  try { el.winnerVideo.pause(); } catch (_) {}
}

function applySnapshot(snap) {
  const d = snap.data || {};
  state.winnerAmount = (typeof d.winnerAmount === 'number') ? d.winnerAmount : null;
  if (Array.isArray(d.players)) {
    for (let i = 0; i < PLAYERS_COUNT; i++) {
      const p = d.players[i];
      state.players[i].name    = (p && typeof p.name === 'string' && p.name.trim()) ? p.name : null;
      state.players[i].balance = (p && typeof p.balance === 'number') ? p.balance : null;
    }
  }
  state.capitalSet = !!d.capitalSet;
  state.roundsLog = Array.isArray(d.roundsLog) ? d.roundsLog : [];

  displayWinnerAmount();
  renderPlayers();
  updateManualWinnerBtnState();
  renderRoundsIfOpen();

  // انبثاق شاشة الفوز بالتزامن مع الحكم (مرة واحدة لكل حدث فوز)
  const ev = (typeof snap.winnerEvent === 'number') ? snap.winnerEvent : 0;
  if (viewerLastEvent === null) {
    viewerLastEvent = ev;
    if (snap.winnerShown && typeof snap.winnerIdx === 'number' && snap.winnerIdx >= 0) {
      showWinner(snap.winnerIdx);
    }
  } else if (ev > viewerLastEvent) {
    viewerLastEvent = ev;
    if (typeof snap.winnerIdx === 'number' && snap.winnerIdx >= 0) {
      showWinner(snap.winnerIdx);
    }
  }
}

async function viewerPoll() {
  if (viewerEnded) return;
  try {
    const res = await fetch(`${DB_BASE}/boards/${VIEW_SHARE_ID}/state/rev.json?t=` + Date.now(), { cache: 'no-store' });
    if (!res.ok) return;
    const rev = await res.json();
    if (rev === null) { showEndedScreen(); return; }   // الرابط غير موجود أو حُذف
    if (typeof rev !== 'number' || rev === viewerLastRev) return;

    const full = await fetch(`${DB_BASE}/boards/${VIEW_SHARE_ID}/state.json?t=` + Date.now(), { cache: 'no-store' });
    if (!full.ok) return;
    const snap = await full.json();
    if (!snap || snap.ended === true) { showEndedScreen(); return; }
    viewerLastRev = rev;
    applySnapshot(snap);
  } catch (_) { /* شبكة — أعد المحاولة في الدورة القادمة */ }
}

function startViewerMode() {
  document.body.classList.add('viewer-mode');

  viewerPoll();
  viewerPollTimer = setInterval(viewerPoll, SHARE_POLL_MS);
  startShareViewersLoop();

  // اللقب الإجباري ثم الدردشة (نبضة الهوية تبدأ داخل startChat) + إشعار الانضمام
  ensureNick((nick) => {
    startChat(VIEW_SHARE_ID, false);
    postJoinNotice(nick);
  });

  window.addEventListener('pagehide', () => {
    try {
      fetch(`${DB_BASE}/boards/${VIEW_SHARE_ID}/viewers/${beatVid()}.json`, { method: 'DELETE', keepalive: true });
    } catch (_) {}
  });
}

/* ====================================================================
   الدردشة الحية — أسلوب تيك توك (أثناء المشاركة فقط)
   ==================================================================== */
const CHAT_POLL_MS  = 2500;
const CHAT_RATE_MS  = 2000;    // رسالة كل ثانيتين كحد أقصى
const CHAT_FETCH_N  = 30;      // آخر 30 رسالة

let chatShareId   = null;
let chatIsJudge   = false;
let chatTimer     = null;
let chatLastSend  = 0;
let chatLastJson  = '';
let chatMuted     = false;
let chatParticipants = {};     // uid → آخر اسم معروف (لقائمة الإدارة)

function deviceUid() {
  let id = null;
  try {
    id = localStorage.getItem('madagish.chatUid');
    if (!id) {
      id = 'u' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
      localStorage.setItem('madagish.chatUid', id);
    }
  } catch (_) { id = 'u' + Math.random().toString(36).slice(2, 10); }
  return id;
}

/* هوية مالك التطبيق — صلاحيات كاملة (تتبعه على أي جهاز يسجّل دخوله) */
const ADMIN_UID = 'N5Lqkd67iPSpYzKVp3Kq3nlDzL82';
function isOwner() { return chatUid() === ADMIN_UID; }

/* الهوية الفعلية: حساب مسجَّل (يتبعك على أي جهاز) وإلا هوية الجهاز */
function chatUid() {
  try {
    const a = localStorage.getItem('madagish.authUid');
    if (a) return a;
  } catch (_) {}
  return deviceUid();
}

function getNick() {
  try { return localStorage.getItem('madagish.nick') || null; } catch (_) { return null; }
}
function setNick(n) {
  try { localStorage.setItem('madagish.nick', n); } catch (_) {}
}

/* نافذة اللقب الإجبارية (للمشاهد الجديد) */
function ensureNick(onReady) {
  const existing = getNick();
  if (existing) { onReady(existing); return; }
  showPromptModal({
    title: 'أهلاً بك 👋',
    body:  'اكتب لقبك او اسمك هنا',
    okText: 'موافق',
    inputType: 'text',
    placeholder: 'لقبك...',
    mandatory: true,
    onOk: (val) => {
      const nick = (val || '').trim().slice(0, 20);
      if (!nick) { ensureNick(onReady); return; }   // إجباري — لا يكمل بدون لقب
      setNick(nick);
      patchMyProfile({ name: nick });               // اللقب الأول = اسم الملف الشخصي
      onReady(nick);
    }
  });
}

function chatUrl(path) {
  return `${DB_BASE}/boards/${chatShareId}/${path}`;
}

async function sendChatMessage() {
  const input = document.getElementById('chatInput');
  const text = (input.value || '').trim().slice(0, 100);
  if (!text) return;
  if (chatMuted) return;
  const now = Date.now();
  if (now - chatLastSend < CHAT_RATE_MS) { showToast('تمهّل قليلاً بين الرسائل'); return; }
  chatLastSend = now;
  input.value = '';
  const msg = {
    n: chatIsJudge ? 'الحكم' : (getNick() || 'مشاهد'),
    t: text,
    ts: { '.sv': 'timestamp' },
    uid: chatUid()
  };
  if (chatIsJudge) msg.j = 1;
  try {
    await fetch(chatUrl('chat.json'), { method: 'POST', body: JSON.stringify(msg) });
    pollChat();   // اعرضها فوراً
  } catch (_) { showToast('تعذر الإرسال — تحقق من الشبكة'); }
  // بعد الإرسال (بأي طريقة): يُغلق الكيبورد تلقائياً وجاهز لفتح جديد بلمسة
  try { input.blur(); } catch (_) {}
}

function postJoinNotice(nick) {
  // مرة واحدة لكل جلسة لكل مشاركة
  const flag = 'madagish.joined.' + chatShareId;
  try { if (sessionStorage.getItem(flag)) return; sessionStorage.setItem(flag, '1'); } catch (_) {}
  fetch(chatUrl('chat.json'), {
    method: 'POST',
    body: JSON.stringify({ sys: 1, n: nick, ts: { '.sv': 'timestamp' }, uid: chatUid() })
  }).catch(() => {});
}

/* ============ إشعارات المنشن والانضمام (كبسولات فوق حقل الكتابة) ============ */
let chatNotifBaseline = null;    // آخر مفتاح رسالة عولج — لتجاهل التاريخ القديم عند الدخول
let mentionTimer = null;
let joinTimer = null;
let mentionTargetKey = null;

function mentionsMe(text) {
  if (typeof text !== 'string' || !text.includes('@')) return false;
  // المطابقة باليوزر الفريد فقط — صاحب اليوزر نفسه حصرياً يرى "@تم ذكرك"
  // (الأسماء تتكرر بين الناس فلا تصلح لتحديد المقصود)
  const u = myProfile && myProfile.username ? myProfile.username.toLowerCase() : null;
  if (!u) return false;
  return text.toLowerCase().includes('@' + u);
}

function showMentionPill(msgKey) {
  const pill = document.getElementById('mentionPill');
  if (!pill) return;
  mentionTargetKey = msgKey;
  pill.classList.remove('collapsed');
  clearTimeout(mentionTimer);
  mentionTimer = setTimeout(() => pill.classList.add('collapsed'), 60000);   // دقيقة كاملة
}

function showJoinPill(name) {
  const pill = document.getElementById('joinPill');
  if (!pill) return;
  pill.textContent = 'انضم - ' + name;
  pill.classList.remove('collapsed');
  clearTimeout(joinTimer);
  joinTimer = setTimeout(() => pill.classList.add('collapsed'), 10000);      // 10 ثوانٍ
}

function hideChatNotices() {
  clearTimeout(mentionTimer);
  clearTimeout(joinTimer);
  const mp = document.getElementById('mentionPill');
  const jp = document.getElementById('joinPill');
  if (mp) mp.classList.add('collapsed');
  if (jp) jp.classList.add('collapsed');
  mentionTargetKey = null;
  chatNotifBaseline = null;
}

function scrollToMention() {
  if (!mentionTargetKey) return;
  const feed = document.getElementById('chatFeed');
  const row = feed && feed.querySelector(`[data-key="${mentionTargetKey}"]`);
  if (row) {
    row.scrollIntoView({ behavior: 'smooth', block: 'center' });   // انزلاق سلس للرسالة
  } else if (feed) {
    feed.scrollTo({ top: 0, behavior: 'smooth' });                 // الرسالة خرجت من النافذة — لأقدم المعروض
  }
}

function renderChatFeed(data) {
  const feed = document.getElementById('chatFeed');
  if (!feed) return;
  feed.innerHTML = '';
  if (!data || typeof data !== 'object') return;

  const keys = Object.keys(data).sort();   // مفاتيح Firebase POST مرتبة زمنياً
  chatParticipants = {};

  // معالجة الإشعارات: فقط الرسائل الأحدث من خط الأساس (لا نُشعر بالتاريخ القديم عند الدخول)
  const firstLoad = chatNotifBaseline === null;
  for (const k of keys) {
    const m = data[k];
    if (!m || typeof m !== 'object') continue;
    if (!firstLoad && k > chatNotifBaseline) {
      const mUid = (typeof m.uid === 'string') ? m.uid : null;
      if (m.sys === 1) {
        if (mUid !== chatUid()) showJoinPill(((typeof m.n === 'string' ? m.n : '') || 'مشاهد').slice(0, 20));
      } else if (mUid !== chatUid() && mentionsMe(m.t)) {
        showMentionPill(k);
      }
    }
  }
  if (keys.length) chatNotifBaseline = keys[keys.length - 1];

  for (const k of keys) {
    const m = data[k];
    if (!m || typeof m !== 'object') continue;
    const name = (typeof m.n === 'string' ? m.n : '').slice(0, 20);
    const uid  = (typeof m.uid === 'string') ? m.uid : null;
    if (uid) chatParticipants[uid] = { name: name || 'مشاهد', j: m.j === 1 };

    // الانضمام لم يعد فقاعة داخل المحادثة — صار كبسولة إشعار ثابتة
    if (m.sys === 1) continue;

    const row = document.createElement('div');
    row.dataset.key = k;
    {
      row.className = 'chat-msg';
      // الأفتار أقصى اليمين (أسلوب تيك توك)
      const avEl = document.createElement('span');
      avEl.className = 'chat-av';
      avEl.innerHTML = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="3.6"/><path d="M5 20v-1a5.5 5.5 0 0 1 5.5-5.5h3A5.5 5.5 0 0 1 19 19v1"/></svg>';
      if (uid) fillAvatar(avEl, uid);
      row.appendChild(avEl);

      const nEl = document.createElement('span');
      const isOwnerMsg = uid === ADMIN_UID;
      nEl.className = 'chat-name' + (m.j === 1 ? ' judge' : '') + (isOwnerMsg ? ' owner' : '');
      let label;
      if (isOwnerMsg) label = '👑 ' + (name || 'المالك') + ' ( المالك )';   // شارة التاج للمالك
      else if (m.j === 1) label = '⚖️ الحكم';                               // ميزان العدل للحكم
      else label = name || 'مشاهد';
      nEl.textContent = label + ' -';
      // الضغط على الاسم يفتح بطاقة المستخدم (Bottom Sheet)
      if (uid) nEl.addEventListener('click', () => openUserSheet(uid, name || 'مشاهد'));
      const tEl = document.createElement('span');
      tEl.className = 'chat-text';
      tEl.textContent = (typeof m.t === 'string' ? m.t : '').slice(0, 100);
      row.appendChild(nEl);
      row.appendChild(tEl);
    }
    feed.appendChild(row);
  }
  feed.scrollTop = feed.scrollHeight;
}

async function pollChat() {
  if (!chatShareId) return;
  try {
    const res = await fetch(
      chatUrl('chat.json') + `?orderBy=%22%24key%22&limitToLast=${CHAT_FETCH_N}&t=` + Date.now(),
      { cache: 'no-store' }
    );
    if (!res.ok) return;
    const txt = await res.text();
    if (txt !== chatLastJson) {
      chatLastJson = txt;
      renderChatFeed(JSON.parse(txt));
    }
    // حالة الكتم — تسري على الجميع بمن فيهم الحكم؛ المالك وحده محصّن
    if (!isOwner()) {
      const mres = await fetch(chatUrl(`muted/${chatUid()}.json`) + '?t=' + Date.now(), { cache: 'no-store' });
      if (mres.ok) {
        const mval = await mres.json();
        const muted = !!mval;
        if (muted !== chatMuted) {
          chatMuted = muted;
          const input = document.getElementById('chatInput');
          if (input) {
            input.disabled = muted;
            // الرسالة حسب من قام بالكتم: المالك أم الحكم
            const byOwner = mval && typeof mval === 'object' && mval.b === 'o';
            input.placeholder = muted
              ? (byOwner ? 'قام المالك بكتم صوتك 🔇' : 'تم كتم صوتك من قبل الحكم 🔇')
              : 'اكتب...';
          }
        }
      }
    }
  } catch (_) { /* شبكة */ }
}

/* إظهار/إخفاء الدردشة */
function setChatVisible(visible) {
  const root = document.getElementById('chatRoot');
  const showBtn = document.getElementById('chatShowBtn');
  if (!root || !showBtn) return;
  root.classList.toggle('hidden', !visible);
  showBtn.classList.toggle('hidden', visible || !chatShareId);
  try { localStorage.setItem('madagish.chatVisible', visible ? '1' : '0'); } catch (_) {}
  layoutChatPosition();
}

function chatPreferredVisible() {
  try { return localStorage.getItem('madagish.chatVisible') !== '0'; } catch (_) { return true; }
}

/* (أُدمجت إدارة الكتم داخل قائمة "المشاهدون الآن" — openViewersList) */

/* تموضع ديناميكي للدردشة: فوق الشريط السفلي الفعلي + فوق شريط المتصفح/الكيبورد
   يقيس الارتفاعات الحقيقية بدل أرقام ثابتة — يتكيف مع سفاري وكروم وأي متصفح */
function layoutChatPosition() {
  const root    = document.getElementById('chatRoot');
  const showBtn = document.getElementById('chatShowBtn');
  if (!root && !showBtn) return;

  const bar = document.getElementById('bottomBar');
  const barH = (bar && !bar.classList.contains('hidden')) ? bar.offsetHeight : 0;

  // الجزء المحجوب من أسفل الشاشة (شريط سفاري العائم أو الكيبورد المفتوح)
  let occluded = 0;
  if (window.visualViewport) {
    occluded = Math.max(0, window.innerHeight - window.visualViewport.height - window.visualViewport.offsetTop);
  }

  let bottom = barH + occluded + 10;
  // سقف أمان: لا يطير الشات فوق منتصف الشاشة أبداً (قياس عابر خاطئ لن يخفيه)
  const cap = Math.max(120, Math.floor(window.innerHeight * 0.55));
  if (bottom > cap) bottom = barH + 10;
  if (root)    root.style.bottom    = bottom + 'px';
  if (showBtn) showBtn.style.bottom = (bottom + 4) + 'px';
}

/* شفاء ذاتي صارم: طالما المشاركة نشطة، الدردشة تظهر إلزامياً
   (يُستدعى دورياً وعند كل عودة للقائمة — يعالج أي حالة خفيت فيها لأي سبب) */
function ensureChatAlive() {
  if (!chatShareId || viewerEnded) return;
  const root = document.getElementById('chatRoot');
  const showBtn = document.getElementById('chatShowBtn');
  if (!root || !showBtn) return;
  const wantVisible = chatPreferredVisible();
  const rootHidden = root.classList.contains('hidden');
  const btnHidden = showBtn.classList.contains('hidden');
  if (wantVisible && rootHidden) {
    root.classList.remove('hidden');
    showBtn.classList.add('hidden');
  } else if (!wantVisible && rootHidden && btnHidden) {
    showBtn.classList.remove('hidden');   // مخفي باختياره — زر الإظهار لازم يبقى موجوداً
  }
  layoutChatPosition();
}

function bindChatLayout() {
  window.addEventListener('resize', layoutChatPosition);
  window.addEventListener('orientationchange', layoutChatPosition);
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', layoutChatPosition);
    window.visualViewport.addEventListener('scroll', layoutChatPosition);
  }
}

/* تعبئة أفتار عنصر من ملف صاحبه (كسول + كاش) */
function fillAvatar(el2, uid) {
  const p = profilesCache[uid];
  const set = (prof) => {
    if (prof && prof.avatar) {
      el2.innerHTML = '';
      const img = document.createElement('img');
      img.src = prof.avatar; img.alt = '';
      el2.appendChild(img);
    }
  };
  if (p) { set(p); return; }
  fetchProfile(uid).then(set).catch(() => {});
}

/* وضع ظهور المالك في قوائم المشاهدين (افتراضياً: مخفي) */
function ownerVisible() {
  try { return localStorage.getItem('madagish.ownerVisible') === '1'; } catch (_) { return false; }
}

/* معرّف نبضة هذا التبويب */
function beatVid() {
  let v = null;
  try {
    v = sessionStorage.getItem('madagish.viewerId');
    if (!v) {
      v = 'v' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
      sessionStorage.setItem('madagish.viewerId', v);
    }
  } catch (_) { v = 'v' + Math.random().toString(36).slice(2, 10); }
  return v;
}

/* نبضة هوية موحّدة: الحكم والمشاهدون معاً — تغذي العدّاد وقائمة "المشاهدون الآن" */
function chatHeartbeat() {
  if (!chatShareId) return;
  const url = `${DB_BASE}/boards/${chatShareId}/viewers/${beatVid()}.json`;
  // تخفّي المالك: لا نبضة إطلاقاً (لا في العدد ولا في القائمة) — شبح كامل
  if (isOwner() && !ownerVisible()) {
    fetch(url, { method: 'DELETE' }).catch(() => {});
    return;
  }
  const body = { ts: { '.sv': 'timestamp' }, uid: chatUid(), n: (chatIsJudge ? (getNick() || 'الحكم') : (getNick() || 'مشاهد')) };
  if (chatIsJudge) body.j = 1;
  fetch(url, { method: 'PUT', body: JSON.stringify(body) }).catch(() => {});
}

/* قائمة المشاهدين الآن — متاحة للجميع
   المخوَّلون (الحكم/المالك) يرون أزرار الكتم داخلها؛ المشاهد العادي يرى الأسماء فقط */
async function openViewersList() {
  if (!chatShareId) return;
  const overlay = document.getElementById('viewersOverlay');
  const list = document.getElementById('viewersList');
  list.innerHTML = '<div class="mod-empty">جارِ التحميل...</div>';
  overlay.classList.remove('hidden');

  const privileged = chatIsJudge || isOwner();
  try {
    const res = await fetch(`${DB_BASE}/boards/${chatShareId}/viewers.json?t=` + Date.now(), { cache: 'no-store' });
    const data = res.ok ? await res.json() : null;

    // خريطة الكتم — للمخوَّلين فقط
    let mutedMap = {};
    if (privileged) {
      try {
        const mres = await fetch(`${DB_BASE}/boards/${chatShareId}/muted.json?t=` + Date.now(), { cache: 'no-store' });
        if (mres.ok) mutedMap = (await mres.json()) || {};
      } catch (_) {}
    }

    list.innerHTML = '';
    if (!data || typeof data !== 'object') {
      list.innerHTML = '<div class="mod-empty">لا يوجد مشاهدون الآن.</div>';
      return;
    }
    let maxTs = 0;
    const entries = [];
    for (const k of Object.keys(data)) {
      const e = data[k];
      const ts = (e && typeof e.ts === 'number') ? e.ts : 0;
      entries.push({ ts, uid: e && e.uid, n: (e && e.n) || 'مشاهد', j: e && e.j === 1 });
      if (ts > maxTs) maxTs = ts;
    }
    const fresh = entries.filter(e => maxTs - e.ts < PRESENCE_FRESH_MS);
    if (fresh.length === 0) {
      list.innerHTML = '<div class="mod-empty">لا يوجد مشاهدون الآن.</div>';
      return;
    }
    // الحكم أولاً ثم البقية
    fresh.sort((a, b) => (b.j ? 1 : 0) - (a.j ? 1 : 0));

    for (const e of fresh) {
      const row = document.createElement('div');
      row.className = 'mod-row';

      // يسار الاسم (في RTL): الأفتار أولاً
      const avEl = document.createElement('span');
      avEl.className = 'list-av';
      avEl.innerHTML = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="3.6"/><path d="M5 20v-1a5.5 5.5 0 0 1 5.5-5.5h3A5.5 5.5 0 0 1 19 19v1"/></svg>';
      if (e.uid) fillAvatar(avEl, e.uid);

      const nameEl = document.createElement('span');
      nameEl.className = 'mod-name';
      if (e.uid === ADMIN_UID) {
        nameEl.textContent = '👑 ' + e.n + ' ( المالك )';
        nameEl.classList.add('viewer-row-owner');
      } else if (e.j) {
        nameEl.textContent = '⚖️ الحكم : ' + e.n;
        nameEl.classList.add('viewer-row-judge');
      } else {
        nameEl.textContent = e.n;
      }

      const main = document.createElement('span');
      main.className = 'viewer-row-main';
      main.appendChild(avEl);
      main.appendChild(nameEl);
      if (e.uid) {
        main.style.cursor = 'pointer';
        main.addEventListener('click', () => {
          overlay.classList.add('hidden');
          openUserSheet(e.uid, e.n);
        });
      }
      row.appendChild(main);

      // زر الكتم — للمخوَّلين، ولا يظهر على: نفسك، المالك، أو الحكم (إلا للمالك)
      const canMute = privileged && e.uid &&
                      e.uid !== chatUid() &&
                      e.uid !== ADMIN_UID &&
                      (!e.j || isOwner());
      if (canMute) {
        const btn = document.createElement('button');
        btn.type = 'button';
        let mutedVal = mutedMap[e.uid];
        let isMuted = !!mutedVal;
        const paint = () => {
          btn.className = 'mod-btn' + (isMuted ? ' muted' : '');
          btn.textContent = isMuted ? 'فك الكتم' : 'كتم';
        };
        paint();
        btn.addEventListener('click', async (ev) => {
          ev.stopPropagation();
          try {
            if (isMuted) {
              await fetch(`${DB_BASE}/boards/${chatShareId}/muted/${e.uid}.json`, { method: 'DELETE' });
            } else {
              // نسجّل من قام بالكتم: المالك أم الحكم — لتظهر الرسالة الصحيحة للمكتوم
              const by = isOwner() ? 'o' : 'j';
              await fetch(`${DB_BASE}/boards/${chatShareId}/muted/${e.uid}.json`, {
                method: 'PUT',
                body: JSON.stringify({ b: by })
              });
            }
            isMuted = !isMuted;
            paint();
          } catch (_) { showToast('تعذر التنفيذ — تحقق من الشبكة'); }
        });
        row.appendChild(btn);
      }

      list.appendChild(row);
    }
  } catch (_) { list.innerHTML = '<div class="mod-empty">تعذر التحميل</div>'; }
}

function updateOwnerVisBtn() {
  const btn = document.getElementById('ownerVisBtn');
  if (!btn) return;
  btn.textContent = ownerVisible() ? '👁 مرئي — اضغط للاختفاء' : '🙈 مخفي — اضغط للظهور';
  btn.className = ownerVisible() ? 'btn-primary' : 'btn-secondary';
}

function toggleOwnerVisibility() {
  try { localStorage.setItem('madagish.ownerVisible', ownerVisible() ? '0' : '1'); } catch (_) {}
  updateOwnerVisBtn();
  chatHeartbeat();   // تحديث فوري: يظهر أو يختفي في اللحظة
  showToast(ownerVisible() ? 'صرت مرئياً في القوائم 👁' : 'اختفيت من القوائم 🙈');
}

function startChat(shareId, isJudge) {
  chatShareId = shareId;
  chatIsJudge = isJudge;
  chatLastJson = '';
  chatMuted = false;

  // (زر الإدارة أُدمج في قائمة "المشاهدون الآن")

  setChatVisible(chatPreferredVisible());
  layoutChatPosition();
  setTimeout(layoutChatPosition, 300);   // بعد استقرار تخطيط الصفحة والخطوط
  clearInterval(chatTimer);
  chatTimer = setInterval(pollChat, CHAT_POLL_MS);
  pollChat();

  // نبضة الهوية (الحكم أيضاً يظهر في قائمة المشاهدين بصفته)
  chatHeartbeat();
  clearInterval(chatBeatTimer);
  chatBeatTimer = setInterval(chatHeartbeat, SHARE_VIEWERS_MS);
}
let chatBeatTimer = null;

function stopChat() {
  // احذف نبضتي قبل مسح المعرف
  if (chatShareId) {
    fetch(`${DB_BASE}/boards/${chatShareId}/viewers/${beatVid()}.json`, { method: 'DELETE' }).catch(() => {});
  }
  chatShareId = null;
  clearInterval(chatTimer);
  clearInterval(chatBeatTimer);
  hideChatNotices();
  const root = document.getElementById('chatRoot');
  const showBtn = document.getElementById('chatShowBtn');
  if (root) root.classList.add('hidden');
  if (showBtn) showBtn.classList.add('hidden');
}

function bindChatEvents() {
  const input   = document.getElementById('chatInput');
  const sendBtn = document.getElementById('chatSendBtn');
  const hideBtn = document.getElementById('chatHideBtn');
  const showBtn = document.getElementById('chatShowBtn');

  sendBtn.addEventListener('click', sendChatMessage);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); sendChatMessage(); }
  });
  hideBtn.addEventListener('click', () => setChatVisible(false));
  showBtn.addEventListener('click', () => setChatVisible(true));
  // كبسولة "@تم ذكرك" — الضغط ينزلق بالمحادثة للرسالة المقصودة
  document.getElementById('mentionPill').addEventListener('click', scrollToMention);

  // قائمة المشاهدين الآن (للجميع — والمخوَّلون يرون أزرار الكتم داخلها)
  const viewersOverlay = document.getElementById('viewersOverlay');
  document.getElementById('viewersBtn').addEventListener('click', openViewersList);
  document.getElementById('viewersCloseBtn').addEventListener('click', () => viewersOverlay.classList.add('hidden'));
  viewersOverlay.addEventListener('click', (e) => {
    if (e.target === viewersOverlay) viewersOverlay.classList.add('hidden');
  });
}

/* ====================================================================
   الملفات الشخصية — "أنت": أفتار + اسم + يوزر فريد + نبذة
   ==================================================================== */
const NAME_COOLDOWN_MS = 5 * 60 * 1000;        // تعديل الاسم كل 5 دقائق
const USER_COOLDOWN_MS = 24 * 60 * 60 * 1000;  // تعديل اليوزر كل 24 ساعة
const USERNAME_RE = /^[a-z0-9_]{3,15}$/;

let myProfile = null;               // كاش ملفي
let profilesCache = {};             // uid → ملف (للبطاقات)
let profileViewUid = null;          // من المعروض حالياً في صفحة الملف
let profileIsMine = false;

function profileUrl(uid) { return `${DB_BASE}/profiles/${uid}.json`; }
function usernameUrl(u)  { return `${DB_BASE}/usernames/${u}.json`; }

async function fetchProfile(uid) {
  try {
    const res = await fetch(profileUrl(uid) + '?t=' + Date.now(), { cache: 'no-store' });
    if (!res.ok) return null;
    const p = await res.json();
    if (p && typeof p === 'object') { profilesCache[uid] = p; return p; }
  } catch (_) {}
  return null;
}

async function patchMyProfile(fields) {
  try {
    await fetch(profileUrl(chatUid()), { method: 'PATCH', body: JSON.stringify(fields) });
    myProfile = Object.assign(myProfile || {}, fields);
    profilesCache[chatUid()] = myProfile;
    return true;
  } catch (_) { return false; }
}

/* أفتار الشريط */
function updateBarAvatar() {
  const holder = document.getElementById('meBarAvatar');
  if (!holder) return;
  if (myProfile && myProfile.avatar) {
    holder.innerHTML = '';
    const img = document.createElement('img');
    img.src = myProfile.avatar;
    img.alt = '';
    holder.appendChild(img);
  }
}

async function loadMyProfile() {
  myProfile = await fetchProfile(chatUid());
  // توحيد: اسم الملف = اسم الشات
  if (myProfile && typeof myProfile.name === 'string' && myProfile.name.trim()) {
    setNick(myProfile.name);
  } else if (getNick()) {
    // مستخدم قديم عنده لقب فقط — أنشئ له ملفاً بهدوء
    patchMyProfile({ name: getNick() });
  }
  updateBarAvatar();
}

/* ============ عرض صفحة الملف ============ */
function renderProfileScreen(uid, p) {
  profileViewUid = uid;
  profileIsMine = uid === chatUid();
  const nameEl = document.getElementById('profileName');
  const userEl = document.getElementById('profileUser');
  const img    = document.getElementById('profileAvatarImg');
  const ph     = document.getElementById('profileAvatarPh');
  const cam    = document.getElementById('profileAvatarCam');
  const bioEdit  = document.getElementById('profileBioEdit');
  const bioCount = document.getElementById('profileBioCount');
  const bioView  = document.getElementById('profileBioView');

  const name = (p && p.name) || (profileIsMine ? (getNick() || 'بدون اسم') : 'مستخدم');
  const uname = p && p.username ? '@' + p.username : (profileIsMine ? 'لا يوجد يوزر بعد' : '');
  const bio = (p && typeof p.bio === 'string') ? p.bio : '';

  nameEl.textContent = name;
  userEl.textContent = uname;

  if (p && p.avatar) {
    img.src = p.avatar;
    img.classList.remove('hidden');
    ph.classList.add('hidden');
  } else {
    img.classList.add('hidden');
    ph.classList.remove('hidden');
  }

  const suspended = !!(p && p.suspended);
  const owner = isOwner();

  // إشعار الإيقاف
  document.getElementById('suspendedNotice').classList.toggle('hidden', !suspended);

  // صاحب الملف الموقوف: لا وصول ولا تعديل — يرى الإشعار فقط (المالك مستثنى)
  const lockedOut = suspended && profileIsMine && !owner;
  // زائر يشاهد ملفاً موقوفاً: يرى الاسم والإشعار فقط (المالك يرى كل شيء)
  const hiddenContent = suspended && !owner;

  if (hiddenContent) {
    img.classList.add('hidden');
    ph.classList.remove('hidden');
    userEl.textContent = '';
  }

  document.getElementById('editNameBtn').classList.toggle('hidden', !profileIsMine || lockedOut);
  document.getElementById('editUserBtn').classList.toggle('hidden', !profileIsMine || lockedOut);
  cam.classList.toggle('hidden', !profileIsMine || lockedOut);

  // النبذة تُخفى في الملف الموقوف (لغير المالك)
  document.querySelector('.profile-bio-label').classList.toggle('hidden', hiddenContent);
  if (hiddenContent) {
    document.getElementById('profileBioEdit').classList.add('hidden');
    document.getElementById('profileBioCount').classList.add('hidden');
    document.getElementById('profileBioView').classList.add('hidden');
  } else {
    document.getElementById('profileBioView').classList.toggle('hidden', profileIsMine);
  }

  // زر الإبلاغ: يظهر لغير صاحب الملف (والمالك ما يحتاجه)
  document.getElementById('reportBtn').classList.toggle('hidden', profileIsMine || owner);

  // أدوات المالك: تظهر للمالك على ملفات الآخرين فقط
  const panel = document.getElementById('adminPanel');
  panel.classList.toggle('hidden', !owner || profileIsMine);
  if (owner && !profileIsMine) {
    document.getElementById('adminSuspendBtn').textContent = suspended ? '▶ فك الإيقاف' : '⏸ إيقاف مؤقت';
    refreshAdminReportsCount(uid);
  }

  renderAccountSection();
  if (lockedOut) document.getElementById('accountSection').classList.add('hidden');

  bioEdit.classList.toggle('hidden', !profileIsMine);
  bioCount.classList.toggle('hidden', !profileIsMine);
  bioView.classList.toggle('hidden', profileIsMine);
  if (profileIsMine) {
    bioEdit.value = bio;
    bioCount.textContent = bio.length + '/1000';
  } else {
    bioView.textContent = bio || '—';
  }
}

async function openProfileScreen(uid) {
  if (state.winnerShown) return;
  closeUserSheet(true);
  closeSubScreensAll();
  el.listScreen.classList.add('hidden');
  document.getElementById('profileScreen').classList.remove('hidden');
  const cached = profilesCache[uid];
  renderProfileScreen(uid, cached || null);
  const fresh = await fetchProfile(uid);
  if (profileViewUid === uid) renderProfileScreen(uid, fresh);
}

function closeSubScreensAll() { closeSubScreens(); }

/* ============ رفع الأفتار (ضغط تلقائي عبر canvas) ============ */
function handleAvatarFile(file) {
  if (!file || !file.type || !file.type.startsWith('image/')) return;
  const reader = new FileReader();
  reader.onload = () => {
    const imgObj = new Image();
    imgObj.onload = async () => {
      const S = 160;
      const canvas = document.createElement('canvas');
      canvas.width = S; canvas.height = S;
      const ctx = canvas.getContext('2d');
      // قصّ مربع من المنتصف ثم تصغير — مثل كل منصات التواصل
      const side = Math.min(imgObj.width, imgObj.height);
      const sx = (imgObj.width - side) / 2;
      const sy = (imgObj.height - side) / 2;
      ctx.drawImage(imgObj, sx, sy, side, side, 0, 0, S, S);
      const dataUrl = canvas.toDataURL('image/jpeg', 0.78);
      const ok = await patchMyProfile({ avatar: dataUrl });
      if (ok) {
        renderProfileScreen(chatUid(), myProfile);
        updateBarAvatar();
        showToast('تم تحديث الصورة ✓');
      } else {
        showToast('تعذر رفع الصورة — تحقق من الشبكة');
      }
    };
    imgObj.src = reader.result;
  };
  reader.readAsDataURL(file);
}

/* ============ نافذة تعديل الاسم (عدّاد 5 دقائق) ============ */
let nameCooldownTimer = null;

function fmtCountdown(ms) {
  const s = Math.ceil(ms / 1000);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m + ':' + String(r).padStart(2, '0');
}

function openNameEditor() {
  const overlay = document.getElementById('nameOverlay');
  const input = document.getElementById('nameEditInput');
  const ok = document.getElementById('nameOkBtn');
  const cd = document.getElementById('nameCooldown');
  overlay.classList.remove('hidden');
  input.value = getNick() || '';

  function tick() {
    let changedAt = 0;
    try { changedAt = parseInt(localStorage.getItem('madagish.nameChangedAt') || '0', 10); } catch (_) {}
    const left = changedAt + NAME_COOLDOWN_MS - Date.now();
    if (left > 0) {
      input.disabled = true;
      ok.disabled = true;
      cd.classList.remove('hidden');
      cd.textContent = 'يمكنك التعديل بعد : ' + fmtCountdown(left);
    } else {
      input.disabled = false;
      ok.disabled = false;
      cd.classList.add('hidden');
    }
  }
  tick();
  clearInterval(nameCooldownTimer);
  nameCooldownTimer = setInterval(tick, 1000);
}

function closeNameEditor() {
  clearInterval(nameCooldownTimer);
  document.getElementById('nameOverlay').classList.add('hidden');
}

async function saveNameEdit() {
  const input = document.getElementById('nameEditInput');
  const v = (input.value || '').trim().slice(0, 20);
  if (!v) return;
  if (v === getNick()) { closeNameEditor(); return; }
  setNick(v);
  try { localStorage.setItem('madagish.nameChangedAt', String(Date.now())); } catch (_) {}
  await patchMyProfile({ name: v });
  closeNameEditor();
  renderProfileScreen(chatUid(), myProfile);
  showToast('تم تغيير الاسم ✓');
}

/* ============ نافذة اليوزر (فحص إتاحة حي + عدّاد 24 ساعة) ============ */
let userCooldownTimer = null;
let userCheckTimer = null;
let userCheckState = 'idle';   // idle | ok | bad

function setUserCheck(stateName, hint) {
  const icon = document.getElementById('userCheckIcon');
  const hintEl = document.getElementById('userHint');
  const ok = document.getElementById('userOkBtn');
  userCheckState = stateName;
  if (stateName === 'ok') {
    icon.className = 'user-check ok';
    icon.textContent = '✓';
    icon.classList.remove('hidden');
    hintEl.classList.add('hidden');
    ok.disabled = false;
  } else if (stateName === 'bad') {
    icon.className = 'user-check bad';
    icon.textContent = '✕';
    icon.classList.remove('hidden');
    hintEl.textContent = hint || '';
    hintEl.classList.toggle('hidden', !hint);
    ok.disabled = true;
  } else {
    icon.classList.add('hidden');
    hintEl.classList.add('hidden');
    ok.disabled = true;
  }
}

async function checkUsernameAvailable(u) {
  try {
    const res = await fetch(usernameUrl(u) + '?t=' + Date.now(), { cache: 'no-store' });
    if (!res.ok) return null;
    const owner = await res.json();
    return owner === null || owner === chatUid();
  } catch (_) { return null; }
}

function openUserEditor() {
  const overlay = document.getElementById('userOverlay');
  const input = document.getElementById('userEditInput');
  const cd = document.getElementById('userCooldown');
  overlay.classList.remove('hidden');
  input.value = (myProfile && myProfile.username) || '';
  setUserCheck('idle');

  function tick() {
    let changedAt = 0;
    try { changedAt = parseInt(localStorage.getItem('madagish.userChangedAt') || '0', 10); } catch (_) {}
    const left = changedAt + USER_COOLDOWN_MS - Date.now();
    if (left > 0) {
      input.disabled = true;
      document.getElementById('userOkBtn').disabled = true;
      cd.classList.remove('hidden');
      const h = Math.floor(left / 3600000);
      const m = Math.ceil((left % 3600000) / 60000);
      cd.textContent = 'يمكنك تغيير اليوزر بعد : ' + h + ' ساعة و ' + m + ' دقيقة';
    } else {
      input.disabled = false;
      cd.classList.add('hidden');
    }
  }
  tick();
  clearInterval(userCooldownTimer);
  userCooldownTimer = setInterval(tick, 1000);
}

function closeUserEditor() {
  clearInterval(userCooldownTimer);
  clearTimeout(userCheckTimer);
  document.getElementById('userOverlay').classList.add('hidden');
}

function onUserInput() {
  const input = document.getElementById('userEditInput');
  input.value = input.value.toLowerCase().replace(/[^a-z0-9_]/g, '');
  const v = input.value;
  clearTimeout(userCheckTimer);
  if (v === '') { setUserCheck('idle'); return; }
  if (!USERNAME_RE.test(v)) {
    setUserCheck('bad', 'من 3 إلى 15: أحرف إنجليزية صغيرة وأرقام و _ فقط');
    return;
  }
  if (myProfile && myProfile.username === v) {
    setUserCheck('bad', 'هذا يوزرك الحالي');
    return;
  }
  setUserCheck('idle');
  userCheckTimer = setTimeout(async () => {
    const avail = await checkUsernameAvailable(v);
    if (document.getElementById('userEditInput').value !== v) return;  // تغيّر أثناء الفحص
    if (avail === true) setUserCheck('ok');
    else if (avail === false) setUserCheck('bad', 'هذا اليوزر محجوز من مستخدم آخر');
    else setUserCheck('bad', 'تعذر الفحص — تحقق من الشبكة');
  }, 400);
}

async function saveUserEdit() {
  const v = document.getElementById('userEditInput').value;
  if (userCheckState !== 'ok' || !USERNAME_RE.test(v)) return;
  // فحص نهائي ثم حجز
  const avail = await checkUsernameAvailable(v);
  if (avail !== true) { setUserCheck('bad', 'سبقك أحد إليه للتو — جرّب غيره'); return; }
  try {
    const old = myProfile && myProfile.username;
    await fetch(usernameUrl(v), { method: 'PUT', body: JSON.stringify(chatUid()) });
    if (old && old !== v) fetch(usernameUrl(old), { method: 'DELETE' }).catch(() => {});
    await patchMyProfile({ username: v });
    try { localStorage.setItem('madagish.userChangedAt', String(Date.now())); } catch (_) {}
    closeUserEditor();
    renderProfileScreen(chatUid(), myProfile);
    showToast('تم حجز اليوزر @' + v + ' ✓');
  } catch (_) { showToast('تعذر الحفظ — تحقق من الشبكة'); }
}

/* ============ النافذة السفلية (بطاقة مستخدم الدردشة) ============ */
let sheetUid = null;
let sheetNameText = '';

async function openUserSheet(uid, fallbackName) {
  if (!uid) return;
  sheetUid = uid;
  const backdrop = document.getElementById('sheetBackdrop');
  const sheet = document.getElementById('userSheet');
  const nameEl = document.getElementById('sheetName');
  const userEl = document.getElementById('sheetUser');
  const avEl = document.getElementById('sheetAvatar');

  nameEl.textContent = fallbackName || 'مستخدم';
  sheetNameText = fallbackName || 'مستخدم';
  userEl.textContent = '';
  // زر الرد يظهر فقط أثناء دردشة نشطة وليس على نفسك
  const replyBtn = document.getElementById('sheetReplyBtn');
  replyBtn.classList.toggle('hidden', !chatShareId || uid === chatUid());
  avEl.innerHTML = '<svg viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="3.6"/><path d="M5 20v-1a5.5 5.5 0 0 1 5.5-5.5h3A5.5 5.5 0 0 1 19 19v1"/></svg>';

  backdrop.classList.remove('hidden');
  sheet.classList.remove('hidden');
  sheet.classList.add('slide-out');
  sheet.style.transform = '';
  requestAnimationFrame(() => requestAnimationFrame(() => sheet.classList.remove('slide-out')));

  const p = profilesCache[uid] || await fetchProfile(uid);
  if (sheetUid !== uid) return;
  if (p) {
    if (p.name) { nameEl.textContent = p.name; sheetNameText = p.name; }
    if (p.username) userEl.textContent = '@' + p.username;
    if (p.avatar) {
      avEl.innerHTML = '';
      const img = document.createElement('img');
      img.src = p.avatar; img.alt = '';
      avEl.appendChild(img);
    }
  }
}

function closeUserSheet(instant) {
  const backdrop = document.getElementById('sheetBackdrop');
  const sheet = document.getElementById('userSheet');
  if (sheet.classList.contains('hidden')) return;
  sheetUid = null;
  if (instant) {
    sheet.classList.add('hidden');
    backdrop.classList.add('hidden');
    return;
  }
  sheet.classList.add('slide-out');
  backdrop.classList.add('hidden');
  setTimeout(() => { sheet.classList.add('hidden'); sheet.classList.remove('slide-out'); sheet.style.transform = ''; }, 300);
}

/* سحب النافذة السفلية بالإصبع للأسفل */
function bindSheetDrag() {
  const sheet = document.getElementById('userSheet');
  const handle = document.getElementById('sheetHandle');
  let startY = null;
  let dy = 0;

  function onStart(e) {
    startY = (e.touches ? e.touches[0].clientY : e.clientY);
    dy = 0;
    sheet.style.transition = 'none';
  }
  function onMove(e) {
    if (startY === null) return;
    const y = (e.touches ? e.touches[0].clientY : e.clientY);
    dy = Math.max(0, y - startY);
    sheet.style.transform = 'translateY(' + dy + 'px)';
  }
  function onEnd() {
    if (startY === null) return;
    sheet.style.transition = '';
    startY = null;
    if (dy > 80) {
      sheet.style.transform = '';
      closeUserSheet();
    } else {
      sheet.style.transform = '';
    }
  }
  handle.addEventListener('touchstart', onStart, { passive: true });
  handle.addEventListener('touchmove', onMove, { passive: true });
  handle.addEventListener('touchend', onEnd);
  handle.addEventListener('mousedown', onStart);
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onEnd);
}

/* ============ مشاركة صفحة الملف ============ */
function profileLink(uid, p) {
  const base = `${location.origin}${location.pathname}`;
  if (p && p.username) return `${base}?profile=${p.username}`;
  return `${base}?profile=u:${uid}`;
}

/* ============ فتح ملف من رابط ?profile= ============ */
async function handleProfileParam() {
  const target = VIEW_PARAMS.get('profile');
  if (!target) return;
  let uid = null;
  if (target.startsWith('u:')) {
    uid = target.slice(2);
  } else {
    try {
      const res = await fetch(usernameUrl(target.toLowerCase()) + '?t=' + Date.now(), { cache: 'no-store' });
      if (res.ok) uid = await res.json();
    } catch (_) {}
  }
  if (uid) openProfileScreen(uid);
}

/* ============ البلاغات + أدوات المالك ============ */
async function refreshAdminReportsCount(uid) {
  const line = document.getElementById('adminReports');
  try {
    const res = await fetch(`${DB_BASE}/reports/${uid}.json?t=` + Date.now(), { cache: 'no-store' });
    const data = res.ok ? await res.json() : null;
    const n = (data && typeof data === 'object') ? Object.keys(data).length : 0;
    line.textContent = 'عدد البلاغات : ' + n;
  } catch (_) { line.textContent = 'عدد البلاغات : —'; }
}

function doReportUser() {
  const target = profileViewUid;
  if (!target || target === chatUid()) return;
  showConfirm({
    title: 'إبلاغ عن المُستخدم',
    body:  'سيصل بلاغك للإدارة وسيتم التحقق يدوياً. المتابعة؟',
    okText: 'نعم، أبلغ',
    danger: true,
    onOk: async () => {
      try {
        // كل مُبلّغ يُحسب مرة واحدة لكل مستخدم — مقاوم للسبام
        await fetch(`${DB_BASE}/reports/${target}/${chatUid()}.json`, {
          method: 'PUT',
          body: JSON.stringify({ ts: { '.sv': 'timestamp' } })
        });
        showToast('وصل بلاغك للإدارة ✓');
      } catch (_) { showToast('تعذر الإرسال — تحقق من الشبكة'); }
    }
  });
}

function adminToggleSuspend() {
  const uid = profileViewUid;
  const p = profilesCache[uid] || {};
  const suspending = !p.suspended;
  showConfirm({
    title: suspending ? 'إيقاف مؤقت' : 'فك الإيقاف',
    body:  suspending
      ? 'سيُمنع المستخدم من الوصول لملفه وتعديله، وسيرى الزوار أنه موقوف. أنت وحدك سترى محتواه.'
      : 'سيعود الملف للعمل الطبيعي.',
    okText: suspending ? 'أوقف' : 'فك الإيقاف',
    danger: suspending,
    onOk: async () => {
      try {
        await fetch(profileUrl(uid), { method: 'PATCH', body: JSON.stringify({ suspended: suspending ? true : null }) });
        if (profilesCache[uid]) profilesCache[uid].suspended = suspending;
        renderProfileScreen(uid, profilesCache[uid]);
        showToast(suspending ? 'تم الإيقاف ⏸' : 'تم فك الإيقاف ▶');
      } catch (_) { showToast('تعذر التنفيذ'); }
    }
  });
}

function adminClearReports() {
  const uid = profileViewUid;
  showConfirm({
    title: 'مسح البلاغات',
    body:  'سيُصفَّر عدّاد البلاغات على هذا المستخدم بعد معالجتها.',
    okText: 'امسح',
    danger: false,
    onOk: async () => {
      await fetch(`${DB_BASE}/reports/${uid}.json`, { method: 'DELETE' }).catch(() => {});
      refreshAdminReportsCount(uid);
      showToast('تم مسح البلاغات ✓');
    }
  });
}

function adminDeleteProfile() {
  const uid = profileViewUid;
  const p = profilesCache[uid] || {};
  showConfirm({
    title: 'حذف الملف نهائياً',
    body:  `سيُحذف ملف "${p.name || 'المستخدم'}" بالكامل (الصورة، النبذة، اليوزر) ولا يمكن التراجع. متأكد؟`,
    okText: 'نعم، احذف نهائياً',
    danger: true,
    onOk: async () => {
      try {
        if (p.username) await fetch(usernameUrl(p.username), { method: 'DELETE' }).catch(() => {});
        await fetch(profileUrl(uid), { method: 'DELETE' });
        fetch(`${DB_BASE}/reports/${uid}.json`, { method: 'DELETE' }).catch(() => {});
        delete profilesCache[uid];
        showToast('تم حذف الملف نهائياً 🗑');
        backToList();
      } catch (_) { showToast('تعذر الحذف'); }
    }
  });
}

/* ============ لوحة المالك ============ */
async function sha256Hex(str) {
  const bytes = new TextEncoder().encode(str.trim().toLowerCase());
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function writeEmailHash(email, uid) {
  try {
    const h = await sha256Hex(email);
    await fetch(`${DB_BASE}/emails/${h}.json`, { method: 'PUT', body: JSON.stringify(uid) });
  } catch (_) {}
}

function openOwnerScreen() {
  if (!isOwner() || state.winnerShown) return;
  closeSubScreens();
  el.listScreen.classList.add('hidden');
  document.getElementById('ownerScreen').classList.remove('hidden');
  updateOwnerVisBtn();
  renderReportsList();
  renderLiveList();
}

function vipShowError(msg) {
  const e = document.getElementById('vipError');
  e.textContent = msg;
  e.classList.toggle('hidden', !msg);
}

async function vipAssign() {
  const email = (document.getElementById('vipEmail').value || '').trim();
  const uname = (document.getElementById('vipUser').value || '').trim().toLowerCase();
  vipShowError('');
  if (!email || !uname) { vipShowError('اكتب الإيميل واليوزر معاً'); return; }
  if (!/^[a-z0-9_]{1,15}$/.test(uname)) { vipShowError('صيغة اليوزر غير صحيحة'); return; }
  try {
    // 1) إيميل → هوية العضو (عبر البصمة المشفرة)
    const h = await sha256Hex(email);
    const r1 = await fetch(`${DB_BASE}/emails/${h}.json?t=` + Date.now(), { cache: 'no-store' });
    const uid = r1.ok ? await r1.json() : null;
    if (!uid) { vipShowError('لا يوجد عضو مسجَّل بهذا الإيميل (لازم يكون سجّل دخوله في التطبيق بعد آخر تحديث)'); return; }
    // 2) اليوزر متاح أو محجوز للإدارة؟
    const r2 = await fetch(usernameUrl(uname) + '?t=' + Date.now(), { cache: 'no-store' });
    const cur = r2.ok ? await r2.json() : null;
    if (cur !== null && cur !== 'reserved' && cur !== uid) { vipShowError('هذا اليوزر مستخدم من عضو آخر فعلاً'); return; }
    // 3) حرّر يوزره القديم إن وجد ثم اربط الجديد
    const prof = await fetchProfile(uid);
    if (prof && prof.username && prof.username !== uname) {
      fetch(usernameUrl(prof.username), { method: 'DELETE' }).catch(() => {});
    }
    await fetch(usernameUrl(uname), { method: 'PUT', body: JSON.stringify(uid) });
    await fetch(profileUrl(uid), { method: 'PATCH', body: JSON.stringify({ username: uname }) });
    if (profilesCache[uid]) profilesCache[uid].username = uname;
    document.getElementById('vipEmail').value = '';
    document.getElementById('vipUser').value = '';
    showToast('تم إهداء @' + uname + ' للعضو ✓');
  } catch (_) { vipShowError('تعذر التنفيذ — تحقق من الشبكة'); }
}

async function renderReportsList() {
  const list = document.getElementById('reportsList');
  list.innerHTML = '<div class="mod-empty">جارِ التحميل...</div>';
  try {
    const res = await fetch(`${DB_BASE}/reports.json?t=` + Date.now(), { cache: 'no-store' });
    const data = res.ok ? await res.json() : null;
    list.innerHTML = '';
    if (!data || typeof data !== 'object' || Object.keys(data).length === 0) {
      list.innerHTML = '<div class="mod-empty">لا توجد بلاغات — الوضع هادئ 🌿</div>';
      return;
    }
    const entries = Object.keys(data)
      .map(uid => ({ uid, n: Object.keys(data[uid] || {}).length }))
      .sort((a, b) => b.n - a.n);
    for (const e of entries) {
      const p = profilesCache[e.uid] || await fetchProfile(e.uid);
      const row = document.createElement('div');
      row.className = 'owner-row';
      const main = document.createElement('span');
      main.className = 'owner-row-main';
      main.textContent = (p && p.name ? p.name : 'مستخدم') + (p && p.username ? ' ( @' + p.username + ' )' : '');
      const sub = document.createElement('span');
      sub.className = 'owner-row-sub';
      sub.textContent = '🚩 ' + e.n + ' بلاغ';
      row.appendChild(main);
      row.appendChild(sub);
      row.addEventListener('click', () => openProfileScreen(e.uid));
      list.appendChild(row);
    }
  } catch (_) { list.innerHTML = '<div class="mod-empty">تعذر التحميل</div>'; }
}

async function renderLiveList() {
  const list = document.getElementById('liveList');
  list.innerHTML = '<div class="mod-empty">جارِ التحميل...</div>';
  try {
    const res = await fetch(`${DB_BASE}/live.json?t=` + Date.now(), { cache: 'no-store' });
    const data = res.ok ? await res.json() : null;
    list.innerHTML = '';
    const now = Date.now();
    const rows = [];
    if (data && typeof data === 'object') {
      for (const id of Object.keys(data)) {
        const e = data[id];
        const ts = (e && typeof e.ts === 'number') ? e.ts : 0;
        const ageMin = Math.floor((now - ts) / 60000);
        if (ageMin <= 15) rows.push({ id, n: (e && e.n) || 'حكم', ageMin });
        else if (ageMin > 720) fetch(`${DB_BASE}/live/${id}.json`, { method: 'DELETE' }).catch(() => {});
      }
    }
    if (rows.length === 0) {
      list.innerHTML = '<div class="mod-empty">لا توجد نشرات حيَّة الآن.</div>';
      return;
    }
    rows.sort((a, b) => a.ageMin - b.ageMin);
    for (const r of rows) {
      const row = document.createElement('div');
      row.className = 'owner-row';
      const main = document.createElement('span');
      main.className = 'owner-row-main';
      main.textContent = 'نشرة الحكم : ' + r.n;
      const sub = document.createElement('span');
      sub.className = 'owner-row-sub live';
      sub.textContent = r.ageMin === 0 ? '🟢 الآن' : '🟢 قبل ' + r.ageMin + ' د';
      row.appendChild(main);
      row.appendChild(sub);
      row.addEventListener('click', () => {
        location.href = `${location.origin}${location.pathname}?view=${r.id}`;
      });
      list.appendChild(row);
    }
  } catch (_) { list.innerHTML = '<div class="mod-empty">تعذر التحميل</div>'; }
}

/* ============ حماية الحساب (Firebase Auth REST) ============ */
const AUTH_API_KEY = 'AIzaSyDPwG5SXz2v5tbEYF0ayaVzXhT_BEOTpU0';
const AUTH_BASE = 'https://identitytoolkit.googleapis.com/v1';

function getAuthEmail() {
  try { return localStorage.getItem('madagish.authEmail') || null; } catch (_) { return null; }
}

async function authRequest(action, body) {
  const res = await fetch(`${AUTH_BASE}/accounts:${action}?key=${AUTH_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  if (!res.ok) {
    const code = (data && data.error && data.error.message) || 'UNKNOWN';
    throw new Error(code);
  }
  return data;
}

function authErrorAr(code) {
  if (code.includes('EMAIL_EXISTS')) return 'هذا الإيميل مسجّل من قبل — جرّب تسجيل الدخول';
  if (code.includes('INVALID_LOGIN_CREDENTIALS') || code.includes('INVALID_PASSWORD')) return 'الإيميل أو كلمة المرور غير صحيحة';
  if (code.includes('EMAIL_NOT_FOUND')) return 'لا يوجد حساب بهذا الإيميل';
  if (code.includes('WEAK_PASSWORD')) return 'كلمة المرور ضعيفة — 6 أحرف فأكثر';
  if (code.includes('INVALID_EMAIL')) return 'صيغة الإيميل غير صحيحة';
  if (code.includes('TOO_MANY_ATTEMPTS')) return 'محاولات كثيرة — انتظر قليلاً ثم أعد المحاولة';
  return 'تعذر الاتصال — تحقق من الشبكة';
}

function accShowError(msg) {
  const e = document.getElementById('accError');
  e.textContent = msg;
  e.classList.toggle('hidden', !msg);
}

function renderAccountSection() {
  const section = document.getElementById('accountSection');
  section.classList.toggle('hidden', !profileIsMine);
  if (!profileIsMine) return;
  const email = getAuthEmail();
  document.getElementById('accSignedOut').classList.toggle('hidden', !!email);
  document.getElementById('accSignedIn').classList.toggle('hidden', !email);
  if (email) document.getElementById('accEmailShow').textContent = email;
  accShowError('');
}

/* نقل ملف الجهاز إلى الحساب الجديد (مرة واحدة عند الإنشاء) */
async function migrateDeviceProfileTo(newUid) {
  const old = deviceUid();
  if (!old || old === newUid) return;
  const p = await fetchProfile(old);
  if (!p) return;
  const existing = await fetchProfile(newUid);
  if (existing) return;   // الحساب له ملف بالفعل — لا نلمسه
  await fetch(profileUrl(newUid), { method: 'PATCH', body: JSON.stringify(p) }).catch(() => {});
  if (p.username) {
    await fetch(usernameUrl(p.username), { method: 'PUT', body: JSON.stringify(newUid) }).catch(() => {});
  }
}

function finishAuth(email, uid, msg) {
  try {
    localStorage.setItem('madagish.authUid', uid);
    localStorage.setItem('madagish.authEmail', email);
  } catch (_) {}
  showToast(msg);
  setTimeout(() => location.reload(), 1000);   // إعادة تشغيل نظيفة بالهوية الجديدة
}

async function doSignup() {
  const email = (document.getElementById('accEmail').value || '').trim();
  const pass = document.getElementById('accPass').value || '';
  if (!email || !pass) { accShowError('اكتب الإيميل وكلمة المرور'); return; }
  accShowError('');
  try {
    const d = await authRequest('signUp', { email, password: pass, returnSecureToken: true });
    await migrateDeviceProfileTo(d.localId);
    await writeEmailHash(email, d.localId);   // لربط "عضو خاص" بالإيميل
    finishAuth(email, d.localId, 'تم إنشاء الحساب ✓');
  } catch (e) { accShowError(authErrorAr(String(e.message))); }
}

async function doLogin() {
  const email = (document.getElementById('accEmail').value || '').trim();
  const pass = document.getElementById('accPass').value || '';
  if (!email || !pass) { accShowError('اكتب الإيميل وكلمة المرور'); return; }
  accShowError('');
  try {
    const d = await authRequest('signInWithPassword', { email, password: pass, returnSecureToken: true });
    await migrateDeviceProfileTo(d.localId);   // لو حسابه بلا ملف وعنده ملف جهاز — ننقله (فحص داخلي)
    await writeEmailHash(email, d.localId);    // لربط "عضو خاص" بالإيميل
    finishAuth(email, d.localId, 'تم تسجيل الدخول ✓');
  } catch (e) { accShowError(authErrorAr(String(e.message))); }
}

async function doForgot() {
  let email = (document.getElementById('accEmail').value || '').trim();
  if (!email) email = getAuthEmail() || '';
  if (!email) { accShowError('اكتب إيميلك أولاً في الحقل'); return; }
  accShowError('');
  try {
    await authRequest('sendOobCode', { requestType: 'PASSWORD_RESET', email });
    showToast('أُرسل رابط تغيير كلمة المرور إلى إيميلك 📧');
  } catch (e) { accShowError(authErrorAr(String(e.message))); }
}

function doLogout() {
  showConfirm({
    title: 'تسجيل الخروج',
    body:  'سيعود هذا الجهاز لملفه المحلي. ملفك المسجّل محفوظ وترجع له بتسجيل الدخول متى شئت.',
    okText: 'خروج',
    danger: true,
    onOk: () => {
      try {
        localStorage.removeItem('madagish.authUid');
        localStorage.removeItem('madagish.authEmail');
      } catch (_) {}
      showToast('تم تسجيل الخروج');
      setTimeout(() => location.reload(), 900);
    }
  });
}

/* ============ ربط أحداث الملف الشخصي ============ */
let bioSaveTimer = null;

function bindProfileEvents() {
  document.getElementById('meBtn').addEventListener('click', () => openProfileScreen(chatUid()));
  document.getElementById('profileBackBtn').addEventListener('click', () => {
    closeSubScreensAll();
    el.listScreen.classList.remove('hidden');
    ensureChatAlive();
  });

  // الأفتار
  const fileInput = document.getElementById('avatarFile');
  document.getElementById('profileAvatarBtn').addEventListener('click', () => {
    if (profileIsMine) fileInput.click();
  });
  fileInput.addEventListener('change', () => {
    if (fileInput.files && fileInput.files[0]) handleAvatarFile(fileInput.files[0]);
    fileInput.value = '';
  });

  // تعديل الاسم
  document.getElementById('editNameBtn').addEventListener('click', openNameEditor);
  document.getElementById('nameX').addEventListener('click', closeNameEditor);
  document.getElementById('nameOkBtn').addEventListener('click', saveNameEdit);
  document.getElementById('nameOverlay').addEventListener('click', (e) => {
    if (e.target === document.getElementById('nameOverlay')) closeNameEditor();
  });

  // تعديل اليوزر
  document.getElementById('editUserBtn').addEventListener('click', openUserEditor);
  document.getElementById('userX').addEventListener('click', closeUserEditor);
  document.getElementById('userOkBtn').addEventListener('click', saveUserEdit);
  document.getElementById('userEditInput').addEventListener('input', onUserInput);
  document.getElementById('userOverlay').addEventListener('click', (e) => {
    if (e.target === document.getElementById('userOverlay')) closeUserEditor();
  });

  // النبذة: حفظ تلقائي أثناء الكتابة (debounce) + عدّاد
  const bio = document.getElementById('profileBioEdit');
  bio.addEventListener('input', () => {
    document.getElementById('profileBioCount').textContent = bio.value.length + '/1000';
    clearTimeout(bioSaveTimer);
    bioSaveTimer = setTimeout(() => { patchMyProfile({ bio: bio.value.slice(0, 1000) }); }, 800);
  });

  // مشاركة الصفحة
  document.getElementById('profileShareBtn').addEventListener('click', () => {
    const p = profilesCache[profileViewUid] || (profileIsMine ? myProfile : null);
    openShareDialog(profileLink(profileViewUid, p));
  });

  // البلاغ + أدوات المالك + لوحة المالك
  document.getElementById('reportBtn').addEventListener('click', doReportUser);
  document.getElementById('adminSuspendBtn').addEventListener('click', adminToggleSuspend);
  document.getElementById('adminClearRepBtn').addEventListener('click', adminClearReports);
  document.getElementById('adminDeleteBtn').addEventListener('click', adminDeleteProfile);
  document.getElementById('ownerBtn').addEventListener('click', openOwnerScreen);
  document.getElementById('ownerBackBtn').addEventListener('click', backToList);
  document.getElementById('vipOkBtn').addEventListener('click', vipAssign);
  document.getElementById('ownerVisBtn').addEventListener('click', toggleOwnerVisibility);

  // حماية الحساب
  document.getElementById('accSignupBtn').addEventListener('click', doSignup);
  document.getElementById('accLoginBtn').addEventListener('click', doLogin);
  document.getElementById('accForgotBtn').addEventListener('click', doForgot);
  document.getElementById('accForgotBtn2').addEventListener('click', doForgot);
  document.getElementById('accLogoutBtn').addEventListener('click', doLogout);

  // النافذة السفلية
  document.getElementById('sheetCloseBtn').addEventListener('click', () => closeUserSheet());
  document.getElementById('sheetBackdrop').addEventListener('click', () => closeUserSheet());
  document.getElementById('sheetName').addEventListener('click', () => {
    if (sheetUid) openProfileScreen(sheetUid);
  });
  // الرد عليه: منشن جاهز في حقل الدردشة (بدون فتح الكيبورد — المستخدم يلمس الحقل بنفسه)
  document.getElementById('sheetReplyBtn').addEventListener('click', () => {
    if (!sheetUid || !chatShareId) return;
    const p = profilesCache[sheetUid];
    const mention = '@' + ((p && p.username) ? p.username : sheetNameText);
    closeUserSheet();
    setChatVisible(true);
    const input = document.getElementById('chatInput');
    if (input && !input.disabled) input.value = mention + ' ';
  });
  bindSheetDrag();
}

/* ============ عدّاد المتصلين الآن (Firebase REST — بدون مكتبات) ============ */
/* آخر الأرقام الحية — تُعرض في قسم الإحصائيات بصفحة المطور */
let statOnlineNow = null;
let statJudgesNow = null;

function refreshStatsDisplay() {
  const jEl = document.getElementById('statJudges');
  const oEl = document.getElementById('statOnline');
  if (jEl && statJudgesNow !== null) jEl.textContent = String(statJudgesNow);
  if (oEl && statOnlineNow !== null) oEl.textContent = String(statOnlineNow);
}

function startPresence() {
  if (!PRESENCE_DB_URL) return;   // الميزة معطلة حتى يُضبط الرابط

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
  const myRole = VIEWER_MODE ? 'v' : 'j';   // حكم أم مشاهد — لإحصائية الحُكّام

  async function beatAndCount() {
    try {
      // 1) نبضة: سجّل نفسي بختم وقت السيرفر + دوري (حكم/مشاهد)
      await fetch(myUrl, {
        method: 'PUT',
        body: JSON.stringify({ ts: { '.sv': 'timestamp' }, r: myRole })
      });
      // 2) اقرأ الجميع واحسب من نبض حديثاً
      const res = await fetch(allUrl, { cache: 'no-store' });
      if (!res.ok) return;
      const data = await res.json();
      if (!data || typeof data !== 'object') {
        statOnlineNow = 1;
        statJudgesNow = myRole === 'j' ? 1 : 0;
        refreshStatsDisplay();
        return;
      }
      let maxTs = 0;
      const entries = [];
      for (const k of Object.keys(data)) {
        const e = data[k];
        const ts = (e && typeof e.ts === 'number') ? e.ts : 0;
        const r  = (e && e.r === 'j') ? 'j' : 'v';
        entries.push({ k, ts, r });
        if (ts > maxTs) maxTs = ts;
      }
      // المقارنة نسبية لأحدث نبضة (ختم سيرفر) — مستقلة عن ساعات الأجهزة
      let total = 0, judges = 0;
      const stale = [];
      for (const e of entries) {
        if (maxTs - e.ts < PRESENCE_FRESH_MS) {
          total++;
          if (e.r === 'j') judges++;
        } else if (maxTs - e.ts > 120000) {
          stale.push(e.k);
        }
      }
      statOnlineNow = Math.max(1, total);
      statJudgesNow = judges;
      refreshStatsDisplay();
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

/* ============ عدّاد الزوار الشهري ============ */
function monthKey() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}

function recordMonthlyVisit() {
  if (!PRESENCE_DB_URL) return;
  const ym = monthKey();
  const flag = 'madagish.visited.' + ym;
  try { if (sessionStorage.getItem(flag)) return; sessionStorage.setItem(flag, '1'); } catch (_) {}
  // زيادة ذرّية على خادم Firebase — كل جلسة تُحسب مرة واحدة
  // الشهر +1 والسنة +1 معاً: تصفير الشهر الجديد لا يمس مجموع السنة
  fetch(`${DB_BASE}/stats/visits/${ym}.json`, {
    method: 'PUT',
    body: JSON.stringify({ '.sv': { 'increment': 1 } })
  }).catch(() => {});
  fetch(`${DB_BASE}/stats/years/${yearKey()}.json`, {
    method: 'PUT',
    body: JSON.stringify({ '.sv': { 'increment': 1 } })
  }).catch(() => {});
}

async function fetchMonthlyVisits() {
  const el2 = document.getElementById('statMonthly');
  if (!el2) return;
  try {
    const res = await fetch(`${DB_BASE}/stats/visits/${monthKey()}.json?t=` + Date.now(), { cache: 'no-store' });
    if (!res.ok) return;
    const n = await res.json();
    el2.textContent = (typeof n === 'number') ? String(n) : '0';
  } catch (_) {}
}

/* ============ عدّاد السنة (تراكمي بنفس أسلوب الشهري) ============ */
function yearKey() {
  return String(new Date().getFullYear());
}

async function fetchYearlyUsers() {
  const numEl = document.getElementById('statYearly');
  const labEl = document.getElementById('statYearLabel');
  if (labEl) labEl.textContent = yearKey();
  if (!numEl) return;
  try {
    const res = await fetch(`${DB_BASE}/stats/years/${yearKey()}.json?t=` + Date.now(), { cache: 'no-store' });
    if (!res.ok) return;
    const n = await res.json();
    numEl.textContent = (typeof n === 'number') ? String(n) : '0';
  } catch (_) {}
}

/* ============ الإقلاع ============ */
function init() {
  loadState();
  bindEvents();
  if (!VIEWER_MODE) bindCrossTabSync();
  render();
  updateShareBtn();
  startUpdateChecker();
  startPresence();
  recordMonthlyVisit();
  loadMyProfile();
  handleProfileParam();
  // زر لوحة المالك — يظهر للمالك وحده
  if (isOwner()) document.getElementById('ownerBtn').classList.remove('hidden');

  if (VIEWER_MODE) {
    startViewerMode();
  } else if (state.shareId) {
    // استئناف مشاركة نشطة بعد إعادة تحميل صفحة الحكم
    schedulePushBoard();
    startShareViewersLoop();
    startChat(state.shareId, true);
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
